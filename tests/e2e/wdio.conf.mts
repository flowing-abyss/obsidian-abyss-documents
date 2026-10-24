import * as path from 'node:path';
import { env } from 'node:process';
import { parseObsidianVersions } from 'wdio-obsidian-service';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const cacheDir = path.resolve(repoRoot, '.obsidian-cache');
// One shared vault fixture for both desktop and Android — the version/platform matrix
// lives in `capabilities`, not in separate vault folders. Add a second vault under
// tests/vaults/ once there's real persistence/migration behavior worth fixturing
// against; an empty "hostile" or "migration-v1" vault today would test nothing.
const vault = path.resolve(repoRoot, 'dev-documents-vault');

// The manifest's 1.7.2 floor is an Insiders beta. Test its first public successor,
// 1.7.4, on the same earliest installer, plus the newest stable release.
// Override for a one-off run, e.g.: OBSIDIAN_VERSIONS="1.8.0/1.8.0" pnpm run test:e2e
const desktopVersions = await parseObsidianVersions(
  env['OBSIDIAN_VERSIONS'] ?? '1.7.4/earliest latest/latest',
  {
    cacheDir,
  },
);
const coarseVersion = desktopVersions[desktopVersions.length - 1];
if (coarseVersion === undefined) throw new Error('No Obsidian version was selected.');
const [coarseAppVersion, coarseInstallerVersion] = coarseVersion;

if (env['CI']) {
  // Printed so the CI workflow can key its Obsidian-binary cache off the resolved
  // versions (they can drift between "latest" runs) — see .github/workflows/e2e.yml.
  console.log('obsidian-cache-key:', JSON.stringify(desktopVersions));
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  framework: 'mocha',

  // Resolved relative to this config file's own directory (tests/e2e/), not the cwd
  // it's invoked from.
  specs: [
    './smoke.e2e.ts',
    './reader.e2e.ts',
    './reader-selection.e2e.ts',
    './reader-toolbar.e2e.ts',
    './reader-toolbar-coarse.e2e.ts',
    './reader-sidebar.e2e.ts',
  ],

  // Native tooltip and focus restoration assertions need one foreground Electron window.
  maxInstances: Number(env['WDIO_MAX_INSTANCES'] ?? 1),

  capabilities: [
    ...desktopVersions.map(([appVersion, installerVersion]) => ({
      browserName: 'obsidian',
      'wdio:exclude': ['./reader-toolbar-coarse.e2e.ts'],
      'wdio:obsidianOptions': {
        appVersion,
        installerVersion,
        plugins: [repoRoot],
        vault,
      },
    })),
    {
      browserName: 'obsidian',
      'goog:chromeOptions': {
        mobileEmulation: {
          deviceMetrics: { height: 844, pixelRatio: 3, touch: true, width: 390 },
        },
      },
      'wdio:specs': ['./reader-toolbar-coarse.e2e.ts'],
      'wdio:obsidianOptions': {
        appVersion: coarseAppVersion,
        emulateMobile: true,
        installerVersion: coarseInstallerVersion,
        plugins: [repoRoot],
        vault,
      },
    },
  ],

  services: ['obsidian'],
  // Wraps wdio's spec-reporter to show the Obsidian version a test ran under
  // instead of the underlying Chromium version.
  reporters: ['obsidian'],

  mochaOpts: {
    grep: env['E2E_GREP'],
    ui: 'bdd',
    timeout: 60 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 5 * 1000,
  logLevel: 'warn',

  cacheDir,

  // Import describe/it/expect explicitly instead of relying on injected globals —
  // matches this repo's vitest config (`globals: false`) and keeps ESLint honest.
  injectGlobals: false,
};
