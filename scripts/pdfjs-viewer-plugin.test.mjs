import { describe, expect, it } from 'vitest';
import { bindPdfjsViewerSource } from './pdfjs-viewer-plugin.mjs';

describe('bindPdfjsViewerSource', () => {
  it('binds the packaged viewer to the packaged core instead of the Obsidian global', () => {
    const source = 'const { version } = globalThis.pdfjsLib;\nexport { version };\n';

    const bound = bindPdfjsViewerSource(source);

    expect(bound).toContain("import * as __abyssPdfjsLib from '../build/pdf.mjs';");
    expect(bound).toContain('const { version } = __abyssPdfjsLib;');
    expect(bound).not.toContain('globalThis.pdfjsLib');
  });

  it('rejects a changed viewer boundary instead of silently shipping a host collision', () => {
    expect(() => bindPdfjsViewerSource('export const version = "unknown";')).toThrow(
      /exactly one globalThis\.pdfjsLib reference/u,
    );
    expect(() => bindPdfjsViewerSource('globalThis.pdfjsLib; globalThis.pdfjsLib;')).toThrow(
      /exactly one globalThis\.pdfjsLib reference/u,
    );
  });
});
