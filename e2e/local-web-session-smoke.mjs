import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium, expect } from 'playwright/test';
import { createApp } from '../dist/server/app.js';
import { webAccessKey } from '../dist/server/web-access.js';

const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const { port } = reservation.address();
await new Promise((done, fail) => reservation.close(error => error ? fail(error) : done()));
const origin = `http://127.0.0.1:${port}`;
const key = webAccessKey();
const api = createApp({ origin, webAccessKey: key, staticRoot: resolve('dist/client') });
let browser;
try {
  await api.listen({ port, host: '127.0.0.1' });
  browser = await chromium.launch({ channel: process.env.PULSE_E2E_BROWSER_CHANNEL });
  const context = await browser.newContext();
  const page = await context.newPage();
  const project = await page.request.get(origin + '/api/projects');
  assert.equal(project.status(), 401);

  await page.goto(origin + '/#access=' + key);
  await expect(page.getByRole('button', { name: 'Новый проект', exact: true }).first()).toBeVisible();
  assert.equal(new URL(page.url()).hash, '');
  const [cookie] = await context.cookies(origin + '/api/projects');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'Strict');
  assert.equal(cookie.path, '/api');
  assert.notEqual(cookie.value, key);
  assert.equal((await page.request.get(origin + '/api/projects')).status(), 200);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Новый проект', exact: true }).first()).toBeVisible();
  const created = await page.request.post(origin + '/api/projects', {
    headers: { Origin: origin }, data: { name: 'Веб-сессия' },
  });
  assert.equal(created.status(), 201);
  const path = '/api/projects/' + (await created.json()).id + '/export?format=json';
  const downloadReady = page.waitForEvent('download');
  await page.evaluate(path => {
    const link = document.createElement('a');
    link.href = path;
    link.click();
  }, path);
  const download = await downloadReady;
  assert.match(download.suggestedFilename(), / - Веб-сессия\.json$/);
  assert.equal(await download.failure(), null);
  console.log('Browser session, reload and protected streamed download passed.');
} finally {
  await browser?.close();
  await api.close();
}
