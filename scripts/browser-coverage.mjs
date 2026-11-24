import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import coverage from 'istanbul-lib-coverage';
import sourceMaps from 'istanbul-lib-source-maps';

const directory = await mkdtemp(join(tmpdir(), 'pulse-browser-coverage-'));
const raw = join(directory, 'raw');
const web = join(directory, 'client');
const output = resolve(process.env.PULSE_BROWSER_COVERAGE_OUTPUT || 'coverage/browser');

function run(script, args, env = process.env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(script), ...args], { env, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code, signal) => code === 0 ? done() : fail(new Error(`${script}: ${signal || code}`)));
  });
}

try {
  await mkdir(raw);
  await run('node_modules/vite/bin/vite.js', ['build', '--config', 'scripts/browser-coverage-vite.mjs', '--outDir', web, '--emptyOutDir']);
  await run('node_modules/@playwright/test/cli.js', ['test', ...process.argv.slice(2)], {
    ...process.env, PULSE_E2E_STATIC_ROOT: web, PULSE_BROWSER_COVERAGE_RAW: raw,
  });
  const map = coverage.createCoverageMap({});
  for (const name of await readdir(raw)) {
    const observations = JSON.parse(await readFile(join(raw, name), 'utf8'));
    for (const data of observations) map.merge(data);
  }
  const remapped = await sourceMaps.createSourceMapStore().transformCoverage(map);
  remapped.filter(file => file.replaceAll('\\', '/').includes('/src/client/'));
  if (!remapped.files().length) throw new Error('Покрытие не удалось сопоставить с исходниками React.');
  const total = remapped.getCoverageSummary().toJSON();
  const files = Object.fromEntries(remapped.files().sort().map(path => {
    const file = remapped.fileCoverageFor(path);
    const name = 'src/client/' + path.replaceAll('\\', '/').split('/src/client/').pop();
    return [name, { ...file.toSummary().toJSON(), uncoveredLines: file.getUncoveredLines() }];
  }));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'coverage-summary.json'), JSON.stringify({ total, files }, null, 2) + '\n');
  await writeFile(join(output, 'coverage-final.json'), JSON.stringify(remapped.toJSON()) + '\n');
  console.log(`React: ${total.lines.pct}% строк, ${total.branches.pct}% ветвей, ${total.functions.pct}% функций. ${output}`);
  if (process.argv.length === 2 && (total.lines.pct < 84 || total.branches.pct < 79)) {
    throw new Error('Покрытие React ниже порога: 84% строк и 79% ветвей.');
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
