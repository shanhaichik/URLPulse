import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { CATALOG_FILE_LIMIT, type CatalogFilter } from '../../shared/catalog.js';
import { pacReferences } from '../pac-config.js';
import { releaseRequestSecrets } from '../request-profiles.js';
import type { RequestSecrets } from '../request-secrets.js';
import { ApiError, type Store } from '../store.js';
import { Catalog, type CatalogInput } from './database.js';
import type { CatalogDeletion, CatalogDeletionResult, DeleteSourceReply } from './source-worker.js';
import type { CatalogSecretReply, CatalogSecretRequest } from './worker.js';

export class CatalogService {
  readonly db: Catalog;
  private readonly directory: string;
  private readonly uploads = new Map<number, { projectId: number; stop: AbortController; done: Promise<void> }>();
  private readonly clearing = new Set<number>();
  private active?: { id: number; projectId: number; kind: 'import' | 'transfer' | 'cleanup'; worker: Worker; done: Promise<void> };
  private sourceDeletes = Promise.resolve();
  private closeTask?: Promise<void>;
  private closed = false;
  private reconcileTask?: Promise<void>;
  private cleanupFailed = false;

  constructor(private readonly database: string, private readonly reportError = console.error,
    private readonly credentials?: { store: Store; secrets: RequestSecrets }) {
    this.database = resolve(database);
    this.directory = this.database + '.catalog';
    this.db = new Catalog(this.database);
  }

  start() {
    this.db.recover();
    this.kick();
    this.reconcileTask = this.reconcile().catch(this.reportError);
  }

  create(projectId: number, input: CatalogInput) {
    this.assertWritable(projectId);
    const job = this.db.create(projectId, input);
    this.kick();
    return job;
  }

  transfer(projectId: number) {
    this.assertWritable(projectId);
    const job = this.db.transfers.enqueue(projectId);
    this.kick();
    return job;
  }

  stopTransfer(projectId: number, id: number) {
    this.assertWritable(projectId);
    const transfer = this.db.transfers.stop(projectId, id);
    if (this.active?.kind === 'transfer' && this.active.id === id) this.active.worker.postMessage('stop');
    this.kick();
    return transfer;
  }

  private writeBlock(projectId: number) {
    if (this.closed) return new ApiError(503, 'Приложение завершает работу.');
    if (this.clearing.has(projectId)) return new ApiError(409, 'Дождитесь завершения очистки каталога.');
  }

  assertWritable(projectId: number) {
    const error = this.writeBlock(projectId);
    if (error) throw error;
  }

  private queueDeletion<T>(operation: () => Promise<T>) {
    const deletion = this.sourceDeletes.then(operation);
    this.sourceDeletes = deletion.then(() => {}, () => {});
    return deletion;
  }

  private async cleanDeletedFiles(files: CatalogDeletionResult['files']) {
    for (const { key } of files) {
      const file = this.fileForKey(key);
      if (file) await Promise.all([file, file + '.partial'].map(path => rm(path, { force: true }).catch(this.reportError)));
    }
  }

  private async releasePacSecrets(refs: readonly string[]) {
    if (this.credentials) await releaseRequestSecrets(this.credentials.store, this.credentials.secrets, refs);
  }

  deleteSource(projectId: number, sourceId: number) {
    const error = this.writeBlock(projectId);
    if (error) return Promise.reject(error);
    return this.queueDeletion(async () => {
      const refs = this.db.pacSecretReferences(projectId, sourceId);
      const { files } = await this.runDeletion(projectId, { sourceId });
      await this.cleanDeletedFiles(files);
      await this.releasePacSecrets(refs);
    });
  }

  clear(projectId: number, confirmation: string) {
    const error = this.writeBlock(projectId);
    if (error) return Promise.reject(error);
    this.clearing.add(projectId);
    return this.queueDeletion(async () => {
      try {
        const refs = this.db.pacSecretReferences(projectId);
        // The transaction removes the jobs and their source versions together. After it commits no worker can add another batch.
        const { deleted, files } = await this.runDeletion(projectId, { confirmation });
        const active = this.active?.projectId === projectId ? this.active : undefined;
        active?.worker.postMessage('stop');
        const uploads = [...this.uploads.values()].filter(upload => upload.projectId === projectId);
        for (const upload of uploads) upload.stop.abort();
        await Promise.allSettled([active?.done, ...uploads.map(upload => upload.done)]);
        await this.cleanDeletedFiles(files);
        await this.releasePacSecrets(refs);
        return { deleted };
      } finally {
        this.clearing.delete(projectId);
        this.kick();
      }
    });
  }

  private runDeletion(projectId: number, operation: CatalogDeletion) {
    return new Promise<CatalogDeletionResult>((resolve, reject) => {
      const typescript = import.meta.url.endsWith('.ts');
      const script = typescript ? './source-worker.ts' : './source-worker.js';
      const worker = new Worker(new URL(script, import.meta.url), {
        workerData: { database: this.database, projectId, operation },
        execArgv: typescript ? ['--import', 'tsx'] : undefined,
      });
      let reply: DeleteSourceReply | undefined;
      let failure: Error | undefined;
      worker.once('message', (result: DeleteSourceReply) => { reply = result; });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => {
        if (failure) reject(failure);
        else if (code !== 0 || !reply) reject(new Error('Удаление данных каталога прервалось.'));
        else if ('files' in reply) resolve(reply);
        else if (reply.statusCode) reject(new ApiError(reply.statusCode, reply.message));
        else reject(Object.assign(new Error(reply.message), { errcode: reply.errcode }));
      });
    });
  }

  pick(projectId: number, file: string, sourceId?: number) {
    const job = this.create(projectId, { fileName: basename(file), sourceId });
    void this.upload(projectId, job.id, () => createReadStream(file)).catch(this.reportError);
    return job;
  }

  async upload(projectId: number, id: number, input: () => Readable) {
    this.assertWritable(projectId);
    if (this.uploads.has(id) || this.db.job(projectId, id).state !== 'upload') {
      throw new ApiError(409, 'Загрузка файла уже началась или была остановлена.');
    }
    const stop = new AbortController();
    const file = this.file(id);
    if (!file) throw new ApiError(409, 'Задание не принимает файл.');
    const temporary = file + '.partial';
    const done = (async () => {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        let size = 0;
        const guard = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > CATALOG_FILE_LIMIT) callback(new ApiError(413, 'Файл sitemap превышает 256 МиБ.'));
            else callback(null, chunk);
          },
        });
        await pipeline(input(), guard, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: stop.signal });
        stop.signal.throwIfAborted();
        await rename(temporary, file);
        this.db.uploaded(projectId, id);
        this.kick();
      } catch (error) {
        this.db.failUpload(id, 'Не удалось загрузить файл. Выберите его повторно.');
        await rm(file, { force: true }).catch(this.reportError);
        if (stop.signal.aborted) throw new ApiError(409, 'Загрузка sitemap остановлена.');
        throw error;
      } finally {
        await rm(temporary, { force: true }).catch(this.reportError);
        this.uploads.delete(id);
      }
    })();
    this.uploads.set(id, { projectId, stop, done });
    await done;
    return this.db.job(projectId, id);
  }

  async control(projectId: number, id: number, action: 'pause' | 'resume' | 'cancel') {
    this.assertWritable(projectId);
    if (action === 'resume' && this.db.job(projectId, id).needsFile && !(await this.hasFile(id))) {
      throw new ApiError(409, 'Файл недоступен. Выберите его повторно.');
    }
    this.assertWritable(projectId);
    const job = this.db.control(projectId, id, action);
    const importing = this.active?.kind === 'import' && this.active.id === id;
    if (action !== 'resume' && importing && this.active) this.active.worker.postMessage('stop');
    if (action === 'cancel') {
      this.uploads.get(id)?.stop.abort();
      if (!importing) await this.clean(id);
      if (!importing) await this.releasePacSecrets(pacReferences(this.db.pacSnapshot(id)));
    }
    this.kick();
    return job;
  }

  csv(projectId: number, filter: CatalogFilter, selected?: string[]) {
    return this.db.csv(this.database, projectId, filter, selected);
  }

  private file(id: number) {
    return this.fileForKey(this.db.fileKey(id));
  }
  private fileForKey(key?: string | null) {
    return key && /^[a-f0-9-]{36}$/.test(key) ? join(this.directory, key + '.bin') : undefined;
  }
  private async hasFile(id: number) {
    const file = this.file(id);
    return file && (await stat(file).catch(() => null))?.isFile();
  }
  private async clean(id: number) {
    const file = this.file(id);
    if (file) await rm(file, { force: true }).catch(this.reportError);
  }
  private async reconcile() {
    const entries = await readdir(this.directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const name of entries) {
      const match = /^([a-f0-9-]{36})\.bin(\.partial)?$/.exec(name);
      if (!match) continue;
      const id = this.db.openFileKey(match[1]);
      if (id === undefined || (match[2] && !this.uploads.has(id))) {
        await rm(join(this.directory, name), { force: true });
      }
    }
  }

  private kick() {
    if (this.closed || this.active || this.clearing.size) return;
    const transfer = this.db.transfers.next();
    const queued = this.db.next();
    const kind = transfer !== undefined ? 'transfer' : queued !== undefined ? 'import' : 'cleanup';
    const id = transfer?.id ?? queued ?? (this.cleanupFailed ? undefined : this.db.nextCleanup());
    if (id === undefined) return;
    const projectId = transfer?.projectId ?? this.db.importProject(id);
    if (projectId === undefined) return;
    const refs = new Set(kind === 'import' ? pacReferences(this.db.pacSnapshot(id)) : []);
    const script = import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js';
    const worker = new Worker(new URL(script, import.meta.url), { workerData: {
      database: this.database, id, kind, projectId, file: kind === 'import' ? this.file(id) : undefined,
    } });
    worker.on('error', this.reportError);
    worker.on('message', (request: CatalogSecretRequest) => {
      if (request?.type !== 'pac-secret') return;
      const value = refs.has(request.ref) ? this.credentials?.secrets.read(request.ref) : undefined;
      void Promise.resolve(value).catch(() => undefined).then(secret => {
        worker.postMessage({ type: 'pac-secret', id: request.id, value: secret } satisfies CatalogSecretReply);
      }).catch(this.reportError);
    });
    const done = new Promise<void>(resolve => {
      worker.once('exit', code => {
        void (async () => {
          const state = kind === 'import' ? this.db.state(id) : undefined;
          if (!this.closed && code !== 0) {
            if (kind === 'cleanup') this.cleanupFailed = true;
            else if (transfer) this.db.transfers.fail(transfer.projectId, id, 'Перенос прервался. Запустите перенос повторно.');
            else if (state === 'queued' || state === 'running') this.db.workerFailed(id);
          }
          if (kind === 'cleanup' || (kind === 'import' && (state === 'done' || state === 'cancelled' || !state))) await this.clean(id);
          if (refs.size) await this.releasePacSecrets([...refs]);
        })().catch(this.reportError).finally(() => {
          this.active = undefined;
          resolve();
          this.kick();
        });
      });
    });
    this.active = { id, projectId, kind, worker, done };
  }

  close() {
    return this.closeTask ??= this.shutdown();
  }

  private async shutdown() {
    this.closed = true;
    for (const upload of this.uploads.values()) upload.stop.abort();
    if (this.active) {
      this.active.worker.postMessage('stop');
      // During import, each committed chunk and document can be recovered on next startup.
      const terminate = setTimeout(() => { void this.active?.worker.terminate(); }, 2_000);
      await this.active.done;
      clearTimeout(terminate);
    }
    await Promise.allSettled([...this.uploads.values()].map(upload => upload.done));
    await this.reconcileTask;
    await this.sourceDeletes;
    this.db.close();
  }
}
