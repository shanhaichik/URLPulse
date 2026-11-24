import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { parentPort } from 'node:worker_threads';
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten';
import { pacHelpers } from './pac-helpers.js';
import type { PacDnsRequest, PacWorkerReply, PacWorkerRequest } from './pac.js';

const maxDnsLookups = 8;
const maxResultBytes = 4_096;
const scriptTimeMs = 300;
const dnsTimeoutMs = 250;

const port = parentPort!;
const quickJs = await getQuickJS();

function stringLength(context: QuickJSContext, value: QuickJSHandle) {
  // The caller has checked this is a primitive string, so reading length cannot invoke guest code.
  using length = context.getProp(value, 'length');
  return context.getNumber(length);
}

function readString(context: QuickJSContext, value: QuickJSHandle, length: number) {
  const result = context.getString(value);
  // QuickJS bindings may truncate a C string at NUL, which must never change a PAC decision.
  return result.length === length ? result : undefined;
}

function localIp() {
  return Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)
    ?.address ?? '127.0.0.1';
}

function resolveIPv4(hostname: string): string | null {
  // Only the worker waits here. The parent uses a cancellable DNS resolver and never blocks.
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT + 16);
  const state = new Int32Array(buffer, 0, 1);
  port.postMessage({ hostname, buffer } satisfies PacDnsRequest);
  if (Atomics.wait(state, 0, 0, dnsTimeoutMs) === 'timed-out' || Atomics.load(state, 0) !== 2) return null;
  return Buffer.from(buffer, state.byteLength).toString('ascii').replace(/\0+$/, '');
}

function evaluate({ source, args }: PacWorkerRequest): PacWorkerReply {
  let dnsExceeded = false;
  const dnsCache = new Map<string, string | null>();
  let timedOut = false;
  let deadline = 0;
  using runtime = quickJs.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => timedOut ||= performance.now() > deadline);

  using context = runtime.newContext();
  using dnsResolve = context.newFunction('dnsResolve', host => {
    if (!host || context.typeof(host) !== 'string') return context.null;
    const length = stringLength(context, host);
    if (length > 254) return context.null;
    const input = readString(context, host, length);
    if (input && isIPv4(input)) return context.newString(input);
    if (!args || !input || !input.replace(/\.$/, '').split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return context.null;

    const hostname = input.toLowerCase().replace(/\.$/, '');
    if (!dnsCache.has(hostname)) {
      if (dnsCache.size >= maxDnsLookups) {
        dnsExceeded = true;
        return context.null;
      }
      const started = performance.now();
      dnsCache.set(hostname, resolveIPv4(hostname + '.'));
      deadline += performance.now() - started;
    }
    const address = dnsCache.get(hostname);
    return address ? context.newString(address) : context.null;
  });
  let ip: string | undefined;
  using myIpAddress = context.newFunction('myIpAddress', () => context.newString(ip ??= localIp()));
  context.setProp(context.global, 'dnsResolve', dnsResolve);
  context.setProp(context.global, 'myIpAddress', myIpAddress);

  deadline = performance.now() + scriptTimeMs;
  using helpers = context.evalCode(pacHelpers, 'pac-helpers.js', { type: 'global' });
  if (helpers.error) return { error: 'runtime' };
  using loaded = context.evalCode(source, 'proxy.pac', { type: 'global' });
  if (timedOut) return { error: 'timeout' };
  if (dnsExceeded) return { error: 'dns' };
  if (loaded.error) return { error: 'load' };

  using entry = context.evalCode('typeof FindProxyForURL === "function"', 'proxy.pac', { type: 'global' });
  if (entry.error || !context.eq(entry.value, context.true)) return { error: timedOut ? 'timeout' : 'entry' };
  if (dnsExceeded) return { error: 'dns' };
  if (!args) return { value: '' };

  const invocation = `FindProxyForURL(${JSON.stringify(args[0])}, ${JSON.stringify(args[1])})`;
  using result = context.evalCode(invocation, 'proxy.pac', { type: 'global' });
  if (timedOut) return { error: 'timeout' };
  if (dnsExceeded) return { error: 'dns' };
  if (result.error) return { error: 'execute' };
  if (context.typeof(result.value) !== 'string') return { error: 'type' };
  const length = stringLength(context, result.value);
  if (length > maxResultBytes) return { error: 'size' };
  const value = readString(context, result.value, length);
  if (value === undefined) return { error: 'route' };
  if (Buffer.byteLength(value, 'utf8') > maxResultBytes) return { error: 'size' };
  return { value };
}

port.on('message', (request: PacWorkerRequest) => {
  try { port.postMessage(evaluate(request)); }
  catch { port.postMessage({ error: 'runtime' } satisfies PacWorkerReply); }
});
