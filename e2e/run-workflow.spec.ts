import { expect, test } from './fixtures.js';

test('opens and stops the waiting run while the current run continues', async ({ page, request }) => {
  const { id } = await (await request.post('/api/projects', { data: { name: 'Две проверки в очереди' } })).json();
  const path = `/api/projects/${id}`;
  await request.post(path + '/urls', { data: { input: 'example.com/wait-for-stop' } });
  const running = await (await request.post(path + '/runs', { data: {} })).json();
  const awaiting: number[] = [];
  try {
    await page.goto(`/?project=${id}`);
    const progress = page.locator('.progress-bar');
    await expect(progress).toContainText('Выполняется проверка');
    const start = page.getByRole('button', { name: 'Проверить проект' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url().endsWith(path + '/runs'));
      await start.click();
      awaiting.push((await (await response).json()).id);
    }

    const queue = page.getByRole('region', { name: 'Очередь проверок' });
    await expect(queue).toBeVisible();
    expect(awaiting[0]).toBe(awaiting[1]);
    await expect(queue.getByRole('button', { name: 'Открыть отчёт' })).toHaveCount(1);
    await queue.getByRole('button', { name: 'Открыть отчёт' }).click();
    const report = page.getByRole('dialog', { name: `Отчёт по запуску №${awaiting[0]}` });
    await expect(report).toBeVisible();
    await report.getByRole('button', { name: 'Закрыть' }).click();
    await queue.getByRole('button', { name: 'Остановить проверку' }).click();
    await expect(queue).toHaveCount(0);
    await expect(progress).toContainText(`№${running.id}`);
    await expect(progress).toContainText('Выполняется проверка');
    expect((await (await request.get(path + '/runs/' + awaiting[0])).json()).run.status).toBe('cancelled');
  } finally {
    await Promise.all([running.id, ...awaiting].map(run => request.post(path + '/runs/' + run + '/stop')));
  }
});

test('keeps the stop button in view in a long mobile report and retains checked results', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id } = await (await request.post('/api/projects', { data: { name: 'Длинная проверка на телефоне' } })).json();
  const path = `/api/projects/${id}`;
  const pending = Array.from({ length: 102 }, (_, i) => 'example.com/' + i + '/wait-for-stop');
  await request.post(path + '/urls', { data: { input: ['example.com/finished', ...pending].join('\n') } });
  const run = await (await request.post(path + '/runs', { data: {} })).json();
  try {
    await page.goto(`/?project=${id}`);
    const progress = page.locator('.progress-bar');
    await expect(progress).toContainText('1 из 103');
    await progress.getByRole('button', { name: 'Открыть отчёт' }).click();
    const report = page.getByRole('dialog', { name: `Отчёт по запуску №${run.id}` });
    await expect(report.locator('.result')).toHaveCount(100);
    const stop = report.getByRole('button', { name: 'Остановить проверку' });
    await expect(stop).toBeInViewport({ ratio: 1 });
    await report.locator('.result').nth(50).scrollIntoViewIfNeeded();
    await expect(stop).toBeInViewport({ ratio: 1 });
    await stop.click();
    await expect(report.getByText('Остановлена', { exact: true })).toBeVisible();
    await expect(report.getByText('Не проверено 102')).toBeVisible();
    await expect(report.locator('.result-name').getByText('https://example.com/finished', { exact: true })).toBeVisible();
  } finally {
    await request.post(path + '/runs/' + run.id + '/stop');
  }
});

test('restarts the stopped selection from Addresses after reload, then again from its report', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id } = await (await request.post('/api/projects', { data: { name: 'Перезапуск проверки' } })).json();
  const path = `/api/projects/${id}`;
  const finished = 'https://example.com/restart-finished';
  const pending = 'https://example.com/restart/wait-for-stop';
  await request.post(path + '/urls', { data: { input: [finished, pending, 'example.com/unselected'].join('\n') } });
  const { items } = await (await request.get(path + '/urls/page')).json();
  const ids = items.filter((entry: { url: string }) => [finished, pending].includes(entry.url)).map((entry: { id: number }) => entry.id);
  const original = await (await request.post(path + '/runs', { data: { ids } })).json();
  const runningIds = [original.id];
  const getRun = async (run: number) => (await request.get(`${path}/runs/${run}`)).json();
  try {
    await page.goto(`/?project=${id}`);
    const progress = page.locator('.progress-bar');
    await expect(progress).toContainText('1 из 2');
    await progress.getByRole('button', { name: 'Остановить проверку' }).click();
    const stopped = page.getByRole('region', { name: 'Остановленная проверка' });
    await expect(stopped.getByRole('button', { name: 'Запустить заново', exact: true })).toBeInViewport();
    await page.reload();
    await expect(stopped).toContainText(`Проверка №${original.id} остановлена.`);

    const firstRestart = page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url().endsWith(`${path}/runs/${original.id}/restart`));
    await stopped.getByRole('button', { name: 'Запустить заново', exact: true }).click();
    const next = (await (await firstRestart).json()).id;
    runningIds.push(next);
    await expect(progress).toContainText(`№${next}`);
    await expect(progress).toContainText('1 из 2');
    expect(await getRun(next)).toMatchObject({ results: [{ url: finished, status: 'ok' }, { url: pending, status: 'pending' }] });
    expect(await getRun(original.id)).toMatchObject({ run: { status: 'cancelled', completed: 1 }, results: [{ url: finished, status: 'ok' }] });

    await progress.getByRole('button', { name: 'Открыть отчёт' }).click();
    const report = page.getByRole('dialog', { name: `Отчёт по запуску №${next}` });
    await report.getByRole('button', { name: 'Остановить проверку' }).click();
    const secondRestart = page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url().endsWith(`${path}/runs/${next}/restart`));
    await report.getByRole('button', { name: 'Запустить заново', exact: true }).click();
    const latest = (await (await secondRestart).json()).id;
    runningIds.push(latest);
    await report.getByRole('button', { name: 'Открыть новый отчёт' }).click();
    await expect(page.getByRole('dialog', { name: `Отчёт по запуску №${latest}` })).toBeVisible();
  } finally {
    await Promise.all(runningIds.map(run => request.post(`${path}/runs/${run}/stop`)));
  }
});
