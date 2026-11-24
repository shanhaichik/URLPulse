import { expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { startBackground } from '../src/server/worker.js';

const settings = { schedule: null, notify: 'off', email: null } as const;

test('defaults to six and accepts only project limits from 1 to 24', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Лимит проверок', '');
    const other = store.createProject('Новый проект', '');
    const root = `/api/projects/${project.id}`;
    const update = (value?: unknown) => app.inject({ method: 'PATCH', url: `${root}/settings`,
      payload: { ...settings, checkConcurrency: value } });
    expect((await app.inject(`${root}?view=summary`)).json().project).toMatchObject({ checkConcurrency: 6 });
    for (const input of [0, 25, 2.5, '3', null]) expect((await update(input)).statusCode).toBe(400);
    expect((await update(1)).json()).toMatchObject({ checkConcurrency: 1 });
    expect((await update(24)).json()).toMatchObject({ checkConcurrency: 24 });
    expect((await update()).json()).toMatchObject({ checkConcurrency: 24 });
    expect(store.project(other.id).checkConcurrency).toBe(6);
  } finally { await app.close(); store.close(); }
});

test('honors the project limit at dispatch and preserves it while a run is executing', async () => {
  const store = new Store(':memory:');
  const { id } = store.createProject('Очередь с лимитами', '');
  store.addUrls(id, ['first', 'next'].flatMap((phase, batch) => Array.from({ length: 6 }, (_, index) => ({
    input: `https://example.test/${phase}/${index}`, line: batch * 6 + index + 1,
  }))));
  const addresses = store.addresses(id);
  const first = store.enqueue(id, addresses.filter(address => address.url.includes('/first/')).map(address => address.id));
  const next = store.enqueue(id, addresses.filter(address => address.url.includes('/next/')).map(address => address.id));
  store.saveSettings(id, { ...settings, checkConcurrency: 2 });
  const firstChecks: (() => void)[] = [];
  const nextChecks: (() => void)[] = [];
  let finishing = false;
  const close = startBackground(store, { check: async url => {
    const waiting = url.includes('/first/') ? firstChecks : nextChecks;
    if (!finishing) await new Promise<void>(resolve => waiting.push(resolve));
    return { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: url, redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null };
  } });
  try {
    await vi.waitFor(() => expect(firstChecks).toHaveLength(2));
    store.saveSettings(id, { ...settings, checkConcurrency: 4 });
    firstChecks.shift()!();
    await vi.waitFor(() => expect(store.run(first.id, id).completed).toBe(1));
    expect(firstChecks).toHaveLength(2);
    while (store.run(first.id, id).completed < 6) {
      const completed = store.run(first.id, id).completed;
      firstChecks.splice(0).forEach(resume => resume());
      await vi.waitFor(() => expect(store.run(first.id, id).completed).toBeGreaterThan(completed));
    }
    await vi.waitFor(() => expect(nextChecks).toHaveLength(4), { timeout: 3000 });
    expect(store.run(next.id, id).status).toBe('running');
  } finally {
    finishing = true;
    firstChecks.splice(0).forEach(resume => resume());
    nextChecks.splice(0).forEach(resume => resume());
    await close();
    store.close();
  }
});
