import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ownDatabase } from '../src/server/database-owner.js';
import { Store } from '../src/server/store.js';

test('refuses another process before recovery and releases the lock after a crash', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-owner-test-'));
  const file = join(directory, 'pulse.sqlite3');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { ownDatabase } from './src/server/database-owner.ts';
    import { Store } from './src/server/store.ts';
    const ownership = ownDatabase(process.argv[1]);
    const store = new Store(ownership.path);
    const project = store.createProject('Владелец', '');
    store.addUrls(project.id, [{ line: 1, input: 'example.com' }]);
    const run = store.enqueue(project.id);
    store.claim();
    process.stdout.write(JSON.stringify({ projectId: project.id, runId: run.id }) + '\\n');
    process.stdin.resume();
  `, file], { stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(child, 'exit');
  try {
    let line = '';
    for await (const chunk of child.stdout) {
      line += chunk.toString();
      if (line.includes('\n')) break;
    }
    const { projectId, runId } = JSON.parse(line);
    expect(() => ownDatabase(file)).toThrow('уже открыта в другой копии');
    const reader = new Store(file, Date.now, false, false, true);
    try { expect(reader.run(runId, projectId).status).toBe('running'); }
    finally { reader.close(); }
    child.kill('SIGKILL');
    await closed;
    const ownership = ownDatabase(file);
    try {
      const reopened = new Store(ownership.path);
      try { expect(reopened.run(runId, projectId).status).toBe('queued'); }
      finally { reopened.close(); }
    } finally { ownership.release(); }
    ownDatabase(file).release();
    const alias = join(directory, 'hard-link.sqlite3');
    linkSync(file, alias);
    expect(() => ownDatabase(alias)).toThrow('жёсткие ссылки');
  } finally {
    child.kill('SIGKILL');
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
}, 12_000);
