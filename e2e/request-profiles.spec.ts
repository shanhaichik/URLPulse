import { expect, test } from './fixtures.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

const proxyFailure = {
  status: 'error', httpCode: null, durationMs: 24, finalUrl: 'https://example.com/proxy-failure', redirects: 0,
  contentType: null, contentLength: null, errorKind: 'connection', error: 'Прокси отклонил запрос.',
  requestProfile: 'Проверка через прокси', requestRoute: 'proxy', failureStage: 'proxy', proxyHttpCode: 407,
} as const;

test('manages request profiles and assigns one to a matching URL', async ({ page, request }) => {
  const project = await request.post('/api/projects', { data: { name: 'Профили HTTP' } });
  expect(project.ok()).toBe(true);
  const { id } = await project.json();
  const root = `/api/projects/${id}`;
  const url = 'https://example.com/profile-check';
  const imported = await request.post(root + '/urls', { data: { input: url } });
  expect(imported.ok()).toBe(true);
  const { items: [address] } = await (await request.get(root + '/urls/page')).json();
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const create = page.getByRole('button', { name: 'Добавить профиль' });
  await create.click();
  const form = page.getByRole('dialog', { name: 'Новый профиль HTTP' });
  await expect(form.getByRole('textbox', { name: 'Название профиля' })).toBeFocused();
  await form.getByRole('textbox', { name: 'Название профиля' }).fill('Профиль приложения');
  await form.getByLabel('Адрес сервера').fill('https://example.com');
  await form.getByRole('button', { name: 'Добавить заголовок' }).click();
  const header = form.getByRole('group', { name: 'Заголовок 1' });
  await expect(header.getByRole('textbox', { name: 'Имя' })).toBeFocused();
  await header.getByRole('textbox', { name: 'Имя' }).fill('Accept-Language');
  await header.getByRole('textbox', { name: 'Значение' }).fill('ru');
  await form.getByLabel('Авторизация сайта').selectOption('bearer');
  await form.getByRole('textbox', { name: 'Переменная окружения для токена' }).fill('PULSE_REQUEST_SECRET_E2E_BEARER');
  await form.getByRole('button', { name: 'Сохранить профиль' }).click();
  await expect(form).toHaveCount(0);
  const list = page.getByRole('list', { name: 'Профили запросов' });
  const profile = list.getByRole('listitem').filter({ hasText: 'Профиль приложения' });
  await expect(profile).toBeVisible();
  const { profiles: [saved] } = await (await request.get(root + '/request-profiles')).json();
  expect(saved).toMatchObject({ name: 'Профиль приложения', headers: [{ name: 'accept-language', value: 'ru' }] });

  await profile.getByRole('button', { name: 'Редактировать' }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать профиль HTTP' });
  await expect(editor.getByText('Секрет настроен', { exact: true })).toBeVisible();
  await expect(editor.getByRole('textbox', { name: 'Переменная окружения для токена' })).toHaveValue('');
  await editor.getByLabel('Авторизация сайта').selectOption('none');
  await editor.getByRole('button', { name: 'Сохранить профиль' }).click();
  await expect(editor).toHaveCount(0);

  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  const editAddress = page.getByRole('button', { name: `Редактировать ${url}`, exact: true });
  await editAddress.click();
  const addressForm = page.getByRole('dialog', { name: 'Редактировать URL' });
  const picker = addressForm.getByLabel('Профиль HTTP-запроса');
  await expect(picker).toHaveValue('inherit');
  await addressForm.getByRole('textbox', { name: 'URL', exact: true }).fill('https://another.example.com/profile-check');
  await expect(picker.locator('option').filter({ hasText: 'Профиль приложения' })).toHaveCount(0);
  await addressForm.getByRole('textbox', { name: 'URL', exact: true }).fill(url);
  await picker.selectOption({ label: 'Профиль приложения' });
  await addressForm.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(addressForm).toHaveCount(0);
  const selectionPath = `${root}/urls/${address.id}/request-profile`;
  expect(await (await request.get(selectionPath)).json()).toMatchObject({ profileId: saved.id });
  await editAddress.click();
  await expect(picker).toHaveValue(String(saved.id));
  await picker.selectOption('direct');
  await addressForm.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(addressForm).toHaveCount(0);
  expect(await (await request.get(selectionPath)).json()).toMatchObject({ profileId: null });

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await profile.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('dialog', { name: 'Удалить профиль HTTP?' }).getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(profile).toHaveCount(0);
});

test('identifies a proxy 407 in a profile test result', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id } = await (await request.post('/api/projects', { data: { name: 'Тест прокси' } })).json();
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить профиль' }).click();
  const editor = page.getByRole('dialog', { name: 'Новый профиль HTTP' });
  await editor.getByLabel('Название профиля').fill(proxyFailure.requestProfile);
  await editor.getByLabel('Адрес сервера').fill('https://example.com');
  await editor.getByLabel('Маршрут подключения').selectOption('proxy');
  await editor.getByLabel('Адрес прокси').fill('https://proxy.example.com:8443');
  await editor.getByRole('button', { name: 'Сохранить профиль' }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: 'Проверить профиль', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Проверить профиль' });
  await dialog.getByRole('textbox', { name: 'URL для проверки' }).fill(proxyFailure.finalUrl);
  await dialog.getByRole('button', { name: 'Проверить профиль' }).click();
  const result = dialog.getByRole('status');
  await expect(result).toContainText('Ошибка авторизации прокси');
  await expect(result).toContainText('HTTP прокси');
  await expect(result).toContainText('407');
  await expect(result).toContainText('24 мс');
});

test('distinguishes proxy authentication from an HTTP 401 at the site in a saved report', async ({ page }) => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  try {
    const project = store.createProject('Отчёт по профилям', '');
    const siteUrl = 'https://example.com/site-auth';
    store.addUrls(project.id, [{ input: proxyFailure.finalUrl, line: 1 }, { input: siteUrl, line: 2 }]);
    const run = store.enqueue(project.id);
    for (const item of store.claim()!.items) {
      store.saveResult(item.id, item.url === proxyFailure.finalUrl ? proxyFailure : {
        ...proxyFailure, finalUrl: siteUrl, httpCode: 401, proxyHttpCode: null, failureStage: 'target', errorKind: 'http', error: 'HTTP 401',
      });
    }
    store.finish(run.id);
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const response = await app.inject(url.pathname + url.search);
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto(`/?project=${project.id}&run=${run.id}`);
    const report = page.getByRole('dialog', { name: /Отчёт по запуску/ });
    const proxy = report.locator('details').filter({ has: page.getByText(proxyFailure.finalUrl, { exact: true }) });
    const site = report.locator('details').filter({ has: page.getByText(siteUrl, { exact: true }) });
    await proxy.locator('summary').click();
    await expect(proxy).toContainText('Ошибка авторизации прокси');
    await expect(proxy).toContainText('407');
    await expect(proxy).toContainText(proxyFailure.requestProfile);
    await site.locator('summary').click();
    await expect(site).toContainText('Запрос к сайту');
    await expect(site).toContainText('401');
    await expect(site).not.toContainText('Ошибка авторизации прокси');
  } finally {
    await app.close();
    store.close();
  }
});
