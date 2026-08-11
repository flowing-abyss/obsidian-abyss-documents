import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalOnlyBundle,
  prepareSmokeVault,
  stageCommunityPackage,
} from './smoke-community-package.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('stageCommunityPackage', () => {
  it('copies only the three files delivered by the Community installer', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'abyss-package-source-'));
    const destination = await mkdtemp(path.join(tmpdir(), 'abyss-package-destination-'));
    temporaryDirectories.push(source, destination);
    await Promise.all([
      writeFile(path.join(source, 'main.js'), 'module.exports = {};\n'),
      writeFile(path.join(source, 'manifest.json'), '{"id":"abyss-documents","version":"0.1.0"}'),
      writeFile(path.join(source, 'styles.css'), '.abyss-documents {}\n'),
      mkdir(path.join(source, 'node_modules')),
      writeFile(path.join(source, 'secret-development-file.ts'), 'do not package'),
    ]);

    const staged = await stageCommunityPackage(source, destination);

    expect(staged.version).toBe('0.1.0');
    expect(await readdir(destination)).toEqual(['main.js', 'manifest.json', 'styles.css']);
  });

  it('prepares the minimum Obsidian vault configuration required by the real-app harness', async () => {
    const vault = await mkdtemp(path.join(tmpdir(), 'abyss-package-vault-'));
    temporaryDirectories.push(vault);

    await prepareSmokeVault(vault);

    expect(await readFile(path.join(vault, '.obsidian', 'app.json'), 'utf8')).toBe('{}\n');
    expect(await readFile(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8')).toBe(
      '[]\n',
    );
    expect(await readdir(path.join(vault, 'Documents'))).toContain('text-12-pages.pdf');
  });

  it('rejects packaged Node transport imports that renderer interception cannot observe', () => {
    expect(() => {
      assertLocalOnlyBundle('const obsidian = require("obsidian");');
    }).not.toThrow();
    expect(() => {
      assertLocalOnlyBundle('const https = require("node:https");');
    }).toThrow('Node network transport');
    expect(() => {
      assertLocalOnlyBundle('import("undici")');
    }).toThrow('Node network transport');
    expect(() => {
      assertLocalOnlyBundle('const electron = require("electron");');
    }).toThrow('external module');
    expect(() => {
      assertLocalOnlyBundle(
        'var import_obsidian = require("obsidian"); (0, import_obsidian.requestUrl)("https://example.com");',
      );
    }).toThrow('Obsidian external transport');
  });

  it.each([
    'var import_obsidian = require("obsidian"); (0, import_obsidian.request)("https://example.com");',
    'var import_obsidian = require("obsidian"); import_obsidian.requestUrl("https://example.com");',
    'var import_obsidian = require("obsidian"); import_obsidian["request"]("https://example.com");',
    "var import_obsidian = require('obsidian'); import_obsidian['requestUrl']('https://example.com');",
    'var $obsidian = require("obsidian"); $obsidian.request("https://example.com");',
  ])('rejects an Obsidian transport referenced through the packaged module alias', (source) => {
    expect(() => {
      assertLocalOnlyBundle(source);
    }).toThrow('Obsidian external transport');
  });

  it.each([
    'const client = { request() {} }; client.request();',
    'const client = { requestUrl() {} }; client.requestUrl();',
    'var import_obsidian = require("obsidian"); import_obsidian.FileView;',
    'const message = "request requestUrl";',
  ])('allows unrelated request-shaped identifiers: $source', (source) => {
    expect(() => {
      assertLocalOnlyBundle(source);
    }).not.toThrow();
  });
});
