import { expect, test } from 'vitest';
import { desktopRequest, exportScope } from '../src/desktop/contracts.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

test('organizes a URL into multiple groups and filters without changing the project worklist', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  const project = store.createProject('Project', '').id;
  const other = store.createProject('Other', '').id;
  store.addUrls(project, ['one', 'two', 'three'].map((path, index) => ({ input: `example.com/${path}`, line: index + 1 })));
  store.addUrls(other, [{ input: 'example.net', line: 1 }]);
  const [one, two, three] = store.addresses(project);
  const [foreign] = store.addresses(other);
  const path = `/api/projects/${project}`;
  const groups = path + '/groups';
  const add = (endpoint: string, name: string) => app.inject({ method: 'POST', url: endpoint, payload: { name } });
  const members = (group: number, operation: 'add' | 'remove', ids: number[]) => app.inject({
    method: 'PATCH', url: `${groups}/${group}/members`, payload: { operation, ids },
  });
  try {
    const created = await add(groups, 'Критичные');
    expect(created.statusCode).toBe(201);
    const first = created.json().id;
    const second = (await add(groups, 'Оплата')).json().id;
    const outside = (await add(`/api/projects/${other}/groups`, 'Скрытые')).json().id;
    expect((await add(groups, 'КРИТИЧНЫЕ')).statusCode).toBe(409);
    expect((await members(first, 'add', [one.id, two.id])).json()).toEqual({ changed: 2 });
    expect((await members(second, 'add', [one.id, three.id])).json()).toEqual({ changed: 2 });
    expect((await members(second, 'add', [one.id])).json()).toEqual({ changed: 0 });
    expect((await members(first, 'add', [three.id, foreign.id])).statusCode).toBe(409);
    expect((await members(outside, 'add', [one.id])).statusCode).toBe(404);
    expect((await app.inject(`${path}/urls/page?group=${first}&sort=url&direction=desc`)).json().items.map((row: { id: number }) => row.id))
      .toEqual([two.id, one.id]);
    expect((await app.inject(`${path}/urls/selection?group=${second}&q=three`)).json()).toEqual({ ids: [three.id], exceeded: false });
    expect((await members(first, 'remove', [one.id])).json()).toEqual({ changed: 1 });
    const renamed = await app.inject({ method: 'PATCH', url: `${groups}/${second}`, payload: { name: 'Checkout' } });
    expect(renamed.json()).toMatchObject({ id: second, name: 'Checkout', count: 2 });
    expect((await app.inject({ method: 'DELETE', url: `${groups}/${first}` })).statusCode).toBe(200);
    expect((await app.inject(groups)).json()).toEqual([{ id: second, name: 'Checkout', count: 2 }]);
    expect(store.addresses(project)).toHaveLength(3);
  } finally { await app.close(); store.close(); }
});

test('exports only group runs, preserves run membership after regrouping and exposes a single run through IPC', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  const project = store.createProject('Exports', '').id;
  store.addUrls(project, [{ input: 'example.com/a', line: 1 }, { input: 'example.com/b', line: 2 }]);
  const [first, second] = store.addresses(project);
  const root = `/api/projects/${project}`;
  const complete = () => {
    const work = store.claim()!;
    for (const item of work.items) store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 1,
      finalUrl: item.url, redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });
    store.finish(work.id);
  };
  try {
    const created = await app.inject({ method: 'POST', url: `${root}/groups`, payload: { name: 'Оплата' } });
    expect(created.statusCode).toBe(201);
    const groupId = created.json().id;
    const group = `${root}/groups/${groupId}`;
    const start = () => app.inject({ method: 'POST', url: `${group}/runs` });
    const update = (operation: 'add' | 'remove', ids: number[]) => app.inject({ method: 'PATCH', url: `${group}/members`, payload: { operation, ids } });
    expect((await start()).statusCode).toBe(400);
    await update('add', [first.id]);
    const unrelated = store.enqueue(project, [first.id]);
    const started = await start();
    expect(started.statusCode).toBe(202);
    const runId = started.json().id;
    expect(runId).not.toBe(unrelated.id);
    expect((await start()).json()).toEqual({ id: runId });
    await update('remove', [first.id]);
    await update('add', [second.id]);
    complete();
    complete();
    const next = (await start()).json().id;
    complete();
    expect((await app.inject(`${group}/runs`)).json().items.map((row: { id: number }) => row.id)).toEqual([next, runId]);
    expect((await app.inject(`${group}/export?format=json`)).json().map((row: { runId: number; url: string }) => [row.runId, row.url]))
      .toEqual([[next, second.url], [runId, first.url]]);
    expect((await app.inject(`${root}/runs/${runId}/export?format=json`)).json()).toMatchObject([{ runId, url: first.url }]);
    expect(exportScope(group)).toEqual({ projectId: project, groupId });
    expect(desktopRequest({ method: 'POST', path: `${group}/runs` }).path).toBe(`${group}/runs`);
    const stopped = (await start()).json().id;
    await app.inject({ method: 'POST', url: `${root}/runs/${stopped}/stop` });
    await update('remove', [second.id]);
    const restart = (await app.inject({ method: 'POST', url: `${root}/runs/${stopped}/restart` })).json().id;
    complete();
    expect((await app.inject(`${group}/export?format=json`)).json()[0]).toMatchObject({ runId: restart, url: second.url });
    await app.inject({ method: 'DELETE', url: group });
    expect((await app.inject(`${root}/runs/${runId}`)).json().run).toMatchObject({ group: { id: groupId, name: 'Оплата' } });
  } finally { await app.close(); store.close(); }
});
