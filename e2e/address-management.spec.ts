import { expect, test } from './fixtures.js';

test('shows the filtered count and resets the search and status in the mobile worklist', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id } = await (await request.post('/api/projects', { data: { name: 'Панель адресов' } })).json();
  await request.post(`/api/projects/${id}/urls`, {
    data: { input: 'https://example.com/alpha\nhttps://example.com/alpha-two\nhttps://example.com/beta' },
  });
  await page.goto(`/?project=${id}`);
  const panel = page.locator('.address-panel');
  const search = panel.getByRole('searchbox', { name: 'Поиск по адресам' });
  const status = panel.getByRole('combobox', { name: 'Фильтр по статусу' });
  const actions = panel.getByRole('button', { name: 'Действия', exact: true });
  const add = panel.getByRole('button', { name: 'Добавить URL', exact: true });
  await expect(add).toHaveClass(/\bprimary\b/);
  const searchControl = panel.locator('.address-filters .search');
  const [searchBox, statusBox, actionsBox, addBox] = await Promise.all(
    [searchControl, status, actions, add].map(control => control.boundingBox()),
  );
  expect(searchBox!.width).toBeGreaterThan((await panel.boundingBox())!.width * 0.9);
  expect(statusBox!.y).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height);
  for (const box of [statusBox, actionsBox, addBox]) expect(box!.height).toBeCloseTo(searchBox!.height);
  await expect(panel.getByText('Всего 3', { exact: true })).toBeVisible();

  await search.fill('alpha');
  await expect(panel.getByText('Найдено 2 из 3', { exact: true })).toBeVisible();
  await status.selectOption('ok');
  await expect(panel.getByText('Найдено 0 из 3', { exact: true })).toBeVisible();
  const reset = panel.getByRole('button', { name: 'Сбросить фильтры', exact: true });
  await expect(reset).toHaveCount(1);
  await reset.click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(status).toHaveValue('all');
  await expect(panel.getByText(/^Найдено/)).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'https://example.com/beta', exact: true })).toBeVisible();
});

test('warns about active and queued checks before clearing the project worklist', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = await (await request.post('/api/projects', { data: { name: 'Очистка адресов' } })).json();
  const root = `/api/projects/${project.id}`;
  await request.post(root + '/urls', { data: { input: 'example.com/clear-first\nexample.com/clear/wait-for-stop' } });
  const { items: [first] } = await (await request.get(root + '/urls/page')).json();
  const running = await (await request.post(root + '/runs', { data: {} })).json();
  const group = await (await request.post(root + '/groups', { data: { name: 'Сохранённая группа' } })).json();
  const getRun = async (runId: number) => (await (await request.get(`${root}/runs/${runId}`)).json());
  const pending: number[] = [running.id];
  try {
    await expect.poll(async () => (await getRun(running.id)).run.completed).toBe(1);
    const queued = await (await request.post(root + '/runs', { data: { ids: [first.id] } })).json();
    pending.push(queued.id);
    await page.goto(`/?project=${project.id}`);
    const actions = page.getByRole('button', { name: 'Действия', exact: true });
    const clear = page.getByRole('button', { name: 'Удалить все адреса проекта', exact: true });
    const search = page.getByRole('searchbox', { name: 'Поиск по адресам' });
    const status = page.getByLabel('Фильтр по статусу');
    const groups = page.getByLabel('Рабочая группа', { exact: true });
    await expect(clear).toHaveCount(0);
    await search.fill('first');
    await actions.click();
    await expect(clear).toBeDisabled();
    await expect(clear).toBeInViewport({ ratio: 1 });
    await expect(page.getByText('Сбросьте поиск и фильтр статуса.', { exact: true })).toBeVisible();
    await actions.press('Escape');
    await expect(clear).toHaveCount(0);
    await expect(actions).toBeFocused();
    await search.fill('');
    await status.selectOption('ok');
    await actions.click();
    await expect(clear).toBeDisabled();
    await actions.press('Escape');
    await status.selectOption('all');
    await groups.selectOption(String(group.id));
    await actions.click();
    await expect(clear).toBeDisabled();
    await actions.press('Escape');
    await groups.selectOption('');

    await actions.click();
    await clear.click();
    const dialog = page.getByRole('dialog', { name: 'Удалить все адреса проекта?' });
    await expect(dialog).toContainText('Очистка адресов');
    await expect(dialog).toContainText('Адресов к удалению: 2');
    await expect(dialog).toContainText('Выполняется: 1. В очереди: 1.');
    const cancel = dialog.getByRole('button', { name: 'Отмена' });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await cancel.click();
    await expect(actions).toBeFocused();
    expect((await getRun(running.id)).run.status).toBe('running');
    expect((await getRun(queued.id)).run.status).toBe('queued');

    await actions.click();
    await clear.click();
    await dialog.getByRole('button', { name: 'Остановить и удалить', exact: true }).click();
    await expect(page.getByText('В проекте пока нет адресов')).toBeVisible();
    await expect(page.getByText('Удалено адресов: 2. Остановлено проверок: 2.')).toBeVisible();
    await expect(clear).toHaveCount(0);
    await expect(actions).toHaveCount(0);
    expect(await getRun(running.id)).toMatchObject({ run: { status: 'cancelled', completed: 1 }, results: [{ httpCode: 200 }] });
    expect((await getRun(queued.id)).run.status).toBe('cancelled');
  } finally { await Promise.all(pending.map(runId => request.post(`${root}/runs/${runId}/stop`))); }
});

test('checks only the URL from its own history card', async ({ page, request }) => {
  const { id } = await (await request.post('/api/projects', { data: { name: 'Проверка из карточки адреса' } })).json();
  const root = `/api/projects/${id}`;
  const url = 'https://example.com/check-from-card';
  await request.post(root + '/urls', { data: { input: `${url}\nhttps://example.com/not-from-card` } });
  await page.goto(`/?project=${id}`);
  await page.getByRole('button', { name: url, exact: true }).click();
  const address = page.getByRole('dialog', { name: 'История URL' });
  await address.getByRole('button', { name: 'Проверить этот URL', exact: true }).click();
  await address.getByRole('button', { name: 'Открыть новый отчёт' }).click();
  const report = page.getByRole('dialog', { name: /Отчёт по запуску/ });
  await expect(report).toContainText('1 из 1');
  await expect(report.locator('.result')).toHaveCount(1);
  await expect(report.locator('.result')).toContainText(url);
});

test('shows the hidden selected URL before applying a destructive action', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: 'Область выделения' } })).json();
  const root = `/api/projects/${project.id}`;
  await request.post(root + '/urls', { data: { input: 'example.com/hidden-row\nexample.com/visible-row' } });
  await page.goto(`/?project=${project.id}`);
  const hidden = page.getByRole('checkbox', { name: 'Выбрать https://example.com/hidden-row', exact: true });
  const search = page.getByRole('searchbox', { name: 'Поиск по адресам' });
  await hidden.check();
  await search.fill('visible-row');
  await expect(hidden).toHaveCount(0);
  await expect(page.getByText('Вне текущей страницы 1')).toBeVisible();
  await page.getByRole('button', { name: 'Удалить выбранные' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить адрес?' });
  await expect(confirmation.getByText('https://example.com/hidden-row', { exact: true })).toBeVisible();
  await expect(confirmation.getByText('Скрыто фильтром 1', { exact: true })).toBeVisible();
  await confirmation.getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await search.fill('');
  await expect(page.getByRole('button', { name: 'https://example.com/visible-row', exact: true })).toBeVisible();
  await expect(hidden).toHaveCount(0);
});

test('restores a removed address from its report history without losing its result', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: 'Восстановление адреса' } })).json();
  const root = `/api/projects/${project.id}`;
  const url = 'https://example.com/restore-row';
  await request.post(root + '/urls', { data: { input: url } });
  const { items: [address] } = await (await request.get(root + '/urls/page')).json();
  const run = await (await request.post(root + '/runs', { data: {} })).json();
  const reportPath = `${root}/runs/${run.id}`;
  await expect.poll(async () => (await (await request.get(reportPath)).json()).run.status).toBe('done');
  await request.post(root + '/urls/delete', { data: { ids: [address.id] } });
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  const report = page.getByRole('dialog', { name: `Отчёт по запуску №${run.id}` });
  await report.locator('.result summary').click();
  await report.getByRole('button', { name: 'История этого URL' }).click();
  const history = page.getByRole('dialog', { name: 'История URL' });
  await history.getByRole('button', { name: 'Восстановить адрес' }).click();
  await expect(history.getByRole('button', { name: 'Восстановить адрес' })).toHaveCount(0);
  await history.getByRole('button', { name: 'Закрыть' }).click();
  await report.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'Адреса', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: url }).getByRole('cell', { name: '200' })).toBeVisible();
  expect((await (await request.get(root + '/urls/page')).json()).items[0].id).toBe(address.id);
});
