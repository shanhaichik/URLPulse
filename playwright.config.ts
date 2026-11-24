import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:8732';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  reporter: 'list',
  use: { baseURL, channel: process.env.PULSE_E2E_BROWSER_CHANNEL, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: {
    command: 'node --import tsx e2e/server.ts',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
  },
});
