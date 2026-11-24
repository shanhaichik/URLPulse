import { expect, test, type Page } from './fixtures.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

test('saves a project concurrency limit and resets it to six', async ({ page, request }) => {
  const { id } = await (await request.post('/api/projects', { data: { name: 'Число одновременных проверок' } })).json();
  await page.goto(`/?project=${id}`);
  const settings = page.getByRole('button', { name: 'Настройки', exact: true });
  await settings.click();
  const concurrency = page.getByRole('spinbutton', { name: 'Одновременных проверок' });
  const save = page.getByRole('button', { name: 'Сохранить настройки' });
  await expect(concurrency).toHaveValue('6');
  await concurrency.fill('12');
  await save.click();
  await expect(page.getByText('Настройки сохранены', { exact: true })).toBeVisible();
  await page.reload();
  await settings.click();
  await expect(concurrency).toHaveValue('12');
  await page.getByRole('button', { name: 'Сбросить до 6' }).click();
  await expect(concurrency).toHaveValue('6');
  await save.click();
  await expect(page.getByText('Настройки сохранены', { exact: true })).toBeVisible();
  expect((await (await request.get(`/api/projects/${id}?view=summary`)).json()).project.checkConcurrency).toBe(6);
});

async function routeReads(page: Page, app: ReturnType<typeof createApp>) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const result = await app.inject(url.pathname + url.search);
    await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
  });
}

async function closeRoutedApp(page: Page, app: ReturnType<typeof createApp>, store: Store) {
  try {
    // Polling requests can still be in flight after the last UI assertion.
    await page.unrouteAll({ behavior: 'wait' });
  } finally {
    try { await app.close(); }
    finally { store.close(); }
  }
}

test('keeps edits made during a project save as an unsaved draft', async ({ page, request }) => {
  const { id } = await (await request.post('/api/projects', { data: { name: 'Изменения во время сохранения' } })).json();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/projects/${id}/settings`, async route => {
    await waiting;
    await route.continue();
  });
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const concurrency = page.getByRole('spinbutton', { name: 'Одновременных проверок' });
  const save = page.getByRole('button', { name: 'Сохранить настройки' });
  await concurrency.fill('12');
  await save.click();
  await concurrency.fill('18');
  release();
  await expect(save).toBeEnabled();
  await expect(concurrency).toHaveValue('18');
  await expect(page.getByText('Настройки сохранены', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Последние изменения не сохранены.', { exact: true })).toBeVisible();
  expect((await (await request.get(`/api/projects/${id}?view=summary`)).json()).project.checkConcurrency).toBe(12);
  await save.click();
  await expect(page.getByText('Настройки сохранены', { exact: true })).toBeVisible();
});

test('asks before abandoning project settings by switching tabs or pressing Escape', async ({ page, request }) => {
  const { id } = await (await request.post('/api/projects', { data: { name: 'Черновик настроек' } })).json();
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const concurrency = page.getByRole('spinbutton', { name: 'Одновременных проверок' });
  await concurrency.fill('18');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(concurrency).toHaveValue('18');
  page.once('dialog', dialog => dialog.accept());
  await concurrency.press('Escape');
  await expect(concurrency).toHaveValue('6');
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(concurrency).toHaveCount(0);
});

test('updates the delivery and removes deleted reports while notification history is open', async ({ page }) => {
  let smtpConfigured = false;
  const store = new Store(':memory:');
  const app = createApp({ store, smtpConfigured: () => smtpConfigured });
  try {
    const { id } = store.createProject('История уведомлений', '');
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

    await routeReads(page, app);
    await page.goto('/');
    await page.getByRole('button', { name: 'Уведомления', exact: true }).click();
    const pagination = page.getByRole('navigation', { name: 'Страницы уведомлений' });
    await pagination.getByRole('button', { name: 'Следующая страница' }).click();
    const oldest = page.getByRole('article').filter({
      has: page.getByText('История уведомлений · Запуск №1', { exact: true }),
    });
    await expect(oldest.getByText('Email ждёт подключения SMTP')).toBeVisible();
    await expect(pagination.getByText('Страница 2')).toBeVisible();

    smtpConfigured = true;
    await expect(oldest.getByText('Email в очереди')).toBeVisible();
    store.finishEmail(store.claimEmail()!, null, false);
    await expect(oldest.getByText('Email отправлен')).toBeVisible();
    const deleted = await app.inject({ method: 'DELETE', url: `/api/projects/${id}/runs/1` });
    expect(deleted.statusCode).toBe(200);
    await expect(oldest).toHaveCount(0);
    await expect(pagination.getByText('Страница 1')).toBeVisible();
    await expect(pagination.getByRole('button', { name: 'Следующая страница' })).toBeDisabled();
  } finally {
    await closeRoutedApp(page, app, store);
  }
});

test('shows the global schedule pause in project settings in place of the next date', async ({ page }) => {
  let paused = true;
  const clock = Date.parse('2040-01-01T09:59:00Z');
  const store = new Store(':memory:', () => clock);
  const app = createApp({ store, schedulesPaused: () => paused });
  try {
    const { id } = store.createProject('Настройки расписания', '');
    store.saveSettings(id, { schedule: { weekdays: [7], time: '10:00', timezone: 'UTC' }, notify: 'off', email: null });
    await routeReads(page, app);
    await page.goto(`/?project=${id}`);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await expect(page.getByText('Расписание проекта на паузе.', { exact: false })).toBeVisible();
    await expect(page.getByText('Следующий запуск', { exact: false })).toHaveCount(0);

    paused = false;
    await expect(page.getByText('Следующий запуск', { exact: false })).toBeVisible();
    await expect(page.getByText('Расписание проекта на паузе.', { exact: false })).toHaveCount(0);
  } finally {
    await closeRoutedApp(page, app, store);
  }
});

test('shows an interrupted email and its persisted attempt count in the notification feed', async ({ page }) => {
  const store = new Store(':memory:');
  const app = createApp({ store, smtpConfigured: true });
  try {
    const { id } = store.createProject('Прерванная отправка', '');
    store.addUrls(id, [{ input: 'example.invalid', line: 1 }]);
    store.saveSettings(id, { schedule: null, notify: 'all', email: 'operator@example.invalid' });
    const run = store.enqueue(id);
    const [item] = store.claim()!.items;
    store.saveResult(item.id, { status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url, redirects: 0,
      contentType: null, contentLength: null, errorKind: null, error: null });
    store.finish(run.id);
    expect(store.claimEmail()?.attempts).toBe(1);
    store.recover();

    await routeReads(page, app);
    await page.goto(`/?project=${id}&tab=notifications`);
    const entry = page.getByRole('article').filter({ hasText: 'Прерванная отправка' });
    await expect(entry.getByText(/Доставка не подтверждена/)).toBeVisible();
    await expect(entry.getByText('Попыток отправки: 1', { exact: true })).toBeVisible();
  } finally {
    await closeRoutedApp(page, app, store);
  }
});
