import { expect, test } from './fixtures.js';

test('clears every catalog source after a warning and retains transferred URLs and reports', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await (await request.post('/api/projects', { data: { name: 'Полная очистка sitemap' } })).json();
  const root = `/api/projects/${project.id}`;
  const catalog = `${root}/catalog`;
  const url = 'https://example.com/retained-sitemap-address';
  await page.goto(`/?project=${project.id}`);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await page.getByLabel('Загрузить файл', { exact: true }).setInputFiles({ name: 'published.xml', mimeType: 'application/xml',
    buffer: Buffer.from(`<urlset><url><loc>${url}</loc></url></urlset>`) });
  const row = page.getByRole('cell', { name: url, exact: true });
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'В рабочий список', exact: true }).click();
  await expect(page.getByText('В работе добавлено: 1 · Повторы: 0')).toBeVisible();
  const run = await (await request.post(`${root}/runs`, { data: {} })).json();
  await expect.poll(async () => (await (await request.get(`${root}/runs/${run.id}`)).json()).run.completed).toBe(1);
  await request.post(`${catalog}/imports`, { data: { fileName: 'awaiting-upload.xml' } });

  const clear = page.getByRole('button', { name: 'Очистить каталог', exact: true });
  const prefix = page.getByLabel('Начало пути');
  await expect(clear).toBeVisible();
  await prefix.fill('/retained');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(clear).toHaveCount(0);
  await prefix.fill('');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await clear.click();
  const confirm = page.getByRole('dialog', { name: 'Очистить каталог sitemap?' });
  await expect(confirm).toContainText('Полная очистка sitemap');
  await expect(confirm).toContainText('Источников: 2');
  await expect(confirm).toContainText('Активных импортов: 1');
  await confirm.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(row).toBeVisible();
  await clear.click();
  await confirm.getByRole('button', { name: 'Остановить и очистить', exact: true }).click();
  await expect(page.getByText('Каталог очищен. Удалено источников: 2.', { exact: true })).toBeVisible();
  await expect(clear).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect((await (await request.get(catalog)).json())).toEqual({ sources: [], jobs: [], transfer: null });
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(page.getByRole('button', { name: url, exact: true })).toBeVisible();
  expect((await (await request.get(`${root}/runs/${run.id}`)).json()).results).toMatchObject([{ url, httpCode: 200 }]);
});

test('cancels catalog source deletion before removing it without removing worklist URLs', async ({ page, request }) => {
  const project = await request.post('/api/projects', { data: { name: 'Удаление источника каталога' } });
  const { id } = await project.json();
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();

  const url = 'https://example.test/catalog-source';
  await page.getByLabel('Загрузить файл', { exact: true }).setInputFiles({
    name: 'scoped-delete.xml', mimeType: 'application/xml',
    buffer: Buffer.from(`<urlset><url><loc>${url}</loc></url></urlset>`),
  });
  const row = page.getByRole('cell', { name: url, exact: true });
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'В рабочий список', exact: true }).click();
  await expect(page.getByText('В работе добавлено: 1 · Повторы: 0')).toBeVisible();

  const remove = page.getByRole('button', { name: 'Удалить источник', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Удалить источник sitemap?' });
  await remove.click();
  await expect(dialog.getByText('Уже перенесённые URL останутся в «Адресах».', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(row).toBeVisible();

  await remove.click();
  await dialog.getByRole('button', { name: 'Удалить источник', exact: true }).click();
  await expect(page.getByLabel('Загрузить файл', { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(page.getByRole('button', { name: url, exact: true })).toBeVisible();
});

test('finds a resumable catalog error on the second history page', async ({ page, request }) => {
  const project = await request.post('/api/projects', { data: { name: 'Старые ошибки импорта каталога' } });
  const { id } = await project.json();
  const catalog = `/api/projects/${id}/catalog`;
  const creation = await request.post(catalog + '/imports', { data: { fileName: 'failed-history.xml' } });
  const failed = await creation.json();
  expect((await request.put(catalog + '/imports/' + failed.id + '/file', {
    data: Buffer.from('<urlset>'), headers: { 'Content-Type': 'application/octet-stream' },
  })).status()).toBe(202);
  await expect.poll(async () => (await (await request.get(catalog)).json()).jobs[0].state).toBe('failed');
  for (let index = 0; index < 20; index++) {
    const fresh = await (await request.post(catalog + '/imports', { data: { fileName: `newer-history-${index}.xml` } })).json();
    const cancelled = await request.post(catalog + '/imports/' + fresh.id + '/control', { data: { action: 'cancel' } });
    expect(cancelled.ok()).toBeTruthy();
  }

  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  const failure = page.getByRole('listitem').filter({ hasText: '№' + failed.id + ' · Ошибка импорта' });
  await page.getByRole('button', { name: 'История импортов', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await page.getByRole('button', { name: 'Более ранние импорты', exact: true }).click();
  await expect(failure.getByRole('button', { name: 'Продолжить', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Более новые импорты', exact: true }).click();
  await expect(failure).toHaveCount(0);
});
