import type { TFile } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentViewport } from '../../document-core/document.js';
import type { PdfRuntime } from './pdf-runtime.js';
import { PdfDocumentSession, type PdfViewportFactory } from './pdf-session.js';
import type { PdfTextSearch } from './pdf-text-search.js';

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

  it('passes one session-owned text search service to every created viewport', async () => {
    const { document, pdfjsViewer, session, viewportFactory } = sessionFixture();

    await session.createViewport();
    await session.createViewport();

    expect(viewportFactory).toHaveBeenCalledTimes(2);
    expect(viewportFactory.mock.calls[0]?.[0]).toBe(document);
    expect(viewportFactory.mock.calls[0]?.[1]).toBe(pdfjsViewer);
    expect(viewportFactory.mock.calls[0]?.[2]).toBe(viewportFactory.mock.calls[1]?.[2]);
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
