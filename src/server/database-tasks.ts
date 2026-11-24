import { Worker } from 'node:worker_threads';
import type { ReportFilters } from '../shared/reports.js';
import type { ComparisonInput, ComparisonPair } from '../shared/run-comparison.js';
import type { AddressFilters, CheckResult } from '../shared/types.js';
import { ApiError, PROJECT_URL_LIMIT, type EmailJob, type ExportScope, type Store } from './store.js';

export function databaseBusy(error: unknown) {
  const code = (error as { errcode?: number } | null)?.errcode;
  return typeof code === 'number' && (code & 0xff) === 5;
}

export const databaseCommands = {
  report: (store: Store, project: number, run: number, filters: ReportFilters, after: number) => store.report(project, run, filters, after),
  beginExport: (store: Store, project: number, scope: ExportScope, filters: ReportFilters) => store.beginExport(project, scope, filters),
  readExport: (store: Store, id: string, before: number) => store.readExport(id, before),
  endExport: (store: Store, id: string) => store.endExport(id),
  comparisonOptions: (store: Store, project: number, before?: number) => store.comparisonOptions(project, before),
  comparisonSummary: (store: Store, project: number, pair: ComparisonPair) => store.comparisonSummary(project, pair),
  comparisonPage: (store: Store, project: number, input: ComparisonInput, after: number) => store.comparisonPage(project, input, after),
  beginComparisonExport: (store: Store, project: number, input: ComparisonInput) => store.beginComparisonExport(project, input),
  readComparisonExport: (store: Store, id: string, after: number) => store.readComparisonExport(id, after),
  endComparisonExport: (store: Store, id: string) => store.endComparisonExport(id),
  overview: (store: Store, projectId: number) => store.overview(projectId),
  page: (store: Store, projectId: number, filters: AddressFilters, page: number) => store.worklist.page(projectId, filters, page),
  selection: (store: Store, projectId: number, filters: AddressFilters) => store.worklist.selection(projectId, filters, PROJECT_URL_LIMIT),
  enqueue: (store: Store, projectId: number) => store.enqueue(projectId),
  enqueueGroup: (store: Store, projectId: number, groupId: number) => store.enqueueGroup(projectId, groupId),
  groups: (store: Store, projectId: number) => store.groups(projectId),
  deleteGroup: (store: Store, projectId: number, groupId: number) => store.deleteGroup(projectId, groupId),
  claim: (store: Store, schedulesEnabled: boolean) => store.claim(schedulesEnabled),
  requeue: (store: Store, runId: number) => store.requeue(runId),
  finish: (store: Store, runId: number, email: boolean) => store.finish(runId, email),
  saveResult: (store: Store, id: number, result: CheckResult, run: number) => store.saveResult(id, result, run),
  claimEmail: (store: Store) => store.claimEmail(),
  finishEmail: (store: Store, job: EmailJob, error: string | null, retry: boolean) => store.finishEmail(job, error, retry),
  schedule: (store: Store) => store.enqueueDue(),
  deleteProject: (store: Store, projectId: number) => store.deleteProject(projectId),
  deleteRun: (store: Store, projectId: number, runId: number) => store.deleteRun(projectId, runId),
  previewDeleteAll: (store: Store, projectId: number) => store.previewDeleteAll(projectId),
  deleteAllUrls: (store: Store, projectId: number, confirmation: string) => store.deleteAllUrls(projectId, confirmation),
  stopRun: (store: Store, projectId: number, runId: number) => store.stopRun(projectId, runId),
  restartRun: (store: Store, projectId: number, runId: number) => store.restartRun(projectId, runId),
};

type Commands = typeof databaseCommands;
type Command = keyof Commands;
type Arguments<K extends Command> = Parameters<Commands[K]> extends [Store, ...infer Args] ? Args : never;

export type DatabaseRequest = { id: number; command: Command; args: unknown[] };
export type DatabaseResponse = { id: number; value: unknown } | { id: number; message: string; status?: number };
const writes = new Set<Command>(['enqueue', 'enqueueGroup', 'deleteGroup', 'claim', 'requeue', 'finish', 'saveResult', 'claimEmail', 'finishEmail', 'schedule', 'deleteProject', 'deleteRun', 'deleteAllUrls', 'stopRun', 'restartRun']);

class DatabaseLane {
  private next = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly worker: Worker;

  constructor(file: string) {
    const entry = import.meta.url.endsWith('.ts') ? './database-worker.ts' : './database-worker.js';
    this.worker = new Worker(new URL(entry, import.meta.url), { workerData: file });
    this.worker.on('message', (message: DatabaseResponse) => {
      const task = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!task) return;
      if ('value' in message) task.resolve(message.value);
      else task.reject(message.status ? new ApiError(message.status, message.message) : new Error(message.message));
    });
    this.worker.on('error', error => this.rejectAll(error));
    this.worker.on('exit', () => this.rejectAll(new Error('Фоновая операция с базой прервалась.')));
  }

  send(command: Command, args: unknown[]) {
    const id = this.next++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, command, args } satisfies DatabaseRequest);
    });
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export class DatabaseTasks {
  private reader?: DatabaseLane;
  private writer?: DatabaseLane;
  private closed = false;

  constructor(private readonly file: string) {}

  run<K extends Command>(command: K, ...args: Arguments<K>): Promise<Awaited<ReturnType<Commands[K]>>> {
    if (this.closed) return Promise.reject(new Error('Приложение завершает работу.'));
    const slot = writes.has(command) ? 'writer' : 'reader';
    if (!this[slot]) {
      const lane = new DatabaseLane(this.file);
      this[slot] = lane;
      lane.worker.once('exit', () => { if (this[slot] === lane) this[slot] = undefined; });
    }
    return this[slot]!.send(command, args) as Promise<Awaited<ReturnType<Commands[K]>>>;
  }

  async close() {
    this.closed = true;
    await Promise.all([this.reader?.worker.terminate(), this.writer?.worker.terminate()]);
  }
}
