import { test as base } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export * from '@playwright/test';

type BrowserCoverage = Record<string, { s: Record<string, number>; f: Record<string, number>; b: Record<string, number[]> }>;

export const test = base.extend({
  async page({ page }, use, testInfo) {
    const output = process.env.PULSE_BROWSER_COVERAGE_RAW;
    if (!output) {
      await use(page);
      return;
    }
    const key = 'pulse-react-test-coverage';
    await page.addInitScript(key => {
      window.addEventListener('pagehide', () => {
        const current = (window as Window & { __coverage__?: BrowserCoverage }).__coverage__;
        if (!current) return;
        const previous = JSON.parse(sessionStorage.getItem(key) ?? '{}') as BrowserCoverage;
        for (const [filename, counts] of Object.entries(current)) {
          const existing = previous[filename];
          if (!existing) {
            previous[filename] = counts;
            continue;
          }
          for (const id of Object.keys(counts.s)) existing.s[id] += counts.s[id];
          for (const id of Object.keys(counts.f)) existing.f[id] += counts.f[id];
          for (const id of Object.keys(counts.b)) counts.b[id].forEach((hit, index) => { existing.b[id][index] += hit; });
        }
        sessionStorage.setItem(key, JSON.stringify(previous));
      });
    }, key);
    try { await use(page); }
    finally {
      if (!page.isClosed() && testInfo.status === 'passed' && page.url() !== 'about:blank') {
        const result = await page.evaluate(key => [
          JSON.parse(sessionStorage.getItem(key) ?? '{}'),
          (window as Window & { __coverage__?: BrowserCoverage }).__coverage__ ?? {},
        ], key);
        await writeFile(join(output, testInfo.testId + '.json'), JSON.stringify(result));
      }
    }
  },
});
