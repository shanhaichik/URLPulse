import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import release from './release.cjs';

release.requirePublisher('win32');

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const root = resolve(process.env.PULSE_PACKAGE_OUT || 'out');
const output = join(root, 'installers');
const folder = join(root, 'Pulse URL-win32-x64');
const appExe = join(folder, 'Pulse URL.exe');
const installer = join(output, `Pulse-URL-${manifest.version}-win-x64-Setup.exe`);
if (!existsSync(appExe)) throw new Error('Сначала соберите Windows x64 через electron-forge package.');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} завершился с кодом ${result.status}.`);
}

function sign(path) {
  const thumbprint = process.env.PULSE_WINDOWS_CERT_THUMBPRINT;
  if (!thumbprint) return;
  if (!process.env.PULSE_WINDOWS_TIMESTAMP_URL || process.platform !== 'win32' || !/^[\da-f]{40}$/i.test(thumbprint)) {
    throw new Error('Для подписи Windows укажите отпечаток сертификата в системном хранилище и URL меток времени.');
  }
  run(process.env.PULSE_SIGNTOOL || 'signtool.exe', ['sign', '/fd', 'SHA256',
    '/sha1', thumbprint, '/tr', process.env.PULSE_WINDOWS_TIMESTAMP_URL, '/td', 'SHA256', path]);
}

function uninstallFiles(relative = '') {
  const fileList = [];
  const current = join(folder, relative);
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const child = join(relative, entry.name);
    const nsisPath = child.replaceAll('/', '\\').replaceAll('$', '$$$$');
    if (entry.isDirectory()) {
      fileList.push(...uninstallFiles(child), `RMDir "$INSTDIR\\${nsisPath}"`);
    } else {
      fileList.push(`Delete "$INSTDIR\\${nsisPath}"`);
    }
  }
  return fileList;
}

mkdirSync(output, { recursive: true });
const uninstaller = join(root, 'windows-uninstall-files.nsh');
writeFileSync(uninstaller, uninstallFiles().join('\n') + '\n');
sign(appExe);
const windowsCompiler = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe');
const compiler = process.env.PULSE_MAKENSIS || (existsSync(windowsCompiler) ? windowsCompiler : 'makensis');
const option = process.platform === 'win32' ? '/' : '-';
run(compiler, [
  option + 'V2', option + 'INPUTCHARSET', 'UTF8',
  option + 'DAPP_FOLDER=' + folder, option + 'DOUTPUT_EXE=' + installer,
  option + 'DAPP_VERSION=' + manifest.version, option + 'DUNINSTALL_FILES=' + uninstaller,
  option + 'DAPP_ICON=' + fileURLToPath(new URL('../desktop-assets/pulse-icon.ico', import.meta.url)),
  resolve('packaging', 'windows.nsi'),
]);
sign(installer);
if (release.publicRelease) {
  release.verifyWindows(appExe);
  release.verifyWindows(installer);
}
await release.writeChecksum(installer);
console.log(installer);
