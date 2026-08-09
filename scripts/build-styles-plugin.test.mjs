import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBuildStylesPlugin } from './build-styles-plugin.mjs';

describe('buildStylesPlugin', () => {
  it('registers both stylesheet inputs as watch files', () => {
    let loadMain;
    const runBuildStyles = vi.fn();
    const plugin = createBuildStylesPlugin(runBuildStyles);
    plugin.setup({
      onLoad: (_options, callback) => {
        loadMain = callback;
      },
      onStart: () => undefined,
    });

    const loaded = loadMain({ path: resolve('src/main.ts') });

    expect(loaded.watchFiles).toEqual([
      resolve('node_modules/pdfjs-dist/web/pdf_viewer.css'),
      resolve('src/styles/reader.css'),
    ]);
  });
});
