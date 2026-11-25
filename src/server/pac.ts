import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Worker } from 'node:worker_threads';
import { MAX_PAC_BYTES, type PacRoute, type PacRouteResolver } from '../shared/pac.js';

export class PacError extends Error {}

const workerErrors = {
  load: 'Не удалось загрузить PAC. Проверьте синтаксис и код верхнего уровня.',
  entry: 'В PAC нужна функция FindProxyForURL(url, host).',
  execute: 'Ошибка выполнения FindProxyForURL. Проверьте скрипт PAC.',
  timeout: 'PAC превысил лимит времени выполнения.',
  dns: 'PAC превысил лимит DNS-запросов.',
  type: 'Функция FindProxyForURL должна вернуть строку маршрутов PAC.',
  size: 'PAC превысил лимит размера строки маршрутов.',
  route: 'PAC вернул неверную строку маршрутов.',
  runtime: 'Не удалось запустить изолированную проверку PAC.',
};

export type PacWorkerRequest = { source: string; args?: readonly [url: string, host: string] };
export type PacWorkerReply = { value: string } | { error: keyof typeof workerErrors };
export type PacDnsRequest = { hostname: string; buffer: SharedArrayBuffer };

interface Job {
  request: PacWorkerRequest;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  detachAbort: () => void;
  slot?: Slot;
  timer?: NodeJS.Timeout;
  dns?: Resolver;
}

interface Slot {
  worker: Worker;
  job?: Job;
  retiring?: boolean;
}

const maxWorkers = 4;
const maxWaitingJobs = 128;
const workerTimeoutMs = 2_500;
const waiting: Job[] = [];
const slots = new Set<Slot>();

function retire(slot: Slot) {
  if (slot.retiring) return;
  slot.retiring = true;
  void slot.worker.terminate().catch(() => undefined);
}

function finish(job: Job, result: { value: string } | { error: unknown }) {
  const slot = job.slot;
  if (slot) {
    job.slot = undefined;
    slot.job = undefined;
    if (!slot.retiring) slot.worker.unref();
  }
  job.detachAbort();
  clearTimeout(job.timer);
  job.dns?.cancel();
  if ('error' in result) job.reject(result.error);
  else job.resolve(result.value);
}

async function answerDns(job: Job, { hostname, buffer }: PacDnsRequest) {
  const state = new Int32Array(buffer, 0, 1);
  let address: string | undefined;
  try {
    job.dns ??= new Resolver({ timeout: 200, tries: 1 });
    [address] = await job.dns.resolve4(hostname);
  } catch {
    // A failed lookup is reported to the PAC script as null.
  }
  if (address) new Uint8Array(buffer, state.byteLength).set(Buffer.from(address, 'ascii'));
  Atomics.store(state, 0, address ? 2 : 1);
  Atomics.notify(state, 0);
}

function makeSlot(): Slot {
  const typescript = import.meta.url.endsWith('.ts');
  const worker = new Worker(new URL(typescript ? './pac-worker.ts' : './pac-worker.js', import.meta.url), {
    execArgv: typescript ? ['--import', 'tsx'] : [],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  });
  const slot: Slot = { worker };
  slots.add(slot);
  const failed = () => {
    if (slot.job) finish(slot.job, { error: new PacError(workerErrors.runtime) });
  };
  worker.on('message', (reply: PacWorkerReply | PacDnsRequest) => {
    if (!slot.job || slot.retiring) return;
    if ('hostname' in reply) {
      void answerDns(slot.job, reply);
      return;
    }
    if ('error' in reply) {
      if (reply.error === 'runtime') retire(slot);
      finish(slot.job, { error: new PacError(workerErrors[reply.error]) });
    } else finish(slot.job, reply);
    dispatch();
  });
  worker.once('error', () => {
    retire(slot);
    failed();
  });
  worker.once('exit', () => {
    slots.delete(slot);
    failed();
    dispatch();
  });
  return slot;
}

function dispatch() {
  while (waiting.length) {
    let slot = [...slots].find(slot => !slot.job && !slot.retiring);
    if (!slot && slots.size >= maxWorkers) return;
    const job = waiting.shift()!;
    try {
      const selected = slot ?? makeSlot();
      slot = selected;
      selected.job = job;
      job.slot = selected;
      selected.worker.ref();
      selected.worker.postMessage(job.request);
      job.timer = setTimeout(() => {
        retire(selected);
        finish(job, { error: new PacError(workerErrors.timeout) });
        dispatch();
      }, workerTimeoutMs);
    } catch {
      if (slot) retire(slot);
      finish(job, { error: new PacError(workerErrors.runtime) });
    }
  }
}

function evaluate(request: PacWorkerRequest, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (Buffer.byteLength(request.source, 'utf8') > MAX_PAC_BYTES || !request.source.trim() || request.source.includes('\0')) {
      throw new PacError('Укажите непустой файл PAC в кодировке UTF-8 размером до 256 КиБ.');
    }
    if (waiting.length >= maxWaitingJobs) throw new PacError('Очередь проверки PAC заполнена. Повторите попытку.');

    const job: Job = { request, resolve, reject, detachAbort: () => signal?.removeEventListener('abort', abort) };
    const abort = () => {
      const index = waiting.indexOf(job);
      if (index !== -1) waiting.splice(index, 1);
      if (job.slot) retire(job.slot);
      finish(job, { error: signal?.reason });
      dispatch();
    };

    signal?.addEventListener('abort', abort, { once: true });
    waiting.push(job);
    dispatch();
  });
}

function proxyUrl(kind: string, authority: string): string {
  const invalid = () => new PacError('В маршруте PROXY или HTTPS укажите хост и порт в формате host:port.');
  const parts = /^(\[[\da-f:.]+\]|[^\s\p{Cc}:\/\\?#@%\[\]]+)(?::([0-9]{1,5}))?$/iu.exec(authority);
  if (!parts || (parts[2] && (Number(parts[2]) < 1 || Number(parts[2]) > 65535))) throw invalid();
  let url: URL;
  try { url = new URL(`${kind === 'HTTPS' ? 'https' : 'http'}://${authority}/`); }
  catch { throw invalid(); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const labels = host.replace(/\.$/, '').split('.');
  if (!isIP(host) && (host.length > 254 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) {
    throw invalid();
  }
  if (host.endsWith('.')) url.hostname = host.slice(0, -1);
  return url.origin;
}

export function normalizePacProxyUrl(value: unknown): string {
  const parts = typeof value === 'string' && value.length <= 300
    ? /^(https?):\/\/([^/]+)\/?$/i.exec(value.trim()) : null;
  if (!parts) throw new PacError('Укажите схему, хост и порт доверенного прокси.');
  return proxyUrl(parts[1].toLowerCase() === 'https' ? 'HTTPS' : 'PROXY', parts[2]);
}

function parseRoutes(result: string): PacRoute[] {
  const entries = result.trim().split(';');
  if (entries.length > 1 && !entries.at(-1)?.trim()) entries.pop();
  if (entries.length > 16) throw new PacError('PAC превысил лимит маршрутов (16).');
  return entries.map(entry => {
    const [, directive, authority = ''] = /^(\S+)(?:[ \t]+(.*))?$/.exec(entry.trim()) ?? [];
    if (!directive) throw new PacError('PAC вернул пустой или неверный маршрут.');
    switch (directive.toUpperCase()) {
      case 'DIRECT':
        if (authority) throw new PacError('В маршруте DIRECT нельзя указывать адрес прокси.');
        return { kind: 'direct' };
      case 'PROXY':
      case 'HTTPS':
        return { kind: 'proxy', url: proxyUrl(directive.toUpperCase(), authority) };
      default:
        throw new PacError('PAC вернул неподдерживаемый маршрут. Доступны PROXY, HTTPS и DIRECT.');
    }
  });
}

export function createPacRouteResolver(source: string): PacRouteResolver {
  return async (url, signal) => {
    signal.throwIfAborted();
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PacError('PAC поддерживает адреса HTTP и HTTPS.');
    const address = url.protocol === 'https:' ? `${url.origin}/` : `${url.origin}${url.pathname}${url.search}`;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return parseRoutes(await evaluate({ source, args: [address, host] }, signal));
  };
}

export async function validatePac(source: string, signal?: AbortSignal): Promise<void> {
  await evaluate({ source }, signal);
}
