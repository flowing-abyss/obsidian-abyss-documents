import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDevVault, registerVaultInConfig } from './generate-dev-vault.mjs';

const temporaryDirectories: string[] = [];

async function temporaryRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), 'abyss-dev-vault-'));
  temporaryDirectories.push(repository);
  await Promise.all([
    writeFile(path.join(repository, 'main.js'), 'module.exports = {};\n'),
    writeFile(
      path.join(repository, 'manifest.json'),
      JSON.stringify({ id: 'abyss-documents', version: '0.1.0' }),
    ),
    writeFile(path.join(repository, 'styles.css'), '.abyss-documents {}\n'),
  ]);
  return repository;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('generateDevVault', () => {
  it('recreates only managed fixture, config, and plugin paths while preserving vault data', async () => {
    const repository = await temporaryRepository();
    const vault = path.join(repository, 'dev-documents-vault');
    await mkdir(path.join(vault, '.obsidian'), { recursive: true });
    await writeFile(path.join(vault, 'keep-me.md'), 'user-owned');
    await writeFile(path.join(vault, '.obsidian', 'keep-me.json'), '{}');

    const result = await generateDevVault({ launch: false, repoRoot: repository });

    expect(result.vaultPath).toBe(vault);
    expect(await readFile(path.join(vault, 'keep-me.md'), 'utf8')).toBe('user-owned');
    expect(await readFile(path.join(vault, '.obsidian', 'keep-me.json'), 'utf8')).toBe('{}');
    expect(await readdir(path.join(vault, '.obsidian', 'plugins', 'abyss-documents'))).toEqual([
      'main.js',
      'manifest.json',
      'styles.css',
    ]);
    expect(await readdir(path.join(vault, 'Documents'))).toEqual([
      'fixtures.v1.json',
      'invalid.pdf',
      'outline-20-pages.pdf',
      'raster-heavy-24-pages.pdf',
      'text-12-pages.pdf',
      'text-700-pages.pdf',
    ]);
    expect(await readdir(path.join(repository, 'artifacts', 'manual-qa'))).toEqual([]);
  });

  it('adds one exact vault registry entry without changing existing global configuration', async () => {
    const repository = await temporaryRepository();
    const registry = path.join(repository, 'obsidian.json');
    const vault = path.join(repository, 'dev-documents-vault');
    await mkdir(vault);
    await writeFile(
      registry,
      JSON.stringify({
        cli: true,
        custom: { keep: true },
        vaults: { existing: { path: '/notes' } },
      }),
    );

    const first = await registerVaultInConfig(registry, vault);
    const second = await registerVaultInConfig(registry, vault);
    const saved = JSON.parse(await readFile(registry, 'utf8')) as {
      readonly custom: unknown;
      readonly vaults: Record<string, { readonly path: string }>;
    };

    expect(first.added).toBe(true);
    expect(second).toEqual({ added: false, vaultId: first.vaultId });
    expect(saved.custom).toEqual({ keep: true });
    expect(saved.vaults['existing']).toEqual({ path: '/notes' });
    expect(saved.vaults[first.vaultId]).toMatchObject({ path: vault });
  });

  it('refuses a symlinked managed ancestor without touching its target', async () => {
    const repository = await temporaryRepository();
    const vault = path.join(repository, 'dev-documents-vault');
    const outside = await mkdtemp(path.join(tmpdir(), 'abyss-dev-vault-outside-'));
    temporaryDirectories.push(outside);
    await mkdir(path.join(vault, '.obsidian'), { recursive: true });
    await writeFile(path.join(outside, 'sentinel.txt'), 'untouched');
    await symlink(outside, path.join(vault, '.obsidian', 'plugins'));

    await expect(generateDevVault({ launch: false, repoRoot: repository })).rejects.toThrow(
      /symbolic link/u,
    );
    expect(await readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched');
  });

  it('refuses a symlinked managed config file without overwriting its target', async () => {
    const repository = await temporaryRepository();
    const vault = path.join(repository, 'dev-documents-vault');
    const outside = path.join(repository, 'outside-config.json');
    await mkdir(path.join(vault, '.obsidian'), { recursive: true });
    await writeFile(outside, '{"owned":"elsewhere"}');
    await symlink(outside, path.join(vault, '.obsidian', 'app.json'));

    await expect(generateDevVault({ launch: false, repoRoot: repository })).rejects.toThrow(
      /symbolic link/u,
    );
    expect(await readFile(outside, 'utf8')).toBe('{"owned":"elsewhere"}');
  });
});
