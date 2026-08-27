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
        {
          id: 'page-0-match-0',
          pageIndex: 0,
          matchIndex: 0,
          preview: 'Echo echo ECHO',
          previewMatches: [
            { end: 4, start: 0 },
            { end: 9, start: 5 },
            { end: 14, start: 10 },
          ],
        },
        {
          id: 'page-0-match-1',
          pageIndex: 0,
          matchIndex: 1,
          preview: 'Echo echo ECHO',
          previewMatches: [
            { end: 4, start: 0 },
            { end: 9, start: 5 },
            { end: 14, start: 10 },
          ],
        },
        {
          id: 'page-0-match-2',
          pageIndex: 0,
          matchIndex: 2,
          preview: 'Echo echo ECHO',
          previewMatches: [
            { end: 4, start: 0 },
            { end: 9, start: 5 },
            { end: 14, start: 10 },
          ],
        },
      ],
      complete: true,
    });
    expect(updates).toEqual([result]);
  });

  it('preserves exact Unicode and RTL ranges while numbering matches like PDF.js', async () => {
    const { pdf } = pdfWithPages([content('banana CAFÉ אבג אבג')]);
    const search = new PdfTextSearch(pdf);

    const overlapping = await search.search('ana', AbortSignal.timeout(1_000), () => {});
    expect(overlapping.hits).toEqual([
      {
        id: 'page-0-match-0',
        pageIndex: 0,
        matchIndex: 0,
        preview: 'banana CAFÉ אבג אבג',
        previewMatches: [{ end: 4, start: 1 }],
      },
    ]);

    const composed = await search.search('café', AbortSignal.timeout(1_000), () => {});
    expect(composed.hits).toEqual([
      {
        id: 'page-0-match-0',
        pageIndex: 0,
        matchIndex: 0,
        preview: 'banana CAFÉ אבג אבג',
        previewMatches: [{ end: 11, start: 7 }],
      },
    ]);

    const rtl = await search.search('אבג', AbortSignal.timeout(1_000), () => {});
    expect(rtl.hits).toHaveLength(2);
    expect(rtl.hits[0]?.previewMatches).toEqual([
      { end: 15, start: 12 },
      { end: 19, start: 16 },
    ]);
    expect(rtl.hits[1]?.previewMatches).toEqual(rtl.hits[0]?.previewMatches);
  });

  it('mirrors PDF.js EOL, punctuation, and NFKC occurrence ranges', async () => {
    const fixture = pdfWithPages([
      content({ str: 'first', hasEOL: true }, 'second … first second'),
      content("don't don’t"),
      content('office oﬃce'),
    ]);
    const search = new PdfTextSearch(fixture.pdf);

    const eol = await search.search('first second', AbortSignal.timeout(1_000), () => {});
    expect(eol.hits.map((hit) => [hit.pageIndex, hit.matchIndex, hit.previewMatches])).toEqual([
      [
        0,
        0,
        [
          { end: 12, start: 0 },
          { end: 27, start: 15 },
        ],
      ],
      [
        0,
        1,
        [
          { end: 12, start: 0 },
          { end: 27, start: 15 },
        ],
      ],
    ]);

    const punctuation = await search.search("don't", AbortSignal.timeout(1_000), () => {});
    expect(
      punctuation.hits.map((hit) => [hit.pageIndex, hit.matchIndex, hit.previewMatches]),
    ).toEqual([
      [
        1,
        0,
        [
          { end: 5, start: 0 },
          { end: 11, start: 6 },
        ],
      ],
      [
        1,
        1,
        [
          { end: 5, start: 0 },
          { end: 11, start: 6 },
        ],
      ],
    ]);

    const nfkc = await search.search('office', AbortSignal.timeout(1_000), () => {});
    expect(nfkc.hits.map((hit) => [hit.pageIndex, hit.matchIndex, hit.previewMatches])).toEqual([
      [
        2,
        0,
        [
          { end: 6, start: 0 },
          { end: 11, start: 7 },
        ],
      ],
      [
        2,
        1,
        [
          { end: 6, start: 0 },
          { end: 11, start: 7 },
        ],
      ],
    ]);
  });

  it('mirrors PDF.js hyphen-EOL branches and exact occurrence ranges', async () => {
    const fixture = pdfWithPages([
      content(' -\nnext … - next'),
      content('e\u0301-\nlan … e\u0301lan'),
      content('lower-\ncase UPPER-\nCase 1-\nray'),
    ]);
    const search = new PdfTextSearch(fixture.pdf);

    const whitespace = await search.search('- next', AbortSignal.timeout(1_000), () => {});
    expect(
      whitespace.hits.map((hit) => [hit.pageIndex, hit.matchIndex, hit.previewMatches]),
    ).toEqual([
      [
        0,
        0,
        [
          { end: 6, start: 0 },
          { end: 15, start: 9 },
        ],
      ],
      [
        0,
        1,
        [
          { end: 6, start: 0 },
          { end: 15, start: 9 },
        ],
      ],
    ]);

    const combining = await search.search('e\u0301lan', AbortSignal.timeout(1_000), () => {});
    expect(
      combining.hits.map((hit) => [hit.pageIndex, hit.matchIndex, hit.previewMatches]),
    ).toEqual([
      [
        1,
        0,
        [
          { end: 7, start: 0 },
          { end: 15, start: 10 },
        ],
      ],
      [
        1,
        1,
        [
          { end: 7, start: 0 },
          { end: 15, start: 10 },
        ],
      ],
    ]);

    const lowercase = await search.search('lowercase', AbortSignal.timeout(1_000), () => {});
    const uppercase = await search.search('UPPERCase', AbortSignal.timeout(1_000), () => {});
    const retainedHyphen = await search.search('1-ray', AbortSignal.timeout(1_000), () => {});
    expect(lowercase.hits).toHaveLength(1);
    expect(uppercase.hits).toHaveLength(1);
    expect(retainedHyphen.hits).toHaveLength(1);
    expect(lowercase.hits[0]?.previewMatches[0]).toEqual({ end: 11, start: 0 });
    expect(uppercase.hits[0]?.previewMatches[0]).toEqual({ end: 23, start: 12 });
    expect(retainedHyphen.hits[0]?.previewMatches[0]).toEqual({ end: 30, start: 24 });
  });

  it('uses original adjacency for consecutive EOL after combining-mark hyphenation', async () => {
    const source = 'e\u0301-\n\nlan … e\u0301lan';
    const search = new PdfTextSearch(pdfWithPages([content(source)]).pdf);

    const result = await search.search('e\u0301lan', AbortSignal.timeout(1_000), () => {});

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      matchIndex: 0,
      pageIndex: 0,
      previewMatches: [{ end: 15, start: 10 }],
    });
  });

  it('keeps bounded previews well-formed when a window begins inside an astral symbol', async () => {
    const text = `${'a'.repeat(54)}😀${'b'.repeat(55)}needle${'z'.repeat(100)}`;
    const search = new PdfTextSearch(pdfWithPages([content(text)]).pdf);

    const result = await search.search('needle', AbortSignal.timeout(1_000), () => {});

    const preview = result.hits[0]?.preview as string & { isWellFormed(): boolean };
    expect(preview.isWellFormed()).toBe(true);
    const match = result.hits[0]?.previewMatches[0];
    if (match === undefined) throw new Error('Expected an exact preview match range.');
    expect(preview.slice(match.start, match.end)).toBe('needle');
  });

  it('matches combining-mark exceptions with PDF.js occurrence numbering and source ranges', async () => {
    const search = new PdfTextSearch(pdfWithPages([content('क् क'), content('が か')]).pdf);

    const virama = await search.search('क', AbortSignal.timeout(1_000), () => {});
    expect(virama.hits.map((hit) => [hit.pageIndex, hit.matchIndex, hit.previewMatches])).toEqual([
      [
        0,
        0,
        [
          { end: 1, start: 0 },
          { end: 4, start: 3 },
        ],
      ],
      [
        0,
        1,
        [
          { end: 1, start: 0 },
          { end: 4, start: 3 },
        ],
      ],
    ]);

    const voicing = await search.search('か', AbortSignal.timeout(1_000), () => {});
    expect(voicing.hits.map((hit) => [hit.pageIndex, hit.matchIndex, hit.previewMatches])).toEqual([
      [
        1,
        0,
        [
          { end: 1, start: 0 },
          { end: 4, start: 3 },
        ],
      ],
      [
        1,
        1,
        [
          { end: 1, start: 0 },
          { end: 4, start: 3 },
        ],
      ],
    ]);
  });

  it('marks the exact visible intersection of a match longer than the bounded preview', async () => {
    const query = 'x'.repeat(130);
    const search = new PdfTextSearch(pdfWithPages([content(query)]).pdf);

    const result = await search.search(query, AbortSignal.timeout(1_000), () => {});

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.preview.length).toBeLessThanOrEqual(120);
    const visibleMatch = result.hits[0]?.previewMatches[0];
    if (visibleMatch === undefined) throw new Error('Expected a clipped visible match range.');
    expect(visibleMatch.end).toBeGreaterThan(visibleMatch.start);
    expect(result.hits[0]?.preview.slice(visibleMatch.start, visibleMatch.end)).toMatch(/^x+$/u);
  });

  it('does not add a leading ellipsis when surrogate alignment moves the window to offset zero', async () => {
    const text = `😀${'b'.repeat(55)}needle${'z'.repeat(100)}`;
    const search = new PdfTextSearch(pdfWithPages([content(text)]).pdf);

    const result = await search.search('needle', AbortSignal.timeout(1_000), () => {});

    const preview = result.hits[0]?.preview as string & { isWellFormed(): boolean };
    expect(preview.isWellFormed()).toBe(true);
    expect(preview.startsWith('…')).toBe(false);
    expect(preview.startsWith('😀')).toBe(true);
  });

  it('maps a match through normalized preview whitespace without losing source case', async () => {
    const { pdf } = pdfWithPages([content({ str: 'before', hasEOL: true }, '  NeedLe   after')]);

    const result = await new PdfTextSearch(pdf).search(
      'needle',
      AbortSignal.timeout(1_000),
      () => {},
    );

    expect(result.hits[0]).toEqual({
      id: 'page-0-match-0',
      pageIndex: 0,
      matchIndex: 0,
      preview: 'before NeedLe after',
      previewMatches: [{ end: 13, start: 7 }],
    });
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
