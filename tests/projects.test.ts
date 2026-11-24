import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as application from '../src/server/app.js';

describe('project API', () => {
  let app: FastifyInstance | undefined;
  let url: string;

  beforeEach(async () => {
    expect(application).toHaveProperty('createApp');
    app = application.createApp({ database: ':memory:' });
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Основной' } });
    expect(created.statusCode).toBe(201);
    url = `/api/projects/${created.json().id}`;
  });
  afterEach(async () => { await app?.close(); });

  test('reports invalid and repeated input on the original lines', async () => {
    const added = await app!.inject({
      method: 'POST', url: url + '/urls',
      payload: { input: 'example.com\n\nftp://example.com\nhttps://example.com/#top\nexample.org' },
    });
    expect(added.json()).toMatchObject({
      added: 2, duplicates: 1, issues: [{ line: 3, kind: 'invalid' }, { line: 4, kind: 'duplicate' }],
    });
    expect((await app!.inject(url + '/urls')).json()).toMatchObject([
      { url: 'https://example.com/', latest: null },
      { url: 'https://example.org/', latest: null },
    ]);
  });

  test('sorts matching addresses and applies bulk deletion only to the current project', async () => {
    await app!.inject({ method: 'POST', url: url + '/urls', payload: { input: 'example.com\nexample.org\niana.org' } });
    const filtered = (await app!.inject(url + '/urls?q=example&sort=url&direction=desc')).json();
    expect(filtered.map((row: { url: string }) => row.url)).toEqual(['https://example.org/', 'https://example.com/']);
    const other = (await app!.inject({
      method: 'POST', url: '/api/projects', payload: { name: 'Другой' },
    })).json();
    const badDelete = await app!.inject({
      method: 'POST', url: `/api/projects/${other.id}/urls/delete`, payload: { ids: [filtered[0].id] },
    });
    expect(badDelete.statusCode).toBe(409);
    expect((await app!.inject({
      method: 'POST', url: url + '/urls/delete', payload: { ids: [filtered[0].id, filtered[1].id] },
    })).json()).toEqual({ deleted: 2 });
    expect((await app!.inject(url + '/urls')).json()).toHaveLength(1);
  });
});

test('preserves leading blank lines in import diagnostics', async () => {
  const app = application.createApp({ database: ':memory:' });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Строки' } })).json();
    const response = await app.inject({
      method: 'POST', url: `/api/projects/${project.id}/urls`, payload: { input: '\n\nftp://example.com' },
    });
    expect(response.json()).toMatchObject({ added: 0, issues: [{ line: 3, kind: 'invalid' }] });
  } finally {
    await app.close();
  }
});

test('reports a URL that exceeds the supported length after percent encoding', async () => {
  const app = application.createApp({ database: ':memory:' });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Длина URL' } })).json();
    const response = await app.inject({
      method: 'POST', url: `/api/projects/${project.id}/urls`,
      payload: { input: 'https://example.com/' + 'я'.repeat(400) },
    });
    expect(response.json()).toMatchObject({ added: 0, issues: [{ line: 1, kind: 'invalid' }] });
  } finally {
    await app.close();
  }
});

test('serves bounded worklist pages and filter selection through the API', async () => {
  const app = application.createApp({ database: ':memory:' });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Страницы' } })).json();
    const root = `/api/projects/${project.id}`;
    const urls = Array.from({ length: 32 }, (_, i) => 'https://example.com/page/' + String(i).padStart(2, '0'));
    await app.inject({ method: 'POST', url: root + '/urls', payload: { input: urls.join('\n') } });
    await app.inject({ method: 'POST', url: root + '/urls', payload: { input: 'https://example.org/', label: 'Ёлка' } });
    const page = await app.inject(root + '/urls/page?q=example.com&status=unchecked&direction=desc&page=2');
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ total: 32, page: 2, items: urls.slice(0, 7).reverse().map(url => ({ url })) });
    expect((await app.inject(root + '/urls/page?q=ёлка')).json()).toMatchObject({ total: 1, items: [{ label: 'Ёлка' }] });
    expect((await app.inject(root + '/urls/selection?q=ёлка')).json().ids).toHaveLength(1);
    const summary = (await app.inject(root + '?view=summary')).json();
    expect(summary).toMatchObject({ summary: { total: 33, unchecked: 33 } });
    expect(summary).not.toHaveProperty('addresses');
  } finally { await app.close(); }
});

test('keeps the existing numeric ordering for a narrow filter in a large working list', async () => {
  const app = application.createApp({ database: ':memory:' });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Большой список и сортировка' } })).json();
    const root = `/api/projects/${project.id}/urls`;
    await app.inject({ method: 'POST', url: root, payload: { input: 'example.com/fixed/2\nexample.com/fixed/10' } });
    const original = (await app.inject(root + '/page?q=%2Ffixed')).json();
    for (let batch = 0; batch < 5; batch++) {
      const input = Array.from({ length: 1000 }, (_, i) => `https://example.com/other/${batch}-${i}`).join('\n');
      const imported = await app.inject({ method: 'POST', url: root, payload: { input } });
      expect(imported.json().added).toBe(1000);
    }
    const filtered = (await app.inject(root + '/page?q=%2Ffixed')).json();
    expect(filtered).toEqual(original);
    expect(filtered.items.map((entry: { url: string }) => entry.url)).toEqual([
      'https://example.com/fixed/2', 'https://example.com/fixed/10',
    ]);
    expect((await app.inject(root + '/selection')).json()).toEqual({ ids: [], exceeded: true });
  } finally { await app.close(); }
});
