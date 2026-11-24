const { createHash } = require('node:crypto');
const { appendFileSync, createReadStream, readFileSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, relative, resolve, sep } = require('node:path');
const { execFileSync } = require('node:child_process');

const publicRelease = process.env.PULSE_PUBLIC_RELEASE === '1';
const credentials = {
  darwin: ['PULSE_MAC_SIGN_IDENTITY', 'PULSE_MAC_NOTARY_PROFILE'],
  win32: ['PULSE_WINDOWS_CERT_THUMBPRINT', 'PULSE_WINDOWS_TIMESTAMP_URL'],
};

function requirePublisher(platform) {
  if (!publicRelease) return;
  const missing = credentials[platform].filter(key => !process.env[key]?.trim());
  if (missing.length) throw new Error('Для публичного выпуска обязательны ' + missing.join(', ') + '.');
  if (platform !== process.platform) throw new Error('Подписанный выпуск собирается и проверяется на целевой ОС.');
}

function verifyMac(bundle, image) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', image], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'execute', bundle], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', image], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', bundle], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', image], { stdio: 'inherit' });
}

function verifyWindows(file) {
  execFileSync(process.env.PULSE_SIGNTOOL || 'signtool.exe', ['verify', '/pa', '/all', file], { stdio: 'inherit' });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:PULSE_VERIFY_PATH; if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate -or $signature.SignerCertificate.Thumbprint -ne $env:PULSE_WINDOWS_CERT_THUMBPRINT) { exit 1 }"],
  { env: { ...process.env, PULSE_VERIFY_PATH: file }, stdio: 'inherit' });
}

async function artifactHash(artifact) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeChecksum(artifact) {
  writeFileSync(join(dirname(artifact), 'SHA256SUMS.txt'), `${await artifactHash(artifact)}  ${basename(artifact)}\n`);
}

function releaseSource() {
  const { version } = require('../package.json');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Публичный выпуск требует версию X.Y.Z.');
  const tag = `v${version}`;
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const sha = git('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(process.env.PULSE_SOURCE_SHA || '') || sha !== process.env.PULSE_SOURCE_SHA || sha !== process.env.GITHUB_SHA) {
    throw new Error('Отпечаток исходников не совпадает с выбранным SHA выпуска.');
  }
  if (git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`) !== sha) {
    throw new Error(`Тег ${tag} должен указывать на выбранный коммит.`);
  }
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('В исходниках выпуска есть незаписанные изменения.');
  return { version, tag, sha };
}

async function verifyChecksum(folder) {
  const { version } = require('../package.json');
  const name = process.platform === 'win32' ? `Pulse-URL-${version}-win-x64-Setup.exe` : `Pulse URL-${version}-${process.arch}.dmg`;
  const manifest = readFileSync(join(folder, 'SHA256SUMS.txt'), 'utf8');
  const artifact = resolve(folder, name);
  const sha256 = await artifactHash(artifact);
  if (manifest !== `${sha256}  ${name}\n`) throw new Error(`Неверная контрольная сумма ${name}.`);
  return { artifact, sha256 };
}

async function recordRelease(folder) {
  if (!publicRelease) throw new Error('Манифест выпуска требует проверенную публичную сборку.');
  const source = releaseSource();
  const { artifact, sha256 } = await verifyChecksum(folder);
  const provenance = {
    ...source,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    workflowRun: process.env.GITHUB_RUN_ID,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    files: [{ name: basename(artifact), sha256 }],
    checks: ['installer SHA-256', 'packaged desktop smoke', ...(process.platform === 'darwin'
      ? ['strict codesign, Gatekeeper and stapled tickets for DMG and delivered app']
      : ['timestamped Authenticode for installer and installed app', 'clean installation, same-version reinstallation and removal'])],
  };
  writeFileSync(join(folder, 'release.json'), JSON.stringify(provenance, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) {
    const workflowPath = relative(process.cwd(), artifact).split(sep).join('/');
    appendFileSync(process.env.GITHUB_OUTPUT, `installer=${workflowPath}\n`);
  }
}

module.exports = { publicRelease, requirePublisher, verifyMac, verifyWindows, writeChecksum };

async function main([command, ...args]) {
  switch (command) {
    case 'source': console.log(JSON.stringify(releaseSource())); break;
    case 'checksum': console.log((await verifyChecksum(args[0])).artifact); break;
    case 'record': await recordRelease(args[0]); break;
    case 'verify-mac': verifyMac(args[0], args[1]); break;
    case 'verify-windows': verifyWindows(args[0]); break;
    case 'darwin': case 'win32': requirePublisher(command); break;
    default: throw new Error(`Неизвестная команда выпуска ${command}.`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
