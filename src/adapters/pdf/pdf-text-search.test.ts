import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import type { SearchResultSet } from '../../document-core/document.js';
import { PdfTextSearch, type PdfTextContent } from './pdf-text-search.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rejectedWith<T>(reason: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    Reflect.apply(reject, undefined, [reason]);
  });
}

function content(...items: Array<string | { str: string; hasEOL: boolean }>): PdfTextContent {
  return {
    items: items.map((item) => {
      const value = typeof item === 'string' ? { str: item, hasEOL: false } : item;
      return {
        ...value,
        dir: 'ltr',
        transform: [1, 0, 0, 1, 0, 0],
        width: 1,
        height: 1,
        fontName: 'test',
      };
    }),
    styles: {},
    lang: null,
  };
}

function pdfWithPages(
  pages: Array<PdfTextContent | Promise<PdfTextContent>>,
  onGetPage: () => void = () => undefined,
): {
  getPage: ReturnType<typeof vi.fn>;
  pdf: PDFDocumentProxy;
  textCalls: Array<ReturnType<typeof vi.fn>>;
} {
  const textCalls = pages.map((page) => vi.fn(async () => page));
  const getPage = vi.fn(async (pageNumber: number) => {
    onGetPage();
    return { getTextContent: textCalls[pageNumber - 1] };
  });
  return {
    getPage,
    pdf: { numPages: pages.length, getPage } as unknown as PDFDocumentProxy,
    textCalls,
  };
}

describe('PdfTextSearch', () => {
  it('rejects an already-aborted empty query without emitting or extracting', async () => {
    const fixture = pdfWithPages([content('alpha')]);
    const search = new PdfTextSearch(fixture.pdf);
    const emit = vi.fn();

    await expect(search.search('', AbortSignal.abort(), emit)).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(emit).not.toHaveBeenCalled();
    expect(fixture.getPage).not.toHaveBeenCalled();
    expect(search.cachedPageCount).toBe(0);
  });

  it('rejects an already-aborted query before starting page extraction', async () => {
    const fixture = pdfWithPages([content('alpha')]);
    const search = new PdfTextSearch(fixture.pdf);
    const emit = vi.fn();

    await expect(search.search('alpha', AbortSignal.abort(), emit)).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(emit).not.toHaveBeenCalled();
    expect(fixture.getPage).not.toHaveBeenCalled();
    expect(search.cachedPageCount).toBe(0);
  });

  it('finds repeated case-insensitive matches with stable page and match IDs', async () => {
    const { pdf } = pdfWithPages([content('Echo echo ECHO')]);
    const search = new PdfTextSearch(pdf);
    const updates: SearchResultSet[] = [];

    const result = await search.search('echo', AbortSignal.timeout(1_000), (update) => {
      updates.push(update);
    });

    expect(result).toEqual({
      query: 'echo',
      hits: [
        { id: 'page-0-match-0', pageIndex: 0, matchIndex: 0, preview: 'Echo echo ECHO' },
        { id: 'page-0-match-1', pageIndex: 0, matchIndex: 1, preview: 'Echo echo ECHO' },
        { id: 'page-0-match-2', pageIndex: 0, matchIndex: 2, preview: 'Echo echo ECHO' },
      ],
      complete: true,
    });
    expect(updates).toEqual([result]);
  });

  it('matches and builds a bounded snippet across text-item boundaries', async () => {
    const longPrefix = 'a'.repeat(100);
    const longSuffix = 'z'.repeat(100);
    const { pdf } = pdfWithPages([content(`${longPrefix} inter`, `national ${longSuffix}`)]);
    const search = new PdfTextSearch(pdf);

    const result = await search.search('international', AbortSignal.timeout(1_000), () => {});

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.preview).toContain('international');
    expect(result.hits[0]?.preview.length).toBeLessThanOrEqual(120);
    expect(result.hits[0]?.preview.startsWith('…')).toBe(true);
    expect(result.hits[0]?.preview.endsWith('…')).toBe(true);
  });

  it('preserves explicit PDF line endings while normalizing whitespace in previews', async () => {
    const { pdf } = pdfWithPages([content({ str: 'first line', hasEOL: true }, 'second   line')]);
    const search = new PdfTextSearch(pdf);

    const result = await search.search('second', AbortSignal.timeout(1_000), () => {});

    expect(result.hits[0]?.preview).toBe('first line second line');
  });

  it('ignores marked-content structure while extracting searchable text', async () => {
    const marked = {
      items: [{ type: 'beginMarkedContent' }, { str: 'needle', hasEOL: false }],
      styles: {},
      lang: null,
    } satisfies PdfTextContent;
    const { pdf } = pdfWithPages([marked]);

    const result = await new PdfTextSearch(pdf).search(
      'needle',
      AbortSignal.timeout(1_000),
      () => {},
    );

    expect(result.hits).toHaveLength(1);
  });

  it('maps a non-Error page extraction rejection to a stable error', async () => {
    const { pdf } = pdfWithPages([rejectedWith('raw extraction rejection')]);

    await expect(
      new PdfTextSearch(pdf).search('needle', AbortSignal.timeout(1_000), () => {}),
    ).rejects.toThrow('Unknown PDF text extraction failure.');
  });

  it('preserves an Error page extraction rejection', async () => {
    const cause = new Error('page extraction failed');
    const { pdf } = pdfWithPages([Promise.reject(cause)]);

    await expect(
      new PdfTextSearch(pdf).search('needle', AbortSignal.timeout(1_000), () => {}),
    ).rejects.toBe(cause);
  });

  it('stops when the caller aborts as page extraction begins', async () => {
    const controller = new AbortController();
    const fixture = pdfWithPages([content('needle')], () => {
      controller.abort();
    });

    await expect(
      new PdfTextSearch(fixture.pdf).search('needle', controller.signal, () => {}),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('completes a non-empty search in an empty PDF', async () => {
    const { pdf } = pdfWithPages([]);
    const updates: SearchResultSet[] = [];

    const result = await new PdfTextSearch(pdf).search(
      'needle',
      new AbortController().signal,
      (update) => {
        updates.push(update);
      },
    );

    expect(result).toEqual({ query: 'needle', hits: [], complete: true });
    expect(updates).toEqual([result]);
  });

  it('emits immutable partial results in page order while scanning', async () => {
    const { pdf } = pdfWithPages([
      content('needle first'),
      content('no match'),
      content('needle last'),
    ]);
    const search = new PdfTextSearch(pdf);
    const updates: SearchResultSet[] = [];

    await search.search('needle', AbortSignal.timeout(1_000), (update) => {
      updates.push(update);
    });

    expect(
      updates.map((update) => [update.complete, update.hits.map((hit) => hit.pageIndex)]),
    ).toEqual([
      [false, [0]],
      [false, [0]],
      [true, [0, 2]],
    ]);
    expect(updates.every((update) => Object.isFrozen(update) && Object.isFrozen(update.hits))).toBe(
      true,
    );
    expect(updates[0]?.hits).not.toBe(updates[1]?.hits);
  });

  it('stops promptly when cancelled during page extraction', async () => {
    const pending = deferred<PdfTextContent>();
    const fixture = pdfWithPages([content('first'), pending.promise, content('third')]);
    const search = new PdfTextSearch(fixture.pdf);
    const controller = new AbortController();
    const updates: SearchResultSet[] = [];

    const scanning = search.search('first', controller.signal, (update) => {
      updates.push(update);
    });
    await vi.waitFor(() => {
      expect(fixture.getPage).toHaveBeenCalledTimes(2);
    });
    controller.abort();

    await expect(scanning).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.getPage).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(1);
    pending.resolve(content('first late'));
  });

  it('caches only extracted page text and clears the cache on dispose', async () => {
    const fixture = pdfWithPages([content('alpha beta')]);
    const search = new PdfTextSearch(fixture.pdf);

    await search.search('alpha', AbortSignal.timeout(1_000), () => {});
    await search.search('beta', AbortSignal.timeout(1_000), () => {});

    expect(fixture.getPage).toHaveBeenCalledOnce();
    expect(search.cachedPageCount).toBe(1);

    search.dispose();
    search.dispose();

    expect(search.cachedPageCount).toBe(0);
    await expect(
      search.search('alpha', AbortSignal.timeout(1_000), () => {}),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
