import * as path from 'node:path';
import { env } from 'node:process';
import { parseObsidianVersions } from 'wdio-obsidian-service';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginDirectory = env['ABYSS_PACKAGE_PLUGIN_DIR'];
const vaultDirectory = env['ABYSS_PACKAGE_VAULT_DIR'];
if (pluginDirectory === undefined || vaultDirectory === undefined) {
  throw new Error('Package smoke requires ABYSS_PACKAGE_PLUGIN_DIR and ABYSS_PACKAGE_VAULT_DIR.');
}
const cacheDir = path.resolve(repoRoot, '.obsidian-cache');
const versions = await parseObsidianVersions(
  env['OBSIDIAN_PACKAGE_VERSIONS'] ?? env['OBSIDIAN_VERSIONS'] ?? '1.13.4/1.13.4',
  { cacheDir },
);

export const config: WebdriverIO.Config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./package-smoke.e2e.ts'],
  maxInstances: 1,
  capabilities: versions.map(([appVersion, installerVersion]) => ({
    browserName: 'obsidian',
    'wdio:obsidianOptions': {
      appVersion,
      installerVersion,
      plugins: [pluginDirectory],
      vault: vaultDirectory,
    },
  })),
  services: ['obsidian'],
  reporters: ['obsidian'],
  mochaOpts: { ui: 'bdd', timeout: 90_000 },
  waitforInterval: 250,
  waitforTimeout: 15_000,
  logLevel: 'warn',
  cacheDir,
  injectGlobals: false,
};
