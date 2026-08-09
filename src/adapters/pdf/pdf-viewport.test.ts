import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import type { ViewportEvent } from '../../document-core/document.js';
import type { PdfRuntime } from './pdf-runtime.js';
import { PdfTextSearch } from './pdf-text-search.js';
import { createPdfDocumentViewport, PdfDocumentViewport } from './pdf-viewport.js';

type Listener = (event: unknown) => void;

interface FakePageView {
  draw: ReturnType<typeof vi.fn<() => Promise<void>>>;
  renderingState: 'FINISHED' | 'INITIAL' | 'RUNNING';
  reset: ReturnType<typeof vi.fn<() => void>>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(data);
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

function viewerRuntime(
  findOptions: { findDelay?: number; findState?: number; suppressFindState?: boolean } = {},
) {
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
    document: PDFDocumentProxy | null = null;

    constructor(readonly options: { eventBus: FakeEventBus }) {
      state.linkService = this;
    }

    setDocument(document: PDFDocumentProxy | null): void {
      this.documents.push(document);
      this.document = document;
    }

    setViewer(viewer: FakeViewer): void {
      this.viewer = viewer;
    }

    goToPage(page: number | string): void {
      this.pages.push(page);
      if (typeof page === 'number') this.page = page;
    }

    goToXY(page: number, x: number, y: number): void {
      this.positions.push([page, x, y]);
      this.page = page;
    }

    get pagesCount(): number {
      return this.document?.numPages ?? 0;
    }

    get page(): number {
      return this.viewer?.currentPageNumber ?? 1;
    }

    set page(pageNumber: number) {
      if (this.viewer !== null) this.viewer.currentPageNumber = pageNumber;
    }
  }

  class FakeFindController {
    readonly documents: Array<PDFDocumentProxy | null> = [];
    readonly selections: Array<{ matchIndex: number; pageIndex: number; query: string }> = [];
    private pending: number | null = null;
    private matchIndex = -1;

    constructor(
      readonly options: { linkService: FakeLinkService; eventBus: FakeEventBus; delay?: number },
    ) {
      state.findController = this;
      options.eventBus.on('find', (event) => {
        this.onFind(event);
      });
    }

    setDocument(document: PDFDocumentProxy | null): void {
      this.documents.push(document);
    }

    private onFind(event: unknown): void {
      const data = event as Record<string, unknown>;
      const query = typeof data['query'] === 'string' ? data['query'] : '';
      if (data['type'] === '') {
        if (this.pending !== null) window.clearTimeout(this.pending);
        this.matchIndex = 0;
      } else if (data['type'] === 'again')
        this.matchIndex += data['findPrevious'] === true ? -1 : 1;
      if (findOptions.suppressFindState === true) return;
      const selection = {
        matchIndex: this.matchIndex,
        pageIndex: this.options.linkService.page - 1,
        query,
      };
      this.pending = window.setTimeout(() => {
        this.selections.push(selection);
        this.options.eventBus.dispatch('updatefindcontrolstate', {
          source: this,
          state: findOptions.findState ?? 0,
          previous: false,
          entireWord: false,
          matchesCount: { current: selection.matchIndex + 1, total: 10 },
          rawQuery: query,
        });
      }, findOptions.findDelay ?? 0);
    }
  }

  class FakeViewer {
    readonly cleanup = vi.fn();
    readonly focus = vi.fn();
    readonly update = vi.fn();
    readonly documents: Array<PDFDocumentProxy | null> = [];
    readonly findDocumentsBeforeViewerOwnership: Array<Array<PDFDocumentProxy | null>> = [];
    readonly pageColorsAtSetDocument: Array<object | null> = [];
    readonly pageViews: FakePageView[] = [];
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
      this.findDocumentsBeforeViewerOwnership.push([...this.options.findController.documents]);
      this.documents.push(pdfDocument);
      this.pageColorsAtSetDocument.push(this.pageColors === null ? null : { ...this.pageColors });
      this.options.viewer.replaceChildren();
      this.pageViews.length = 0;
      if (pdfDocument === null) {
        this.currentPageNumber = 1;
        this.currentScale = 1;
        this.currentScaleValue = 'auto';
        this.options.findController.setDocument(null);
        return;
      }
      for (let pageNumber = 1; pageNumber <= Math.min(3, pdfDocument.numPages); pageNumber += 1) {
        const page = createDiv();
        page.className = 'page';
        page.dataset['pageNumber'] = String(pageNumber);
        this.options.viewer.append(page);
        const pageView: FakePageView = {
          draw: vi.fn(async () => {
            pageView.renderingState = 'RUNNING';
          }),
          renderingState: 'FINISHED',
          reset: vi.fn(() => {
            pageView.renderingState = 'INITIAL';
            page.replaceChildren();
          }),
        };
        this.pageViews.push(pageView);
      }
      this.options.findController.setDocument(pdfDocument);
    }

    getPageView(pageIndex: number) {
      return this.pageViews[pageIndex];
    }
  }

  const module = {
    EventBus,
    FindState: { FOUND: 0, NOT_FOUND: 1, PENDING: 3, WRAPPED: 2 },
    PDFLinkService: FakeLinkService,
    PDFFindController: FakeFindController,
    PDFViewer: FakeViewer,
  } as unknown as PdfRuntime['pdfjsViewer'];
  return { module, state };
}

async function mountedViewport(
  pageCount = 700,
  options: { findDelay?: number; findState?: number; suppressFindState?: boolean } = {},
) {
  const documentProxy = pdf(pageCount);
  const runtime = viewerRuntime(options);
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
    expect(viewer.findDocumentsBeforeViewerOwnership).toEqual([[]]);
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

    fixture.runtime.state.eventBus?.dispatch('pagesinit', {});
    fixture.viewport.setReadingColors(colors);

    expect(viewer.pageColors).toEqual({ background: '#f4ecd8', foreground: '#2d281f' });
    expect(viewer.pageColorsAtSetDocument[viewer.pageColorsAtSetDocument.length - 1]).toEqual({
      background: '#f4ecd8',
      foreground: '#2d281f',
    });
    fixture.runtime.state.eventBus?.dispatch('pagesinit', {});
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    expect(root?.style.getPropertyValue('--abyss-reader-brightness')).toBe('0.95');
    const redrawFailure = new Error('redraw failed');
    vi.spyOn(viewer, 'setDocument').mockImplementationOnce(() => {
      throw redrawFailure;
    });

    expect(() => {
      fixture.viewport.setReadingColors(colors);
    }).not.toThrow();
    expect(events[events.length - 1]).toEqual({
      type: 'render-error',
      pageIndex: 0,
      cause: redrawFailure,
    });
  });

  it('rebuilds public page views with new colors while preserving page and preset scale', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) {
      throw new Error('Expected viewer components.');
    }
    eventBus.dispatch('pagesinit', {});
    viewer.currentPageNumber = 3;
    viewer.currentScaleValue = 'page-fit';
    const colors = {
      background: '#f4ecd8',
      foreground: '#2d281f',
      brightness: 0.95,
      contrast: 1.05,
      imageDim: 0.1,
    };

    fixture.viewport.setReadingColors(colors);

    expect(viewer.documents).toEqual([fixture.documentProxy, null, fixture.documentProxy]);
    expect(viewer.pageColorsAtSetDocument[viewer.pageColorsAtSetDocument.length - 1]).toEqual({
      background: '#f4ecd8',
      foreground: '#2d281f',
    });
    expect(fixture.runtime.state.findController?.documents).toEqual([
      fixture.documentProxy,
      null,
      fixture.documentProxy,
    ]);
    expect(fixture.runtime.state.linkService?.documents).toEqual([fixture.documentProxy]);
    eventBus.dispatch('pagesinit', {});
    expect(viewer.currentPageNumber).toBe(3);
    expect(viewer.currentScaleValue).toBe('page-fit');
  });

  it('waits for initial pages before rebinding the profile selected during mount', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) {
      throw new Error('Expected viewer components.');
    }
    const colors = {
      background: '#202020',
      foreground: '#e6e1d8',
      brightness: 0.86,
      contrast: 0.95,
      imageDim: 0.18,
    };

    fixture.viewport.setReadingColors(colors);

    expect(viewer.documents).toEqual([fixture.documentProxy]);
    eventBus.dispatch('pagesinit', {});
    expect(viewer.documents).toEqual([fixture.documentProxy, null, fixture.documentProxy]);
    expect(viewer.pageColorsAtSetDocument[viewer.pageColorsAtSetDocument.length - 1]).toEqual({
      background: '#202020',
      foreground: '#e6e1d8',
    });
    eventBus.dispatch('pagesinit', {});
    expect(viewer.currentScaleValue).toBe('page-width');
  });

  it('coalesces racing Auto theme colors so the latest rebuild wins', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) {
      throw new Error('Expected viewer components.');
    }
    eventBus.dispatch('pagesinit', {});
    viewer.currentPageNumber = 2;
    viewer.currentScale = 1.5;
    viewer.currentScaleValue = '1.5';
    const autoLight = {
      background: '#f7f7f5',
      foreground: '#202020',
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    };
    const autoDark = {
      background: '#202020',
      foreground: '#e6e1d8',
      brightness: 0.86,
      contrast: 0.95,
      imageDim: 0.18,
    };

    fixture.viewport.setReadingColors(autoLight);
    fixture.viewport.setReadingColors(autoDark);

    expect(eventBus.listeners.get('pagesinit')).toHaveLength(2);
    expect(viewer.documents).toEqual([fixture.documentProxy, null, fixture.documentProxy]);
    eventBus.dispatch('pagesinit', {});
    expect(viewer.pageColorsAtSetDocument[viewer.pageColorsAtSetDocument.length - 1]).toEqual({
      background: '#202020',
      foreground: '#e6e1d8',
    });
    eventBus.dispatch('pagesinit', {});
    expect(viewer.currentPageNumber).toBe(2);
    expect(viewer.currentScale).toBe(1.5);
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
    const find = fixture.runtime.state.eventBus?.dispatched.find(
      ({ name, data }) => name === 'find' && data['query'] === 'needle',
    );
    expect(find?.data['highlightAll']).toBe(false);
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

  it('selects a delayed non-adjacent page-local occurrence through public find events', async () => {
    vi.useFakeTimers();
    const fixture = await mountedViewport(6, { findDelay: 25 });

    const selecting = fixture.viewport.selectSearchHit(
      { id: 'page-4-match-2', pageIndex: 4, matchIndex: 2, preview: 'Needle' },
      '  needle  ',
    );
    await vi.runAllTimersAsync();
    await selecting;

    expect(fixture.runtime.state.linkService?.page).toBe(5);
    expect(fixture.runtime.state.findController?.selections).toEqual([
      { matchIndex: 0, pageIndex: 4, query: 'needle' },
      { matchIndex: 1, pageIndex: 4, query: 'needle' },
      { matchIndex: 2, pageIndex: 4, query: 'needle' },
    ]);
    const commands = fixture.runtime.state.eventBus?.dispatched.filter(
      ({ name }) => name === 'find',
    );
    expect(commands?.map(({ data }) => [data['type'], data['query']])).toEqual([
      ['', 'needle'],
      ['again', 'needle'],
      ['again', 'needle'],
    ]);
    expect(commands?.every(({ data }) => data['highlightAll'] === false)).toBe(true);
    vi.useRealTimers();
  });

  it('cancels a stale selection when a newer page-local hit wins', async () => {
    vi.useFakeTimers();
    const fixture = await mountedViewport(6, { findDelay: 25 });
    const first = fixture.viewport
      .selectSearchHit(
        { id: 'page-0-match-3', pageIndex: 0, matchIndex: 3, preview: 'First' },
        'needle',
      )
      .catch((cause: unknown) => cause);

    const second = fixture.viewport.selectSearchHit(
      { id: 'page-5-match-1', pageIndex: 5, matchIndex: 1, preview: 'Second' },
      'needle',
    );
    await vi.runAllTimersAsync();

    await expect(first).resolves.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBeUndefined();
    expect(fixture.runtime.state.linkService?.page).toBe(6);
    expect(fixture.runtime.state.findController?.selections).toEqual([
      { matchIndex: 0, pageIndex: 5, query: 'needle' },
      { matchIndex: 1, pageIndex: 5, query: 'needle' },
    ]);
    vi.useRealTimers();
  });

  it('times out a selection without leaking its public event listener', async () => {
    vi.useFakeTimers();
    const fixture = await mountedViewport(3, { suppressFindState: true });
    const selecting = fixture.viewport
      .selectSearchHit(
        { id: 'page-1-match-0', pageIndex: 1, matchIndex: 0, preview: 'Missing' },
        'needle',
      )
      .catch((cause: unknown) => cause);

    await vi.runAllTimersAsync();

    await expect(selecting).resolves.toMatchObject({ name: 'TimeoutError' });
    expect(fixture.runtime.state.eventBus?.listeners.get('updatefindcontrolstate')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('contains a public not-found state and removes its listener', async () => {
    const fixture = await mountedViewport(3, { findState: 1 });

    await expect(
      fixture.viewport.selectSearchHit(
        { id: 'missing', pageIndex: 1, matchIndex: 0, preview: 'Missing' },
        'needle',
      ),
    ).rejects.toThrow('PDF search could not find “needle”.');
    expect(fixture.runtime.state.eventBus?.listeners.get('updatefindcontrolstate')).toHaveLength(0);
  });

  it('accepts a public wrapped state as a completed find step', async () => {
    const fixture = await mountedViewport(3, { findState: 2 });

    await expect(
      fixture.viewport.selectSearchHit(
        { id: 'wrapped', pageIndex: 2, matchIndex: 0, preview: 'Wrapped' },
        'needle',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects hit selection when the normalized query is empty', async () => {
    const fixture = await mountedViewport(3);

    await expect(
      fixture.viewport.selectSearchHit(
        { id: 'empty', pageIndex: 0, matchIndex: 0, preview: 'Empty' },
        '   ',
      ),
    ).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('normalizes one query for extraction results and visible PDF find', async () => {
    const fixture = await mountedViewport(1);
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));

    fixture.viewport.search('  needle  ');

    await vi.waitFor(() => {
      expect(events[events.length - 1]).toMatchObject({
        type: 'search-results',
        results: { query: 'needle', complete: true },
      });
    });
    expect(
      fixture.runtime.state.eventBus?.dispatched.find(({ name }) => name === 'find')?.data['query'],
    ).toBe('needle');
  });

  it('aborts prior extraction for each query and clears public find matches for empty input', async () => {
    const fixture = await mountedViewport(3);
    const signals: AbortSignal[] = [];
    vi.spyOn(fixture.search, 'search').mockImplementation(async (query, signal, emit) => {
      signals.push(signal);
      if (query.length === 0) {
        const empty = { query, hits: [], complete: true } as const;
        emit(empty);
        return empty;
      }
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Cancelled', 'AbortError'));
          },
          { once: true },
        );
      });
      return { query, hits: [], complete: true };
    });

    fixture.viewport.search('first');
    fixture.viewport.search('second');
    fixture.viewport.search('');

    expect(signals).toHaveLength(3);
    expect(signals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
    expect(signals[2]?.aborted).toBe(false);
    const findEvents = fixture.runtime.state.eventBus?.dispatched.filter(
      ({ name }) => name === 'find',
    );
    expect(findEvents?.[findEvents.length - 1]?.data['query']).toBe('');
    await fixture.viewport.destroy();
  });

  it('keeps a render error page-local and resets the failed page before a contained redraw', async () => {
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
    const pageView = viewer.getPageView(1);
    if (pageView === undefined) throw new Error('Expected a fake page view.');
    const redraw = deferred<void>();
    pageView.draw.mockReturnValueOnce(redraw.promise);
    expect(retry?.textContent).toBe('Retry page');
    expect(() => retry?.click()).not.toThrow();
    expect(pageView.reset).toHaveBeenCalledOnce();
    expect(pageView.renderingState).toBe('INITIAL');
    expect(pageView.draw).toHaveBeenCalledOnce();
    expect(fixture.host.querySelector('[data-page-number="2"] [data-render-error]')).not.toBeNull();

    redraw.resolve();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-page-number="2"] [data-render-error]')).toBeNull();
    });
    expect(viewer.update).not.toHaveBeenCalled();
  });

  it('contains a rejected page redraw and leaves retry available', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) {
      throw new Error('Expected viewer components.');
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));
    eventBus.dispatch('pagerendered', { pageNumber: 2, error: new Error('canvas failed') });
    const pageView = viewer.getPageView(1);
    const retry = fixture.host.querySelector<HTMLButtonElement>(
      '[data-page-number="2"] [data-action="retry-page"]',
    );
    if (pageView === undefined || retry === null) throw new Error('Expected page retry controls.');
    const redrawCause = new Error('redraw failed');
    pageView.draw.mockRejectedValueOnce(redrawCause);

    expect(() => {
      retry.click();
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(retry.disabled).toBe(false);
    });
    expect(fixture.host.querySelector('[data-page-number="2"] [data-render-error]')).not.toBeNull();
    expect(events[events.length - 1]).toEqual({
      type: 'render-error',
      pageIndex: 1,
      cause: redrawCause,
    });
    expect(log).toHaveBeenCalledOnce();
  });

  it('detaches listeners, cancels work, and clears viewer resources exactly once', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined)
      throw new Error('Expected viewer components.');
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));
    fixture.viewport.setReadingColors({
      background: '#202020',
      foreground: '#e6e1d8',
      brightness: 0.86,
      contrast: 0.95,
      imageDim: 0.18,
    });
    expect(eventBus.listeners.get('pagesinit')).toHaveLength(2);

    await fixture.viewport.destroy();
    await fixture.viewport.destroy();
    eventBus.dispatch('pagechanging', { pageNumber: 3 });

    expect(events).toEqual([]);
    expect(viewer.cleanup).toHaveBeenCalledOnce();
    expect(viewer.documents).toEqual([fixture.documentProxy, null]);
    expect(viewer.findDocumentsBeforeViewerOwnership).toEqual([[], [fixture.documentProxy]]);
    expect(fixture.runtime.state.findController?.documents).toEqual([fixture.documentProxy, null]);
    expect(fixture.runtime.state.linkService?.documents).toEqual([fixture.documentProxy, null]);
    expect(eventBus.listeners.get('pagesinit')).toHaveLength(0);
    expect(fixture.host.children).toHaveLength(0);
  });

  it('rejects invalid mounting states and ignores malformed viewer events', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    if (eventBus === undefined) throw new Error('Expected a fake event bus.');
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));

    eventBus.dispatch('pagechanging', { pageNumber: 0 });
    eventBus.dispatch('scalechanging', null as unknown as Record<string, unknown>);
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
