import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

test('shows queued checks separately from the active run and stops the selected queued check', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Очередь проверок', '');
    store.addUrls(id, [{ input: 'example.com/a', line: 1 }, { input: 'example.com/b', line: 2 }]);
    const [a, b] = store.addresses(id);
    const running = store.enqueue(id);
    store.claim();
    const first = store.enqueue(id, [a.id]);
    const second = store.enqueue(id, [b.id]);
    const path = `/api/projects/${id}/runs`;

    const queue = await app.inject(path + '?view=queue');
    expect(queue.json()).toMatchObject([{ id: first.id, status: 'queued' }, { id: second.id, status: 'queued' }]);

    const stopped = await app.inject({ method: 'POST', url: path + `/${first.id}/stop` });
    expect(stopped.json()).toMatchObject({ id: first.id, status: 'cancelled', completed: 0 });
    expect(store.run(running.id, id).status).toBe('running');
    expect((await app.inject(path + '?view=queue')).json()).toMatchObject([{ id: second.id, status: 'queued' }]);
  } finally { await app.close(); store.close(); }
});

test('concurrent requests reuse the same queued URL set and allow a new run when the set changes', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Повтор запуска', '');
    store.addUrls(id, [{ input: 'example.com/a', line: 1 }, { input: 'example.com/b', line: 2 }]);
    const [a, b] = store.addresses(id);
    const running = store.enqueue(id);
    store.claim();
    const request = (ids?: number[]) => app.inject({
      method: 'POST', url: `/api/projects/${id}/runs`, payload: ids ? { ids } : {},
    });
    const replies = await Promise.all([request(), request([b.id, a.id]), request([a.id, b.id, a.id])]);
    expect(replies.every(reply => reply.statusCode === 202)).toBe(true);
    const [first, second, third] = replies.map(reply => reply.json());
    expect(first.id).not.toBe(running.id);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(store.enqueueCatalog(id, [b.url, a.url]).id).toBe(first.id);

    const subset = await request([a.id]);
    expect(subset.json().id).not.toBe(first.id);
    const otherSubset = await request([b.id]);
    expect(otherSubset.json().id).not.toBe(subset.json().id);
    store.editUrl(id, b.id, 'https://example.com/b-new', b.label);
    const revised = await request();
    expect(revised.json().id).not.toBe(first.id);
    expect(store.runs(id)).toHaveLength(5);
  } finally { await app.close(); store.close(); }
});
