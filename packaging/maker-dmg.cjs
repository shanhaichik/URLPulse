const { execFileSync } = require('node:child_process');
const { mkdir, mkdtemp, rename, rm, symlink } = require('node:fs/promises');
const { join } = require('node:path');
const { MakerBase } = require('@electron-forge/maker-base');

module.exports = class MakerDMG extends MakerBase {
  name = 'dmg';
  defaultPlatforms = ['darwin'];

  isSupportedOnCurrentPlatform() { return process.platform === 'darwin'; }

  async make({ dir, makeDir, appName, packageJSON, targetArch }) {
    const destination = join(makeDir, 'dmg', targetArch);
    await mkdir(destination, { recursive: true });
    const work = await mkdtemp(join(destination, '.pulse-dmg-'));
    const content = join(work, 'content');
    const staged = join(work, 'image.dmg');
    const result = join(destination, `${appName}-${packageJSON.version}-${targetArch}.dmg`);
    try {
      await mkdir(content);
      const bundle = `${appName}.app`;
      execFileSync('/usr/bin/ditto', [join(dir, bundle), join(content, bundle)]);
      await symlink('/Applications', join(content, 'Applications'));
      execFileSync('/usr/bin/hdiutil', ['create', '-srcfolder', content, '-volname', appName, '-format', 'ULFO', staged], { stdio: 'inherit' });
      await rename(staged, result);
      return [result];
    } finally { await rm(work, { recursive: true, force: true }); }
  }
};
