import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import type { ViewportEvent } from '../../document-core/document.js';
import type { PdfRuntime } from './pdf-runtime.js';
import { PdfTextSearch } from './pdf-text-search.js';
import { createPdfDocumentViewport, PdfDocumentViewport } from './pdf-viewport.js';

type Listener = (event: unknown) => void;

class FakeEventBus {
  readonly dispatched: Array<{ name: string; data: Record<string, unknown> }> = [];
  readonly listeners = new Map<string, Set<Listener>>();

  on(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  off(name: string, listener: Listener): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, data: Record<string, unknown>): void {
    this.dispatched.push({ name, data });
    for (const listener of this.listeners.get(name) ?? []) listener(data);
  }
}

function pdf(pageCount = 700): PDFDocumentProxy {
  return {
    numPages: pageCount,
    getPage: vi.fn(async () => ({
      getTextContent: vi.fn(async () => ({
        items: [
          {
            str: 'needle in page text',
            hasEOL: false,
            dir: 'ltr',
            transform: [1, 0, 0, 1, 0, 0],
            width: 1,
            height: 1,
            fontName: 'test',
          },
        ],
        styles: {},
        lang: null,
      })),
    })),
  } as unknown as PDFDocumentProxy;
}

function viewerRuntime() {
  const state: {
    eventBus?: FakeEventBus;
    findController?: InstanceType<typeof FakeFindController>;
    linkService?: InstanceType<typeof FakeLinkService>;
    viewer?: InstanceType<typeof FakeViewer>;
  } = {};

  class EventBus extends FakeEventBus {
    constructor() {
      super();
      state.eventBus = this;
    }
  }

  class FakeLinkService {
    readonly documents: Array<PDFDocumentProxy | null> = [];
    readonly pages: Array<number | string> = [];
    readonly positions: Array<[number, number, number]> = [];
    viewer: FakeViewer | null = null;

    constructor(readonly options: { eventBus: FakeEventBus }) {
      state.linkService = this;
    }

    setDocument(document: PDFDocumentProxy | null): void {
      this.documents.push(document);
    }

    setViewer(viewer: FakeViewer): void {
      this.viewer = viewer;
    }

    goToPage(page: number | string): void {
      this.pages.push(page);
    }

    goToXY(page: number, x: number, y: number): void {
      this.positions.push([page, x, y]);
    }
  }

  class FakeFindController {
    readonly documents: Array<PDFDocumentProxy | null> = [];

    constructor(
      readonly options: { linkService: FakeLinkService; eventBus: FakeEventBus; delay?: number },
    ) {
      state.findController = this;
    }

    setDocument(document: PDFDocumentProxy | null): void {
      this.documents.push(document);
    }
  }

  class FakeViewer {
    readonly cleanup = vi.fn();
    readonly focus = vi.fn();
    readonly update = vi.fn();
    readonly documents: Array<PDFDocumentProxy | null> = [];
    currentPageNumber = 1;
    currentScale = 1;
    currentScaleValue = 'auto';
    pageColors: object | null;

    constructor(
      readonly options: {
        container: HTMLDivElement;
        viewer: HTMLDivElement;
        eventBus: FakeEventBus;
        linkService: FakeLinkService;
        findController: FakeFindController;
        textLayerMode: number;
        annotationMode: number;
        enablePermissions: boolean;
        supportsPinchToZoom: boolean;
        maxCanvasPixels: number;
        pageColors: object;
      },
    ) {
      this.pageColors = options.pageColors;
      state.viewer = this;
    }

    setDocument(pdfDocument: PDFDocumentProxy | null): void {
      this.documents.push(pdfDocument);
      this.options.viewer.replaceChildren();
      if (pdfDocument === null) return;
      for (let pageNumber = 1; pageNumber <= Math.min(3, pdfDocument.numPages); pageNumber += 1) {
        const page = createDiv();
        page.className = 'page';
        page.dataset['pageNumber'] = String(pageNumber);
        this.options.viewer.append(page);
      }
    }
  }

  const module = {
    EventBus,
    PDFLinkService: FakeLinkService,
    PDFFindController: FakeFindController,
    PDFViewer: FakeViewer,
  } as unknown as PdfRuntime['pdfjsViewer'];
  return { module, state };
}

async function mountedViewport(pageCount = 700) {
  const documentProxy = pdf(pageCount);
  const runtime = viewerRuntime();
  const search = new PdfTextSearch(documentProxy);
  const viewport = new PdfDocumentViewport(documentProxy, runtime.module, search);
  const host = createDiv();
  host.setCssProps({ '--background-primary': '#fafafa', '--text-normal': '#202020' });
  await viewport.mount(host);
  return { documentProxy, host, runtime, search, viewport };
}

describe('PdfDocumentViewport', () => {
  it('constructs the public PDF.js viewer stack with text, annotations, and bounded canvases', async () => {
    const fixture = await mountedViewport();
    const viewer = fixture.runtime.state.viewer;
    if (viewer === undefined) throw new Error('Expected a fake viewer.');

    expect(viewer.options).toMatchObject({
      textLayerMode: 1,
      annotationMode: 2,
      enablePermissions: true,
      supportsPinchToZoom: true,
      maxCanvasPixels: 16_777_216,
      pageColors: { background: '#fafafa', foreground: '#202020' },
    });
    expect(fixture.runtime.state.linkService?.viewer).toBe(viewer);
    expect(viewer.documents).toEqual([fixture.documentProxy]);
    expect(fixture.host.querySelectorAll('.page')).toHaveLength(3);
  });

  it('maps only the supported PDF.js viewer events into core viewport events', async () => {
    const fixture = await mountedViewport(3);
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));
    const eventBus = fixture.runtime.state.eventBus;
    if (eventBus === undefined) throw new Error('Expected a fake event bus.');

    eventBus.dispatch('pagechanging', { pageNumber: 2 });
    eventBus.dispatch('scalechanging', { scale: 1.5, presetValue: undefined });
    eventBus.dispatch('scalechanging', { scale: 1.2, presetValue: 'page-width' });

    expect(events).toEqual([
      { type: 'page-change', pageIndex: 1 },
      { type: 'scale-change', scale: 1.5 },
      { type: 'scale-change', scale: 'page-width' },
    ]);
  });

  it('delegates navigation, scale, focus, and initial fit through public viewer methods', async () => {
    const fixture = await mountedViewport(4);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const linkService = fixture.runtime.state.linkService;
    if (eventBus === undefined || viewer === undefined || linkService === undefined) {
      throw new Error('Expected viewer components.');
    }

    await fixture.viewport.goTo({ pageIndex: 2 });
    await fixture.viewport.goTo({ pageIndex: 1, x: 12 });
    await fixture.viewport.goTo({ pageIndex: 0, y: 24 });
    fixture.viewport.setScale(1.75);
    fixture.viewport.setScale('page-fit');
    fixture.viewport.focus();
    eventBus.dispatch('pagesinit', {});

    expect(linkService.pages).toEqual([3]);
    expect(linkService.positions).toEqual([
      [2, 12, 0],
      [1, 0, 24],
    ]);
    expect(viewer.currentScale).toBe(1.75);
    expect(viewer.currentScaleValue).toBe('page-width');
    expect(viewer.focus).toHaveBeenCalledOnce();
  });

  it('applies reading colors and turns a synchronous redraw failure into a page error', async () => {
    const fixture = await mountedViewport(3);
    const viewer = fixture.runtime.state.viewer;
    if (viewer === undefined) throw new Error('Expected a fake viewer.');
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));
    const colors = {
      background: '#f4ecd8',
      foreground: '#2d281f',
      brightness: 0.95,
      contrast: 1.05,
      imageDim: 0.1,
    };

    fixture.viewport.setReadingColors(colors);

    expect(viewer.pageColors).toEqual({ background: '#f4ecd8', foreground: '#2d281f' });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    expect(root?.style.getPropertyValue('--abyss-reader-brightness')).toBe('0.95');
    viewer.update.mockImplementationOnce(() => {
      throw new Error('redraw failed');
    });

    expect(() => {
      fixture.viewport.setReadingColors(colors);
    }).not.toThrow();
    expect(events[events.length - 1]).toMatchObject({ type: 'render-error', pageIndex: 0 });
  });

  it('emits owned search results while dispatching visible highlighting through PDF.js', async () => {
    const fixture = await mountedViewport(1);
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));

    fixture.viewport.search('needle');

    await vi.waitFor(() => {
      expect(events[events.length - 1]).toMatchObject({
        type: 'search-results',
        results: { query: 'needle', complete: true },
      });
    });
    expect(
      fixture.runtime.state.eventBus?.dispatched.some(
        ({ name, data }) => name === 'find' && data['query'] === 'needle',
      ),
    ).toBe(true);
  });

  it('supports find-again directions and contains asynchronous search failures', async () => {
    const fixture = await mountedViewport(1);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fixture.viewport.searchAgain('next');
    fixture.viewport.search('needle');
    await vi.waitFor(() => {
      expect(fixture.runtime.state.eventBus?.dispatched.some(({ name }) => name === 'find')).toBe(
        true,
      );
    });
    fixture.viewport.searchAgain('next');
    fixture.viewport.searchAgain('previous');
    const findEvents = fixture.runtime.state.eventBus?.dispatched.filter(
      ({ name }) => name === 'find',
    );
    expect(findEvents?.slice(-2).map(({ data }) => data['findPrevious'])).toEqual([false, true]);

    vi.spyOn(PdfTextSearch.prototype, 'search').mockRejectedValueOnce(new Error('search failed'));
    fixture.viewport.search('broken');
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledOnce();
    });
  });

  it('keeps a render error page-local, logs it once, and retries without escaping callbacks', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined)
      throw new Error('Expected viewer components.');
    const cause = new Error('canvas failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));

    expect(() => {
      eventBus.dispatch('pagerendered', { pageNumber: 2, error: cause });
      eventBus.dispatch('pagerendered', { pageNumber: 2, error: cause });
    }).not.toThrow();

    expect(events).toEqual([
      { type: 'render-error', pageIndex: 1, cause },
      { type: 'render-error', pageIndex: 1, cause },
    ]);
    expect(log).toHaveBeenCalledOnce();
    const retry = fixture.host.querySelector<HTMLButtonElement>(
      '[data-page-number="2"] [data-action="retry-page"]',
    );
    expect(retry?.textContent).toBe('Retry page');
    expect(() => retry?.click()).not.toThrow();
    expect(viewer.update).toHaveBeenCalledOnce();
  });

  it('detaches listeners, cancels work, and clears viewer resources exactly once', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined)
      throw new Error('Expected viewer components.');
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));

    await fixture.viewport.destroy();
    await fixture.viewport.destroy();
    eventBus.dispatch('pagechanging', { pageNumber: 3 });

    expect(events).toEqual([]);
    expect(viewer.cleanup).toHaveBeenCalledOnce();
    expect(viewer.documents).toEqual([fixture.documentProxy, null]);
    expect(fixture.runtime.state.findController?.documents).toEqual([fixture.documentProxy, null]);
    expect(fixture.runtime.state.linkService?.documents).toEqual([fixture.documentProxy, null]);
    expect(fixture.host.children).toHaveLength(0);
  });

  it('rejects invalid mounting states and ignores malformed viewer events', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    if (eventBus === undefined) throw new Error('Expected a fake event bus.');
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));

    eventBus.dispatch('pagechanging', { pageNumber: 0 });
    eventBus.dispatch('scalechanging', { scale: 'large' });
    eventBus.dispatch('scalechanging', { scale: Number.NaN });
    eventBus.dispatch('pagerendered', { pageNumber: 'two', error: new Error('ignored') });
    eventBus.dispatch('pagerendered', { pageNumber: 2, error: null });
    eventBus.dispatch('pagerendered', { pageNumber: 99, error: new Error('not mounted') });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'render-error', pageIndex: 98 });
    await expect(fixture.viewport.mount(createDiv())).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    await fixture.viewport.destroy();
    await expect(fixture.viewport.mount(createDiv())).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    expect(fixture.viewport.onEvent(() => undefined)).toBeTypeOf('function');
    fixture.viewport.search('ignored after destroy');
  });

  it('uses system color fallbacks and exposes the concrete session factory', async () => {
    const documentProxy = pdf(1);
    const runtime = viewerRuntime();
    const search = new PdfTextSearch(documentProxy);
    const viewport = await createPdfDocumentViewport(documentProxy, runtime.module, search);

    expect(viewport).toBeInstanceOf(PdfDocumentViewport);
    await viewport.mount(createDiv());
    expect(runtime.state.viewer?.pageColors).toEqual({
      background: 'Canvas',
      foreground: 'CanvasText',
    });
    await viewport.destroy();
  });

  it('finishes teardown even when viewer cleanup fails', async () => {
    const fixture = await mountedViewport(3);
    const viewer = fixture.runtime.state.viewer;
    if (viewer === undefined) throw new Error('Expected a fake viewer.');
    const cause = new Error('cleanup failed');
    viewer.cleanup.mockImplementationOnce(() => {
      throw cause;
    });

    await expect(fixture.viewport.destroy()).rejects.toBe(cause);

    expect(viewer.documents).toEqual([fixture.documentProxy, null]);
    expect(fixture.runtime.state.findController?.documents).toEqual([fixture.documentProxy, null]);
    expect(fixture.runtime.state.linkService?.documents).toEqual([fixture.documentProxy, null]);
    expect(fixture.host.children).toHaveLength(0);
  });
});
