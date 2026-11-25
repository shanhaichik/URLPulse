import { expect, test } from './fixtures.js';

test('localizes URL selection and preserves the selection when switching languages', async ({ page, request }) => {
  const projectName = 'Контроль адресов';
  const url = 'https://example.com/localized-address';
  const { id } = await (await request.post('/api/projects', { data: { name: projectName } })).json();
  await request.post(`/api/projects/${id}/urls`, { data: { input: url } });
  await page.addInitScript(() => localStorage.setItem('urlpulse.locale', 'en-US'));
  await page.goto(`/?project=${id}`);

  await expect(page.getByRole('heading', { name: 'Work groups' })).toBeVisible({ timeout: 3500 });
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  await page.getByRole('checkbox', { name: `Select ${url}`, exact: true }).check();
  await expect(page.getByRole('button', { name: 'Check selected' })).toBeVisible();
  await page.getByLabel('Language', { exact: true }).selectOption('ru-RU');
  await expect(page.getByRole('checkbox', { name: `Выбрать ${url}`, exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Проверить выбранные' })).toBeVisible();
});
