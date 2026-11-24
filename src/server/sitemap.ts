import { gunzipSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { downloadPublicFile, normalizeUrl } from './checker.js';

export const MAX_SITEMAP_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENTS = 100;
const MAX_ENTRIES = 50_000;
const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

type Source = { file: Buffer } | { url: string };
type Download = (url: string, maxBytes: number, timeoutMs: number) => Promise<Buffer>;

function parseDocument(xml: string) {
  const parser = new SaxesParser({ xmlns: true });
  const locations: string[] = [];
  const stack: { name: string; namespace: string }[] = [];
  let kind: 'sitemapindex' | 'urlset' | undefined;
  let capture: string | undefined;

  parser.on('doctype', () => { throw new Error('Объявления DOCTYPE в sitemap запрещены.'); });
  parser.on('error', () => { throw new Error('Не удалось разобрать XML sitemap.'); });
  parser.on('opentag', tag => {
    stack.push({ name: tag.local, namespace: tag.uri });
    if (stack.length === 1) {
      if ((tag.uri && tag.uri !== SITEMAP_NAMESPACE) || (tag.local !== 'urlset' && tag.local !== 'sitemapindex')) {
        throw new Error('Ожидается sitemap с корневым элементом urlset или sitemapindex.');
      }
      kind = tag.local;
    }
    if (stack.length === 3 && tag.local === 'loc'
      && stack[1].name === (kind === 'urlset' ? 'url' : 'sitemap')
      && stack.every(element => element.namespace === stack[0].namespace)) {
      capture = '';
    }
  });
  const append = (text: string) => {
    if (capture !== undefined && stack.length === 3) capture += text;
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    if (stack.length === 3 && capture !== undefined) {
      locations.push(capture.trim());
      if (locations.length > MAX_ENTRIES) throw new Error('В sitemap больше 50 000 записей.');
      capture = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  return { kind, locations };
}

function unpack(buffer: Buffer) {
  if (buffer.length > MAX_SITEMAP_BYTES) throw new Error('Sitemap превышает 8 МиБ.');
  if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) return buffer;
  try {
    return gunzipSync(buffer, { maxOutputLength: MAX_SITEMAP_BYTES });
  } catch {
    throw new Error('Не удалось распаковать gzip или распакованный sitemap превышает 8 МиБ.');
  }
}

function sitemapUrl(value: string) {
  if (!/^https?:\/\//i.test(value)) throw new Error('Укажите полный HTTP(S) URL sitemap.');
  return normalizeUrl(value);
}

export async function readSitemap(source: Source, download: Download = downloadPublicFile) {
  const files: Source[] = ['url' in source ? { url: sitemapUrl(source.url) } : source];
  const visited = new Set(files.flatMap(file => 'url' in file ? [file.url] : []));
  const deadline = performance.now() + 45_000;
  const urls: string[] = [];
  let documents = 0;
  let bytes = 0;
  for (const file of files) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('Истекло время импорта sitemap.');
    const data = unpack('file' in file ? file.file : await download(file.url, MAX_SITEMAP_BYTES,
      Math.min(10_000, remaining)));
    bytes += data.length;
    if (bytes > MAX_TOTAL_BYTES) throw new Error('Суммарный размер sitemap превышает 32 МиБ.');
    const document = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(data));
    documents++;
    if (document.kind === 'urlset') {
      if (urls.length + document.locations.length > MAX_ENTRIES) {
        throw new Error('В наборе sitemap больше 50 000 записей.');
      }
      urls.push(...document.locations);
      continue;
    }
    for (const location of document.locations) {
      const url = sitemapUrl(location);
      if (visited.has(url)) continue;
      if (files.length >= MAX_DOCUMENTS) throw new Error('Индекс содержит больше 100 файлов sitemap.');
      visited.add(url);
      files.push({ url });
    }
  }
  return { urls, documents };
}
