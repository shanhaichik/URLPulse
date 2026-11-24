import { expect, test } from './fixtures.js';

test('uses the applied catalog scope, retries the same page and resets combined filters', async ({ page, request }) => {
  const project = await request.post('/api/projects', { data: { name: 'Область действий каталога' } });
  const { id } = await project.json();
  const root = `/api/projects/${id}`;
  const path = `${root}/catalog`;
  const urls = Array.from({ length: 101 }, (_, index) => `https://example.com/section/${String(index).padStart(3, '0')}`);
  const outside = 'https://example.net/outside';
  const imported = await request.post(`${path}/imports`, { data: { fileName: 'scope.xml' } });
  const job = await imported.json();
  expect((await request.put(`${path}/imports/${job.id}/file`, {
    headers: { 'Content-Type': 'application/octet-stream' },
    data: Buffer.from(`<urlset>${[...urls, outside].map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`),
  })).status()).toBe(202);
  await expect.poll(async () => (await (await request.get(path)).json()).jobs[0].state).toBe('done');

  const secondPage: string[] = [];
  let allowFilteredResponse!: () => void;
  const holdFilteredResponse = new Promise<void>(resolve => { allowFilteredResponse = resolve; });
  await page.route(`${path}/page?*`, async route => {
    const url = route.request().url();
    const params = new URL(url).searchParams;
    if (params.has('after')) {
      secondPage.push(url);
      if (secondPage.length === 1) {
        await route.fulfill({ status: 503, json: { error: 'Каталог временно недоступен.' } });
        return;
      }
    } else if (params.get('domain') === 'example.com' && params.get('change') === 'all') {
      await holdFilteredResponse;
    }
    await route.continue();
  });
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: 'Каталог sitemap', exact: true }).click();
  const catalog = page.getByRole('region', { name: 'Адреса из sitemap' });
  const domain = catalog.getByLabel('Домен', { exact: true });
  const prefix = catalog.getByLabel('Начало пути');
  const change = catalog.getByRole('combobox', { name: 'Изменения', exact: true });
  const sort = catalog.getByRole('combobox', { name: 'Сортировка', exact: true });
  const add = catalog.getByRole('button', { name: 'В рабочий список', exact: true });
  const check = catalog.getByRole('button', { name: 'Проверить', exact: true });
  const csv = catalog.getByRole('link', { name: 'CSV по фильтру' });
  const found = catalog.getByRole('cell', { name: urls[100], exact: true });

  await expect(add).toBeEnabled();
  for (const field of [change, sort]) {
    await expect(field).toHaveCSS('appearance', 'none');
    const layout = await field.evaluate(element => {
      const arrow = element.nextElementSibling!.getBoundingClientRect();
      const control = element.getBoundingClientRect();
      return {
        inset: control.right - arrow.right,
        centerOffset: Math.abs((control.top + control.bottom - arrow.top - arrow.bottom) / 2),
        padding: parseFloat(getComputedStyle(element).paddingInlineEnd),
      };
    });
    expect(layout.inset).toBeGreaterThanOrEqual(10);
    expect(layout.centerOffset).toBeLessThanOrEqual(1);
    expect(layout.padding).toBeGreaterThanOrEqual(28);
  }
  await domain.fill('example.com');
  await prefix.fill('/section/');
  await expect(catalog.getByText('Примените изменения кнопкой «Найти».')).toBeVisible();
  await expect(add).toBeDisabled();
  await expect(check).toBeDisabled();
  await expect(csv).toHaveCount(0);
  expect(await (await request.get(`${root}/urls`)).json()).toEqual([]);

  const requestStarted = page.waitForRequest(request => request.url().includes('/catalog/page?') && request.url().includes('domain=example.com'));
  try {
    await catalog.getByRole('button', { name: 'Найти', exact: true }).click();
    await requestStarted;
    await expect(add).toBeDisabled();
    await expect(check).toBeDisabled();
    await expect(csv).toHaveCount(0);
  } finally {
    allowFilteredResponse();
  }
  await change.selectOption('added');
  await sort.selectOption('desc');
  await expect(found).toBeVisible();
  await expect(catalog.getByText(/Применено.*example\.com.*\/section\/.*Новые/)).toBeVisible();
  await expect(catalog.getByText('Проверка и перенос охватят до 100 первых URL по применённым условиям.')).toBeVisible();
  await catalog.getByLabel('Первые URL по фильтру').fill('1');
  await expect(catalog.getByText('Проверка и перенос охватят до 1 первых URL по применённым условиям.')).toBeVisible();
  await expect(csv).toHaveAttribute('href', /domain=example\.com/);
  await add.click();
  await expect(catalog.getByText('В работе добавлено: 1 · Повторы: 0')).toBeVisible();
  expect((await (await request.get(`${root}/urls`)).json()).map((address: { url: string }) => address.url)).toEqual([urls[100]]);

  await catalog.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(catalog.getByText('Каталог временно недоступен.')).toBeVisible();
  await expect(add).toBeDisabled();
  await catalog.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(catalog.getByRole('cell', { name: urls[0], exact: true })).toBeVisible();
  await expect(catalog.getByText('Страница 2', { exact: true })).toBeVisible();
  expect(secondPage).toEqual([secondPage[0], secondPage[0]]);

  await catalog.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await expect(domain).toHaveValue('');
  await expect(prefix).toHaveValue('');
  await expect(change).toHaveValue('all');
  await expect(sort).toHaveValue('asc');
  await expect(catalog.getByText('Страница 1', { exact: true })).toBeVisible();
  await expect(catalog.getByRole('cell', { name: urls[0], exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Очистить каталог', exact: true })).toBeVisible();
});
