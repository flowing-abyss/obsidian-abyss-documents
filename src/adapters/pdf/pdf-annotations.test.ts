import { describe, expect, it, vi } from 'vitest';
import type { DocumentAnnotation } from '../../document-core/annotations.js';
import { extractAnnotations } from './pdf-annotations.js';

function page(annotations: Array<Record<string, unknown>>) {
  return { getAnnotations: vi.fn(async () => annotations), view: [0, 0, 600, 800] };
}

describe('extractAnnotations', () => {
  it('maps native and read-only PDF annotations and parses explicit metadata tokens', async () => {
    const pages = [
      page([
        {
          annotationType: 9,
          id: 'highlight-1',
          rect: [10, 700, 110, 720],
          quadPoints: [10, 720, 110, 720, 10, 700, 110, 700],
          color: new Uint8ClampedArray([255, 212, 0]),
          textContent: ['Selected concept'],
          titleObj: { str: 'Ada' },
          contentsObj: { str: 'Read #Theory and #ＴＨＥＯＲＹ near [[Foundations]]; not x#noise.' },
          modificationDate: 'D:20260811120000Z',
        },
        {
          annotationType: 1,
          id: 'note-1',
          rect: [20, 600, 40, 620],
          contentsObj: { str: 'Ordinary note' },
        },
      ]),
    ];
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async (number: number) => {
        const found = pages[number - 1];
        if (found === undefined) throw new Error('Missing test page.');
        return found;
      }),
    };
    const batches: unknown[][] = [];

    await extractAnnotations(pdf, new AbortController().signal, (batch) =>
      batches.push([...batch]),
    );

    const annotations = batches.flat();
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toMatchObject({
      type: 'highlight',
      color: '#ffd400',
      selectedText: 'Selected concept',
      author: 'Ada',
      comment: 'Read #Theory and #ＴＨＥＯＲＹ near [[Foundations]]; not x#noise.',
      tags: ['Theory'],
      links: ['Foundations'],
      anchor: { kind: 'fixed-page', pageIndex: 0 },
    });
    expect(annotations[1]).toMatchObject({ type: 'text-note', comment: 'Ordinary note' });
  });

  it('uses canonical alias, heading, and Unicode token normalization', async () => {
    const batches: DocumentAnnotation[][] = [];
    await extractAnnotations(
      {
        numPages: 1,
        getPage: vi.fn(async () =>
          page([
            {
              annotationType: 9,
              id: 'token-id',
              rect: [0, 0, 1, 1],
              contentsObj: { str: '#ＴＡＧ [[Ｆｏｏ#Heading|Alias]]' },
            },
          ]),
        ),
      },
      new AbortController().signal,
      (batch) => batches.push([...batch]),
    );
    expect(batches.flat()[0]).toMatchObject({ tags: ['ＴＡＧ'], links: ['Ｆｏｏ'] });
  });

  it('stops before reading a stale page and yields batches within a configurable deadline', async () => {
    const controller = new AbortController();
    const second = page([]);
    const pdf = {
      numPages: 2,
      getPage: vi.fn(async (number: number) => {
        if (number === 1) return page([{ annotationType: 1, id: 'one', rect: [0, 0, 1, 1] }]);
        return second;
      }),
    };

    await expect(
      extractAnnotations(pdf, controller.signal, () => {
        controller.abort();
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(pdf.getPage).toHaveBeenCalledTimes(1);
  });

  it('enriches a page read failure with its exact 1-based page number', async () => {
    const cause = new Error('worker page failed');
    const pdf = {
      numPages: 3,
      getPage: vi.fn(async (pageNumber: number) => {
        if (pageNumber === 2) throw cause;
        return page([]);
      }),
    };

    await expect(
      extractAnnotations(pdf, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({
      name: 'PdfAnnotationExtractionError',
      pageNumber: 2,
      cause,
    });
  });

  it('flushes a large page in time-bounded batches without rendering it', async () => {
    const now = vi.spyOn(performance, 'now');
    let tick = 0;
    now.mockImplementation(() => (tick += 30));
    const getAnnotations = vi.fn(async () =>
      Array.from({ length: 6 }, (_, index) => ({
        annotationType: 1,
        id: `note-${index}`,
        rect: [0, 0, 1, 1],
      })),
    );
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => ({ getAnnotations, view: [0, 0, 600, 800] })),
    };
    const batches: number[] = [];

    await extractAnnotations(pdf, new AbortController().signal, (batch) =>
      batches.push(batch.length),
    );

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.reduce((sum, length) => sum + length, 0)).toBe(6);
    expect(getAnnotations).toHaveBeenCalledWith({ intent: 'display' });
  });

  it('maps all supported geometry branches and tolerates malformed optional metadata', async () => {
    const annotations = [
      { annotationType: 3, rect: [1, 2, 11, 22], textContent: 'Free', creationDate: 'bad' },
      { annotationType: 10, id: '', rect: [0, 0, 1, 1], textContent: [] },
      { annotationType: 15, id: 'ink', inkLists: [[1, 2, 3, 4]], color: [-2, 300, 10.4] },
      { annotationType: 99, id: 'other', rect: null, contentsObj: { str: '[[ ]] [[ok]] [[ok]]' } },
      { annotationType: {}, id: 'unknown', rect: [], titleObj: { str: 1 } },
    ];
    const pdf = {
      numPages: 1,
      getPage: vi.fn(async () => page(annotations)),
    };
    const result: DocumentAnnotation[] = [];
    await extractAnnotations(pdf, new AbortController().signal, (batch) => {
      result.push(...batch);
    });

    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({ type: 'free-text', selectedText: 'Free', createdAt: null });
    expect(result[1]).toMatchObject({ type: 'underline', identity: { kind: 'legacy' } });
    expect(result[2]).toMatchObject({
      type: 'ink',
      color: '#00ff0a',
      anchor: {
        geometry: {
          kind: 'ink',
          paths: [
            [
              { x: 1, y: 798 },
              { x: 3, y: 796 },
            ],
          ],
        },
      },
    });
    expect(result[3]).toMatchObject({ type: 'unsupported', externalType: '99', links: ['ok'] });
    expect(result[4]).toMatchObject({ type: 'unsupported', externalType: 'unknown', author: '' });
  });

  it('cancels immediately when already aborted and after an owned yield', async () => {
    const already = new AbortController();
    already.abort();
    const pdf = { numPages: 1, getPage: vi.fn(async () => page([])) };
    await expect(extractAnnotations(pdf, already.signal, () => undefined)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(pdf.getPage).not.toHaveBeenCalled();

    const during = new AbortController();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 100;
      return now;
    });
    const timeout = vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      during.abort();
      callback();
      return 1 as unknown as ReturnType<typeof window.setTimeout>;
    });
    await expect(
      extractAnnotations(
        { numPages: 1, getPage: vi.fn(async () => page([{ annotationType: 1 }])) },
        during.signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    timeout.mockRestore();
  });
});
