import { expect, test, type APIRequestContext, type Page } from './fixtures.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

function deferred() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

async function project(request: APIRequestContext, name: string, input?: string) {
  const { id }: { id: number } = await (await request.post('/api/projects', { data: { name } })).json();
  const path = `/api/projects/${id}`;
  if (input) expect((await request.post(path + '/urls', { data: { input } })).ok()).toBe(true);
  return { id, path, url: `/?project=${id}` };
}

test('shows that a submitted project is saving and respects Back while the POST is in flight', async ({ page, request }) => {
  const existing = await project(request, 'Проект для возврата');
  const received = deferred();
  const respond = deferred();
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    received.release();
    await respond.pending;
    await route.fulfill({ response });
  });
  await page.goto(existing.url);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  await page.getByRole('button', { name: 'Новый проект', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Новый проект' });
  await form.getByLabel('Название проекта').fill('Создание с задержкой');
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/projects'));
  await form.getByRole('button', { name: 'Создать проект' }).click();
  try {
    await received.pending;
    await expect(form.getByRole('status')).toContainText('Сохраняем проект');
    await expect(form.getByRole('button', { name: 'Отмена' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('button', { name: 'Адреса', exact: true })).toHaveAttribute('aria-current', 'page');
  } finally { respond.release(); }
  await (await completed).finished();
  await expect(page.getByRole('navigation', { name: 'Проекты' }).getByRole('button', { name: /Создание с задержкой/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Проект для возврата', exact: true })).toBeVisible();
});

for (const action of ['clear', 'row', 'filter', 'project'] as const) {
  test(`ignores delayed Select all after the ${action} action`, async ({ page, request }) => {
    const urls = ['https://example.com/selection-a', 'https://example.com/selection-b'];
    const current = await project(request, 'Запрос выделения ' + action, urls.join('\n'));
    const other = action === 'project' ? await project(request, 'Другой выбор', urls[1]) : undefined;
    const received = deferred();
    const respond = deferred();
    await page.route('**' + current.path + '/urls/selection?**', async route => {
      const response = await route.fetch();
      received.release();
      await respond.pending;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(current.url);
    const [first, second] = urls.map(url => page.getByRole('checkbox', { name: 'Выбрать ' + url, exact: true }));
    await first.check();
    await page.getByRole('checkbox', { name: 'Выбрать все по фильтру', exact: true }).click();
    const selection = page.waitForResponse(response => response.url().includes('/urls/selection?'));
    try {
      await received.pending;
      if (action === 'clear') await page.getByRole('button', { name: 'Снять выделение' }).click();
      if (action === 'row') await first.uncheck({ timeout: 2000 });
      if (action === 'filter') await page.getByRole('searchbox', { name: 'Поиск по адресам' }).fill('selection-b');
      if (other) await page.getByRole('button', { name: /Другой выбор/ }).click();
    } finally { respond.release(); }
    await selection;
    await expect(second).not.toBeChecked();
    if (action !== 'filter') await expect(page.getByRole('button', { name: 'Проверить выбранные', exact: true })).toHaveCount(0);
  });
}

test('restores project and tab via reload, Back and Forward', async ({ page, request }) => {
  const first = await project(request, 'Первый маршрут');
  await project(request, 'Второй маршрут');
  await page.goto(first.url);
  const catalog = page.getByRole('button', { name: 'Каталог sitemap', exact: true });
  await catalog.click();
  await page.reload();
  await expect(catalog).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: /Второй маршрут/ }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Первый маршрут', exact: true })).toBeVisible();
  await expect(catalog).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Второй маршрут', exact: true })).toBeVisible();
});

test('explains a missing project and a missing report with a route back', async ({ page, request }) => {
  const current = await project(request, 'Маршрут для устаревших ссылок');
  await page.goto('/?project=99999999&run=99899999');
  await expect(page.getByRole('heading', { name: 'Проект не найден' })).toBeVisible();
  await page.getByRole('button', { name: 'К проектам' }).click();
  await expect(page.getByRole('heading', { name: 'Проект не найден' })).toHaveCount(0);
  await page.goto(`${current.url}&run=99899999`);
  const report = page.getByRole('dialog', { name: /Отчёт по запуску/ });
  await expect(report.getByText(/не найден/)).toBeVisible();
  await report.getByRole('button', { name: 'К журналу запусков' }).click();
  await expect(report).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Журнал запусков', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('focuses the project name and returns to the opener on Escape', async ({ page }) => {
  await page.goto('/');
  const open = page.getByRole('button', { name: 'Новый проект', exact: true }).first();
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Название проекта' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
});

test('keeps search focused on mobile and restores applied report filters after reload', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const current = await project(request, 'Доступный поиск отчёта', 'example.com/report-match\nexample.com/other');
  const { id } = await (await request.post(current.path + '/runs', { data: {} })).json();
  await expect.poll(async () => (await (await request.get(`${current.path}/runs/${id}`)).json()).run.status).toBe('done');
  await page.goto(`${current.url}&run=${id}`);
  const search = page.getByRole('searchbox', { name: 'URL или название' });
  await search.fill('report-match');
  await search.press('Enter');
  await expect(page.locator('.result-name strong')).toHaveText(['https://example.com/report-match']);
  await expect(search).toBeFocused();
  await expect(search).toBeInViewport();
  await page.reload();
  await expect(search).toHaveValue('report-match');
  await expect(page.locator('.result-name strong')).toHaveText(['https://example.com/report-match']);
});

test('an open address card retries a failed read and updates when its run completes', async ({ page, request }) => {
  const current = await project(request, 'Обновляемая карточка', 'example.com/card-check');
  const { items: [row] } = await (await request.get(current.path + '/urls/page')).json();
  await page.route(`**${current.path}/urls/${row.id}`, route => route.fulfill({ status: 503, json: { error: 'Временная ошибка' } }), { times: 1 });
  await page.goto(current.url);
  await page.getByRole('button', { name: 'https://example.com/card-check', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'История URL' });
  await expect(card.getByText('Временная ошибка')).toBeVisible();
  await card.getByRole('button', { name: 'Повторить' }).click();
  await expect(card.getByText('Адрес ещё не проверяли')).toBeVisible();
  await card.getByRole('button', { name: 'Проверить этот URL' }).click();
  await expect(card.locator('.result-code')).toHaveText(['200']);
  await expect(card.getByText('Адрес ещё не проверяли')).toHaveCount(0);
});

async function localDatabase(page: Page) {
  const store = new Store(':memory:');
  const app = createApp({ store });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method() as 'GET' | 'POST';
    const result = await app.inject({ method, url: url.pathname + url.search, payload: route.request().postData() ?? undefined,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined });
    await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
  });
  return { store, close: async () => { await app.close(); store.close(); } };
}

function finishNextRun(store: Store, beforeResult?: () => void) {
  const { id, items: [item] } = store.claim()!;
  beforeResult?.();
  store.saveResult(item.id, {
    status: 'ok', httpCode: 200, durationMs: 1, finalUrl: item.url, redirects: 0,
    contentType: null, contentLength: null, errorKind: null, error: null,
  });
  store.finish(id);
}

test('keeps older history pages and separates an old run from the new address version', async ({ page }) => {
  const fixture = await localDatabase(page);
  try {
    const { store } = fixture;
    const current = store.createProject('Версии и страницы истории', '');
    const oldUrl = 'https://example.com/old-version';
    const newUrl = 'https://example.com/new-version';
    store.addUrls(current.id, [{ input: oldUrl, line: 1 }]);
    const [{ id: urlId }] = store.addressRows(current.id);
    for (let i = 0; i < 101; i++) {
      store.enqueue(current.id);
      finishNextRun(store);
    }
    await page.goto(`/?project=${current.id}&address=${urlId}`);
    const card = page.getByRole('dialog', { name: 'История URL' });
    const results = card.locator('.result');
    await expect(results).toHaveCount(100);
    await card.getByRole('button', { name: 'Загрузить ещё' }).click();
    await expect(results).toHaveCount(101);
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/runs'));
    await card.getByRole('button', { name: 'Проверить этот URL' }).click();
    await accepted;
    finishNextRun(store, () => store.editUrl(current.id, urlId, newUrl, ''));
    await expect(card.locator('.modal-header').getByText(newUrl, { exact: true })).toBeVisible();
    await expect(card.getByRole('status', { name: 'Текущая версия URL' })).toContainText('Не проверен');
    await expect(results).toHaveCount(102);
    await expect(card.locator('.result-code')).toHaveText(Array.from({ length: 102 }, () => '200'));
  } finally { await fixture.close(); }
});

async function inbox(page: Page, count: number, unread = 1) {
  const fixture = await localDatabase(page);
  const { store } = fixture;
  const project = store.createProject('Лента аудита', '');
  store.addUrls(project.id, [{ input: 'example.com/inbox', line: 1 }]);
  store.saveSettings(project.id, { schedule: null, notify: 'all', email: null });
  for (let i = 0; i < count; i++) {
    store.enqueue(project.id);
    finishNextRun(store);
    if (i === count - unread - 1) store.markRead();
  }
  return fixture;
}

test('marks all notifications read from a page without unread entries', async ({ page }) => {
  const fixture = await inbox(page, 101);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Уведомления', exact: true }).click();
    const markAll = page.getByRole('button', { name: 'Отметить все как прочитанные' });
    await expect(markAll).toBeVisible();
    const pagination = page.getByRole('navigation', { name: 'Страницы уведомлений' });
    await pagination.getByRole('button', { name: 'Следующая страница' }).click();
    await expect(pagination.getByText('Страница 2')).toBeVisible();
    await markAll.click({ timeout: 2000 });
    await expect(markAll).toHaveCount(0);
    await expect(page.locator('.notification-count')).toHaveCount(0);
    await expect(pagination.getByText('Страница 2')).toBeVisible();
  } finally { await fixture.close(); }
});

test('opening a report marks just its own notification read', async ({ page }) => {
  const fixture = await inbox(page, 3, 2);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Уведомления', exact: true }).click();
    const unread = page.locator('.notification-count');
    await expect(unread).toHaveText('2');
    const newest = page.getByRole('article').filter({ hasText: 'Запуск №3' });
    await newest.getByRole('button', { name: 'Открыть отчёт' }).click();
    await expect(page.getByRole('dialog', { name: 'Отчёт по запуску №3' })).toBeVisible();
    await expect(unread).toHaveText('1');
    expect(fixture.store.notifications().map(entry => [entry.runId, !!entry.readAt])).toEqual([[3, true], [2, false], [1, true]]);
  } finally { await fixture.close(); }
});

test('returns from a report to the page-three notification and its focused opener', async ({ page }) => {
  const fixture = await inbox(page, 201);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Уведомления', exact: true }).click();
    const pagination = page.getByRole('navigation', { name: 'Страницы уведомлений' });
    const next = pagination.getByRole('button', { name: 'Следующая страница' });
    await next.click();
    await next.click();
    await expect(pagination.getByText('Страница 3')).toBeVisible();
    const open = page.getByRole('article').filter({ hasText: 'Запуск №1' }).getByRole('button', { name: 'Открыть отчёт' });
    const report = page.getByRole('dialog', { name: 'Отчёт по запуску №1' });
    await open.click();
    await expect(report).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
    await open.click();
    await report.getByRole('button', { name: 'Закрыть' }).click();
    await expect(open).toBeFocused();
    await expect(pagination.getByText('Страница 3')).toBeVisible();
  } finally { await fixture.close(); }
});

test('adds the selected URL into the current group even when local search matches nothing', async ({ page, request }) => {
  const a = 'https://example.com/add-to-current-group';
  const current = await project(request, 'Явная область группы', a);
  const { id } = await (await request.post(current.path + '/groups', { data: { name: 'Оплата' } })).json();
  await page.goto(current.url);
  await page.getByRole('checkbox', { name: 'Выбрать ' + a, exact: true }).check();
  await page.getByRole('combobox', { name: 'Рабочая группа' }).selectOption(String(id));
  await expect(page.getByText('Выбрано: 1')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить в «Оплата»' }).click();
  await expect(page.getByRole('button', { name: a, exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Поиск по адресам' }).fill('query-with-no-match');
  await expect(page.getByText('Адреса не найдены')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Проверить группу целиком · 1 URL' })).toBeEnabled();
});

test('keeps filter borders distinguishable on mobile', async ({ page, request }) => {
  const current = await project(request, 'Границы фильтра', 'example.com/contrast');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(current.url);
  const filter = page.getByRole('combobox', { name: 'Фильтр по статусу' });
  const ratio = await filter.evaluate(element => {
    const styles = getComputedStyle(element);
    function luminance(color: string) {
      const [r, g, b] = color.match(/\d+/g)!.map(channel => {
        const value = Number(channel) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const border = luminance(styles.borderTopColor);
    const background = luminance(styles.backgroundColor);
    return (Math.max(border, background) + 0.05) / (Math.min(border, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(3);
});

test('shows a long original result URL on mobile when opened by keyboard', async ({ page, request }) => {
  const url = 'https://example.com/' + 'history-address-'.repeat(17) + 'visible-end';
  const current = await project(request, 'Полный URL в отчёте', url);
  const { id } = await (await request.post(current.path + '/runs', { data: {} })).json();
  await expect.poll(async () => (await (await request.get(`${current.path}/runs/${id}`)).json()).run.status).toBe('done');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${current.url}&run=${id}`);
  const summary = page.locator('.result summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  const result = page.locator('.result');
  await expect(result).toHaveAttribute('open', '');
  const original = summary.locator('strong');
  await expect(original).toHaveText(url);
  expect(await original.evaluate(element => element.scrollWidth)).toBe(await original.evaluate(element => element.clientWidth));
  await expect(result.getByRole('button', { name: `История этого URL: ${url}` })).toBeVisible();
});
