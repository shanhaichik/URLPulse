import { gzipSync } from 'node:zlib';
import { expect, test, type APIRequestContext } from './fixtures.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { MAX_PAC_BYTES } from '../src/shared/pac.js';

async function createProject(request: APIRequestContext, name: string, input?: string) {
  const response = await request.post('/api/projects', { data: { name } });
  expect(response.ok()).toBe(true);
  const { id }: { id: number } = await response.json();
  const path = `/api/projects/${id}`;
  if (input) expect((await request.post(path + '/urls', { data: { input } })).ok()).toBe(true);
  return { path, url: `/?project=${id}` };
}

test('corrects an invalid mobile schedule and keeps the saved HTTPS and notification choices', async ({ page, request }) => {
  const { path, url } = await createProject(request, 'Проверка настроек календаря');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url + '&tab=settings');
  await page.getByRole('checkbox', { name: 'Включить расписание' }).check();
  const weekdays = page.getByRole('group', { name: 'Дни недели' });
  for (const day of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт']) {
    await weekdays.getByRole('checkbox', { name: day, exact: true }).press('Space');
  }
  const save = page.getByRole('button', { name: 'Сохранить настройки' });
  await save.click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Выберите хотя бы один день недели.');

  const sunday = weekdays.getByRole('checkbox', { name: 'Вс', exact: true });
  await sunday.press('Space');
  await expect(sunday).toBeFocused();
  await expect(sunday).toBeChecked();
  await expect(weekdays.getByText('Вс', { exact: true })).toHaveCSS('outline-style', 'solid');
  const timezone = page.getByLabel('Часовой пояс');
  await timezone.fill('Invalid/Timezone');
  const time = page.getByLabel('Время', { exact: true });
  await time.fill('23:55');
  const tls = page.getByLabel('Профиль HTTPS');
  await tls.selectOption('russian-ca');
  const notification = page.getByLabel('Когда уведомлять');
  await notification.selectOption('errors');
  const email = page.getByLabel('Email получателя');
  await email.fill('operator@example.com');
  await save.click();
  await expect(alert).toHaveText('Выберите действительный часовой пояс.');
  await expect(time).toHaveValue('23:55');
  const rejected = await (await request.get(path + '?view=summary')).json();
  expect(rejected.project).toMatchObject({ schedule: null, tlsProfile: 'default' });

  await timezone.fill('UTC');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Настройки сохранены' })).toBeVisible();
  await page.reload();
  await expect(sunday).toBeChecked();
  await expect(timezone).toHaveValue('UTC');
  await expect(tls).toHaveValue('russian-ca');
  await expect(notification).toHaveValue('errors');
  await expect(email).toHaveValue('operator@example.com');
  expect((await (await request.get(path + '?view=summary')).json()).project.schedule)
    .toEqual({ weekdays: [7], time: '23:55', timezone: 'UTC' });
});

test('reports normalized duplicates and original line numbers in a partial list import', async ({ page, request }) => {
  const { path, url } = await createProject(request, 'Смешанный список адресов', 'example.com/existing');
  await page.goto(url);
  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  const form = page.getByRole('dialog', { name: 'Добавить URL' });
  await form.getByLabel('Адреса', { exact: true }).fill(
    'https://EXAMPLE.com/existing#fragment\n\nftp://example.com/file\nexample.com/added',
  );
  await expect(form.getByLabel('Название адреса')).toHaveCount(0);
  await form.getByRole('button', { name: 'Добавить адреса' }).click();
  await expect(form.getByText('Добавлено: 1', { exact: true })).toBeVisible();
  await expect(form.getByText('Дубликаты: 1', { exact: true })).toBeVisible();
  await expect(form.getByText('Ошибки: 1', { exact: true })).toBeVisible();
  await expect(form.getByText('Строка 1', { exact: true })).toBeVisible();
  await expect(form.getByText('Строка 3', { exact: true })).toBeVisible();
  await expect(form.getByText('Этот адрес уже добавлен.')).toBeVisible();
  await expect(form.getByText('Допустимы только HTTP и HTTPS.')).toBeVisible();
  await form.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByRole('button', { name: 'https://example.com/added', exact: true })).toBeVisible();
  const { items }: { items: { url: string }[] } = await (await request.get(path + '/urls/page')).json();
  expect(items.map(item => item.url).sort()).toEqual(['https://example.com/added', 'https://example.com/existing']);
});

test('keeps the worklist intact after malformed sitemap XML and imports a gzip replacement', async ({ page, request }) => {
  const { path, url } = await createProject(request, 'Восстановление импорта sitemap');
  await page.goto(url);
  await page.getByRole('button', { name: 'Добавить URL' }).first().click();
  const form = page.getByRole('dialog', { name: 'Добавить URL' });
  await form.getByRole('button', { name: 'Файл sitemap' }).click();
  const file = form.getByLabel('Выберите файл');
  const submit = form.getByRole('button', { name: 'Импортировать sitemap' });
  const entry = '<url><loc>https://example.com/gzip-entry</loc></url>';
  await file.setInputFiles({ name: 'broken.xml', mimeType: 'application/xml', buffer: Buffer.from('<urlset>' + entry) });
  await submit.click();
  await expect(form.getByRole('alert')).toContainText(/XML/);
  expect((await (await request.get(path + '/urls/page')).json()).items).toEqual([]);

  await file.setInputFiles({ name: 'sitemap.xml.gz', mimeType: 'application/gzip', buffer: gzipSync('<urlset>' + entry + '</urlset>') });
  await submit.click();
  await expect(form.getByText('Добавлено: 1', { exact: true })).toBeVisible();
  await expect(form.getByText('Файлов sitemap: 1', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByRole('button', { name: 'https://example.com/gzip-entry', exact: true })).toBeVisible();
});

test('pages through selected addresses and refreshes an outdated clear-all confirmation', async ({ page, request }) => {
  const addresses = Array.from({ length: 26 }, (_, index) => `https://example.com/to-clear-${String(index + 1).padStart(2, '0')}`);
  const { path, url } = await createProject(request, 'Обновление области удаления', addresses.join('\n'));
  await page.goto(url);
  await page.getByRole('checkbox', { name: 'Выбрать все по фильтру' }).click();
  await page.getByRole('button', { name: 'Удалить выбранные' }).click();
  const selection = page.getByRole('dialog', { name: 'Удалить выбранные адреса?' });
  const pagination = selection.getByRole('navigation', { name: 'Страницы адресов к удалению' });
  const listed = selection.getByRole('list', { name: 'Адреса к удалению' }).getByRole('listitem');
  await expect(listed).toHaveCount(25);
  await pagination.getByRole('button', { name: 'Следующая страница' }).click();
  await expect(listed).toHaveText([addresses[25]]);
  await expect(pagination.getByRole('button', { name: 'Следующая страница' })).toBeDisabled();
  await pagination.getByRole('button', { name: 'Предыдущая страница' }).click();
  await expect(listed).toHaveCount(25);
  await selection.getByRole('button', { name: 'Отмена' }).click();

  await page.getByRole('button', { name: 'Действия', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить все адреса проекта', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить все адреса проекта?' });
  await expect(confirmation.getByText('Адресов к удалению: 26')).toBeVisible();
  expect((await request.post(path + '/urls', { data: { input: 'example.com/to-clear-27' } })).ok()).toBe(true);
  const clear = confirmation.getByRole('button', { name: 'Удалить все адреса', exact: true });
  await clear.click();
  await expect(confirmation.getByRole('alert')).toContainText('Список адресов или проверок изменился');
  await expect(confirmation.getByText('Адресов к удалению: 27')).toBeVisible();
  expect((await (await request.get(path + '/urls/page')).json()).total).toBe(27);
  await clear.click();
  await expect(page.getByText('В проекте пока нет адресов')).toBeVisible();
  expect((await (await request.get(path + '/urls/page')).json()).total).toBe(0);
});

test('recovers report loading and compares changed destinations through applied filters', async ({ page }) => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Сравнение истории отчёта', '');
    const urls = ['https://example.com/destination', 'https://example.com/unchanged'];
    store.addUrls(project.id, urls.map((input, index) => ({ input, line: index + 1 })));
    function completeRun(changed: boolean) {
      const run = store.enqueue(project.id);
      for (const item of store.claim()!.items) {
        const finalUrl = changed && item.url === urls[0] ? urls[0] + '-new' : item.url;
        store.saveResult(item.id, {
          status: 'ok', httpCode: 200, durationMs: 15, finalUrl, redirects: Number(finalUrl !== item.url),
          contentType: 'text/html', contentLength: null, errorKind: null, error: null,
        });
      }
      store.finish(run.id);
      return run.id;
    }
    const baseline = completeRun(false);
    const run = completeRun(true);
    const path = `/api/projects/${project.id}/runs/${run}`;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const response = await app.inject(url.pathname + url.search);
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.route(url => url.pathname === path, route =>
      route.fulfill({ status: 503, json: { error: 'Отчёт временно недоступен.' } }), { times: 1 });
    await page.goto(`/?project=${project.id}&run=${run}`);
    const report = page.getByRole('dialog', { name: `Отчёт по запуску №${run}` });
    await expect(report.getByRole('alert')).toHaveText('Отчёт временно недоступен.');
    await report.getByRole('button', { name: 'Повторить' }).click();
    await expect(report.getByText(`Ближайший завершённый запуск №${baseline}`, { exact: false })).toBeVisible();
    const results = report.locator('.result-name strong');
    await expect(results).toHaveText(urls);

    const search = report.getByRole('searchbox', { name: 'URL или название' });
    const filters = ['Статус', 'Изменение'].map(name => ({
      select: report.getByRole('combobox', { name, exact: true }),
      arrow: report.locator('label').filter({ has: page.getByRole('combobox', { name, exact: true }) }).locator('svg'),
    }));
    const [{ select: status }, { select: change }] = filters;
    await test.step('insets and centers both filter arrows at desktop and mobile widths', async () => {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        for (const { select, arrow } of filters) {
          await expect(select).toHaveCSS('appearance', 'none');
          await expect(arrow).toHaveCount(1);
          await expect(arrow).toBeVisible();
          const control = (await select.boundingBox())!;
          const icon = (await arrow.boundingBox())!;
          const rightGap = control.x + control.width - icon.x - icon.width;
          expect(control.height).toBe(34);
          expect(rightGap).toBeCloseTo(11, 0);
          expect(icon.y + icon.height / 2).toBeCloseTo(control.y + control.height / 2, 0);
          const paddingRight = await select.evaluate(element => parseFloat(getComputedStyle(element).paddingRight));
          expect(paddingRight - rightGap - icon.width).toBeGreaterThanOrEqual(6);
        }
      }
      await page.emulateMedia({ forcedColors: 'active' });
      for (const { select, arrow } of filters) {
        await expect(select).toHaveCSS('appearance', 'auto');
        await expect(arrow).toBeHidden();
      }
      await page.emulateMedia({ forcedColors: 'none' });
    });
    const keyboard = await page.context().newCDPSession(page);
    // Send Cyrillic key events to exercise the native select's typeahead.
    async function typeLetter(key: string) {
      await keyboard.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key.toLowerCase() });
      await keyboard.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    }
    await search.press('Tab');
    await expect(status).toBeFocused();
    await typeLetter('Д');
    await expect(status).toHaveValue('ok');
    await status.press('Tab');
    await expect(report.getByRole('spinbutton', { name: 'HTTP-код' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(change).toBeFocused();
    await typeLetter('И');
    await expect(change).toHaveValue('changed');
    await keyboard.detach();
    await report.getByRole('button', { name: 'Найти', exact: true }).press('Enter');
    await expect(results).toHaveText([urls[0]]);
    await report.locator('summary').press('Enter');
    await expect(report.getByText('Предыдущий конечный URL · ' + urls[0], { exact: true })).toBeVisible();
    await expect(report.getByRole('link', { name: 'JSON', exact: true })).toHaveAttribute('href', path + '/export?status=ok&change=changed&format=json');
    await search.fill('unchanged');
    await search.press('Enter');
    await expect(report.getByRole('heading', { name: 'Результаты не найдены' })).toBeVisible();
    await report.getByRole('button', { name: 'Сбросить фильтры' }).click();
    await expect(search).toBeFocused();
    await expect(status).toHaveValue('');
    await expect(change).toHaveValue('');
    await expect(results).toHaveText(urls);
  } finally { await app.close(); store.close(); }
});

test('keeps notifications unread when marking all fails and updates them after retry', async ({ page, request }) => {
  const { path, url } = await createProject(request, 'Повтор отметки уведомлений', 'example.com/inbox-retry');
  expect((await request.patch(path + '/settings', { data: { schedule: null, notify: 'all', email: null } })).ok()).toBe(true);
  const { id }: { id: number } = await (await request.post(path + '/runs', { data: {} })).json();
  await expect.poll(async () => (await (await request.get(path + '/runs/' + id)).json()).run.status).toBe('done');
  await page.route('**/api/notifications/read', route =>
    route.fulfill({ status: 503, json: { error: 'Не удалось отметить уведомления.' } }), { times: 1 });
  await page.goto(url + '&tab=notifications');
  const entry = page.getByRole('article').filter({ hasText: `Повтор отметки уведомлений · Запуск №${id}` });
  const markAll = page.getByRole('button', { name: 'Отметить все как прочитанные' });
  await expect(entry.getByTitle('Новое')).toBeVisible();
  await markAll.click();
  await expect(page.getByRole('alert')).toHaveText('Не удалось отметить уведомления.');
  await expect(entry.getByTitle('Новое')).toBeVisible();
  await expect(markAll).toBeEnabled();
  await markAll.click();
  await expect(markAll).toHaveCount(0);
  await expect(entry.getByTitle('Новое')).toHaveCount(0);
  await page.reload();
  await expect(entry).toBeVisible();
  await expect(entry.getByTitle('Новое')).toHaveCount(0);
});

test('retries PAC loading and rejects invalid files with accessible mobile dialog controls', async ({ page, request }) => {
  const { path, url } = await createProject(request, 'Восстановление настроек PAC');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**' + path + '/proxy-pac', route =>
    route.fulfill({ status: 503, json: { error: 'Не удалось загрузить PAC.' } }), { times: 1 });
  await page.goto(url + '&tab=settings');
  const pac = page.getByRole('region', { name: 'PAC-файл проекта' });
  await expect(pac.getByRole('alert')).toHaveText('Не удалось загрузить PAC.');
  await pac.getByRole('button', { name: 'Повторить загрузку PAC' }).click();
  await expect(pac.getByText('PAC не настроен')).toBeVisible();

  const opener = pac.getByRole('button', { name: 'Загрузить PAC-файл' });
  await opener.press('Enter');
  const upload = page.getByRole('dialog', { name: 'Загрузить PAC-файл' });
  const file = upload.getByLabel('Файл .pac');
  const save = upload.getByRole('button', { name: 'Сохранить PAC' });
  await expect(file).toBeFocused();
  await expect(save).toBeDisabled();
  const mimeType = 'application/x-ns-proxy-autoconfig';
  await file.setInputFiles({ name: 'large.pac', mimeType, buffer: Buffer.alloc(MAX_PAC_BYTES + 1, ' ') });
  await save.click();
  await expect(upload.getByRole('alert')).toHaveText('Размер PAC-файла должен быть не больше 256 КиБ.');
  await file.setInputFiles({ name: 'encoding.pac', mimeType, buffer: Buffer.from([0xff]) });
  await expect(upload.getByRole('alert')).toHaveCount(0);
  await save.click();
  await expect(upload.getByRole('alert')).toHaveText('Сохраните PAC-файл в кодировке UTF-8.');
  await page.keyboard.press('Escape');
  await expect(upload).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await (await request.get(path + '/proxy-pac')).json()).toEqual({ pac: null });
});
