import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PluginManifest } from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import AbyssDocumentsPlugin from '../../src/main.js';
import { readerPerformanceSnapshot } from '../../src/reader-performance.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

describe('reader build and activation budgets', () => {
  it('parses the production metafile and keeps main.js within the Community package budget', () => {
    execFileSync(process.execPath, ['esbuild.config.mjs', 'production'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    const metafile = JSON.parse(
      readFileSync(path.join(repoRoot, 'artifacts', 'build-meta.json'), 'utf8'),
    ) as { outputs: Record<string, { bytes: number }> };
    const metrics = {
      mainJsBytes: Object.values(metafile.outputs).reduce(
        (total, output) => total + output.bytes,
        0,
      ),
    };

    expect(metrics.mainJsBytes).toBeLessThanOrEqual(2_097_152);
  });

  it('records zero PDF work during real plugin activation', async () => {
    const manifest: PluginManifest = {
      author: 'test',
      description: 'test',
      id: 'abyss-documents',
      minAppVersion: '1.7.2',
      name: 'Abyss Documents',
      version: '0.1.0',
    };
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);

    await plugin.onload();

    const metrics = readerPerformanceSnapshot().counters;
    expect(metrics.pdfWorkDuringPluginOnload).toBe(0);
    expect(metrics.pdfRuntimeLoads).toBe(0);
  });
});
