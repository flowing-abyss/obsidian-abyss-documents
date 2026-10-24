import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

export function createPdfjsWorkerPlugin() {
  return {
    name: 'gzip-base64',
    setup(build) {
      build.onResolve(
        { filter: /^pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs\?gzip-base64$/ },
        () => ({
          namespace: 'gzip-base64',
          path: import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
        }),
      );
      build.onLoad({ filter: /.*/, namespace: 'gzip-base64' }, ({ path }) => {
        const workerSource = readFileSync(new URL(path));
        const compressedWorker = gzipSync(workerSource, { level: 9 });
        return {
          contents: `export default ${JSON.stringify(compressedWorker.toString('base64'))};`,
          loader: 'js',
        };
      });
    },
  };
}
