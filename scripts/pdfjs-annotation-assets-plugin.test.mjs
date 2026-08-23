import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPdfjsAnnotationImageDataUrls } from './pdfjs-annotation-assets-plugin.mjs';

describe('PDF.js annotation asset bundle', () => {
  it('embeds every annotation image used by the PDF.js annotation layer', () => {
    const images = loadPdfjsAnnotationImageDataUrls(
      path.resolve('node_modules/pdfjs-dist/web/images'),
    );

    expect(Object.keys(images).sort((left, right) => left.localeCompare(right))).toEqual([
      'annotation-check.svg',
      'annotation-comment.svg',
      'annotation-help.svg',
      'annotation-insert.svg',
      'annotation-key.svg',
      'annotation-newparagraph.svg',
      'annotation-noicon.svg',
      'annotation-note.svg',
      'annotation-paperclip.svg',
      'annotation-paragraph.svg',
      'annotation-pushpin.svg',
    ]);
    expect(
      Object.values(images).every((value) => value.startsWith('data:image/svg+xml;base64,')),
    ).toBe(true);
  });

  it('resolves and loads the virtual data map through the production esbuild API', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { build } from 'esbuild'; import { createPdfjsAnnotationAssetsPlugin } from './scripts/pdfjs-annotation-assets-plugin.mjs'; const result = await build({ bundle: true, format: 'esm', plugins: [createPdfjsAnnotationAssetsPlugin()], stdin: { contents: \"import images from 'pdfjs-dist/web/images/annotation-assets?data-url-map'; export default images;\", resolveDir: process.cwd() }, write: false }); process.stdout.write(result.outputFiles[0]?.text ?? '');",
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(output).toContain('data:image/svg+xml;base64,');
    expect(output).toContain('annotation-comment.svg');
  });
});
