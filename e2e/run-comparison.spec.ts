import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { expect, test } from './fixtures.js';

test('chooses comparison runs across picker pages, restores filters and reopens the source report', async ({ page }) => {
  let time = Date.UTC(2026, 10, 23, 10, 0);
  const store = new Store(':memory:', () => ++time);
  const app = createApp({ store, staticRoot: resolve(process.env.PULSE_E2E_STATIC_ROOT || 'dist/client') });
  try {
    const project = store.createProject('Сравнение проверок', '');
    const urls = ['https://example.test/regression', 'https://example.test/redirect', 'https://example.test/same'];
    store.addUrls(project.id, urls.map((input, index) => ({ input, line: index + 1 })));
    function completeRun(changed = false) {
      const { id } = store.enqueue(project.id);
      for (const item of store.claim()!.items) {
        const error = changed && item.url === urls[0];
        const finalUrl = changed && item.url === urls[1] ? item.url + '/new' : item.url;
        store.saveResult(item.id, { status: error ? 'error' : 'ok', httpCode: error ? 503 : 200,
          durationMs: 100, finalUrl, redirects: Number(finalUrl !== item.url), contentType: 'text/html',
          contentLength: null, errorKind: error ? 'http' : null, error: error ? 'HTTP 503' : null });
      }
      store.finish(id);
      return id;
    }
    const baseline = completeRun();
    let previous = baseline;
    for (let index = 0; index < 26; index++) previous = completeRun();
    const target = completeRun(true);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?project=${project.id}&tab=runs`);
    const openComparison = page.getByRole('button', { name: 'Сравнить прогоны', exact: true });
    await openComparison.press('Enter');
    const comparison = page.getByRole('dialog', { name: 'Сравнение прогонов', exact: true });
    await expect(comparison).toBeVisible();

    const before = comparison.getByRole('region', { name: 'Было', exact: true });
    const after = comparison.getByRole('region', { name: 'Стало', exact: true });
    await before.getByRole('button', { name: 'Выбрать прогон', exact: true }).click();
    const beforePicker = page.getByRole('dialog', { name: 'Выберите прогон — Было', exact: true });
    await beforePicker.getByRole('button', { name: 'Следующая страница', exact: true }).click();
    await expect(beforePicker.getByText('Страница 2', { exact: true })).toBeVisible();
    await beforePicker.getByRole('button', { name: `Выбрать прогон №${baseline}`, exact: true }).click();
    await after.getByRole('button', { name: 'Выбрать прогон', exact: true }).click();
    const afterPicker = page.getByRole('dialog', { name: 'Выберите прогон — Стало', exact: true });
    await afterPicker.getByRole('button', { name: `Выбрать прогон №${target}`, exact: true }).click();
    const table = comparison.getByRole('table', { name: 'Результаты сравнения', exact: true });
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table).toContainText(urls[0]);
    await expect(table).toContainText(urls[1]);
    await expect(table).not.toContainText(urls[2]);
    const regression = table.getByRole('row').filter({ hasText: urls[0] });
    await expect(regression.getByRole('cell', { name: /HTTP 200/ })).toBeVisible();
    await expect(regression.getByRole('cell', { name: /HTTP 503/ })).toBeVisible();
    await regression.getByRole('button', { name: 'Подробности', exact: true }).click();
    await expect(table.getByText('Конечный URL', { exact: true }).first()).toBeVisible();

    const summary = comparison.getByRole('region', { name: 'Сводка сравнения', exact: true });
    await summary.getByRole('button', { name: /Новые сбои/ }).click();
    await expect(table.getByRole('row')).toHaveCount(2);
    const search = comparison.getByRole('searchbox', { name: 'URL или название', exact: true });
    await search.fill('regression');
    await search.press('Enter');
    const json = comparison.getByRole('link', { name: 'JSON', exact: true });
    await expect.poll(async () => {
      const href = await json.getAttribute('href');
      const url = new URL(href!, page.url());
      return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
    }).toEqual({ path: `/api/projects/${project.id}/run-comparison/export`,
      params: { baseline: String(baseline), target: String(target), q: 'regression', kind: 'regression', format: 'json' } });
    const download = page.waitForEvent('download');
    await json.click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2} - Сравнение проверок\.json$/);
    const exported = JSON.parse(await readFile(await file.path(), 'utf8'));
    expect(exported).toMatchObject({ baseline: { id: baseline }, target: { id: target }, rows: [
      { baseline: { result: { url: urls[0], httpCode: 200 } }, target: { result: { url: urls[0], httpCode: 503 } } },
    ] });
    await page.reload();
    await expect(search).toHaveValue('regression');
    await expect(summary.getByRole('button', { name: /Новые сбои/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(table).toContainText(urls[0]);
    await comparison.getByRole('button', { name: 'Поменять местами', exact: true }).click();
    await expect(before).toContainText(`№${target}`);
    await expect(after).toContainText(`№${baseline}`);
    await expect(table).toContainText(urls[0]);
    await expect(regression.getByRole('cell').nth(1)).toContainText('HTTP 503');
    await expect(regression.getByRole('cell').nth(2)).toContainText('HTTP 200');
    const comparisonWidth = await comparison.evaluate(element => ({ actual: element.scrollWidth, visible: element.clientWidth }));
    expect(comparisonWidth.actual).toBe(comparisonWidth.visible);
    await page.keyboard.press('Escape');
    await expect(comparison).toHaveCount(0);
    await expect(openComparison).toBeVisible();

    await page.getByRole('row').filter({ hasText: `№${target} ·` })
      .getByRole('button', { name: 'Открыть отчёт', exact: true }).click();
    const report = page.getByRole('dialog', { name: `Отчёт по запуску №${target}`, exact: true });
    const compareReport = report.getByRole('button', { name: 'Сравнить с другим прогоном', exact: true });
    await compareReport.click();
    await expect(before).toContainText(`№${previous}`);
    await expect(after).toContainText(`№${target}`);
    await page.keyboard.press('Escape');
    await expect(report).toBeVisible();
    await expect(compareReport).toBeFocused();
  } finally { await app.close(); store.close(); }
});

test('keeps comparison open if a run was deleted before export', async ({ page, request }) => {
  const created = await request.post('/api/projects', { data: { name: 'Удаление отчёта при сравнении' } });
  expect(created.ok()).toBe(true);
  const project = await created.json() as { id: number };
  const path = `/api/projects/${project.id}`;
  expect((await request.post(path + '/urls', { data: { input: 'https://example.com/still-available' } })).ok()).toBe(true);
  const runs: number[] = [];
  for (let index = 0; index < 3; index++) {
    const createdRun = await request.post(path + '/runs', { data: {} });
    expect(createdRun.ok()).toBe(true);
    const run = await createdRun.json() as { id: number };
    await expect.poll(async () => (await (await request.get(`${path}/runs/${run.id}`)).json()).run.status).toBe('done');
    runs.push(run.id);
  }
  const [replacement, baseline, target] = runs;
  await page.goto(`/?project=${project.id}&tab=runs&compare=1&baseline=${baseline}&target=${target}`);
  const comparison = page.getByRole('dialog', { name: 'Сравнение прогонов', exact: true });
  const json = comparison.getByRole('link', { name: 'JSON', exact: true });
  await expect(json).toBeVisible();
  const original = page.url();
  expect((await request.delete(`${path}/runs/${baseline}`)).ok()).toBe(true);
  await json.click();
  await expect(comparison.getByRole('alert')).toContainText('Выберите другой прогон');
  await expect(page).toHaveURL(original);
  await expect(json).toHaveCount(0);
  const left = comparison.getByRole('region', { name: 'Было', exact: true });
  await left.getByRole('button', { name: 'Изменить прогон', exact: true }).click();
  await page.getByRole('dialog', { name: 'Выберите прогон — Было', exact: true })
    .getByRole('button', { name: `Выбрать прогон №${replacement}`, exact: true }).click();
  await expect(left).toContainText(`№${replacement}`);
  await expect(comparison.getByRole('alert')).toHaveCount(0);
  await expect(json).toBeVisible();
});
