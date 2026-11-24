import { gzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import * as sitemap from '../src/server/sitemap.js';
import { createApp } from '../src/server/app.js';

const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://example.com/a?one=1&amp;two=2</loc><image:image><image:loc>https://example.com/image.jpg</image:loc></image:image></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

test('reads uploaded gzip XML and skips extension URLs', async () => {
  const app = createApp({ database: ':memory:' });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Sitemap' } })).json();
    const root = `/api/projects/${project.id}/urls`;
    const payload = { file: gzipSync(xml).toString('base64') };
    const imported = await app.inject({ method: 'POST', url: root + '/sitemap', payload });
    expect(imported.json()).toMatchObject({ added: 2, duplicates: 0, documents: 1 });
    const repeated = await app.inject({ method: 'POST', url: root + '/sitemap', payload });
    expect(repeated.json()).toMatchObject({ added: 0, duplicates: 2 });
    expect((await app.inject(root)).json().map((entry: { url: string }) => entry.url)).toEqual([
      'https://example.com/a?one=1&two=2', 'https://example.com/b',
    ]);
  } finally {
    await app.close();
  }
});

test('recurses through sitemap indexes, handles gzip children and fetches a repeated child once', async () => {
  const first = 'https://example.com/sitemap.xml';
  const child = 'https://example.com/nested.xml.gz';
  const index = `<sitemapindex><sitemap><loc>${child}</loc></sitemap>
    <sitemap><loc>${child}</loc></sitemap></sitemapindex>`;
  const fetched: string[] = [];
  const discovered = await sitemap.readSitemap({ url: first }, async url => {
    fetched.push(url);
    return url === first ? Buffer.from(index) : gzipSync(xml);
  });
  expect(fetched).toEqual([first, child]);
  expect(discovered).toMatchObject({ documents: 2, urls: expect.arrayContaining([
    'https://example.com/a?one=1&two=2', 'https://example.com/b',
  ]) });
});

test('rejects document types, malformed XML and private sitemap sources', async () => {
  for (const data of ['<!DOCTYPE urlset><urlset/>', '<urlset><url>']) {
    await expect(sitemap.readSitemap({ file: Buffer.from(data) })).rejects.toThrow();
  }
  await expect(sitemap.readSitemap({ url: 'http://127.0.0.1/sitemap.xml' })).rejects.toThrow();
});

const syntheticUrl = 'https://example.test/entry';
const root = 'https://example.test/sitemap.xml';
const urls = (count: number) => Buffer.from(`<urlset>${`<url><loc>${syntheticUrl}</loc></url>`.repeat(count)}</urlset>`);
const index = (children: string[]) => Buffer.from(`<sitemapindex>${children.map(url =>
  `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`);

test('reads CDATA in sitemap locations and ignores entries in extension namespaces', async () => {
  const file = Buffer.from(`<map:urlset xmlns:map="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:ext="urn:example">
    <map:url><map:loc><![CDATA[  https://example.test/a?x=1&y=2  ]]></map:loc></map:url>
    <ext:url><map:loc>https://example.test/extension-entry</map:loc></ext:url>
    <map:url><ext:loc>https://example.test/extension-location</ext:loc></map:url>
  </map:urlset>`);
  await expect(sitemap.readSitemap({ file })).resolves.toEqual({ urls: ['https://example.test/a?x=1&y=2'], documents: 1 });
});

test.each([
  ['wrong root', Buffer.from('<other/>'), /urlset или sitemapindex/],
  ['wrong namespace', Buffer.from('<urlset xmlns="urn:example"/>'), /urlset или sitemapindex/],
  ['invalid UTF-8', Buffer.concat([Buffer.from('<urlset>'), Buffer.from([0xc3, 0x28]), Buffer.from('</urlset>')]), /UTF-8/i],
  ['truncated gzip', gzipSync('<urlset/>').subarray(0, 8), /распаковать gzip/],
])('rejects a sitemap with %s', async (_name, file, error) => {
  await expect(sitemap.readSitemap({ file })).rejects.toThrow(error);
});

test('enforces the 50,000-entry limit within a sitemap and across an index', async () => {
  const atLimit = await sitemap.readSitemap({ file: urls(50_000) });
  expect(atLimit.urls).toHaveLength(50_000);
  await expect(sitemap.readSitemap({ file: urls(50_001) })).rejects.toThrow(/В sitemap больше 50 000/);

  const left = 'https://example.test/left.xml';
  const right = 'https://example.test/right.xml';
  const half = urls(25_000);
  const run = (last: Buffer) => sitemap.readSitemap({ url: root }, async url => {
    if (url === root) return index([left, right]);
    return url === left ? half : last;
  });
  const combined = await run(half);
  expect(combined.documents).toBe(3);
  expect(combined.urls).toHaveLength(50_000);
  await expect(run(urls(25_001))).rejects.toThrow(/В наборе sitemap больше 50 000/);
});

test('counts the root in the 100-document limit and rejects extra children before fetching them', async () => {
  const children = Array.from({ length: 100 }, (_, number) => `https://example.test/child-${number}.xml`);
  const include = async (links: string[], requests: string[]) => sitemap.readSitemap({ url: root }, async url => {
    requests.push(url);
    return url === root ? index(links) : Buffer.from('<urlset/>');
  });
  const valid: string[] = [];
  const distinct = children.slice(0, 99);
  await expect(include([...distinct, root, distinct[0]], valid)).resolves.toEqual({ urls: [], documents: 100 });
  expect(valid).toEqual([root, ...distinct]);
  const excessive: string[] = [];
  await expect(include(children, excessive)).rejects.toThrow(/больше 100 файлов/);
  expect(excessive).toEqual([root]);
});

test('enforces the 8 MiB limit before and after gzip decompression', async () => {
  const max = 8 * 1024 * 1024;
  const plain = Buffer.alloc(max, ' ');
  plain.write('<urlset/>');
  const large = Buffer.concat([plain, Buffer.from(' ')]);
  await expect(sitemap.readSitemap({ file: plain })).resolves.toEqual({ urls: [], documents: 1 });
  await expect(sitemap.readSitemap({ file: large })).rejects.toThrow(/Sitemap превышает 8 МиБ/);
  await expect(sitemap.readSitemap({ file: gzipSync(plain) })).resolves.toEqual({ urls: [], documents: 1 });
  await expect(sitemap.readSitemap({ file: gzipSync(large) })).rejects.toThrow(/распакованный sitemap превышает 8 МиБ/);
});

test('includes the index in the cumulative uncompressed byte limit', async () => {
  const children = [1, 2, 3, 4].map(number => `https://example.test/part-${number}.xml`);
  const rootData = index(children);
  const regular = Buffer.alloc(8 * 1024 * 1024, ' ');
  regular.write('<urlset/>');
  const lastAtLimit = regular.subarray(0, regular.length - rootData.length);
  const run = (last: Buffer) => sitemap.readSitemap({ url: root }, async url => {
    if (url === root) return rootData;
    return url === children[3] ? last : regular;
  });
  await expect(run(lastAtLimit)).resolves.toEqual({ urls: [], documents: 5 });
  await expect(run(Buffer.concat([lastAtLimit, Buffer.from(' ')]))).rejects.toThrow(/Суммарный размер sitemap превышает 32 МиБ/);
}, 20_000);

test('stops before downloading the next child after the total deadline', async () => {
  const child = 'https://example.test/child.xml';
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const downloaded: string[] = [];
  try {
    await expect(sitemap.readSitemap({ url: root }, async url => {
      downloaded.push(url);
      now.mockReturnValue(45_000);
      return index([child]);
    })).rejects.toThrow(/Истекло время импорта/);
    expect(downloaded).toEqual([root]);
  } finally { now.mockRestore(); }
});
