import type { DesktopPreferences } from '../src/shared/desktop.js';
import { expect, test, type Page } from './fixtures.js';

async function launchDesktopRenderer(page: Page, smtpState: DesktopPreferences['smtp']['state'], blockLoginChange = false) {
  await page.addInitScript(({ state, blockLoginChange }) => {
    const defaultSmtp = {
      host: '', port: 587, tlsMode: 'starttls' as const, user: '', from: '', hasPassword: false, state,
    };
    let preferences: DesktopPreferences = { openAtLogin: blockLoginChange ? false : null, schedulesEnabled: true, smtp: defaultSmtp };
    let imports = 0;
    window.pulseDesktop = {
      async request({ path, method, body }) {
        const response = await fetch(path, { method, body, headers: body ? { 'content-type': 'application/json' } : {} });
        return { status: response.status, data: await response.json() };
      },
      onNavigate: () => () => {},
      openAddress: async () => {},
      exportReport: async () => ({ saved: false }),
      exportComparison: async () => ({ saved: false }),
      pickCatalogFile: async () => null,
      exportCatalog: async () => ({ saved: false }),
      exportBackup: async () => ({ saved: true }),
      async importBackup() {
        imports++;
        if (imports === 1) throw new Error('simulated database failure');
        return imports > 2;
      },
      onBackupProgress: () => () => {},
      getPreferences: async () => preferences,
      async savePreferences(input) {
        if (input.section === 'background') {
          preferences = { ...preferences, schedulesEnabled: input.schedulesEnabled };
          if (blockLoginChange && input.openAtLogin !== null) {
            return { preferences, loginError: 'Не удалось изменить автозапуск. Проверьте параметры автозапуска системы и повторите попытку.' };
          }
        } else if (input.section === 'email-language') {
          preferences = { ...preferences, emailLocale: input.emailLocale };
        } else {
          const smtp = input.smtp;
          preferences = { ...preferences, smtp: smtp
            ? { host: smtp.host, port: smtp.port, user: smtp.user, from: smtp.from, tlsMode: smtp.tlsMode,
              hasPassword: Boolean(smtp.password), state: 'configured' }
            : { ...defaultSmtp, state: 'empty' } };
        }
        return { preferences };
      },
    };
  }, { state: smtpState, blockLoginChange });
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Настройки приложения' }).click();
  return page.getByRole('dialog', { name: 'Настройки приложения' });
}

test('keeps an existing startup error readable after switching languages', async ({ page }) => {
  await launchDesktopRenderer(page, 'empty', true);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Запускать приложение при входе в систему').check();
  await dialog.getByRole('button', { name: 'Сохранить фоновую работу' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Не удалось изменить автозапуск.');

  await dialog.getByLabel('Язык', { exact: true }).selectOption('en-US');
  await expect(dialog.getByRole('alert')).toContainText('Could not change startup behavior.');
  await expect(dialog.getByLabel('Open app at login')).not.toBeChecked();
});

test('persists SMTP form state through the bridge and does not refill a saved password', async ({ page }) => {
  const dialog = await launchDesktopRenderer(page, 'empty');
  await expect(dialog.getByRole('checkbox', { name: 'Запускать приложение при входе в систему' })).toBeDisabled();
  await dialog.getByLabel('SMTP-хост').fill('mail.example.test');
  await dialog.getByLabel('Порт', { exact: true }).fill('465');
  await dialog.getByLabel('Шифрование').selectOption('tls');
  await dialog.getByLabel('Адрес отправителя').fill('pulse@example.test');
  await dialog.getByLabel('Имя пользователя').fill('operator');
  const password = dialog.getByLabel('Пароль SMTP');
  await password.fill('fixture-password');
  const emailLanguage = dialog.getByLabel('Язык писем');
  await expect(emailLanguage).toHaveValue('ru-RU');
  await emailLanguage.selectOption('en-US');
  await dialog.getByRole('button', { name: 'Сохранить язык писем' }).click();
  await expect(dialog.getByText('Язык писем сохранён.')).toBeVisible();
  await expect(password).toHaveValue('fixture-password');
  await dialog.getByRole('button', { name: 'Сохранить SMTP' }).click();
  await expect(dialog.getByText('Настройки SMTP сохранены.')).toBeVisible();
  await expect(emailLanguage).toHaveValue('en-US');
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('placeholder', /Сохранён/);
  const reset = dialog.getByRole('button', { name: 'Удалить настройки SMTP' });
  page.once('dialog', confirmation => confirmation.dismiss());
  await reset.click();
  await expect(dialog.getByLabel('SMTP-хост')).toHaveValue('mail.example.test');
  page.once('dialog', confirmation => confirmation.accept());
  await reset.click();
  await expect(dialog.getByText('Настройки SMTP удалены.')).toBeVisible();
  await expect(dialog.getByLabel('SMTP-хост')).toHaveValue('');
  await expect(emailLanguage).toHaveValue('en-US');
});

test('saves email language while the stored SMTP settings are unavailable', async ({ page }) => {
  const dialog = await launchDesktopRenderer(page, 'unavailable');
  await dialog.getByLabel('Язык писем').selectOption('en-US');
  await dialog.getByRole('button', { name: 'Сохранить язык писем' }).click();
  await expect(dialog.getByText('Язык писем сохранён.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Сохранить язык писем' })).toBeDisabled();
  await expect(dialog.getByText(/Сохранённые параметры SMTP недоступны/)).toBeVisible();
});

test('distinguishes failed, cancelled and completed restore while SMTP is unavailable', async ({ page }) => {
  const dialog = await launchDesktopRenderer(page, 'unavailable');
  await expect(dialog.getByText(/Сохранённые параметры SMTP недоступны/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Сохранить SMTP' })).toHaveCount(0);
  const restore = dialog.getByRole('button', { name: 'Восстановить базу' });
  await restore.click();
  await expect(dialog.getByText(/Не удалось восстановить резервную копию/)).toBeVisible();
  await restore.click();
  await expect(restore).toBeEnabled();
  await expect(dialog.getByText('Резервная копия восстановлена.')).toHaveCount(0);
  await restore.click();
  await expect(dialog.getByText('Резервная копия восстановлена.')).toBeVisible();
});
