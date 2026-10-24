import type * as FsPromises from 'node:fs/promises';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateDevVault, registerVaultInConfig } from './generate-dev-vault.mjs';

const temporaryDirectories: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return { ...original, lstat: vi.fn(original.lstat), open: vi.fn(original.open) };
});

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
  it(
    'recreates only managed fixture, config, and plugin paths while preserving vault data',
    {
      timeout: 15_000,
    },
    async () => {
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
        'annotation-qualification.pdf',
        'annotations-10000.pdf',
        'fixtures.v1.json',
        'invalid.pdf',
        'outline-20-pages.pdf',
        'permission-restricted.pdf',
        'raster-heavy-24-pages.pdf',
        'signed-document.pdf',
        'text-12-pages.pdf',
        'text-700-pages.pdf',
        'unicode-annotations.pdf',
      ]);
      expect(await readdir(path.join(repository, 'artifacts', 'manual-qa'))).toEqual([]);
    },
  );

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

  it('keeps registry reads and writes on the opened file after pathname replacement', async () => {
    const repository = await temporaryRepository();
    const registry = path.join(repository, 'obsidian.json');
    const backup = path.join(repository, 'original-registry.json');
    const outside = path.join(repository, 'outside.json');
    const vault = path.join(repository, 'Резюме-😀');
    await writeFile(registry, '{"custom":"original","vaults":{}}');
    const outsideBytes = '{"custom":"outside","vaults":{}}';
    await writeFile(outside, outsideBytes);
    const original = await vi.importActual<typeof FsPromises>('node:fs/promises');
    vi.mocked(lstat).mockImplementationOnce(async (...arguments_) => {
      const stat = await original.lstat(...arguments_);
      await rename(registry, backup);
      await symlink(outside, registry);
      return stat;
    });

    const result = await registerVaultInConfig(registry, vault);

    expect(await readFile(outside, 'utf8')).toBe(outsideBytes);
    const saved = JSON.parse(await readFile(backup, 'utf8')) as {
      custom: string;
      vaults: Record<string, { path: string }>;
    };
    expect(saved.custom).toBe('original');
    expect(saved.vaults[result.vaultId]?.path).toBe(vault);
  });

  it('rejects a registry whose pathname identifies a different file after open', async () => {
    const repository = await temporaryRepository();
    const registry = path.join(repository, 'obsidian.json');
    const backup = path.join(repository, 'original-registry.json');
    const initial = '{"vaults":{}}';
    const replacement = '{"custom":"replacement","vaults":{}}';
    await writeFile(registry, initial);
    const original = await vi.importActual<typeof FsPromises>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...arguments_) => {
      const handle = await original.open(...arguments_);
      await rename(registry, backup);
      await writeFile(registry, replacement);
      return handle;
    });

    await expect(registerVaultInConfig(registry, repository)).rejects.toThrow(/identity/u);

    expect(await readFile(registry, 'utf8')).toBe(replacement);
    expect(await readFile(backup, 'utf8')).toBe(initial);
  });

  it('rejects a symlinked global registry without touching its target', async () => {
    const repository = await temporaryRepository();
    const registry = path.join(repository, 'obsidian.json');
    const outside = path.join(repository, 'outside.json');
    const initial = '{"vaults":{}}';
    await writeFile(outside, initial);
    await symlink(outside, registry);

    await expect(registerVaultInConfig(registry, repository)).rejects.toThrow();

    expect(await readFile(outside, 'utf8')).toBe(initial);
  });

  it('writes complete Unicode registry bytes after partial writes and removes old trailing data', async () => {
    const repository = await temporaryRepository();
    const registry = path.join(repository, 'obsidian.json');
    const vault = path.join(repository, 'Резюме-😀');
    await writeFile(registry, `{"custom":"Журнал","vaults":{}}${' '.repeat(4096)}`);
    const original = await vi.importActual<typeof FsPromises>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...arguments_) => {
      const handle = await original.open(...arguments_);
      const write = handle.write.bind(handle);
      Object.defineProperty(handle, 'write', {
        value: (buffer: Buffer, offset: number, length: number, position: number) =>
          write(buffer, offset, Math.min(length, 3), position),
      });
      return handle;
    });

    const result = await registerVaultInConfig(registry, vault);

    const bytes = await readFile(registry, 'utf8');
    const saved = JSON.parse(bytes) as { custom: string; vaults: Record<string, { path: string }> };
    expect(saved.custom).toBe('Журнал');
    expect(saved.vaults[result.vaultId]?.path).toBe(vault);
    expect(bytes).toBe(JSON.stringify(saved));
  });

  it('rejects a write with no progress and closes the file without truncating it', async () => {
    const repository = await temporaryRepository();
    const registry = path.join(repository, 'obsidian.json');
    const initial = '{"vaults":{}}';
    await writeFile(registry, initial);
    const original = await vi.importActual<typeof FsPromises>('node:fs/promises');
    let opened: FsPromises.FileHandle | undefined;
    vi.mocked(open).mockImplementationOnce(async (...arguments_) => {
      opened = await original.open(...arguments_);
      Object.defineProperty(opened, 'write', {
        value: () => Promise.resolve({ bytesWritten: 0 }),
      });
      return opened;
    });

    await expect(registerVaultInConfig(registry, repository)).rejects.toThrow(/Unable to write/u);

    expect(await readFile(registry, 'utf8')).toBe(initial);
    expect(opened?.fd).toBe(-1);
  });

  it('rejects an unverifiable file identity before reading and closes its descriptor', async () => {
    const repository = await temporaryRepository();
    const registry = path.join(repository, 'obsidian.json');
    const initial = '{"vaults":{}}';
    await writeFile(registry, initial);
    const original = await vi.importActual<typeof FsPromises>('node:fs/promises');
    let opened: FsPromises.FileHandle | undefined;
    const read = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (...arguments_) => {
      opened = await original.open(...arguments_);
      const stat = await opened.stat({ bigint: true });
      Object.defineProperty(stat, 'ino', { value: 0n });
      Object.defineProperty(opened, 'stat', { value: () => Promise.resolve(stat) });
      Object.defineProperty(opened, 'readFile', { value: read });
      return opened;
    });

    await expect(registerVaultInConfig(registry, repository)).rejects.toThrow(/identity/u);

    expect(read).not.toHaveBeenCalled();
    expect(await readFile(registry, 'utf8')).toBe(initial);
    expect(opened?.fd).toBe(-1);
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
