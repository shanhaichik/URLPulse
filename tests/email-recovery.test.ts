import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { deliverPending } from '../src/server/worker.js';

function queueEmail(store: Store) {
  const { id } = store.createProject('Доставка результата', '');
  store.saveSettings(id, { schedule: null, notify: 'all', email: 'fixture@example.invalid' });
  store.addUrls(id, [{ input: 'https://example.invalid/', line: 1 }]);
  const run = store.enqueue(id);
  const [item] = store.claim()!.items;
  store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url,
    redirects: 0, contentType: null, contentLength: null, errorKind: null, error: null });
  store.finish(run.id, true);
}

it('preserves the claimed attempt and prevents automatic resend after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-mail-recovery-'));
  const file = join(directory, 'pulse.sqlite3');
  try {
    const store = new Store(file);
    let claimed;
    try {
      queueEmail(store);
      claimed = store.claimEmail()!;
      expect(claimed.attempts).toBe(1);
    } finally {
      store.close();
    }
    const restarted = new Store(file);
    try {
      expect(restarted.notifications()).toMatchObject([{ delivery: 'uncertain', attempts: 1 }]);
      let sent = 0;
      await deliverPending(restarted, async () => { sent++; });
      expect(sent).toBe(0);
      restarted.finishEmail(claimed!, null, false);
      expect(restarted.notifications()).toMatchObject([{ delivery: 'uncertain', attempts: 1 }]);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('upgrades earlier databases with pending mail preserved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-mail-legacy-'));
  const file = join(directory, 'pulse.sqlite3');
  try {
    const initial = new Store(file);
    try { queueEmail(initial); } finally { initial.close(); }
    const legacy = new DatabaseSync(file);
    try { legacy.exec('ALTER TABLE notifications DROP COLUMN email_message_id'); }
    finally { legacy.close(); }
    const migrated = new Store(file);
    try { expect(migrated.claimEmail()).toMatchObject({ attempts: 1, messageId: expect.any(String) }); }
    finally { migrated.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('retains one Message-ID and increments the visible attempts on a confirmed SMTP retry', async () => {
  let now = Date.UTC(2026, 10, 24);
  const store = new Store(':memory:', () => now);
  try {
    queueEmail(store);
    let firstMessageId: string | undefined;
    await deliverPending(store, async job => {
      firstMessageId = job.messageId;
      throw Object.assign(new Error('Temporary SMTP failure'), { responseCode: 451 });
    });
    expect(firstMessageId).toMatch(/^<[0-9a-f-]+@pulse-url\.invalid>$/);
    now += 60_000;
    await deliverPending(store, async job => {
      expect(job.messageId).toBe(firstMessageId);
    });
    expect(store.notifications()).toMatchObject([{ delivery: 'sent', attempts: 2 }]);
  } finally {
    store.close();
  }
});
