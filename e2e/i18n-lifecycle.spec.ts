import { expect, test } from './fixtures.js';

test('restores the saved language and updates a draft in another tab', async ({ page, context }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('urlpulse.locale')) localStorage.setItem('urlpulse.locale', 'invalid');
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru-RU');
  await page.getByRole('button', { name: 'Новый проект', exact: true }).first().click();
  const draft = 'Пользовательский черновик';
  await page.getByLabel('Название проекта', { exact: true }).fill(draft);
  const url = page.url();

  const other = await context.newPage();
  await other.goto('/');
  await other.getByLabel('Язык', { exact: true }).selectOption('en-US');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page).toHaveTitle('URLPulse — Availability monitoring');
  await expect(page.getByRole('dialog').getByLabel('Project name', { exact: true })).toHaveValue(draft);
  expect(page.url()).toBe(url);

  await other.reload();
  await expect(other.getByLabel('Language', { exact: true })).toHaveValue('en-US');
  await other.getByLabel('Language', { exact: true }).selectOption('ru-RU');
  await expect(page.getByRole('dialog').getByLabel('Название проекта', { exact: true })).toHaveValue(draft);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru-RU');
  await other.close();
});

test('switches the language inside a narrow dialog and keeps its draft', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const draft = 'Мой проект';
  const url = page.url();
  await expect(dialog.getByLabel('Название проекта', { exact: true })).toBeFocused();
  await dialog.getByLabel('Название проекта', { exact: true }).fill(draft);
  await dialog.getByLabel('Язык', { exact: true }).selectOption('en-US');
  await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue(draft);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  expect(page.url()).toBe(url);
  expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);

  await dialog.getByLabel('Language', { exact: true }).selectOption('ru-RU');
  await expect(dialog.getByLabel('Название проекта', { exact: true })).toHaveValue(draft);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru-RU');
  await dialog.getByLabel('Название проекта', { exact: true }).press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Новый проект', exact: true }).first()).toBeFocused();
});

test('keeps project actions inside the narrow viewport in both languages', async ({ page, request }) => {
  const { id } = await (await request.post('/api/projects', { data: { name: 'URLPulse Demo' } })).json();
  await request.post(`/api/projects/${id}/urls`, { data: { input: 'https://example.test/' } });
  await page.setViewportSize({ width: 320, height: 650 });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(`/?project=${id}`);
  for (const [locale, language, action] of [
    ['ru-RU', 'Язык', 'Проверить проект'],
    ['en-US', 'Language', 'Check project'],
  ] as const) {
    await expect(page.getByRole('button', { name: action })).toBeEnabled();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, locale).toBe(320);
    if (locale === 'ru-RU') await page.getByLabel(language, { exact: true }).selectOption('en-US');
  }
});
