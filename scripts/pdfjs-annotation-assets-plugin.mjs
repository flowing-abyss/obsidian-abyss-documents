import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ID = 'pdfjs-dist/web/images/annotation-assets?data-url-map';
const ASSET_NAMES = [
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
];

export function loadPdfjsAnnotationImageDataUrls(imageDirectory) {
  return Object.fromEntries(
    ASSET_NAMES.map((name) => [
      name,
      `data:image/svg+xml;base64,${readFileSync(path.join(imageDirectory, name)).toString('base64')}`,
    ]),
  );
}

export function createPdfjsAnnotationAssetsPlugin(
  imageDirectory = fileURLToPath(
    new URL('../node_modules/pdfjs-dist/web/images/', import.meta.url),
  ),
) {
  return {
    name: 'pdfjs-annotation-assets',
    setup(build) {
      build.onResolve(
        { filter: /pdfjs-dist\/web\/images\/annotation-assets\?data-url-map/ },
        () => ({ namespace: 'pdfjs-annotation-assets', path: MODULE_ID }),
      );
      build.onLoad({ filter: /.*/, namespace: 'pdfjs-annotation-assets' }, () => ({
        contents: `export default ${JSON.stringify(loadPdfjsAnnotationImageDataUrls(imageDirectory))};`,
        loader: 'js',
      }));
    },
  };
}
