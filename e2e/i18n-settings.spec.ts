import { expect, test } from './fixtures.js';

test('saves project settings from the English UI without translating stored values', async ({ page, request }) => {
  const name = 'Проверка настроек';
  const { id } = await (await request.post('/api/projects', { data: { name } })).json();
  await page.addInitScript(() => localStorage.setItem('urlpulse.locale', 'en-US'));
  await page.goto(`/?project=${id}&tab=settings`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();

  await page.getByRole('spinbutton', { name: 'Concurrent checks' }).fill('12');
  await page.getByRole('combobox', { name: 'When to notify' }).selectOption({ label: 'Only on failures' });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved', { exact: true })).toBeVisible();

  const { project } = await (await request.get(`/api/projects/${id}?view=summary`)).json();
  expect(project).toMatchObject({ name, checkConcurrency: 12, notify: 'errors' });
  await expect(page.getByRole('button', { name: 'Add profile' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Upload PAC file' })).toBeEnabled();
});
