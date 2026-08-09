import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type {
  DocumentLocation,
  DocumentViewport,
  ViewportEvent,
} from '../../document-core/document.js';
import { TypedEventSource } from '../../document-core/events.js';
import type { ResolvedReadingColors } from '../../document-core/reading.js';
import type { PdfRuntime } from './pdf-runtime.js';
import type { PdfViewportFactory } from './pdf-session.js';
import type { PdfTextSearch } from './pdf-text-search.js';

const TEXT_LAYER_MODE_ENABLE = 1;
const ANNOTATION_MODE_ENABLE_FORMS = 2;
const MAX_CANVAS_PIXELS = 16_777_216;

type PdfEventBus = InstanceType<PdfRuntime['pdfjsViewer']['EventBus']>;
type PdfLinkService = InstanceType<PdfRuntime['pdfjsViewer']['PDFLinkService']>;
type PdfViewer = InstanceType<PdfRuntime['pdfjsViewer']['PDFViewer']>;
type PdfEventListener = (event: unknown) => void;

interface ClearablePdfViewer {
  setDocument(document: PDFDocumentProxy | null): void;
}

interface RetryablePdfPageView {
  reset(): void;
  draw(): Promise<void>;
}

function record(event: unknown): Record<string, unknown> | null {
  return typeof event === 'object' && event !== null ? (event as Record<string, unknown>) : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function resolvedPageColors(host: HTMLElement): { background: string; foreground: string } {
  const style = getComputedStyle(host);
  const background = style.getPropertyValue('--background-primary').trim();
  const foreground = style.getPropertyValue('--text-normal').trim();
  return {
    background: background.length > 0 ? background : 'Canvas',
    foreground: foreground.length > 0 ? foreground : 'CanvasText',
  };
}

export class PdfDocumentViewport implements DocumentViewport {
  readonly pageCount: number;

  private readonly events = new TypedEventSource<ViewportEvent>();
  private readonly listeners = new Map<string, PdfEventListener>();
  private eventBus: PdfEventBus | null = null;
  private linkService: PdfLinkService | null = null;
  private viewer: PdfViewer | null = null;
  private root: HTMLDivElement | null = null;
  private viewerElement: HTMLDivElement | null = null;
  private destroyPromise: Promise<void> | null = null;
  private searchAbort: AbortController | null = null;
  private lastQuery = '';
  private readonly failedPages = new Set<number>();

  constructor(
    private readonly pdf: PDFDocumentProxy,
    private readonly pdfjsViewer: PdfRuntime['pdfjsViewer'],
    private readonly textSearch: PdfTextSearch,
  ) {
    this.pageCount = pdf.numPages;
  }

  async mount(host: HTMLElement): Promise<void> {
    if (this.destroyPromise !== null) throw new DOMException('Destroyed', 'InvalidStateError');
    if (this.root !== null) throw new DOMException('Already mounted', 'InvalidStateError');

    const root = createDiv();
    root.className = 'pdfViewerContainer';
    root.tabIndex = 0;
    const viewerElement = createDiv();
    viewerElement.className = 'pdfViewer';
    root.append(viewerElement);
    host.append(root);
    this.root = root;
    this.viewerElement = viewerElement;

    const eventBus = new this.pdfjsViewer.EventBus();
    this.eventBus = eventBus;
    const linkService = new this.pdfjsViewer.PDFLinkService({ eventBus });
    this.linkService = linkService;
    const findController = new this.pdfjsViewer.PDFFindController({
      eventBus,
      linkService,
    });
    const pageColors = resolvedPageColors(host);
    const viewer = new this.pdfjsViewer.PDFViewer({
      container: root,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      textLayerMode: TEXT_LAYER_MODE_ENABLE,
      annotationMode: ANNOTATION_MODE_ENABLE_FORMS,
      enablePermissions: true,
      supportsPinchToZoom: true,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
      pageColors,
    });

    this.viewer = viewer;
    this.bindEvents();
    root.addEventListener('click', this.onRootClick);

    linkService.setViewer(viewer);
    linkService.setDocument(this.pdf);
    viewer.setDocument(this.pdf);
  }

  async goTo(location: DocumentLocation): Promise<void> {
    const linkService = this.requireMounted(this.linkService);
    const pageNumber = location.pageIndex + 1;
    if (location.x === undefined && location.y === undefined) {
      linkService.goToPage(pageNumber);
      return;
    }
    linkService.goToXY(pageNumber, location.x ?? 0, location.y ?? 0);
  }

  setScale(scale: number | 'page-width' | 'page-fit'): void {
    const viewer = this.requireMounted(this.viewer);
    if (typeof scale === 'number') viewer.currentScale = scale;
    else viewer.currentScaleValue = scale;
  }

  setReadingColors(colors: ResolvedReadingColors): void {
    const viewer = this.requireMounted(this.viewer);
    const root = this.requireMounted(this.root);
    root.setCssProps({
      '--abyss-reader-background': colors.background,
      '--abyss-reader-foreground': colors.foreground,
      '--abyss-reader-brightness': String(colors.brightness),
      '--abyss-reader-contrast': String(colors.contrast),
      '--abyss-reader-image-dim': String(colors.imageDim),
    });
    viewer.pageColors = { background: colors.background, foreground: colors.foreground };
    try {
      viewer.cleanup();
      viewer.update();
    } catch (cause) {
      this.handleRenderError(viewer.currentPageNumber, cause);
    }
  }

  search(query: string): void {
    if (this.eventBus === null || this.destroyPromise !== null) return;
    this.lastQuery = query;
    this.dispatchFind(query, false, '');
    this.searchAbort?.abort();
    const abortController = new AbortController();
    this.searchAbort = abortController;
    void this.textSearch
      .search(query, abortController.signal, (results) => {
        if (!abortController.signal.aborted && this.destroyPromise === null) {
          this.events.emit({ type: 'search-results', results });
        }
      })
      .catch((cause: unknown) => {
        if (!abortController.signal.aborted) {
          console.error('[abyss-documents] Failed to search PDF text', { cause });
        }
      });
  }

  searchAgain(direction: 'next' | 'previous'): void {
    if (this.lastQuery.length === 0 || this.eventBus === null) return;
    this.dispatchFind(this.lastQuery, direction === 'previous', 'again');
  }

  onEvent(listener: (event: ViewportEvent) => void): () => void {
    if (this.destroyPromise !== null) return () => undefined;
    return this.events.subscribe(listener);
  }

  focus(): void {
    this.requireMounted(this.viewer).focus();
  }

  destroy(): Promise<void> {
    this.destroyPromise ??= this.destroyOnce();
    return this.destroyPromise;
  }

  private async destroyOnce(): Promise<void> {
    let failure: Error | undefined;
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (cause) {
        failure ??=
          cause instanceof Error
            ? cause
            : new Error(`Unknown PDF viewport cleanup failure: ${String(cause)}`);
      }
    };
    this.searchAbort?.abort();
    this.searchAbort = null;
    const eventBus = this.eventBus;
    if (eventBus !== null) {
      for (const [name, listener] of this.listeners) {
        attempt(() => {
          eventBus.off(name, listener);
        });
      }
      attempt(() => {
        eventBus.dispatch('findbarclose', { source: this });
      });
    }
    this.listeners.clear();

    attempt(() => {
      this.root?.removeEventListener('click', this.onRootClick);
    });
    attempt(() => {
      this.viewer?.cleanup();
    });
    if (this.viewer !== null) {
      attempt(() => {
        (this.viewer as unknown as ClearablePdfViewer).setDocument(null);
      });
    }
    attempt(() => {
      this.linkService?.setDocument(null);
    });
    attempt(() => {
      this.root?.remove();
    });

    this.failedPages.clear();
    this.events.clear();
    this.eventBus = null;
    this.linkService = null;
    this.viewer = null;
    this.viewerElement = null;
    this.root = null;
    if (failure !== undefined) throw failure;
  }

  private bindEvents(): void {
    this.bind('pagesinit', () => {
      if (this.viewer !== null) this.viewer.currentScaleValue = 'page-width';
    });
    this.bind('pagechanging', (event) => {
      this.onPageChanging(event);
    });
    this.bind('scalechanging', (event) => {
      this.onScaleChanging(event);
    });
    this.bind('pagerendered', (event) => {
      this.onPageRendered(event);
    });
  }

  private bind(name: string, listener: PdfEventListener): void {
    const guarded: PdfEventListener = (event) => {
      try {
        listener(event);
      } catch (cause) {
        console.error('[abyss-documents] Failed to handle a PDF viewer event', {
          event: name,
          cause,
        });
      }
    };
    this.listeners.set(name, guarded);
    this.requireMounted(this.eventBus).on(name, guarded);
  }

  private onPageChanging(event: unknown): void {
    const pageNumber = positiveInteger(record(event)?.['pageNumber']);
    if (pageNumber !== null) this.events.emit({ type: 'page-change', pageIndex: pageNumber - 1 });
  }

  private onScaleChanging(event: unknown): void {
    const data = record(event);
    if (data === null) return;
    const preset = data['presetValue'];
    if (preset === 'page-width' || preset === 'page-fit') {
      this.events.emit({ type: 'scale-change', scale: preset });
    } else if (typeof data['scale'] === 'number' && Number.isFinite(data['scale'])) {
      this.events.emit({ type: 'scale-change', scale: data['scale'] });
    }
  }

  private onPageRendered(event: unknown): void {
    const data = record(event);
    const pageNumber = positiveInteger(data?.['pageNumber']);
    if (pageNumber === null) return;
    const error = data?.['error'];
    if (error !== undefined && error !== null) {
      this.handleRenderError(pageNumber, error);
      return;
    }
    this.failedPages.delete(pageNumber);
    this.pageElement(pageNumber)?.querySelector('[data-render-error]')?.remove();
  }

  private handleRenderError(pageNumber: number, cause: unknown): void {
    const pageIndex = pageNumber - 1;
    this.events.emit({ type: 'render-error', pageIndex, cause });
    if (!this.failedPages.has(pageNumber)) {
      this.failedPages.add(pageNumber);
      console.error('[abyss-documents] Failed to render PDF page', { pageIndex, cause });
    }

    const page = this.pageElement(pageNumber);
    if (page === null) return;
    if (page.querySelector('[data-render-error]') !== null) return;
    const surface = createDiv();
    surface.dataset['renderError'] = '';
    surface.setAttribute('role', 'alert');
    const message = createSpan();
    message.textContent = 'Could not render this page.';
    const retry = createEl('button');
    retry.type = 'button';
    retry.dataset['action'] = 'retry-page';
    retry.textContent = 'Retry page';
    surface.append(message, retry);
    page.append(surface);
  }

  private readonly onRootClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const retry = target.closest<HTMLButtonElement>('[data-action="retry-page"]');
    if (retry === null) return;
    const page = target.closest<HTMLElement>('[data-page-number]');
    const pageNumber = positiveInteger(Number(page?.dataset['pageNumber']));
    if (page === null || pageNumber === null || this.viewer === null) return;
    this.retryPage(this.viewer, page, pageNumber, retry);
  };

  private retryPage(
    viewer: PdfViewer,
    page: HTMLElement,
    pageNumber: number,
    retry: HTMLButtonElement,
  ): void {
    const surface = page.querySelector<HTMLElement>('[data-render-error]');
    const pageView = viewer.getPageView(pageNumber - 1) as RetryablePdfPageView | undefined;
    if (pageView === undefined) return;
    try {
      pageView.reset();
      if (surface !== null && !page.contains(surface)) page.append(surface);
      retry.disabled = true;
      const redraw = pageView.draw();
      void redraw
        .then(() => {
          if (this.destroyPromise !== null) return;
          this.failedPages.delete(pageNumber);
          page.querySelector('[data-render-error]')?.remove();
        })
        .catch((cause: unknown) => {
          if (this.destroyPromise !== null) return;
          retry.disabled = false;
          this.handleRenderError(pageNumber, cause);
        });
    } catch (cause) {
      retry.disabled = false;
      this.handleRenderError(pageNumber, cause);
    }
  }

  private pageElement(pageNumber: number): HTMLElement | null {
    return (
      this.viewerElement?.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`) ?? null
    );
  }

  private dispatchFind(query: string, findPrevious: boolean, type: '' | 'again'): void {
    this.eventBus?.dispatch('find', {
      source: this,
      type,
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: true,
    });
  }

  private requireMounted<T>(value: T | null): T {
    if (value === null) throw new DOMException('PDF viewport is not mounted.', 'InvalidStateError');
    return value;
  }
}

export const createPdfDocumentViewport: PdfViewportFactory = (pdf, pdfjsViewer, textSearch) =>
  new PdfDocumentViewport(pdf, pdfjsViewer, textSearch);
