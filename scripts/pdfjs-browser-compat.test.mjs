import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('packaged PDF.js browser compatibility', () => {
  it('initializes the real viewer and streams worker text without APIs absent in Chromium 120', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', path.resolve(import.meta.dirname, 'check-pdfjs-browser-compat.mjs')],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(output).toContain('Packaged PDF.js viewer and worker text extraction passed');
  }, 20_000);
});
