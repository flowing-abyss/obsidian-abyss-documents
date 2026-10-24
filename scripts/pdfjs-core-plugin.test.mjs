import { readFileSync } from 'node:fs';
import { ReadableStream } from 'node:stream/web';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { adaptPdfjsCoreSource, adaptPdfjsLayerDimensions } from './pdfjs-core-plugin.mjs';

const coreSource = readFileSync(
  new URL(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
  'utf8',
);

class PageViewport {
  rawDims = { pageWidth: 612, pageHeight: 792 };
  constructor(rotation) {
    this.rotation = rotation;
  }
}

function loadLayerDimensions(supportsRounding) {
  const source = adaptPdfjsLayerDimensions(coreSource);
  const start = source.indexOf('function setLayerDimensions(');
  const end = source.indexOf('\n}\n', start) + 2;
  // eslint-disable-next-line sonarjs/code-eval -- Run the pinned local core's actual dimension function with an isolated CSS feature fixture.
  return runInNewContext(`${source.slice(start, end)};setLayerDimensions;`, {
    PageViewport,
    CSS: { supports: () => supportsRounding },
  });
}

describe('PDF.js layer dimensions on older Obsidian installers', () => {
  it.each([0, 90, 180, 270])(
    'preserves scale variables and rotation %i without CSS round',
    (rotation) => {
      const setLayerDimensions = loadLayerDimensions(false);
      const div = document.createElement('div');

      setLayerDimensions(div, new PageViewport(rotation), true);

      const flipped = rotation % 180 !== 0;
      expect(div.style.width).toBe(`calc(var(--total-scale-factor) * ${flipped ? 792 : 612}px)`);
      expect(div.style.height).toBe(`calc(var(--total-scale-factor) * ${flipped ? 612 : 792}px)`);
      expect(div.dataset.mainRotation).toBe(String(rotation));
    },
  );

  it('preserves native pixel rounding on capable engines', () => {
    const setLayerDimensions = loadLayerDimensions(true);
    const div = document.createElement('div');

    setLayerDimensions(div, new PageViewport(0));

    expect(div.style.width).toBe(
      'round(down, var(--total-scale-factor) * 612px, var(--scale-round-x))',
    );
    expect(div.style.height).toBe(
      'round(down, var(--total-scale-factor) * 792px, var(--scale-round-y))',
    );
  });

  it('fails the build if an upgrade changes the adapted boundary', () => {
    expect(() => adaptPdfjsLayerDimensions('')).toThrow(/dimension expression/u);
    expect(() => adaptPdfjsLayerDimensions(coreSource + coreSource)).toThrow(
      /dimension expression/u,
    );
  });
});

describe('PDF.js text extraction on older Obsidian installers', () => {
  function loadTextContent() {
    const source = adaptPdfjsCoreSource(coreSource);
    const start = source.indexOf('  async getTextContent(params = {}) {');
    const end = source.indexOf('\n  getStructTree()', start);
    // eslint-disable-next-line sonarjs/code-eval -- Exercise the pinned local core's text method against an isolated older stream feature fixture.
    return runInNewContext(`({${source.slice(start, end)}}).getTextContent;`);
  }

  it('extracts streamed text without ReadableStream async iteration', async () => {
    const getTextContent = loadTextContent();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ items: [{ str: 'fixture' }], styles: { font: {} }, lang: 'en' });
        controller.enqueue({ items: [{ str: ' text' }], styles: { second: {} }, lang: null });
        controller.close();
      },
    });
    Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });

    const content = await getTextContent.call({ _transport: {}, streamTextContent: () => stream });

    expect(content).toEqual({
      items: [{ str: 'fixture' }, { str: ' text' }],
      styles: { font: {}, second: {} },
      lang: 'en',
    });
    expect(stream.locked).toBe(false);
  });

  it('releases the stream lock before awaiting cancellation after malformed content', async () => {
    const getTextContent = loadTextContent();
    let finishCancellation;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ items: undefined, styles: {}, lang: 'en' });
      },
      cancel() {
        return new Promise((resolve) => {
          finishCancellation = resolve;
        });
      },
    });
    Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
    const operation = getTextContent
      .call({ _transport: {}, streamTextContent: () => stream })
      .catch((error) => error);
    await vi.waitFor(() => expect(finishCancellation).toBeTypeOf('function'));
    try {
      expect(stream.locked).toBe(false);
    } finally {
      finishCancellation();
    }
    expect((await operation).name).toBe('TypeError');
  });
});
