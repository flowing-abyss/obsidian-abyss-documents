import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { generatePdfFixtures } from '../tests/fixtures/pdf-fixtures.mjs';

const RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'] as const;
const NODE_NETWORK_TRANSPORT =
  /(?:require|import)\s*\(\s*['"](?:node:)?(?:dgram|dns|http|http2|https|net|tls|undici)['"]\s*\)/u;
const EXTERNAL_REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

export function assertLocalOnlyBundle(source: string): void {
  const match = NODE_NETWORK_TRANSPORT.exec(source);
  if (match !== null) {
    throw new Error(
      `Node network transport is forbidden in the local-only Community package: ${match[0]}`,
    );
  }
  for (const external of source.matchAll(EXTERNAL_REQUIRE)) {
    const moduleName = external[1];
    if (moduleName !== 'obsidian') {
      throw new Error(
        `Unapproved external module is forbidden in the local-only Community package: ${moduleName ?? 'unknown'}`,
      );
    }
  }
  if (/\brequestUrl\b/u.test(source)) {
    throw new Error(
      'Obsidian requestUrl is forbidden in the local-only Community package because its Node transport is outside renderer interception.',
    );
  }
}

export async function stageCommunityPackage(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<{ readonly id: string; readonly version: string }> {
  await mkdir(destinationDirectory, { recursive: true });
  const manifest = JSON.parse(
    await readFile(path.join(sourceDirectory, 'manifest.json'), 'utf8'),
  ) as { readonly id?: unknown; readonly version?: unknown };
  if (manifest.id !== 'abyss-documents' || typeof manifest.version !== 'string') {
    throw new Error('Community package manifest must identify a versioned abyss-documents plugin.');
  }
  assertLocalOnlyBundle(await readFile(path.join(sourceDirectory, 'main.js'), 'utf8'));
  await Promise.all(
    RELEASE_FILES.map((file) =>
      copyFile(path.join(sourceDirectory, file), path.join(destinationDirectory, file)),
    ),
  );
  return { id: manifest.id, version: manifest.version };
}

export async function prepareSmokeVault(vaultDirectory: string): Promise<void> {
  await mkdir(path.join(vaultDirectory, '.obsidian'), { recursive: true });
  await Promise.all([
    writeFile(path.join(vaultDirectory, '.obsidian', 'app.json'), '{}\n'),
    writeFile(path.join(vaultDirectory, '.obsidian', 'community-plugins.json'), '[]\n'),
  ]);
  await generatePdfFixtures(path.join(vaultDirectory, 'Documents'));
}

async function run(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}.`));
    });
  });
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'abyss-community-smoke-'));
  const vaultDirectory = path.join(temporaryRoot, 'vault');
  const pluginDirectory = path.join(vaultDirectory, '.obsidian', 'plugins', 'abyss-documents');
  try {
    await prepareSmokeVault(vaultDirectory);
    const staged = await stageCommunityPackage(repoRoot, pluginDirectory);
    await run(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js'),
        'run',
        'tests/e2e/wdio.package.conf.mts',
      ],
      {
        ...process.env,
        ABYSS_PACKAGE_PLUGIN_DIR: pluginDirectory,
        ABYSS_PACKAGE_VAULT_DIR: vaultDirectory,
      },
    );
    console.info(
      `Community package smoke passed for ${staged.id} ${staged.version}; packaged files: ${RELEASE_FILES.join(', ')}.`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
