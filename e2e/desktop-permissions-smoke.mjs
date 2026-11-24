import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const profile = await mkdtemp(join(tmpdir(), 'pulse-permissions-smoke-'));
let desktop;
try {
  const executablePath = process.env.PULSE_SMOKE_EXECUTABLE;
  desktop = await electron.launch({
    executablePath, args: executablePath ? [] : ['.'],
    env: { ...process.env, PULSE_DESKTOP_DATA_DIR: profile, PULSE_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1' },
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.getByRole('button', { name: 'Настройки приложения' }).waitFor();
  assert.ok(page.url().startsWith('pulse-app://app/'));
  const permissions = await page.evaluate(async () => {
    const query = await navigator.permissions.query({ name: 'notifications' });
    if (query.state !== 'denied') return { query: query.state, request: null };
    return { query: query.state, request: await Notification.requestPermission() };
  });
  assert.deepEqual(permissions, { query: 'denied', request: 'denied' });
  await page.getByRole('button', { name: 'Настройки приложения' }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки приложения', exact: true });
  await settings.waitFor();
  await desktop.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => {
      globalThis.pulsePermissionSaveDialogShown = true;
      return { canceled: true };
    };
  });
  await settings.getByRole('button', { name: 'Экспорт базы' }).click();
  await settings.getByRole('button', { name: 'Экспорт базы' }).and(page.locator('button:enabled')).waitFor();
  assert.equal(await desktop.evaluate(() => globalThis.pulsePermissionSaveDialogShown), true);
  console.log('Chromium permissions denied; desktop protocol, IPC and native save flow are available.');
} finally {
  await desktop?.close();
  await rm(profile, { recursive: true, force: true });
}
