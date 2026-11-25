import { expect, test } from './fixtures.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { CheckResult } from '../src/shared/types.js';

test('installs, previews, replaces and disables the project PAC file', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await request.post('/api/projects', { data: { name: 'Маршруты PAC' } });
  expect(project.ok()).toBe(true);
  const { id } = await project.json();
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();

  const pac = page.getByRole('region', { name: 'PAC-файл проекта' });
  await pac.getByRole('button', { name: 'Загрузить PAC-файл' }).click({ timeout: 3_000 });
  const upload = page.getByRole('dialog', { name: 'Загрузить PAC-файл' });
  await upload.getByLabel('Файл .pac').setInputFiles({
    name: 'project.pac', mimeType: 'application/x-ns-proxy-autoconfig',
    buffer: Buffer.from(`function FindProxyForURL(url, host) {
      return host === 'example.com' ? 'PROXY proxy.example.com:8080; HTTPS reserve.example.com:8443; DIRECT' : 'DIRECT';
    }`),
  });
  await upload.getByRole('button', { name: 'Сохранить PAC' }).click();
  await expect(upload).toHaveCount(0);
  await expect(pac.getByText('project.pac', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await pac.getByRole('button', { name: 'Проверить маршрут' }).click();
  const preview = page.getByRole('dialog', { name: 'Проверить маршрут PAC' });
  const url = preview.getByRole('textbox', { name: 'URL для проверки' });
  const routes = preview.getByRole('list', { name: 'Маршруты PAC' }).getByRole('listitem');
  await url.fill('https://example.com/page');
  await preview.getByRole('button', { name: 'Проверить маршрут' }).click();
  await expect(routes).toHaveText([
    /Основной маршрут.*http:\/\/proxy\.example\.com:8080$/,
    /Резервный маршрут.*https:\/\/reserve\.example\.com:8443$/,
    /Резервный маршрут.*Напрямую/,
  ]);
  await url.fill('https://other.example.com/page');
  await expect(routes).toHaveCount(0);
  await preview.getByRole('button', { name: 'Проверить маршрут' }).click();
  await expect(routes).toHaveText([/Основной маршрут.*Напрямую/]);
  await preview.getByRole('button', { name: 'Закрыть окно' }).click();

  await pac.getByRole('button', { name: 'Заменить PAC-файл' }).click();
  const replace = page.getByRole('dialog', { name: 'Заменить PAC-файл' });
  const file = replace.getByLabel('Файл .pac');
  await file.setInputFiles({
    name: 'invalid.pac', mimeType: 'application/x-ns-proxy-autoconfig', buffer: Buffer.from('function {'),
  });
  await replace.getByRole('button', { name: 'Сохранить PAC' }).click();
  await expect(replace.getByRole('alert')).toContainText(/PAC/);
  await file.setInputFiles({
    name: 'replacement.pac', mimeType: 'application/x-ns-proxy-autoconfig',
    buffer: Buffer.from(`function FindProxyForURL() { return 'DIRECT'; }`),
  });
  await replace.getByRole('button', { name: 'Сохранить PAC' }).click();
  await expect(replace).toHaveCount(0);
  await expect(pac.getByText('replacement.pac', { exact: true })).toBeVisible();
  await pac.getByRole('button', { name: 'Проверить маршрут' }).click();
  await url.fill('https://example.com/page');
  await preview.getByRole('button', { name: 'Проверить маршрут' }).click();
  await expect(routes).toHaveText([/Основной маршрут.*Напрямую/]);
  await preview.getByRole('button', { name: 'Закрыть окно' }).click();

  await pac.getByRole('button', { name: 'Отключить PAC', exact: true }).click();
  const disable = page.getByRole('dialog', { name: 'Отключить PAC проекта?' });
  await disable.getByRole('button', { name: 'Отключить PAC' }).click();
  await expect(pac.getByText('PAC не настроен', { exact: true })).toBeVisible();
  await expect(pac.getByRole('button', { name: 'Проверить маршрут' })).toHaveCount(0);
});

test('configures, localizes and removes a trusted proxy for a project', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await request.post('/api/projects', { data: { name: 'Офисная сеть' } });
  const { id } = await project.json();
  const path = `/api/projects/${id}/proxy-pac`;
  const uploaded = await request.put(path, { data: {
    filename: 'office.pac', source: "function FindProxyForURL() { return 'HTTPS proxy.office.test:8443'; }",
  } });
  expect(uploaded.ok()).toBe(true);
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить доверенный прокси' }).click({ timeout: 3_000 });
  const editor = page.getByRole('dialog');
  const origin = 'https://proxy.office.test:8443';
  await expect(editor.getByLabel('Адрес прокси')).toBeFocused();
  await editor.getByLabel('Адрес прокси').fill('http://proxy.office.test:8443');
  await expect(editor.getByLabel('Авторизация Basic')).toBeDisabled();
  await editor.getByLabel('Адрес прокси').fill(origin);
  await editor.getByLabel('Разрешить приватный IP прокси').check();
  await editor.getByLabel('Передавать имя цели в CONNECT').check();
  await editor.getByLabel('Авторизация Basic').check();
  await editor.getByLabel('Логин прокси').fill('alice');
  await editor.getByLabel('Переменная окружения для пароля').fill('PULSE_REQUEST_SECRET_OFFICE');
  await editor.getByRole('combobox', { name: 'Язык', exact: true }).selectOption('en-US');
  await expect(editor.getByLabel('Proxy address')).toHaveValue(origin);
  await expect(editor.getByLabel('Allow a private proxy IP')).toBeChecked();
  await expect(editor.getByLabel('Password environment variable')).toHaveValue('PULSE_REQUEST_SECRET_OFFICE');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const saved = (await (await request.get(path)).json()).pac.proxies;
  expect(saved).toEqual([{ url: origin, allowPrivate: true, connectByHostname: true,
    auth: { username: 'alice', configured: true, environment: 'PULSE_REQUEST_SECRET_OFFICE' } }]);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const proxy = page.getByRole('listitem').filter({ hasText: origin });
  await expect(proxy.getByText('Basic configured')).toBeVisible();
  await proxy.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog', { name: 'Remove trusted proxy?' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(proxy).toHaveCount(0);
  expect((await (await request.get(path)).json()).pac.proxies).toBeUndefined();
});

test('shows the saved endpoint and routing source, including PAC evaluation failures', async ({ page }) => {
  const store = new Store(':memory:');
  const app = createApp({ store });
  const proxyUrl = 'https://example.com/through-pac';
  const failedUrl = 'https://example.com/pac-error';
  const profileUrl = 'https://example.com/profile-proxy';
  const result: CheckResult = {
    status: 'ok', httpCode: 200, durationMs: 35, finalUrl: proxyUrl, redirects: 0,
    contentType: 'text/html', contentLength: null, errorKind: null, error: null,
    requestProxy: 'https://reserve.example.com:8443', requestSource: 'pac', requestRoute: 'proxy',
  };
  try {
    const project = store.createProject('Отчёт по PAC', '');
    store.addUrls(project.id, [proxyUrl, failedUrl, profileUrl].map((input, index) => ({ input, line: index + 1 })));
    const run = store.enqueue(project.id);
    for (const item of store.claim()!.items) {
      const finalUrl = item.url;
      store.saveResult(item.id, finalUrl === failedUrl ? {
        ...result, finalUrl, status: 'error', httpCode: null, errorKind: 'configuration', error: 'Ошибка выполнения FindProxyForURL.',
        requestProxy: null, requestRoute: null, failureStage: 'pac',
      } : finalUrl === profileUrl ? {
        ...result, finalUrl, requestProxy: 'http://fixed.example.com:8080', requestSource: 'profile', requestProfile: 'Ручной прокси',
      } : result);
    }
    store.finish(run.id);
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const response = await app.inject(url.pathname + url.search);
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto(`/?project=${project.id}&run=${run.id}`);
    const report = page.getByRole('dialog', { name: /Отчёт по запуску/ });
    const viaPac = report.locator('details').filter({ has: page.getByText(proxyUrl, { exact: true }) });
    const viaProfile = report.locator('details').filter({ has: page.getByText(profileUrl, { exact: true }) });
    const failed = report.locator('details').filter({ has: page.getByText(failedUrl, { exact: true }) });
    await viaPac.locator('summary').click();
    await expect(viaPac.getByText('https://reserve.example.com:8443', { exact: true })).toBeVisible({ timeout: 3_000 });
    await expect(viaPac.getByText('PAC проекта', { exact: true })).toBeVisible();
    await viaProfile.locator('summary').click();
    await expect(viaProfile.getByText('http://fixed.example.com:8080', { exact: true })).toBeVisible();
    await expect(viaProfile.getByText('HTTP-профиль', { exact: true })).toBeVisible();
    await failed.locator('summary').click();
    await expect(failed.getByText('Выбор маршрута PAC', { exact: true })).toBeVisible();
    await expect(failed.getByText('Адрес прокси', { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    store.close();
  }
});
