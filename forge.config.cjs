const MakerDMG = require('./packaging/maker-dmg.cjs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { publicRelease, verifyMac, writeChecksum } = require('./packaging/release.cjs');

const identity = process.env.PULSE_MAC_SIGN_IDENTITY;
const notaryProfile = process.env.PULSE_MAC_NOTARY_PROFILE;
if (Boolean(identity) !== Boolean(notaryProfile)) {
  throw new Error('Укажите PULSE_MAC_SIGN_IDENTITY и PULSE_MAC_NOTARY_PROFILE вместе.');
}

module.exports = {
  ...(process.env.PULSE_PACKAGE_OUT && { outDir: process.env.PULSE_PACKAGE_OUT }),
  packagerConfig: {
    asar: true,
    icon: join(__dirname, 'desktop-assets', 'pulse-icon'),
    appBundleId: 'ru.pulseurl.desktop',
    appCategoryType: 'public.app-category.utilities',
    protocols: [{ name: 'Pulse URL report', schemes: ['pulse-url'] }],
    ignore: file => file !== '' && file !== '/package.json' && file !== '/LICENSE'
      && !/^\/(dist|desktop-assets|node_modules)(\/|$)/.test(file),
    ...(identity && {
      osxSign: { identity },
      osxNotarize: { keychainProfile: notaryProfile },
    }),
  },
  makers: [new MakerDMG()],
  hooks: {
    postMake: async (config, results) => {
      for (const result of results) {
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.dmg')) continue;
          if (identity) {
            execFileSync('codesign', ['--force', '--sign', identity, artifact], { stdio: 'inherit' });
            execFileSync('xcrun', ['notarytool', 'submit', artifact, '--keychain-profile', notaryProfile, '--wait'], { stdio: 'inherit' });
            execFileSync('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit' });
          }
          if (publicRelease) {
            const out = config.outDir || 'out';
            const bundle = join(out, `Pulse URL-darwin-${result.arch}`, 'Pulse URL.app');
            verifyMac(bundle, artifact);
          }
          await writeChecksum(artifact);
        }
      }
      return results;
    },
  },
};
