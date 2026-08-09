import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STYLE_INPUT_PATHS = [
  resolve('node_modules/pdfjs-dist/web/pdf_viewer.css'),
  resolve('src/styles/reader.css'),
  resolve('src/styles/settings.css'),
];

function runBuildStyles() {
  execFileSync(process.execPath, [resolve('scripts/build-styles.mjs')], { stdio: 'inherit' });
}

export function createBuildStylesPlugin(buildStyles = runBuildStyles) {
  return {
    name: 'build-styles',
    setup(build) {
      build.onStart(buildStyles);
      build.onLoad({ filter: /[\\/]src[\\/]main\.ts$/ }, ({ path }) => ({
        contents: readFileSync(path, 'utf8'),
        loader: 'ts',
        watchFiles: STYLE_INPUT_PATHS,
      }));
    },
  };
}
