import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { CATALOG_DOCUMENT_LIMIT, CATALOG_FILE_LIMIT, CATALOG_IMPORT_LIMIT } from '../../shared/catalog.js';
import type { TlsProfile } from '../../shared/types.js';
import { openSitemapStream } from '../checker.js';
import { pacRequestOptions } from '../pac-config.js';
import type { RequestSecrets } from '../request-secrets.js';
import { type Catalog, type CatalogDocument, normalizeSitemapUrl, type SitemapEntry } from './database.js';

interface ImportOptions {
  file?: string;
  signal?: AbortSignal;
  open?: (document: CatalogDocument, profile: TlsProfile, signal: AbortSignal) => Promise<Readable>;
  readSecret?: RequestSecrets['read'];
  fileLimit?: number;
  importLimit?: number;
}

const sitemapNamespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const batchSize = 512;

async function* bytes(stream: Readable, signal: AbortSignal) {
  let total = 0;
  for await (const data of stream) {
    signal.throwIfAborted();
    const chunk = Buffer.from(data);
    total += chunk.length;
    if (total > CATALOG_FILE_LIMIT) throw new Error('Входной файл превышает 256 МиБ.');
    yield chunk;
  }
}

async function unpack(stream: Readable, signal: AbortSignal) {
  const chunks = bytes(stream, signal);
  const heads: Buffer[] = [];
  let size = 0;
  while (size < 2) {
    const next = await chunks.next();
    if (next.done) break;
    heads.push(next.value);
    size += next.value.length;
  }
  const head = Buffer.concat(heads);
  const replay = Readable.from((async function* () {
    try {
      yield head;
      yield* chunks;
    } finally { await chunks.return(undefined); }
  })(), { objectMode: false });
  if (head[0] !== 0x1f || head[1] !== 0x8b) return replay;
  const gzip = createGunzip();
  replay.on('error', error => gzip.destroy(error));
  gzip.on('close', () => replay.destroy());
  return replay.pipe(gzip);
}

function lastmod(value: string) {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return null;
  const date = new Date(text.slice(0, 10));
  return Number.isFinite(Date.parse(text)) && date.toISOString().slice(0, 10) === text.slice(0, 10) ? text : null;
}

async function parseFile(catalog: Catalog, id: number, doc: CatalogDocument,
  input: Readable, signal: AbortSignal, maxBytes: number) {
  const parser = new SaxesParser({ xmlns: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stack: string[] = [];
  const links = new Set<string>();
  let ns = '';
  let current: { loc: string; lastmod: string } | undefined;
  let part: 'loc' | 'lastmod' | undefined;
  let size = 0;
  let tokenEnd = 0;
  function checkTokenLength() {
    if (parser.position - tokenEnd > 1_048_576) throw new Error('Слишком длинный XML-элемент.');
  }
  function markBoundary() {
    checkTokenLength();
    tokenEnd = parser.position;
  }
  const entries: SitemapEntry[] = [];
  parser.on('error', () => { throw new Error('Не удалось разобрать XML sitemap.'); });
  parser.on('doctype', () => { throw new Error('DOCTYPE в sitemap запрещён.'); });
  parser.on('comment', markBoundary);
  parser.on('processinginstruction', markBoundary);
  parser.on('xmldecl', markBoundary);
  parser.on('opentag', tag => {
    markBoundary();
    if (stack.length >= 64) throw new Error('Превышена глубина XML.');
    if (stack.length === 0) {
      ns = tag.uri;
      if ((ns && ns !== sitemapNamespace) || !['sitemapindex', 'urlset'].includes(tag.local)) {
        throw new Error('Ожидается XML с корневым элементом urlset или sitemapindex.');
      }
    }
    stack.push(tag.uri === ns ? tag.local : '');
    if (stack.length === 2 && ((stack[0] === 'urlset' && stack[1] === 'url')
      || (stack[0] === 'sitemapindex' && stack[1] === 'sitemap'))) current = { loc: '', lastmod: '' };
    if (current && stack.length === 3 && (stack[2] === 'loc' || stack[2] === 'lastmod')) part = stack[2];
  });
  const append = (text: string) => {
    markBoundary();
    if (!part || !current || stack.length !== 3) return;
    if (current[part].length <= 4000) current[part] += text.slice(0, 4001 - current[part].length);
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    markBoundary();
    if (stack.length === 3) part = undefined;
    if (stack.length === 2 && current) {
      if (stack[0] === 'sitemapindex') {
        links.add(normalizeSitemapUrl(current.loc));
        if (links.size > CATALOG_DOCUMENT_LIMIT) throw new Error('В индексе больше 1 000 файлов.');
      } else entries.push({ loc: current.loc, lastmod: lastmod(current.lastmod) });
      current = undefined;
    }
    stack.pop();
  });
  const flush = () => {
    while (entries.length) {
      signal.throwIfAborted();
      if (catalog.state(id) !== 'running') throw new Error('Импорт остановлен.');
      catalog.insertEntries(id, doc.id, entries.splice(0, batchSize), size);
    }
  };
  const stream = await unpack(input, signal);
  try {
    for await (const data of stream) {
      signal.throwIfAborted();
      size += data.length;
      if (size > maxBytes) throw new Error('Превышен лимит размера файла или всего импорта после распаковки.');
      const text = decoder.decode(data, { stream: true });
      parser.write(text);
      checkTokenLength();
      if (entries.length >= batchSize) flush();
    }
    parser.write(decoder.decode()).close();
    flush();
    catalog.completeDocument(id, doc.id, size, [...links]);
  } finally { stream.destroy(); input.destroy(); }
}

export async function runImport(catalog: Catalog, id: number, options: ImportOptions = {}) {
  if (!catalog.start(id)) return;
  let current: CatalogDocument | undefined;
  const stop = options.signal ?? new AbortController().signal;
  try {
    const network = pacRequestOptions(catalog.pacSnapshot(id), options.readSecret);
    const open = options.open ?? (async (doc, profile, signal) => {
      if (!catalog.isLocal(doc)) return openSitemapStream(doc.location, profile, signal, network);
      if (!options.file) throw new Error('Файл для импорта отсутствует.');
      return createReadStream(options.file, { signal });
    });
    while (catalog.state(id) === 'running') {
      stop.throwIfAborted();
      current = catalog.document(id);
      if (!current) {
        catalog.publish(id);
        return;
      }
      catalog.resetDocument(id, current.id);
      const limit = Math.min(options.fileLimit ?? CATALOG_FILE_LIMIT,
        (options.importLimit ?? CATALOG_IMPORT_LIMIT) - catalog.previousBytes(id));
      if (limit <= 0) throw new Error('Превышен лимит размера импорта.');
      const signal = AbortSignal.any([stop, AbortSignal.timeout(5 * 60_000)]);
      const input = await open(current, catalog.profile(id), signal);
      try { await parseFile(catalog, id, current, input, signal, limit); }
      finally { input.destroy(); }
    }
  } catch (error) {
    if (!stop.aborted) catalog.fail(id, (error as Error).message, current);
  }
}
