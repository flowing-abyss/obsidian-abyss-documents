import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PDFJS_VIEWER_SPECIFIER = 'pdfjs-dist/web/pdf_viewer.mjs';
const PDFJS_GLOBAL_REFERENCE = 'globalThis.pdfjsLib';

export function bindPdfjsViewerSource(source) {
  const references = source.split(PDFJS_GLOBAL_REFERENCE).length - 1;
  if (references !== 1) {
    throw new Error(
      `Expected exactly one globalThis.pdfjsLib reference in ${PDFJS_VIEWER_SPECIFIER}; found ${references}.`,
    );
  }
  return (
    "import * as __abyssPdfjsLib from '../build/pdf.mjs';\n" +
    source.replace(PDFJS_GLOBAL_REFERENCE, '__abyssPdfjsLib')
  );
}

export function createPdfjsViewerPlugin() {
  return {
    name: 'bind-pdfjs-viewer-core',
    setup(build) {
      build.onResolve({ filter: /^pdfjs-dist\/web\/pdf_viewer\.mjs$/ }, () => ({
        namespace: 'bound-pdfjs-viewer',
        path: fileURLToPath(import.meta.resolve(PDFJS_VIEWER_SPECIFIER)),
      }));
      build.onLoad({ filter: /.*/, namespace: 'bound-pdfjs-viewer' }, ({ path: viewerPath }) => ({
        contents: bindPdfjsViewerSource(readFileSync(viewerPath, 'utf8')),
        loader: 'js',
        resolveDir: path.dirname(viewerPath),
      }));
    },
  };
}
