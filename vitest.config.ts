import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    execArgv: ['--import', 'tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/{server,desktop,shared}/**/*.ts'],
      reportsDirectory: 'coverage/node',
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 80, branches: 75 },
    },
  },
});
