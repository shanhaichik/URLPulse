import { expect, test } from './fixtures.js';
import { readFile } from 'node:fs/promises';

test('manages work groups from Addresses and downloads one specific group run', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id } = await (await request.post('/api/projects', { data: { name: 'Рабочие группы' } })).json();
  const root = `/api/projects/${id}`;
  const a = 'https://example.com/group-a';
  const b = 'https://example.com/group-b';
  await request.post(`${root}/urls`, { data: { input: `${a}\n${b}` } });
  await page.goto(`/?project=${id}`);
  const filter = page.getByLabel('Рабочая группа', { exact: true });
  for (const select of [filter, page.getByLabel('Фильтр по статусу', { exact: true })]) {
    await expect(select).toBeVisible();
    const placement = await select.evaluate(element => {
      const arrow = element.nextElementSibling;
      if (!arrow) return null;
      const field = element.getBoundingClientRect();
      const glyph = arrow.getBoundingClientRect();
      return {
        rightInset: field.right - glyph.right,
        middleOffset: Math.abs((field.top + field.bottom - glyph.top - glyph.bottom) / 2),
        textPadding: parseFloat(getComputedStyle(element).paddingInlineEnd),
      };
    });
    expect(placement).not.toBeNull();
    expect(placement!.rightInset).toBeGreaterThanOrEqual(10);
    expect(placement!.middleOffset).toBeLessThan(1);
    expect(placement!.textPadding).toBeGreaterThanOrEqual(30);
  }
  const create = async (name: string) => {
    await page.getByRole('button', { name: 'Новая группа', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Новая рабочая группа' });
    await form.getByLabel('Название группы').fill(name);
    await form.getByRole('button', { name: 'Создать группу' }).click();
    await expect(form).toHaveCount(0);
  };
  await create('Контроль');
  await create('Оплата');
  await filter.selectOption('');
  await page.getByRole('checkbox', { name: `Выбрать ${a}`, exact: true }).check();
  const addTo = async (name: string) => {
    await page.getByRole('button', { name: 'Добавить в группу', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Добавить в группу' });
    await dialog.getByLabel('Куда добавить').selectOption({ label: name });
    await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  await addTo('Контроль');
  await addTo('Оплата');
  await filter.selectOption({ label: 'Оплата (1)' });
  await expect(page.getByRole('button', { name: a, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: b, exact: true })).toHaveCount(0);

  const { items } = await (await request.get(`${root}/urls/page`)).json();
  const { id: addressId } = items.find((row: { url: string }) => row.url === a);
  const projectRun = await (await request.post(`${root}/runs`, { data: { ids: [addressId] } })).json();
  await expect.poll(async () => (await (await request.get(`${root}/runs/${projectRun.id}`)).json()).run.status).toBe('done');
  const runAccepted = page.waitForResponse(response => response.request().method() === 'POST' && /\/groups\/\d+\/runs$/.test(response.url()));
  await page.getByRole('searchbox', { name: 'Поиск по адресам' }).fill('hidden');
  await page.getByRole('button', { name: 'Проверить группу' }).click();
  const run = (await (await runAccepted).json()).id;
  await page.getByRole('button', { name: 'Прогоны группы' }).click();
  const history = page.getByRole('region', { name: 'Прогоны группы' });
  await expect(history.locator('tbody tr')).toHaveCount(1);
  await expect(history.getByText('Завершён')).toBeVisible();
  await history.getByRole('button', { name: `Экспорт прогона №${run}` }).click();
  const exportDialog = page.getByRole('dialog', { name: `Экспорт прогона №${run}` });
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('link', { name: 'JSON', exact: true }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2} - Рабочие группы\.json$/);
  const rows = JSON.parse(await readFile((await saved.path())!, 'utf8'));
  expect(rows.map((row: { runId: number; url: string }) => [row.runId, row.url])).toEqual([[run, a]]);
  await exportDialog.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'Переименовать группу' }).click();
  const rename = page.getByRole('dialog', { name: 'Переименовать рабочую группу' });
  await rename.getByLabel('Название группы').fill('Платежи');
  await rename.getByRole('button', { name: 'Сохранить' }).click();
  await expect(filter.locator('option:checked')).toHaveText('Платежи (1)');
  await page.getByRole('searchbox', { name: 'Поиск по адресам' }).fill('');
  await page.getByRole('checkbox', { name: `Выбрать ${a}`, exact: true }).check();
  await page.getByRole('button', { name: 'Убрать из группы', exact: true }).click();
  await expect(filter.locator('option:checked')).toHaveText('Платежи (0)');
  await page.getByRole('button', { name: 'Удалить группу', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Удалить рабочую группу?' });
  await deletion.getByRole('button', { name: 'Удалить группу', exact: true }).click();
  await expect(filter).toHaveValue('');
  await filter.selectOption({ label: 'Контроль (1)' });
  await expect(page.getByRole('button', { name: a, exact: true })).toBeVisible();
});
