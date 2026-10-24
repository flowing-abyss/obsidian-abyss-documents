import { readFileSync } from 'node:fs';
import path from 'node:path';

// PDF.js 6.4 requires CSS round(), introduced in Chromium 125. Obsidian can run
// current app code on an older installer, so its legacy core also needs this fallback.
// https://github.com/mozilla/pdf.js/blob/v6.4.299/src/display/display_utils.js#L419
export function adaptPdfjsLayerDimensions(source) {
  const expressions = ['Width', 'Height'].map(
    (axis) =>
      `\`round(down, var(--total-scale-factor) * \${page${axis}}px, var(--scale-round-${axis === 'Width' ? 'x' : 'y'}))\``,
  );
  for (const [index, expression] of expressions.entries()) {
    const occurrences = source.split(expression).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Expected one PDF.js layer dimension expression; found ${occurrences}.`);
    }
    const dimension = index === 0 ? 'pageWidth' : 'pageHeight';
    source = source.replace(
      expression,
      `(globalThis.CSS?.supports?.('width', 'round(down, 1px, 1px)') === true ? ${expression} : \`calc(var(--total-scale-factor) * \${${dimension}}px)\`)`,
    );
  }
  return source;
}

export function adaptPdfjsCoreSource(source) {
  const loop = 'for await (const value of readableStream) {';
  const occurrences = source.split(loop).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one PDF.js text stream loop; found ${occurrences}.`);
  }
  // ReadableStream async iteration arrived in Chromium 124. Keep the reader
  // private to this operation and preserve cancellation/release on abrupt exit.
  const compatibleLoop = `for await (const value of (async function* (stream) {
    const reader = stream.getReader();
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { finished = true; return; }
        yield value;
      }
    } finally {
      let cancellation;
      try { if (!finished) cancellation = reader.cancel(); }
      finally { reader.releaseLock(); }
      await cancellation;
    }
  })(readableStream)) {`;
  return adaptPdfjsLayerDimensions(source).replace(loop, compatibleLoop);
}

export function createPdfjsCorePlugin() {
  return {
    name: 'pdfjs-browser-compatibility',
    setup(build) {
      build.onLoad(
        { filter: /[/\\]pdfjs-dist[/\\]legacy[/\\]build[/\\]pdf\.mjs$/ },
        ({ path: corePath }) => ({
          contents: adaptPdfjsCoreSource(readFileSync(corePath, 'utf8')),
          loader: 'js',
          resolveDir: path.dirname(corePath),
        }),
      );
    },
  };
}
