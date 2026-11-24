import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('loads the application icon in the sidebar and browser tab', async ({ page, request }) => {
  await page.goto('/');
  const favicon = page.locator('link[rel="icon"]');
  await expect(favicon).toHaveAttribute('href', '/pulse-icon.png');
  const response = await request.get('/pulse-icon.png');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toBe('image/png');
  await expect(page.locator('img.brand-mark')).toHaveJSProperty('naturalWidth', 128);
});

test('creates a project, imports URLs, checks the selection and exports the report', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект' }).first().click();
  await page.getByLabel('Название проекта').fill('Сервисы команды');
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await expect(page.getByRole('heading', { name: 'Сервисы команды' })).toBeVisible();

  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  await page.getByLabel('Адреса', { exact: true }).fill('https://example.com/ok\nhttps://example.com/unavailable\nftp://example.com/');
  await page.getByRole('button', { name: 'Добавить адреса' }).click();
  await expect(page.getByText('Добавлено: 2', { exact: false })).toBeVisible();
  await expect(page.getByText('Допустимы только HTTP и HTTPS', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Готово' }).click();

  await page.getByRole('searchbox', { name: 'Поиск по адресам' }).fill('unavailable');
  await expect(page.getByText('https://example.com/ok')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Выбрать https://example.com/unavailable' }).check();
  await page.getByRole('button', { name: 'Проверить выбранные' }).click();
  await expect(page.getByRole('cell', { name: '503' })).toBeVisible();
  await page.getByRole('button', { name: 'Журнал запусков' }).click();
  await page.getByRole('button', { name: 'Открыть отчёт' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('https://example.com/unavailable');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('link', { name: 'CSV', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2} - Сервисы команды\.csv$/);
});

test('pages through the journal and returns to the previous page after deleting the last report', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: 'История на три страницы' } })).json();
  const root = `/api/projects/${project.id}`;
  await request.post(root + '/urls', { data: { input: 'example.com/journal' } });
  const ids: number[] = [];
  for (let i = 0; i < 51; i++) {
    const run = await (await request.post(root + '/runs', { data: {} })).json();
    ids.push(run.id);
    await request.post(`${root}/runs/${run.id}/stop`);
  }

  await page.goto(`/?project=${project.id}`);
  await page.getByRole('button', { name: 'Журнал запусков', exact: true }).click();
  const footer = page.getByRole('navigation', { name: 'Страницы журнала' });
  const next = footer.getByRole('button', { name: 'Следующая страница' });
  const back = footer.getByRole('button', { name: 'Предыдущая страница' });
  const rows = page.locator('.run-table tbody tr');
  await expect(rows).toHaveCount(25);
  await expect(back).toBeDisabled();
  await next.click();
  await expect(footer.getByText('Страница 2', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(25);
  await back.click();
  await expect(footer.getByText('Страница 1', { exact: true })).toBeVisible();
  await next.click();
  await next.click();
  await expect(footer.getByText('Страница 3', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(next).toBeDisabled();
  await rows.getByRole('button', { name: 'Открыть отчёт' }).click();
  const report = page.getByRole('dialog', { name: `Отчёт по запуску №${ids[0]}` });
  await report.getByRole('button', { name: 'Закрыть' }).click();
  await expect(footer.getByText('Страница 3', { exact: true })).toBeVisible();
  await rows.getByRole('button', { name: 'Открыть отчёт' }).click();
  await report.getByRole('button', { name: 'Удалить отчёт' }).click();
  await page.getByRole('dialog', { name: 'Удалить отчёт?' }).getByRole('button', { name: 'Удалить отчёт' }).click();
  await expect(footer.getByText('Страница 2', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(25);
  await expect(next).toBeDisabled();
});

test('stops checks from the progress panel and the report while retaining completed rows', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: 'Остановка проверки' } })).json();
  await request.post(`/api/projects/${project.id}/urls`, { data: { input: 'example.com/finished\nexample.com/wait-for-stop' } });
  await page.goto(`/?project=${project.id}`);
  const start = page.getByRole('button', { name: 'Проверить проект' });
  const progress = page.locator('.progress-bar');
  for (const fromReport of [false, true]) {
    await start.click();
    await expect(progress.getByText('1 из 2')).toBeVisible();
    if (fromReport) await progress.getByRole('button', { name: 'Открыть отчёт' }).click();
    const report = page.getByRole('dialog', { name: /Отчёт по запуску/ });
    const controls = fromReport ? report : progress;
    await controls.getByRole('button', { name: 'Остановить проверку' }).click();
    if (!fromReport) {
      await expect(page.getByText(/^Проверка №\d+ остановлена\.$/)).toBeVisible();
      await page.locator('.queued').getByRole('button', { name: 'Открыть отчёт' }).click();
    }
    await expect(report.getByText('Остановлена', { exact: true })).toBeVisible();
    await expect(report.getByText('Не проверено 1')).toBeVisible();
    await expect(report.locator('.result-name').getByText('https://example.com/finished', { exact: true })).toBeVisible();
    await expect(report.getByText('https://example.com/wait-for-stop', { exact: true })).toHaveCount(0);
    await expect(report.getByRole('button', { name: 'Удалить отчёт' })).toBeVisible();
    await report.getByRole('button', { name: 'Закрыть' }).click();
  }
});

test('returns to completed results when stopping from a later page of pending rows', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: 'Страницы остановленной проверки' } })).json();
  const pending = Array.from({ length: 102 }, (_, i) => `example.com/${i}/wait-for-stop`);
  await request.post(`/api/projects/${project.id}/urls`, { data: { input: ['example.com/finished', ...pending].join('\n') } });
  await page.goto(`/?project=${project.id}`);
  await page.getByRole('button', { name: 'Проверить проект' }).click();
  const progress = page.locator('.progress-bar');
  await expect(progress.getByText('1 из 103')).toBeVisible();
  const runs = `/api/projects/${project.id}/runs`;
  const next = await (await request.post(runs, { data: {} })).json();
  try {
    await progress.getByRole('button', { name: 'Открыть отчёт' }).click();
    const report = page.getByRole('dialog', { name: /Отчёт по запуску/ });
    await report.getByRole('button', { name: 'Далее', exact: true }).click();
    await expect(report.getByText('Страница 2')).toBeVisible();
    await report.getByRole('button', { name: 'Остановить проверку' }).click();
    await expect(report.getByText('Остановлена', { exact: true })).toBeVisible();
    await expect(report.locator('.result-name').getByText('https://example.com/finished', { exact: true })).toBeVisible();
    await expect(report.getByText('Страница 2')).toHaveCount(0);
    await report.getByRole('button', { name: 'Закрыть' }).click();
    await expect(progress.getByText(`№${next.id}`, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Проверка №\d+ остановлена\.$/)).toBeVisible();
  } finally { await request.post(`${runs}/${next.id}/stop`); }
});

test('imports a sitemap file into the current project', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект' }).first().click();
  await page.getByLabel('Название проекта').fill('Импорт sitemap');
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  await page.getByRole('button', { name: 'Файл sitemap' }).click();
  await page.getByLabel('Выберите файл').setInputFiles({
    name: 'sitemap.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from('<urlset><url><loc>https://example.com/sitemap-entry</loc></url></urlset>'),
  });
  await page.getByRole('button', { name: 'Импортировать sitemap' }).click();
  await expect(page.getByText('Добавлено: 1', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByText('https://example.com/sitemap-entry')).toBeVisible();
});

test('keeps a filtered report on page fourteen when closing nested URL history', async ({ page, request }) => {
  const root = '/api/projects';
  const project = await (await request.post(root, { data: { name: 'Контекст отчёта' } })).json();
  const path = `${root}/${project.id}`;
  for (const [offset, length] of [[0, 1000], [1000, 305]]) {
    const input = Array.from({ length }, (_, index) => `https://example.com/history/${offset + index}`).join('\n');
    expect((await request.post(path + '/urls', { data: { input } })).ok()).toBeTruthy();
  }
  const run = await (await request.post(path + '/runs', { data: {} })).json();
  await expect.poll(async () => (await (await request.get(`${path}/runs/${run.id}`)).json()).run.status, { timeout: 20_000 }).toBe('done');
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  const report = page.getByRole('dialog', { name: `Отчёт по запуску №${run.id}` });
  const search = report.getByRole('searchbox');
  await search.fill('example.com/history');
  await report.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(report.getByText('Выгрузить по фильтрам')).toBeVisible();
  const next = report.getByRole('button', { name: 'Далее', exact: true });
  for (let number = 2; number <= 14; number++) {
    await next.click();
    await expect(report.getByText(`Страница ${number}`, { exact: true })).toBeVisible();
  }
  const row = report.locator('.result').last();
  const url = (await row.locator('.result-name strong').textContent())!;
  await row.locator('summary').click();
  const open = row.getByRole('button', { name: 'История этого URL' });
  await open.scrollIntoViewIfNeeded();
  const body = report.locator('.modal-body');
  const scroll = await body.evaluate(element => element.scrollTop);
  for (const action of ['Escape', 'button']) {
    await open.click();
    const history = page.getByRole('dialog', { name: 'История URL' });
    await expect(history.getByText(url, { exact: true }).first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`run=${run.id}$`));
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await history.getByRole('button', { name: 'Закрыть' }).click();
    await expect(open).toBeFocused();
    await expect(search).toHaveValue('example.com/history');
    await expect(report.getByText('Страница 14', { exact: true })).toBeVisible();
    await expect(row).toHaveAttribute('open', '');
    expect(await body.evaluate(element => element.scrollTop)).toBe(scroll);
  }
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`\\?project=${project.id}&tab=runs$`));
  await expect(page.getByRole('heading', { name: 'Журнал запусков' })).toBeVisible();
});

test('shows long URL actions at narrow width and links from quick import to the catalog', async ({ page, request }) => {
  const root = '/api/projects';
  const project = await (await request.post(root, { data: { name: 'Мобильные адреса' } })).json();
  const url = 'https://example.com/common-path/common-path/common-path/unique-item';
  expect((await request.post(`${root}/${project.id}/urls`, { data: { input: url } })).ok()).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?project=${project.id}`);
  const address = page.getByRole('button', { name: url, exact: true });
  await expect(address).toHaveCSS('direction', 'rtl');
  for (const action of ['Проверить', 'Редактировать', 'Удалить']) {
    await expect(page.getByRole('button', { name: `${action} ${url}`, exact: true })).toBeAttached();
  }
  const accessibility = await page.context().newCDPSession(page);
  const { nodes } = await accessibility.send('Accessibility.getFullAXTree');
  const names = new Set(nodes.filter(node => node.role?.value === 'button').map(node => node.name?.value));
  for (const text of [url, `Проверить ${url}`, `Редактировать ${url}`, `Удалить ${url}`]) expect(names.has(text)).toBeTruthy();
  await accessibility.detach();
  const scroll = page.locator('.address-table').locator('..');
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await address.focus();
  await page.keyboard.press('Enter');
  const history = page.getByRole('dialog', { name: 'История URL' });
  await expect(history.getByText(url, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(address).toBeFocused();
  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  await page.getByRole('button', { name: 'Файл sitemap' }).click();
  await expect(page.getByText('Быстрый импорт добавляет URL сразу', { exact: false })).toBeVisible();
  await page.getByLabel('Выберите файл').setInputFiles({
    name: 'large.xml', mimeType: 'application/xml', buffer: Buffer.alloc(8 * 1024 * 1024 + 1),
  });
  await page.getByRole('button', { name: 'Импортировать sitemap' }).click();
  await expect(page.getByRole('alert')).toContainText('до 8 МиБ');
  await page.getByRole('button', { name: 'Перейти в каталог sitemap' }).click();
  await expect(page.getByRole('heading', { name: 'Каталог sitemap' })).toBeVisible();
});

test('imports a remote sitemap index and saves calendar and notification settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект' }).first().click();
  await page.getByLabel('Название проекта').fill('Календарный проект');
  await page.getByRole('button', { name: 'Создать проект' }).click();
  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  await page.getByRole('button', { name: 'Ссылка на sitemap' }).click();
  await page.getByLabel('Ссылка на sitemap', { exact: true }).fill('https://example.com/sitemap.xml');
  await page.getByRole('button', { name: 'Импортировать sitemap' }).click();
  await expect(page.getByText('Файлов sitemap: 2')).toBeVisible();
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByText('https://example.com/from-sitemap-link')).toBeVisible();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('Включить расписание').check();
  await page.locator('input[type=time]').fill('10:15');
  await page.getByLabel('Когда уведомлять').selectOption('errors');
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(page.getByText('Настройки сохранены')).toBeVisible();
  await expect(page.getByText('Следующий запуск —', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(page.getByLabel('Включить расписание')).toBeChecked();
  await expect(page.locator('input[type=time]')).toHaveValue('10:15');
  await expect(page.getByLabel('Когда уведомлять')).toHaveValue('errors');
});

test('keeps a delayed run acknowledgement in its original project', async ({ page }) => {
  const createProject = async (name: string) => {
    await page.getByRole('button', { name: 'Новый проект' }).first().click();
    await page.getByLabel('Название проекта').fill(name);
    await page.getByRole('button', { name: 'Создать проект' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
  };
  await page.goto('/');
  await createProject('Другой проект');
  await createProject('Проект запуска');
  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  await page.getByLabel('Адреса', { exact: true }).fill('example.com');
  await page.getByRole('button', { name: 'Добавить адреса' }).click();
  await page.getByRole('button', { name: 'Готово' }).click();

  const switched = signal();
  const fulfilled = signal();
  await page.route(/\/api\/projects\/\d+\/runs$/, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    await switched.promise;
    await route.fulfill({ response });
    fulfilled.resolve();
  });
  await page.getByRole('button', { name: 'Проверить проект' }).click();
  await page.getByRole('button', { name: /Другой проект/ }).click();
  await expect(page.getByText('В проекте пока нет адресов')).toBeVisible();
  const projectId = new URL(page.url()).searchParams.get('project');
  const released = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/' + projectId);
  switched.resolve();
  await fulfilled.promise;
  await expect(page.getByRole('heading', { name: 'Другой проект' })).toBeVisible();
  await released;
  await expect(page.getByRole('button', { name: 'Открыть отчёт' })).toHaveCount(0);
});

test('keeps the table scroll inside its panel on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await page.request.post('/api/projects', { data: { name: 'Мобильный вид' } });
  const { id } = await project.json();
  await page.request.post(`/api/projects/${id}/urls`, { data: { input: 'example.com' } });
  await page.goto(`/?project=${id}`);
  await expect(page.getByText('https://example.com/', { exact: true })).toBeVisible();
  const widths = await page.evaluate(() => {
    const hiddenInTable = document.querySelector('.address-table .sr-only') as HTMLElement;
    return { viewport: window.innerWidth, document: document.documentElement.scrollWidth,
      hiddenHeaderParent: hiddenInTable.offsetParent?.className };
  });
  expect(widths.document, JSON.stringify(widths)).toBe(widths.viewport);
});

test('edits and deletes a project from settings after confirmation', async ({ page }) => {
  const project = await page.request.post('/api/projects', { data: { name: 'Имя до переименования' } });
  const { id } = await project.json();
  await page.request.post(`/api/projects/${id}/urls`, { data: { input: 'example.com' } });
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Редактировать проект' }).click();
  await page.getByLabel('Название проекта', { exact: true }).fill('Проект после переименования');
  await page.getByRole('textbox', { name: /Описание/ }).fill('Описание после сохранения');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('heading', { name: 'Проект после переименования' })).toBeVisible();
  await expect(page.getByText('Описание после сохранения', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(page.getByText('https://example.com/', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();

  await page.getByRole('button', { name: 'Удалить проект' }).click();
  await expect(page.getByRole('dialog')).toContainText('история проверок');
  await page.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByRole('heading', { name: 'Проект после переименования' })).toBeVisible();
  await page.getByRole('button', { name: 'Удалить проект' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить проект' }).click();
  await expect(page.getByRole('button', { name: /Проект после переименования/ })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(String(id));
  expect((await page.request.get(`/api/projects/${id}`)).status()).toBe(404);
});

test('deletes one report from the journal and refreshes URL status', async ({ page }) => {
  const project = await page.request.post('/api/projects', { data: { name: 'Удаление отчёта' } });
  const { id } = await project.json();
  const path = `/api/projects/${id}`;
  await page.request.post(path + '/urls', { data: { input: 'example.com' } });
  const response = await page.request.post(path + '/runs', { data: {} });
  const run = await response.json();

  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Журнал запусков' }).click();
  await page.getByRole('button', { name: 'Открыть отчёт' }).first().click();
  await page.getByRole('button', { name: 'Удалить отчёт' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить отчёт?' });
  await expect(confirmation).toContainText('результаты этого запуска');
  await confirmation.getByRole('button', { name: 'Удалить отчёт' }).click();
  await expect(page.getByText('Запусков ещё нет')).toBeVisible();
  expect((await page.request.get(path + '/runs/' + run.id)).status()).toBe(404);
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(page.getByText('https://example.com/', { exact: true })).toBeVisible();
  await expect(page.getByText('Не проверен', { exact: true })).toBeVisible();
});

test('shows Curator diagnostics, offers a safe browser link and clears the inbox', async ({ page }) => {
  const project = await page.request.post('/api/projects', { data: { name: 'Диагностика доступа' } });
  const { id } = await project.json();
  const base = `/api/projects/${id}`;
  await page.request.post(base + '/urls', { data: { input: 'https://example.com/curator' } });
  const { id: run } = await (await page.request.post(base + '/runs', { data: {} })).json();

  await page.goto(`/?project=${id}`);
  const add = page.getByRole('button', { name: 'Добавить URL' }).first();
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await page.getByRole('button', { name: 'https://example.com/curator', exact: true }).click();
  const card = page.getByRole('dialog');
  const browserLink = card.getByRole('link', { name: 'Открыть в браузере' });
  await expect(browserLink).toHaveAttribute('href', 'https://example.com/curator');
  await expect(browserLink).toHaveAttribute('rel', 'noopener noreferrer');
  await card.getByRole('button', { name: 'Закрыть' }).click();

  await page.getByRole('button', { name: 'Журнал запусков' }).click();
  await page.getByRole('button', { name: 'Открыть отчёт' }).first().click();
  await expect(card.getByText('Проверка Curator', { exact: true })).toBeVisible();
  await card.locator('.result summary').click();
  await expect(card.getByText('TLS прошёл · HTTP 401 · признаки проверки Curator', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Закрыть' }).click();

  await page.getByRole('button', { name: 'Уведомления', exact: true }).click();
  await page.getByRole('button', { name: 'Очистить уведомления' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Очистить уведомления' }).click();
  await expect(page.getByText('Уведомлений пока нет')).toBeVisible();
  expect((await page.request.get(base + '/runs/' + run)).status()).toBe(200);
});

test('imports into the sitemap catalog, compares versions and checks a selection independently of the working list', async ({ page }) => {
  const project = await page.request.post('/api/projects', { data: { name: 'Каталог импорта' } });
  const { id } = await project.json();
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  const input = (urls: string[]) => ({ name: 'catalog.xml', mimeType: 'application/xml', buffer: Buffer.from(
    '<urlset>' + urls.map(url => '<url><loc>' + url + '</loc></url>').join('') + '</urlset>') });
  await page.getByLabel('Загрузить файл', { exact: true }).setInputFiles(input([
    'https://example.com/catalog/first', 'https://example.com/catalog/removed',
  ]));
  await expect(page.getByRole('cell', { name: 'https://example.com/catalog/first', exact: true })).toBeVisible();
  expect(await (await page.request.get(`/api/projects/${id}/urls`)).json()).toEqual([]);
  await page.getByLabel('Загрузить новую версию').setInputFiles(input([
    'https://example.com/catalog/first', 'https://example.com/catalog/added',
  ]));
  await expect(page.getByRole('cell', { name: 'https://example.com/catalog/added', exact: true })).toBeVisible();
  await page.getByLabel('Изменения').selectOption('removed');
  await expect(page.getByRole('cell', { name: 'https://example.com/catalog/removed', exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV по фильтру' }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2} - Каталог импорта\.csv$/);
  await page.getByLabel('Изменения').selectOption('all');
  await page.getByRole('checkbox', { name: 'Выбрать https://example.com/catalog/first', exact: true }).check();
  const selected = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV выбранных' }).click();
  expect((await selected).suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2} - Каталог импорта\.csv$/);
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.getByText('Проверка поставлена в очередь.')).toBeVisible();
  expect(await (await page.request.get(`/api/projects/${id}/urls`)).json()).toEqual([]);
  await page.getByRole('button', { name: 'В рабочий список' }).click();
  await expect(page.getByText('В работе добавлено: 1', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(page.getByRole('button', { name: 'https://example.com/catalog/first', exact: true })).toBeVisible();
});

test('adds every current sitemap source to the worklist with one click, regardless of the visible filter', async ({ page }) => {
  const project = await page.request.post('/api/projects', { data: { name: 'Весь каталог в адреса' } });
  const { id } = await project.json();
  const root = `/api/projects/${id}`;
  await page.request.post(root + '/urls', { data: { input: 'https://example.com/kept', label: 'Существующий адрес' } });
  const sitemap = (urls: string[]) => Buffer.from('<urlset>' +
    urls.map(url => '<url><loc>' + url + '</loc></url>').join('') + '</urlset>');
  for (const [name, list] of [
    ['sitemap-a.xml', ['https://example.com/kept', 'https://example.com/hidden']],
    ['sitemap-b.xml', ['https://example.com/hidden', 'https://example.net/visible']],
  ] as const) {
    const creation = await page.request.post(root + '/catalog/imports', { data: { fileName: name } });
    const job = await creation.json();
    const uploaded = await page.request.put(root + '/catalog/imports/' + job.id + '/file', {
      data: sitemap([...list]), headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(uploaded.ok()).toBeTruthy();
    await expect.poll(async () => (await (await page.request.get(root + '/catalog')).json()).jobs[0].state).toBe('done');
  }
  await page.goto('/?project=' + id);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await page.getByLabel('Начало пути', { exact: true }).fill('/kept');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(page.getByText('https://example.com/hidden', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Добавить все в «Адреса»' }).click();
  await page.getByRole('button', { name: 'Перенести адреса', exact: true }).click();
  await expect(page.getByText('Добавлено: 2 · Уже в списке: 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть «Адреса»' }).click();
  await expect(page.getByRole('button', { name: 'https://example.com/hidden', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'https://example.net/visible', exact: true })).toBeVisible();
  await expect(page.getByText('Существующий адрес', { exact: true })).toBeVisible();
  expect(await (await page.request.get(root + '/runs')).json()).toEqual([]);
});

test('selects current filter matches after their membership changes without changing the count', async ({ page }) => {
  const project = await page.request.post('/api/projects', { data: { name: 'Актуальное выделение' } });
  const { id } = await project.json();
  const root = `/api/projects/${id}`;
  const matches = Array.from({ length: 26 }, (_, i) => 'https://example.com/marked/' + String(i).padStart(2, '0'));
  const spare = 'https://example.com/spare';
  await page.request.post(root + '/urls', { data: { input: [...matches, spare].join('\n') } });
  const entries = await (await page.request.get(root + '/urls')).json();
  const firstId = entries.find((entry: { url: string }) => entry.url === matches[0]).id;
  const spareId = entries.find((entry: { url: string }) => entry.url === spare).id;
  await page.goto('/?project=' + id);
  await page.getByRole('searchbox', { name: 'Поиск по адресам' }).fill('marked');
  await expect(page.getByText('1–25 из 26', { exact: true })).toBeVisible();
  const select = page.getByRole('checkbox', { name: 'Выбрать все по фильтру', exact: true });
  await select.click();
  await expect(select).toBeChecked();
  await expect(page.getByText('Выбрано: 26', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Снять выделение', exact: true }).click();
  await page.request.patch(root + '/urls/' + firstId, { data: { url: 'https://example.com/unrelated', label: '' } });
  await page.request.patch(root + '/urls/' + spareId, { data: { url: 'https://example.com/marked/99', label: '' } });
  await expect(page.getByRole('button', { name: matches[0], exact: true })).toHaveCount(0, { timeout: 8_000 });
  await select.click();
  await expect(select).toBeChecked();
  await expect(page.getByText('Выбрано: 26', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Следующая страница', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Выбрать https://example.com/marked/99', exact: true })).toBeChecked();
});

test('finds errors in a report and downloads the filtered CSV for Excel', async ({ page }) => {
  const { id } = await (await page.request.post('/api/projects', { data: { name: 'Фильтры выгрузки' } })).json();
  const path = `/api/projects/${id}`;
  await page.request.post(path + '/urls', { data: { input: 'https://example.com/ok\nhttps://example.com/unavailable' } });
  const run = await (await page.request.post(path + '/runs', { data: {} })).json();
  await expect.poll(async () => (await (await page.request.get(path + '/runs/' + run.id)).json()).run.status).toBe('done');
  await page.goto(`/?project=${id}&run=${run.id}`);
  const report = page.getByRole('dialog');
  await report.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('error');
  await report.getByLabel('HTTP-код', { exact: true }).fill('503');
  await report.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(report.getByText('Выгрузить по фильтрам', { exact: true })).toBeVisible();
  await expect(report.locator('.result-name strong')).toHaveText(['https://example.com/unavailable']);
  const downloaded = page.waitForEvent('download');
  await report.getByRole('link', { name: 'CSV для Excel', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2} - Фильтры выгрузки\.csv$/);
  const csv = await readFile(await file.path(), 'utf8');
  expect(csv).toContain('Название;Статус;HTTP-код');
  expect(csv).toContain('https://example.com/unavailable');
  expect(csv).not.toContain('https://example.com/ok');
});
