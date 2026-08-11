import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open as openFile,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { generatePdfFixtures, type PdfFixtureManifest } from '../tests/fixtures/pdf-fixtures.mjs';

const execFileAsync = promisify(execFile);
const RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'] as const;

export interface GenerateDevVaultOptions {
  readonly repoRoot: string;
  readonly launch?: boolean;
}

export interface GeneratedDevVault {
  readonly fixtureManifest: PdfFixtureManifest;
  readonly launchStatus: 'already-registered' | 'launched' | 'not-requested';
  readonly pluginFiles: readonly string[];
  readonly vaultPath: string;
}

export async function generateDevVault({
  repoRoot,
  launch = true,
}: GenerateDevVaultOptions): Promise<GeneratedDevVault> {
  const root = path.resolve(repoRoot);
  const vaultPath = path.join(root, 'dev-documents-vault');
  const documents = path.join(vaultPath, 'Documents');
  const obsidian = path.join(vaultPath, '.obsidian');
  const plugins = path.join(obsidian, 'plugins');
  const plugin = path.join(plugins, 'abyss-documents');
  const qaArtifacts = path.join(root, 'artifacts', 'manual-qa');
  const configFiles = [
    path.join(obsidian, 'app.json'),
    path.join(obsidian, 'appearance.json'),
    path.join(obsidian, 'community-plugins.json'),
  ];

  await mkdir(vaultPath, { recursive: true });
  await assertNoSymbolicLink(root, vaultPath);
  await assertNoSymbolicLink(vaultPath, documents);
  await assertNoSymbolicLink(vaultPath, obsidian);
  await assertNoSymbolicLink(vaultPath, plugins);
  await assertNoSymbolicLink(vaultPath, plugin);
  for (const configFile of configFiles) await assertNoSymbolicLink(vaultPath, configFile);
  await assertNoSymbolicLink(root, qaArtifacts);

  // Only these two generated directories are removed. The vault root, .obsidian,
  // QA artifacts, and any user-created file remain untouched.
  await rm(documents, { force: true, recursive: true });
  await rm(plugin, { force: true, recursive: true });
  await Promise.all([
    mkdir(documents, { recursive: true }),
    mkdir(plugin, { recursive: true }),
    mkdir(qaArtifacts, { recursive: true }),
  ]);

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
    readonly id?: unknown;
  };
  if (manifest.id !== 'abyss-documents') {
    throw new Error('manifest.json id must be abyss-documents before generating the dev vault.');
  }
  await Promise.all(
    RELEASE_FILES.map((file) => copyFile(path.join(root, file), path.join(plugin, file))),
  );
  await Promise.all([
    writeJson(configFiles[0]!, { alwaysUpdateLinks: true }),
    writeJson(configFiles[1]!, { baseFontSize: 16 }),
    writeJson(configFiles[2]!, ['abyss-documents']),
  ]);
  const fixtureManifest = await generatePdfFixtures(documents);
  const launchStatus = launch ? await registerVaultIfNeeded(vaultPath) : 'not-requested';
  return { fixtureManifest, launchStatus, pluginFiles: RELEASE_FILES, vaultPath };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertNoSymbolicLink(base: string, target: string): Promise<void> {
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Managed path must be a strict descendant of ${base}.`);
  }
  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Refusing managed path through symbolic link: ${current}`);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function registerVaultIfNeeded(
  vaultPath: string,
): Promise<'already-registered' | 'launched'> {
  const known = await knownVaultPaths();
  if (known.some((candidate) => path.resolve(candidate) === path.resolve(vaultPath))) {
    return 'already-registered';
  }
  const registration = await registerVaultInConfig(obsidianConfigFile(), vaultPath);
  const command = launchCommand(vaultPath, registration.vaultId);
  const child = spawn(command.executable, command.arguments, { detached: true, stdio: 'ignore' });
  child.unref();
  return 'launched';
}

export async function registerVaultInConfig(
  configFile: string,
  vaultPath: string,
): Promise<{ readonly added: boolean; readonly vaultId: string }> {
  const configStat = await lstat(configFile);
  if (configStat.isSymbolicLink()) {
    throw new Error(`Refusing Obsidian registry through symbolic link: ${configFile}`);
  }
  const parsed = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
  const existingVaults =
    typeof parsed['vaults'] === 'object' && parsed['vaults'] !== null
      ? (parsed['vaults'] as Record<string, unknown>)
      : {};
  const resolvedVault = path.resolve(vaultPath);
  for (const [vaultId, value] of Object.entries(existingVaults)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      'path' in value &&
      typeof value.path === 'string' &&
      path.resolve(value.path) === resolvedVault
    ) {
      return { added: false, vaultId };
    }
  }
  let salt = 0;
  let vaultId: string;
  do {
    vaultId = createHash('sha256').update(`${resolvedVault}\0${salt}`).digest('hex').slice(0, 16);
    salt += 1;
  } while (existingVaults[vaultId] !== undefined);
  parsed['vaults'] = {
    ...existingVaults,
    [vaultId]: { open: true, path: resolvedVault, ts: Date.now() },
  };
  const handle = await openFile(configFile, 'r+');
  try {
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(parsed));
  } finally {
    await handle.close();
  }
  return { added: true, vaultId };
}

async function knownVaultPaths(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('obsidian', ['vaults', 'verbose'], { timeout: 5_000 });
    return stdout
      .split(/\r?\n/u)
      .flatMap((line) => {
        const separator = line.indexOf('\t');
        return separator < 0 ? [] : [line.slice(separator + 1).trim()];
      })
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function obsidianConfigFile(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    case 'win32': {
      const appData = process.env['APPDATA'];
      if (appData === undefined) throw new Error('APPDATA is unavailable; cannot register vault.');
      return path.join(appData, 'obsidian', 'obsidian.json');
    }
    default:
      return path.join(
        process.env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config'),
        'obsidian',
        'obsidian.json',
      );
  }
}

function launchCommand(
  vaultPath: string,
  vaultId: string,
): { executable: string; arguments: string[] } {
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultId)}`;
  switch (process.platform) {
    case 'darwin':
      return { executable: 'open', arguments: ['-a', 'Obsidian', uri] };
    case 'win32':
      return { executable: 'Obsidian.exe', arguments: [uri] };
    default:
      return { executable: 'obsidian', arguments: [uri, vaultPath] };
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const generated = await generateDevVault({
    launch: !process.argv.includes('--no-launch'),
    repoRoot,
  });
  console.info(
    `Development vault ready at ${generated.vaultPath} (${generated.launchStatus}); ` +
      `${generated.fixtureManifest.files.length} fixtures generated.`,
  );
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
