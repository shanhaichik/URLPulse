import { expect, test } from 'vitest';
import { desktopRequest } from '../src/desktop/contracts.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

test('updates old notifications through the page cursor and preserves the list response', async () => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const { id } = store.createProject('Уведомления проекта', '');
    store.addUrls(id, [{ input: 'example.com', line: 1 }]);
    store.saveSettings(id, { schedule: null, notify: 'all', email: 'operator@example.com' });
    for (let i = 0; i < 101; i++) {
      const run = store.enqueue(id);
      const [item] = store.claim()!.items;
      store.saveResult(item.id, {
        status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url, redirects: 0,
        contentType: null, contentLength: null, errorKind: null, error: null,
      });
      store.finish(run.id);
    }
    const path = '/api/notifications';
    const legacy = (await app.inject(path)).json();
    expect(legacy).toHaveLength(100);
    const first = (await app.inject(path + '?view=page')).json();
    expect(first).toEqual({ items: legacy, nextBefore: 2 });

    const request = desktopRequest({ method: 'GET', path: path + '?view=page&before=2' });
    const readPage = async () => (await app.inject(request.path)).json();
    const oldest = (await app.inject(path + '?before=2')).json();
    expect(oldest).toMatchObject([{ runId: 1, delivery: 'pending' }]);
    expect(await readPage()).toEqual({ items: oldest, nextBefore: null });

    store.finishEmail(store.claimEmail()!, null, false);
    expect(await readPage()).toMatchObject({ items: [{ runId: 1, delivery: 'sent' }] });
    store.deleteRun(id, 1);
    expect(await readPage()).toEqual({ items: [], nextBefore: null });
    expect((await app.inject(path + '?view=page')).json().nextBefore).toBeNull();
  } finally {
    await app.close();
    store.close();
  }
});
