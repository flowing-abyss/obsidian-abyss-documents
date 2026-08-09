import type { TFile } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentViewport } from '../../document-core/document.js';
import { DocumentPasswordError } from '../../document-core/errors.js';
import type { PdfRuntime } from './pdf-runtime.js';
import { PdfDocumentSession, type PdfViewportFactory } from './pdf-session.js';
import type { PdfTextSearch } from './pdf-text-search.js';

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function file(path: string): TFile {
  const app = App.createConfigured__({ files: { [path]: '' } });
  const source = app.vault.getAbstractFileByPath(path);
  if (!(source instanceof MockTFile)) throw new Error(`Expected a test file at ${path}.`);
  return source.asOriginalType2__();
}

function pdf(overrides: Partial<PDFDocumentProxy> = {}): PDFDocumentProxy {
  return {
    fingerprints: ['primary-fingerprint', 'modified-fingerprint'],
    numPages: 3,
    getOutline: vi.fn(async () => [
      {
        title: 'Chapter 1',
        dest: [{ num: 7, gen: 0 }, { name: 'Fit' }],
        items: [],
      },
    ]),
    getDestination: vi.fn(async () => null),
    getPageIndex: vi.fn(async () => 2),
    getPage: vi.fn(async () => ({
      getTextContent: vi.fn(async () => ({ items: [], styles: {}, lang: null })),
    })),
    cleanup: vi.fn(async () => undefined),
    loadingTask: { destroy: vi.fn(async () => undefined) },
    ...overrides,
  } as unknown as PDFDocumentProxy;
}

function viewport(): DocumentViewport {
  return {
    pageCount: 3,
    mount: vi.fn(async () => undefined),
    goTo: vi.fn(async () => undefined),
    setScale: vi.fn(),
    setReadingColors: vi.fn(),
    search: vi.fn(),
    searchAgain: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    focus: vi.fn(),
    destroy: vi.fn(async () => undefined),
  };
}

function outlineNode(dest: string): Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number] {
  return {
    title: 'Chapter 1',
    bold: false,
    italic: false,
    color: new Uint8ClampedArray([0, 0, 0]),
    dest,
    url: null,
    unsafeUrl: undefined,
    newWindow: undefined,
    count: undefined,
    items: [],
  };
}

function sessionFixture(overrides: Partial<PDFDocumentProxy> = {}) {
  const cleanup = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const document = pdf({
    cleanup,
    loadingTask: { destroy } as unknown as PDFDocumentProxy['loadingTask'],
    ...overrides,
  });
  const createdViewport = viewport();
  const viewportFactory = vi.fn(
    async (
      _pdf: PDFDocumentProxy,
      _pdfjsViewer: PdfRuntime['pdfjsViewer'],
      _search: PdfTextSearch,
    ) => createdViewport,
  ) satisfies PdfViewportFactory;
  const pdfjsViewer = {} as PdfRuntime['pdfjsViewer'];
  const session = new PdfDocumentSession(
    file('Books/Guide.pdf'),
    document,
    pdfjsViewer,
    viewportFactory,
  );
  return { cleanup, createdViewport, destroy, document, pdfjsViewer, session, viewportFactory };
}

describe('PdfDocumentSession', () => {
  it('exposes the PDF descriptor and read-only capabilities', () => {
    const { session } = sessionFixture();

    expect(session.descriptor).toEqual({
      path: 'Books/Guide.pdf',
      name: 'Guide.pdf',
      fingerprint: 'primary-fingerprint',
      pageCount: 3,
    });
    expect(session.capabilities).toEqual(
      new Set(['outline', 'text-search', 'existing-annotations']),
    );
  });

  it('maps outline destinations through the public PDF.js APIs', async () => {
    const { session } = sessionFixture();

    await expect(session.getOutline()).resolves.toEqual([
      { id: 'outline-0', label: 'Chapter 1', target: { pageIndex: 2 }, children: [] },
    ]);
  });

  it('enriches outline failures without collapsing the cause', async () => {
    const cause = new Error('outline worker failed');
    const { session } = sessionFixture({
      getOutline: vi.fn(async () => {
        throw cause;
      }),
    });

    await expect(session.getOutline()).rejects.toMatchObject({
      name: 'DocumentOpenError',
      path: 'Books/Guide.pdf',
      cause,
    });
  });

  it('cancels an outline whose destination resolves after the session closes', async () => {
    const destination = deferred<unknown[] | null>();
    const getDestination = vi.fn(() => destination.promise);
    const { session } = sessionFixture({
      getDestination,
      getOutline: vi.fn(async () => [outlineNode('chapter-one')]),
    });

    const reading = session.getOutline();
    await vi.waitFor(() => {
      expect(getDestination).toHaveBeenCalledOnce();
    });
    await session.close();
    destination.resolve([{ num: 7, gen: 0 }, { name: 'Fit' }]);

    await expect(reading).rejects.toMatchObject({ name: 'DocumentCancelledError' });
  });

  it('maps a PDF.js destination abort to an owned cancellation', async () => {
    const cause = Object.assign(new Error('worker stopped'), { name: 'AbortException' });
    const { session } = sessionFixture({
      getDestination: vi.fn(async () => {
        throw cause;
      }),
      getOutline: vi.fn(async () => [outlineNode('chapter-one')]),
    });

    await expect(session.getOutline()).rejects.toMatchObject({
      name: 'DocumentCancelledError',
      cause,
    });
  });

  it('passes one session-owned text search service to every created viewport', async () => {
    const { document, pdfjsViewer, session, viewportFactory } = sessionFixture();

    await session.createViewport();
    await session.createViewport();

    expect(viewportFactory).toHaveBeenCalledTimes(2);
    expect(viewportFactory.mock.calls[0]?.[0]).toBe(document);
    expect(viewportFactory.mock.calls[0]?.[1]).toBe(pdfjsViewer);
    expect(viewportFactory.mock.calls[0]?.[2]).toBe(viewportFactory.mock.calls[1]?.[2]);
  });

  it('maps a viewport factory failure through the session boundary', async () => {
    const cause = new Error('viewer construction failed');
    const { session, viewportFactory } = sessionFixture();
    viewportFactory.mockRejectedValue(cause);

    await expect(session.createViewport()).rejects.toMatchObject({
      name: 'DocumentOpenError',
      path: 'Books/Guide.pdf',
      cause,
    });
  });

  it('preserves an owned viewport factory failure unchanged', async () => {
    const cause = new DocumentPasswordError(
      'Books/Guide.pdf',
      'This PDF requires a password. Try again and enter the password.',
    );
    const { session, viewportFactory } = sessionFixture();
    viewportFactory.mockRejectedValue(cause);

    await expect(session.createViewport()).rejects.toBe(cause);
  });

  it('maps a PDF.js viewport factory abort to an owned cancellation', async () => {
    const cause = Object.assign(new Error('viewer worker stopped'), { name: 'AbortException' });
    const { session, viewportFactory } = sessionFixture();
    viewportFactory.mockRejectedValue(cause);

    await expect(session.createViewport()).rejects.toMatchObject({
      name: 'DocumentCancelledError',
      cause,
    });
  });

  it('returns cancellation when close wins a pending viewport factory rejection', async () => {
    const pending = deferred<DocumentViewport>();
    const cause = new Error('late factory failure');
    const { session, viewportFactory } = sessionFixture();
    viewportFactory.mockReturnValue(pending.promise);

    const creating = session.createViewport();
    await vi.waitFor(() => {
      expect(viewportFactory).toHaveBeenCalledOnce();
    });
    await session.close();
    pending.reject(cause);

    await expect(creating).rejects.toMatchObject({
      name: 'DocumentCancelledError',
      cause,
    });
  });

  it('keeps cancellation primary when a late viewport rejects destruction', async () => {
    const pending = deferred<DocumentViewport>();
    const destroyCause = new Error('late viewport destroy failed');
    const lateViewport = viewport();
    lateViewport.destroy = vi.fn(async () => {
      throw destroyCause;
    });
    const { session, viewportFactory } = sessionFixture();
    viewportFactory.mockReturnValue(pending.promise);

    const creating = session.createViewport();
    await vi.waitFor(() => {
      expect(viewportFactory).toHaveBeenCalledOnce();
    });
    await session.close();
    pending.resolve(lateViewport);

    await expect(creating).rejects.toMatchObject({
      name: 'DocumentCancelledError',
      cause: destroyCause,
    });
  });

  it('cancels and clears the session search service on close', async () => {
    const { session, viewportFactory } = sessionFixture();
    await session.createViewport();
    const search = viewportFactory.mock.calls[0]?.[2];
    if (search === undefined) throw new Error('Expected the session to create a text search.');
    const scanning = search.search('missing', new AbortController().signal, () => {});

    await session.close();

    await expect(scanning).rejects.toMatchObject({ name: 'AbortError' });
    expect(search.cachedPageCount).toBe(0);
  });

  it('cleans up and destroys the PDF exactly once when close is called twice', async () => {
    const { cleanup, destroy, session } = sessionFixture();

    await Promise.all([session.close(), session.close()]);
    await session.close();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('rejects work after close as a typed cancellation', async () => {
    const { session, viewportFactory } = sessionFixture();
    await session.close();

    await expect(session.getOutline()).rejects.toMatchObject({ name: 'DocumentCancelledError' });
    await expect(session.createViewport()).rejects.toMatchObject({
      name: 'DocumentCancelledError',
    });
    expect(viewportFactory).not.toHaveBeenCalled();
  });
});
