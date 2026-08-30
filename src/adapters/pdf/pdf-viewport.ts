import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import annotationImageData from 'pdfjs-dist/web/images/annotation-assets?data-url-map';
import type {
  DocumentLocation,
  DocumentViewport,
  PdfPageRect,
  SearchHit,
  ViewportAnnotationSnapshot,
  ViewportEvent,
} from '../../document-core/document.js';
import { TypedEventSource } from '../../document-core/events.js';
import type {
  ReaderLayout,
  ReaderScale,
  ReadingAppearance,
  ResolvedReadingProfile,
} from '../../document-core/reading.js';
import {
  incrementReaderCounter,
  markReaderPerformance,
  markReaderPerformanceOnce,
  maximizeReaderCounter,
} from '../../reader-performance.js';
import { replacePdfAnnotationImageSources } from './pdf-annotation-assets.js';
import type { PdfAnnotationCapabilities } from './pdf-annotation-capabilities.js';
import {
  PdfAnnotationEditor,
  type PdfAnnotationInteraction,
  type PdfEditableAnnotationKind,
} from './pdf-annotation-editor.js';
import { PdfCommentBridge, type PdfJsCommentManagerRuntime } from './pdf-comment-bridge.js';
import {
  PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE,
  PDFJS_ANNOTATION_EDITOR_TYPE,
  type PdfRuntime,
} from './pdf-runtime.js';
import {
  PdfDomSelectionObserver,
  type PdfSelectionObserver,
  type PdfTextSelection,
} from './pdf-selection-observer.js';
import type { PdfViewportContext, PdfViewportFactory } from './pdf-session.js';
import type { PdfTextSearch } from './pdf-text-search.js';

const TEXT_LAYER_MODE_ENABLE = 1;
const ANNOTATION_MODE_ENABLE_FORMS = 2;
const MAX_CANVAS_PIXELS = 16_777_216;
const FIND_SELECTION_TIMEOUT_MS = 2_000;
const MIN_SCALE = 0.1;
const MAX_SCALE = 25;
const SCALE_DELTA = 1.1;
const VERTICAL_PADDING = 5;
const PDF_TO_CSS_UNITS = 96 / 72;
const ANNOTATION_HIGHLIGHT_COLORS =
  'yellow=#ffd400,red=#ff6666,green=#5fb236,blue=#2ea8e5,purple=#a28ae5,magenta=#e56eee,orange=#f19837,gray=#aaaaaa';

type PdfEventBus = InstanceType<PdfRuntime['pdfjsViewer']['EventBus']>;
type PdfLinkService = InstanceType<PdfRuntime['pdfjsViewer']['PDFLinkService']>;
type PdfViewer = InstanceType<PdfRuntime['pdfjsViewer']['PDFViewer']>;
type PdfFindController = InstanceType<PdfRuntime['pdfjsViewer']['PDFFindController']>;
type PdfEventListener = (event: unknown) => void;
type ScaleRequest = ReaderScale;

interface RebindablePdfViewer {
  setDocument(document: PDFDocumentProxy | null): void;
}

interface PdfViewerWithCommentManagerOptions {
  new (
    options: ConstructorParameters<PdfRuntime['pdfjsViewer']['PDFViewer']>[0] & {
      readonly commentManager?: PdfJsCommentManagerRuntime | undefined;
    },
  ): PdfViewer;
}

interface ViewerCreationContext {
  readonly eventBus: PdfEventBus;
  readonly findController: PdfFindController;
  readonly linkService: PdfLinkService;
  readonly pageColors: { readonly background: string; readonly foreground: string };
  readonly root: HTMLDivElement;
  readonly viewerElement: HTMLDivElement;
}

type PreservedScale =
  | { readonly type: 'preset'; readonly value: 'page-width' | 'page-fit' | 'page-height' }
  | { readonly type: 'numeric'; readonly value: number };

interface PreservedViewState {
  readonly pageNumber: number;
  readonly scale: PreservedScale;
}

interface RetryablePdfPageView {
  reset(): void;
  draw(): Promise<void>;
}

interface PdfPageViewGeometry {
  readonly viewport: {
    convertToPdfPoint(x: number, y: number): readonly [number, number];
    readonly rawDims: {
      readonly pageHeight: number;
      readonly pageWidth: number;
      readonly pageX: number;
      readonly pageY: number;
    };
  };
}

interface MountedAnnotationContext {
  readonly internalId: string;
  readonly pageIndex: number;
}

interface FindRequest {
  readonly query: string;
  readonly findPrevious: boolean;
  readonly type: '' | 'again';
  readonly signal: AbortSignal;
}

function record(event: unknown): Record<string, unknown> | null {
  return typeof event === 'object' && event !== null ? (event as Record<string, unknown>) : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isElementTarget(target: EventTarget | null): target is Element {
  return target !== null && 'closest' in target && typeof target.closest === 'function';
}

function isNativeFreeTextEditingTarget(target: Element): boolean {
  if (target.closest('.annotationEditorLayer .freeTextEditor.selectedEditor .internal') !== null)
    return true;
  return (
    (target
      .closest('[contenteditable]:not([contenteditable="false"])')
      ?.closest('.annotationEditorLayer .freeTextEditor') ?? null) !== null
  );
}

function hasNativeSelectionModifier(event: MouseEvent | PointerEvent): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}

const ANNOTATION_NODE_TYPES: ReadonlyArray<
  readonly [selector: string, type: ViewportAnnotationSnapshot['type']]
> = [
  ['.highlightEditor, .highlightAnnotation, .highlight', 'highlight'],
  ['.underlineAnnotation, .underline', 'underline'],
  ['.inkEditor, .inkAnnotation, .ink', 'ink'],
  ['.freeTextEditor, .freeTextAnnotation, .freetext', 'free-text'],
  ['.textAnnotation', 'text-note'],
];

function annotationTypeForNode(
  node: Element,
  kind: PdfEditableAnnotationKind | null,
): ViewportAnnotationSnapshot['type'] {
  const editableType = annotationTypeForEditableKind(kind);
  if (editableType !== null) return editableType;
  return (
    ANNOTATION_NODE_TYPES.find(
      ([selector]) => node.matches(selector) || node.querySelector(selector) !== null,
    )?.[1] ?? 'unsupported'
  );
}

function annotationTypeForEditableKind(
  kind: PdfEditableAnnotationKind | null,
): ViewportAnnotationSnapshot['type'] | null {
  if (kind === 'highlight') return 'highlight';
  if (kind === 'ink') return 'ink';
  if (kind === 'freetext') return 'free-text';
  return null;
}

function annotationNodeColor(node: HTMLElement): string | undefined {
  const dataColor = node.dataset['color']?.trim();
  if (dataColor !== undefined && dataColor.length > 0) return dataColor;
  const inlineColor = node.style.getPropertyValue('--editor-highlight-color').trim();
  if (inlineColor.length > 0) return inlineColor;
  return undefined;
}

function annotationNodePageIndex(node: Element): number | null {
  const pageNumber = positiveInteger(
    Number(node.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber']),
  );
  return pageNumber === null ? null : pageNumber - 1;
}

function annotationNodeInternalId(node: HTMLElement): string {
  const elementId = node.id.trim();
  return elementId.length > 0 ? elementId : (node.dataset['annotationId']?.trim() ?? '');
}

function mountedAnnotationContext(node: HTMLElement): MountedAnnotationContext | null {
  const pageIndex = annotationNodePageIndex(node);
  const internalId = annotationNodeInternalId(node);
  return pageIndex === null || internalId.length === 0 ? null : { pageIndex, internalId };
}

function annotationNodeNativeId(
  node: HTMLElement,
  bindingId: string | undefined,
  internalId: string,
): string {
  return bindingId ?? node.dataset['annotationId']?.trim() ?? internalId;
}

function annotationNodeSelectedText(
  node: HTMLElement,
  selection: PdfTextSelection | null,
): string | undefined {
  if (selection !== null) return selection.text;
  const selectedText = node.dataset['selectedText'] ?? node.textContent.trim();
  return selectedText.length === 0 ? undefined : selectedText;
}

function annotationNodeList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // PDF.js DOM metadata is not required to use JSON; accept a compact comma list.
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sameViewportAnnotation(
  left: ViewportAnnotationSnapshot,
  right: ViewportAnnotationSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  private findController: PdfFindController | null = null;
  private viewer: PdfViewer | null = null;
  private annotationEditorInstance: PdfAnnotationEditor | null = null;
  private commentBridge: PdfCommentBridge | null = null;
  private selectionObserverInstance: PdfDomSelectionObserver | null = null;
  private selectionSnapshotUnsubscribe: (() => void) | null = null;
  private annotationMutationUnsubscribe: (() => void) | null = null;
  private pendingPointerActivation: { readonly id: string; readonly timeout: number } | null = null;
  private root: HTMLDivElement | null = null;
  private viewerElement: HTMLDivElement | null = null;
  private destroyPromise: Promise<void> | null = null;
  private searchAbort: AbortController | null = null;
  private selectionAbort: AbortController | null = null;
  private currentSelection: PdfTextSelection | null = null;
  private annotationSnapshotFrame: number | null = null;
  private mountedAnnotationSnapshots = new Map<string, ViewportAnnotationSnapshot>();
  private lastQuery = '';
  private readonly failedPages = new Set<number>();
  private pagesInitialized = false;
  private colorRequestRevision = 0;
  private colorRebindRevision = 0;
  private colorRebindActive = false;
  private requestedPageColors: { background: string; foreground: string } | null = null;
  private preservedViewState: PreservedViewState | null = null;
  private pendingPagesInit: PdfEventListener | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame: number | null = null;
  private pendingLocation: DocumentLocation | null = null;
  private latestLocation: DocumentLocation | null = null;
  private navigationRequestRevision = 0;
  private navigationLifecycleRevision = 0;
  private requestedLayout: ReaderLayout = { pages: 'single', scrolling: 'continuous' };
  private requestedScale: ScaleRequest = 'page-width';
  private scaleRequestRevision = 0;
  private explicitScaleRequest = false;
  private applyingScale: ScaleRequest | null = null;
  private applyingLayout = false;

  constructor(
    private readonly pdf: PDFDocumentProxy,
    private readonly pdfjsViewer: PdfRuntime['pdfjsViewer'],
    private readonly textSearch: PdfTextSearch,
    private readonly context: PdfViewportContext,
  ) {
    this.pageCount = pdf.numPages;
  }

  get annotationCapabilities(): PdfAnnotationCapabilities {
    return this.context.annotationCapabilities;
  }

  async mount(host: HTMLElement): Promise<void> {
    if (this.destroyPromise !== null) throw new DOMException('Destroyed', 'InvalidStateError');
    if (this.root !== null) throw new DOMException('Already mounted', 'InvalidStateError');

    const root = createDiv();
    root.className = 'pdfViewerContainer';
    root.dataset['pinchCapable'] = 'true';
    root.tabIndex = 0;
    const viewerElement = createDiv();
    viewerElement.className = 'pdfViewer';
    root.append(viewerElement);
    host.append(root);
    this.attachRoot(root, viewerElement);

    const eventBus = new this.pdfjsViewer.EventBus();
    this.eventBus = eventBus;
    const linkService = new this.pdfjsViewer.PDFLinkService({ eventBus });
    this.linkService = linkService;
    const findController = new this.pdfjsViewer.PDFFindController({
      eventBus,
      linkService,
    });
    this.findController = findController;
    const pageColors = resolvedPageColors(host);
    const viewer = this.createViewer({
      eventBus,
      findController,
      linkService,
      pageColors,
      root,
      viewerElement,
    });

    this.viewer = viewer;
    this.annotationEditorInstance = this.createAnnotationEditor(eventBus, viewer);
    this.bindAnnotationProjection(this.annotationEditorInstance);
    this.bindEvents();
    this.registerRootListeners(root);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(root);
    }

    linkService.setViewer(viewer);
    linkService.setDocument(this.pdf);
    viewer.setDocument(this.pdf);
  }

  private createViewer(context: ViewerCreationContext): PdfViewer {
    const { eventBus, findController, linkService, pageColors, root, viewerElement } = context;
    const commentBridge =
      this.annotationCapabilities.readOnlyReason === null
        ? new PdfCommentBridge(root, {
            onColorChange: (color) => {
              this.annotationEditorInstance?.notifyNativeColorChange(color);
            },
            onFailure: ({ action, cause }) => {
              this.events.emit({ type: 'annotation-mutation-error', action, cause });
            },
            onNativeMutation: () => {
              this.annotationEditorInstance?.notifyNativeMutation();
            },
          })
        : null;
    this.commentBridge = commentBridge;
    const Viewer = this.pdfjsViewer.PDFViewer as PdfViewerWithCommentManagerOptions;
    return new Viewer({
      container: root,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      textLayerMode: TEXT_LAYER_MODE_ENABLE,
      annotationMode: ANNOTATION_MODE_ENABLE_FORMS,
      annotationEditorMode:
        this.annotationCapabilities.readOnlyReason === null
          ? PDFJS_ANNOTATION_EDITOR_TYPE.NONE
          : PDFJS_ANNOTATION_EDITOR_TYPE.DISABLE,
      annotationEditorHighlightColors: ANNOTATION_HIGHLIGHT_COLORS,
      enablePermissions: true,
      supportsPinchToZoom: true,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
      pageColors,
      ...(commentBridge === null ? {} : { commentManager: commentBridge }),
    });
  }

  async goTo(location: DocumentLocation): Promise<void> {
    const revision = ++this.navigationRequestRevision;
    const lifecycleRevision = this.navigationLifecycleRevision;
    this.requireMounted(this.linkService);
    await this.annotationEditorInstance?.abortInteraction(
      'PDF navigation cancelled the annotation interaction.',
    );
    if (!this.isCurrentNavigationRequest(revision, lifecycleRevision)) return;
    this.selectionObserverInstance?.invalidate();
    this.latestLocation = { ...location };
    if (!this.pagesInitialized || this.colorRebindActive) {
      this.pendingLocation = { ...location };
      return;
    }
    await this.navigateTo(location, revision, lifecycleRevision);
    if (!this.isCurrentNavigationRequest(revision, lifecycleRevision)) return;
    const viewer = this.requireMounted(this.viewer);
    this.refitPageHeight(viewer);
  }

  setScale(scale: ScaleRequest): void {
    const viewer = this.requireMounted(this.viewer);
    this.selectionObserverInstance?.invalidate();
    this.requestedScale = scale;
    this.explicitScaleRequest = true;
    this.scaleRequestRevision += 1;
    if (!this.pagesInitialized) {
      return;
    }
    if (this.colorRebindActive && this.preservedViewState !== null) {
      this.preservedViewState = {
        ...this.preservedViewState,
        scale: this.preservedScale(scale),
      };
      return;
    }
    this.applyScale(viewer, scale, this.scaleRequestRevision);
  }

  stepScale(direction: -1 | 1): void {
    const viewer = this.requireMounted(this.viewer);
    const current =
      typeof this.requestedScale === 'number' ? this.requestedScale : viewer.currentScale;
    const delta = direction > 0 ? SCALE_DELTA : 1 / SCALE_DELTA;
    const round = direction > 0 ? Math.ceil : Math.floor;
    const stepped = round(Number((current * delta).toFixed(2)) * 10) / 10;
    this.setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, stepped)));
  }

  setLayout(layout: ReaderLayout): void {
    const viewer = this.requireMounted(this.viewer);
    this.selectionObserverInstance?.invalidate();
    this.requestedLayout = { ...layout };
    if (!this.pagesInitialized || this.colorRebindActive) {
      return;
    }
    this.applyLayout(viewer, layout);
  }

  setReadingColors(appearance: ReadingAppearance): void {
    const root = this.requireMounted(this.root);
    this.selectionObserverInstance?.invalidate();
    const profile = readingProfile(appearance);
    if (profile.pageColors === null) {
      root.style.removeProperty('--abyss-reader-background');
      root.style.removeProperty('--abyss-reader-foreground');
    } else {
      root.setCssProps({
        '--abyss-reader-background': profile.pageColors.background,
        '--abyss-reader-foreground': profile.pageColors.foreground,
      });
    }
    root.setCssProps({
      '--abyss-reader-brightness': String(profile.brightness),
      '--abyss-reader-contrast': String(profile.contrast),
      '--abyss-reader-image-dim': String(profile.imageDim),
    });
    this.requestedPageColors = profile.pageColors;
    this.colorRequestRevision += 1;
    if (!this.pagesInitialized) {
      this.replacePendingPagesInit(() => {
        this.startColorRebind();
      });
      return;
    }
    if (this.colorRebindActive) {
      this.replacePendingPagesInit(() => {
        this.finishColorRebind();
      });
      return;
    }
    this.startColorRebind();
  }

  search(query: string): void {
    if (this.eventBus === null || this.destroyPromise !== null) return;
    const normalizedQuery = query.trim();
    this.selectionAbort?.abort();
    this.selectionAbort = null;
    this.lastQuery = normalizedQuery;
    this.dispatchFind(normalizedQuery, false, '');
    this.searchAbort?.abort();
    const abortController = new AbortController();
    this.searchAbort = abortController;
    void this.textSearch
      .search(normalizedQuery, abortController.signal, (results) => {
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

  async selectSearchHit(hit: SearchHit, query: string): Promise<void> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      throw new DOMException('Cannot select a search hit without a query.', 'InvalidStateError');
    }
    const eventBus = this.requireMounted(this.eventBus);
    const linkService = this.requireMounted(this.linkService);
    const findController = this.requireMounted(this.findController);
    this.selectionAbort?.abort();
    const abortController = new AbortController();
    this.selectionAbort = abortController;
    try {
      linkService.page = hit.pageIndex + 1;
      await this.dispatchFindAndWait(eventBus, findController, {
        query: normalizedQuery,
        findPrevious: false,
        type: '',
        signal: abortController.signal,
      });
      for (let matchIndex = 0; matchIndex < hit.matchIndex; matchIndex += 1) {
        await this.dispatchFindAndWait(eventBus, findController, {
          query: normalizedQuery,
          findPrevious: false,
          type: 'again',
          signal: abortController.signal,
        });
      }
    } finally {
      if (this.selectionAbort === abortController) this.selectionAbort = null;
    }
  }

  onEvent(listener: (event: ViewportEvent) => void): () => void {
    if (this.destroyPromise !== null) return () => undefined;
    return this.events.subscribe(listener);
  }

  focus(): void {
    this.requireMounted(this.viewer).focus();
  }

  get annotationEditor(): PdfAnnotationEditor | null {
    return this.annotationEditorInstance;
  }

  get annotationInteraction(): PdfAnnotationInteraction | null {
    return this.annotationEditorInstance;
  }

  get selectionObserver(): PdfSelectionObserver {
    return this.requireMounted(this.selectionObserverInstance);
  }

  projectSelectionRects(selection: PdfTextSelection): readonly PdfPageRect[] {
    const clientRects =
      selection.clientRects.length === 0 ? [selection.clientRect] : selection.clientRects;
    return this.projectClientRects(selection.pageIndex, clientRects);
  }

  private projectClientRects(
    pageIndex: number,
    clientRects: ReadonlyArray<Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>>,
  ): readonly PdfPageRect[] {
    const viewer = this.requireMounted(this.viewer);
    const page = this.pageElement(pageIndex + 1);
    const pageView = viewer.getPageView(pageIndex) as unknown as PdfPageViewGeometry | undefined;
    if (page === null || pageView?.viewport === undefined) return [];
    const pageBounds = page.getBoundingClientRect();
    const contentLeft = pageBounds.left + page.clientLeft;
    const contentTop = pageBounds.top + page.clientTop;
    const pageTop = pageView.viewport.rawDims.pageY + pageView.viewport.rawDims.pageHeight;
    return clientRects.map((rect) => {
      const first = pageView.viewport.convertToPdfPoint(
        rect.left - contentLeft,
        rect.top - contentTop,
      );
      const second = pageView.viewport.convertToPdfPoint(
        rect.right - contentLeft,
        rect.bottom - contentTop,
      );
      const x = Math.min(first[0], second[0]);
      const y = pageTop - Math.max(first[1], second[1]);
      return {
        x,
        y,
        width: Math.abs(second[0] - first[0]),
        height: Math.abs(second[1] - first[1]),
      };
    });
  }

  destroy(): Promise<void> {
    if (this.destroyPromise === null) {
      const pending = Promise.resolve().then(() => this.destroyOnce());
      this.destroyPromise = pending;
      void pending.catch(() => {
        if (this.destroyPromise === pending) this.destroyPromise = null;
      });
    }
    return this.destroyPromise;
  }

  private async destroyOnce(): Promise<void> {
    if (this.commentBridge?.dispose() === false) {
      throw new DOMException(
        'The PDF annotation editor still has changes that could not be persisted.',
        'InvalidStateError',
      );
    }
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
    this.abortSearches();
    this.destroyEditorBridges(attempt);
    const eventBus = this.eventBus;
    this.clearPendingPagesInit();
    this.resetDestroyedInteractionState();
    attempt(() => {
      this.disconnectResizeObserver();
    });
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
      if (this.root !== null) this.unregisterRootListeners(this.root);
    });
    if (this.viewer !== null) {
      attempt(() => {
        (this.viewer as unknown as RebindablePdfViewer).setDocument(null);
      });
    }
    attempt(() => {
      this.viewer?.cleanup();
    });
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
    this.clearOwnedViewerReferences();
    this.viewerElement = null;
    this.root = null;
    if (failure !== undefined) throw failure;
  }

  private destroyEditorBridges(attempt: (operation: () => void) => void): void {
    attempt(() => {
      this.selectionSnapshotUnsubscribe?.();
      this.selectionSnapshotUnsubscribe = null;
    });
    attempt(() => {
      this.annotationMutationUnsubscribe?.();
      this.annotationMutationUnsubscribe = null;
    });
    attempt(() => {
      this.selectionObserverInstance?.destroy();
    });
    attempt(() => {
      this.annotationEditorInstance?.destroy();
    });
  }

  private resetDestroyedInteractionState(): void {
    this.colorRebindActive = false;
    this.requestedPageColors = null;
    this.preservedViewState = null;
    this.clearPendingInteractions();
    this.currentSelection = null;
    this.mountedAnnotationSnapshots.clear();
    this.cancelAnnotationSnapshotFrame();
  }

  private clearOwnedViewerReferences(): void {
    this.findController = null;
    this.viewer = null;
    this.annotationEditorInstance = null;
    this.commentBridge = null;
    this.selectionObserverInstance = null;
  }

  private attachRoot(root: HTMLDivElement, viewerElement: HTMLDivElement): void {
    this.root = root;
    this.viewerElement = viewerElement;
    this.selectionObserverInstance = new PdfDomSelectionObserver(root);
    this.selectionSnapshotUnsubscribe = this.selectionObserverInstance.onSelection((selection) => {
      this.currentSelection = selection;
    });
  }

  private registerRootListeners(root: HTMLElement): void {
    root.addEventListener('pointerdown', this.onRootPointerDown, { capture: true });
    root.addEventListener('click', this.onRootClick, { capture: true });
    root.addEventListener('contextmenu', this.onRootContextMenu);
  }

  private unregisterRootListeners(root: HTMLElement): void {
    root.removeEventListener('pointerdown', this.onRootPointerDown, { capture: true });
    root.removeEventListener('click', this.onRootClick, { capture: true });
    root.removeEventListener('contextmenu', this.onRootContextMenu);
    this.clearPendingPointerActivation();
  }

  private createAnnotationEditor(
    eventBus: PdfEventBus,
    viewer: PdfViewer,
  ): PdfAnnotationEditor | null {
    if (this.annotationCapabilities.readOnlyReason !== null) return null;
    return new PdfAnnotationEditor({
      annotationEditorParamsType: PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE,
      annotationEditorType: PDFJS_ANNOTATION_EDITOR_TYPE,
      commentBridge: this.requireMounted(this.commentBridge),
      eventBus,
      pdf: this.pdf,
      selectionObserver: this.requireMounted(this.selectionObserverInstance),
      viewer,
    });
  }

  private bindAnnotationProjection(editor: PdfAnnotationEditor | null): void {
    this.annotationMutationUnsubscribe?.();
    this.annotationMutationUnsubscribe =
      editor?.onMutation(() => {
        this.scheduleAnnotationSnapshot();
      }) ?? null;
  }

  private bindEvents(): void {
    this.bind('pagesinit', () => {
      this.pagesInitialized = true;
      if (this.colorRebindActive) return;
      if (this.viewer !== null) {
        this.applyLayout(this.viewer, this.requestedLayout);
        this.applyScale(this.viewer, this.requestedScale, this.scaleRequestRevision);
      }
      this.flushPendingLocation();
    });
    this.bind('pagechanging', (event) => {
      this.onPageChanging(event);
    });
    this.bind('scalechanging', (event) => {
      this.onScaleChanging(event);
    });
    this.bind('pagerendered', (event) => {
      this.selectionObserverInstance?.invalidate();
      this.onPageRendered(event);
    });
    this.bind('textlayerrendered', () => {
      this.selectionObserverInstance?.invalidate();
      incrementReaderCounter('firstTextLayers');
      markReaderPerformanceOnce('first-text-layer');
      markReaderPerformance('text-layer');
    });
    this.bind('annotationlayerrendered', (event) => {
      const pageNumber = positiveInteger(record(event)?.['pageNumber']);
      if (pageNumber === null) return;
      const page = this.pageElement(pageNumber);
      if (page !== null) replacePdfAnnotationImageSources(page, annotationImageData);
      this.publishMountedAnnotationSnapshot();
    });
  }

  private scheduleAnnotationSnapshot(): void {
    const root = this.root;
    if (root === null) return;
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow === null || this.annotationSnapshotFrame !== null) return;
    this.annotationSnapshotFrame = ownerWindow.requestAnimationFrame(() => {
      this.annotationSnapshotFrame = null;
      this.publishMountedAnnotationSnapshot(true);
    });
  }

  private cancelAnnotationSnapshotFrame(): void {
    if (this.annotationSnapshotFrame === null) return;
    this.root?.ownerDocument.defaultView?.cancelAnimationFrame(this.annotationSnapshotFrame);
    this.annotationSnapshotFrame = null;
  }

  private publishMountedAnnotationSnapshot(detectRemovals = false): void {
    if (this.destroyPromise !== null || this.root === null || this.viewer === null) return;
    const annotations = this.collectMountedAnnotationSnapshots();
    const loadedPages = this.loadedAnnotationPages();
    const next = new Map(
      [...this.mountedAnnotationSnapshots].filter(([, annotation]) =>
        loadedPages.has(annotation.pageIndex),
      ),
    );
    for (const annotation of annotations) next.set(annotation.nativeId, annotation);
    this.emitMountedAnnotationUpserts(annotations);
    if (detectRemovals) this.removeMissingMountedAnnotations(annotations, next, loadedPages);
    this.mountedAnnotationSnapshots = next;
    this.events.emit({ type: 'annotation-snapshot', annotations });
  }

  private emitMountedAnnotationUpserts(annotations: readonly ViewportAnnotationSnapshot[]): void {
    for (const annotation of annotations) {
      const previous = this.mountedAnnotationSnapshots.get(annotation.nativeId);
      if (previous !== undefined && sameViewportAnnotation(previous, annotation)) continue;
      this.events.emit({
        type: 'annotation-change',
        change: { operation: 'upsert', annotation },
      });
    }
  }

  private removeMissingMountedAnnotations(
    annotations: readonly ViewportAnnotationSnapshot[],
    next: Map<string, ViewportAnnotationSnapshot>,
    loadedPages: ReadonlySet<number>,
  ): void {
    const currentIds = new Set(annotations.map((annotation) => annotation.nativeId));
    for (const previous of this.mountedAnnotationSnapshots.values()) {
      if (!loadedPages.has(previous.pageIndex) || currentIds.has(previous.nativeId)) continue;
      next.delete(previous.nativeId);
      this.emitMountedAnnotationRemoval(previous);
    }
  }

  private emitMountedAnnotationRemoval(previous: ViewportAnnotationSnapshot): void {
    this.events.emit({
      type: 'annotation-change',
      change: {
        operation: 'remove',
        nativeId: previous.nativeId,
        ...(previous.provisionalId === undefined ? {} : { provisionalId: previous.provisionalId }),
      },
    });
  }

  private loadedAnnotationPages(): ReadonlySet<number> {
    const root = this.requireMounted(this.root);
    const pages = new Set<number>();
    const layers = Array.from(
      root.querySelectorAll<HTMLElement>('.annotationLayer, .annotationEditorLayer'),
    );
    for (const layer of layers) {
      const pageNumber = positiveInteger(
        Number(layer.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber']),
      );
      if (pageNumber !== null) pages.add(pageNumber - 1);
    }
    return pages;
  }

  private collectMountedAnnotationSnapshots(): readonly ViewportAnnotationSnapshot[] {
    const root = this.requireMounted(this.root);
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(
        '.annotationLayer :is(.highlightAnnotation, .underlineAnnotation, .inkAnnotation, .freeTextAnnotation, .textAnnotation)[data-annotation-id], .annotationEditorLayer :is(.highlightEditor, .inkEditor, .freeTextEditor)[id]',
      ),
    );
    const snapshots = new Map<string, ViewportAnnotationSnapshot>();
    for (const node of nodes) {
      const snapshot = this.snapshotForMountedAnnotation(node);
      if (snapshot !== null) snapshots.set(snapshot.nativeId, snapshot);
    }
    return [...snapshots.values()];
  }

  private snapshotForMountedAnnotation(node: HTMLElement): ViewportAnnotationSnapshot | null {
    const context = mountedAnnotationContext(node);
    if (context === null) return null;
    const binding = this.annotationEditorInstance?.resolveNativeEditor(context.internalId) ?? null;
    const nativeId = annotationNodeNativeId(node, binding?.id, context.internalId);
    if (nativeId.length === 0) return null;
    return this.createMountedAnnotationSnapshot(node, context.pageIndex, nativeId, binding);
  }

  private createMountedAnnotationSnapshot(
    node: HTMLElement,
    pageIndex: number,
    nativeId: string,
    binding: ReturnType<PdfAnnotationEditor['resolveNativeEditor']>,
  ): ViewportAnnotationSnapshot {
    const selected = this.annotationSelectionFor(node, pageIndex);
    const selectedText = annotationNodeSelectedText(node, selected);
    const color = binding === null ? annotationNodeColor(node) : (binding.color ?? undefined);
    const comment = node.dataset['comment'];
    return {
      nativeId,
      ...(selected === null ? {} : { provisionalId: selected.token }),
      pageIndex,
      type: annotationTypeForNode(node, binding?.kind ?? null),
      rects: this.annotationNodeRects(node, pageIndex, selected),
      ...(selectedText === undefined ? {} : { selectedText }),
      ...(color === undefined ? {} : { color }),
      ...(comment === undefined ? {} : { comment }),
      tags: annotationNodeList(node.dataset['tags']),
      links: annotationNodeList(node.dataset['links']),
      ...(binding === null ? {} : { writable: true }),
    };
  }

  private annotationSelectionFor(node: HTMLElement, pageIndex: number): PdfTextSelection | null {
    const selection = this.currentSelection;
    return selection?.pageIndex === pageIndex && node.matches('.selectedEditor') ? selection : null;
  }

  private annotationNodeRects(
    node: HTMLElement,
    pageIndex: number,
    selected: PdfTextSelection | null,
  ): readonly PdfPageRect[] {
    return selected === null
      ? this.projectClientRects(pageIndex, [node.getBoundingClientRect()])
      : this.projectSelectionRects(selected);
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
    if (pageNumber === null) return;
    const pageIndex = pageNumber - 1;
    this.selectionObserverInstance?.invalidate();
    if (this.latestLocation?.pageIndex !== pageIndex) {
      this.latestLocation = { pageIndex };
    }
    this.events.emit({ type: 'page-change', pageIndex });
    if (this.viewer !== null) this.refitPageHeight(this.viewer);
  }

  private onScaleChanging(event: unknown): void {
    if (this.applyingLayout) return;
    const data = record(event);
    if (data === null) return;
    const eventScale = this.scaleFromEvent(data);
    if (eventScale === null) return;
    this.selectionObserverInstance?.invalidate();
    this.requestedScale = eventScale;
    this.explicitScaleRequest = true;
    this.scaleRequestRevision += 1;
    this.events.emit({ type: 'scale-change', scale: eventScale });
  }

  private scaleFromEvent(data: Record<string, unknown>): ReaderScale | null {
    let result: ReaderScale | null = this.applyingScale;
    const preset = data['presetValue'];
    if (
      result === null &&
      (preset === 'page-width' || preset === 'page-fit' || preset === 'page-height')
    ) {
      result = preset;
    }
    const scale = data['scale'];
    if (result === null && typeof scale === 'number' && Number.isFinite(scale)) result = scale;
    return result;
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
    incrementReaderCounter('firstUsablePages');
    markReaderPerformanceOnce('first-usable-page');
    markReaderPerformance('usable-page');
    maximizeReaderCounter(
      'maxRenderedPagesDuringLongNavigation',
      this.viewerElement?.querySelectorAll('canvas').length ?? 0,
    );
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

  private startColorRebind(): void {
    const viewer = this.requireMounted(this.viewer);
    this.navigationLifecycleRevision += 1;
    this.selectionObserverInstance?.invalidate();
    const pageColors = this.requestedPageColors;
    this.preservedViewState ??= this.captureViewState(viewer);
    this.colorRebindActive = true;
    this.pagesInitialized = false;
    this.colorRebindRevision = this.colorRequestRevision;
    viewer.pageColors = pageColors;
    this.replacePendingPagesInit(() => {
      this.finishColorRebind();
    });
    try {
      const rebindableViewer = viewer as unknown as RebindablePdfViewer;
      this.annotationEditorInstance?.detachFromDocument();
      rebindableViewer.setDocument(null);
      rebindableViewer.setDocument(this.pdf);
      this.annotationEditorInstance?.resumeDocumentLifecycle();
    } catch (cause) {
      this.annotationEditorInstance?.resumeDocumentLifecycle();
      const pageNumber = this.preservedViewState.pageNumber;
      this.clearPendingPagesInit();
      this.colorRebindActive = false;
      this.preservedViewState = null;
      this.handleRenderError(pageNumber, cause);
    }
  }

  private replacePendingPagesInit(listener: PdfEventListener): void {
    const eventBus = this.requireMounted(this.eventBus);
    this.clearPendingPagesInit();
    this.pendingPagesInit = listener;
    eventBus.on('pagesinit', listener);
  }

  private clearPendingPagesInit(): void {
    if (this.pendingPagesInit === null) return;
    this.eventBus?.off('pagesinit', this.pendingPagesInit);
    this.pendingPagesInit = null;
  }

  private finishColorRebind(): void {
    this.clearPendingPagesInit();
    this.colorRebindActive = false;
    if (this.destroyPromise !== null) {
      this.preservedViewState = null;
      return;
    }
    if (this.colorRebindRevision !== this.colorRequestRevision) {
      this.startColorRebind();
      return;
    }
    const viewer = this.requireMounted(this.viewer);
    const state = this.requireMounted(this.preservedViewState);
    this.preservedViewState = null;
    try {
      this.applyLayout(viewer, this.requestedLayout);
      const location = this.pendingLocation ?? this.locationForRebind(state);
      this.pendingLocation = null;
      this.latestLocation = { ...location };
      const revision = ++this.navigationRequestRevision;
      const lifecycleRevision = this.navigationLifecycleRevision;
      void this.navigateTo(location, revision, lifecycleRevision).catch((cause: unknown) => {
        this.handleRenderError(state.pageNumber, cause);
      });
      const scale = this.explicitScaleRequest ? this.requestedScale : this.scaleFromState(state);
      this.applyScale(viewer, scale, this.scaleRequestRevision);
    } catch (cause) {
      this.handleRenderError(state.pageNumber, cause);
    }
  }

  private captureViewState(viewer: PdfViewer): PreservedViewState {
    const scaleValue = viewer.currentScaleValue;
    let scale: PreservedScale;
    if (this.explicitScaleRequest) {
      scale = this.preservedScale(this.requestedScale);
    } else if (!this.pagesInitialized) {
      scale = { type: 'preset', value: 'page-width' };
    } else if (
      scaleValue === 'page-width' ||
      scaleValue === 'page-fit' ||
      scaleValue === 'page-height'
    ) {
      scale = { type: 'preset', value: scaleValue };
    } else {
      scale = { type: 'numeric', value: viewer.currentScale };
    }
    return { pageNumber: viewer.currentPageNumber, scale };
  }

  private applyScale(viewer: PdfViewer, scale: ScaleRequest, revision: number): void {
    if (scale === 'page-height') {
      this.applyPageHeight(viewer, revision).catch((cause: unknown) => {
        this.handlePageHeightFailure(viewer, revision, cause);
      });
      return;
    }
    this.applyingScale = scale;
    try {
      if (typeof scale === 'number') viewer.currentScale = scale;
      else viewer.currentScaleValue = scale;
    } finally {
      this.applyingScale = null;
    }
  }

  private async applyPageHeight(viewer: PdfViewer, revision: number): Promise<void> {
    const pageNumber = this.pendingLocation?.pageIndex ?? viewer.currentPageNumber - 1;
    const page = await this.pdf.getPage(pageNumber + 1);
    if (!this.isCurrentScaleRequest(viewer, revision)) return;
    const rotation = (page.rotate + viewer.pagesRotation) % 360;
    const viewport = page.getViewport({
      scale: PDF_TO_CSS_UNITS,
      rotation,
    });
    const availableHeight = Math.max(
      1,
      this.requireMounted(this.root).clientHeight - VERTICAL_PADDING,
    );
    this.applyingScale = 'page-height';
    try {
      viewer.currentScale = availableHeight / viewport.height;
    } finally {
      this.applyingScale = null;
    }
  }

  private isCurrentScaleRequest(viewer: PdfViewer, revision: number): boolean {
    return (
      revision === this.scaleRequestRevision &&
      this.viewer === viewer &&
      this.pagesInitialized &&
      !this.colorRebindActive &&
      this.destroyPromise === null
    );
  }

  private handlePageHeightFailure(viewer: PdfViewer, revision: number, cause: unknown): void {
    if (!this.isCurrentScaleRequest(viewer, revision)) return;
    this.handleRenderError(viewer.currentPageNumber, cause);
  }

  private applyLayout(viewer: PdfViewer, layout: ReaderLayout): void {
    const pageNumber = viewer.currentPageNumber;
    this.applyingLayout = true;
    try {
      viewer.spreadMode =
        layout.pages === 'facing'
          ? this.pdfjsViewer.SpreadMode.ODD
          : this.pdfjsViewer.SpreadMode.NONE;
      viewer.scrollMode =
        layout.scrolling === 'page-by-page'
          ? this.pdfjsViewer.ScrollMode.PAGE
          : this.pdfjsViewer.ScrollMode.VERTICAL;
      viewer.currentPageNumber = pageNumber;
    } finally {
      this.applyingLayout = false;
    }
  }

  private preservedScale(scale: ScaleRequest): PreservedScale {
    return typeof scale === 'number'
      ? { type: 'numeric', value: scale }
      : { type: 'preset', value: scale };
  }

  private scaleFromState(state: PreservedViewState): ScaleRequest {
    return state.scale.value;
  }

  private locationForRebind(state: PreservedViewState): DocumentLocation {
    return this.latestLocation === null
      ? { pageIndex: state.pageNumber - 1 }
      : { ...this.latestLocation };
  }

  private async navigateTo(
    location: DocumentLocation,
    revision: number,
    lifecycleRevision: number,
  ): Promise<void> {
    const linkService = this.requireMounted(this.linkService);
    const pageNumber = location.pageIndex + 1;
    if (location.coordinateSpace === undefined) {
      if (!this.isCurrentNavigationRequest(revision, lifecycleRevision)) return;
      linkService.goToPage(pageNumber);
      return;
    }
    let y = location.y ?? 0;
    if (location.coordinateSpace === 'page-points-top-left') {
      const pageTop = await this.pageTopForNavigation(pageNumber, revision, lifecycleRevision);
      if (pageTop === null) return;
      y = pageTop - y;
    }
    if (!this.isCurrentNavigationRequest(revision, lifecycleRevision)) return;
    linkService.goToXY(pageNumber, location.x ?? 0, y);
  }

  private isCurrentNavigationRequest(revision: number, lifecycleRevision: number): boolean {
    return (
      revision === this.navigationRequestRevision &&
      lifecycleRevision === this.navigationLifecycleRevision &&
      this.destroyPromise === null
    );
  }

  private async pageTopForNavigation(
    pageNumber: number,
    revision: number,
    lifecycleRevision: number,
  ): Promise<number | null> {
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>;
    try {
      page = await this.pdf.getPage(pageNumber);
    } catch (cause) {
      if (!this.isCurrentNavigationRequest(revision, lifecycleRevision)) return null;
      throw cause;
    }
    if (!this.isCurrentNavigationRequest(revision, lifecycleRevision)) return null;
    const pageTop = page.view[3];
    if (pageTop === undefined)
      throw new TypeError('The PDF page crop box is missing its top coordinate.');
    return pageTop;
  }

  private flushPendingLocation(): void {
    if (
      this.pendingLocation === null ||
      !this.pagesInitialized ||
      this.colorRebindActive ||
      this.pendingPagesInit !== null
    )
      return;
    const location = this.pendingLocation;
    this.pendingLocation = null;
    const revision = ++this.navigationRequestRevision;
    const lifecycleRevision = this.navigationLifecycleRevision;
    void this.navigateTo(location, revision, lifecycleRevision).catch((cause: unknown) => {
      this.handleRenderError(location.pageIndex + 1, cause);
    });
  }

  private clearPendingInteractions(): void {
    this.navigationRequestRevision += 1;
    this.navigationLifecycleRevision += 1;
    this.pendingLocation = null;
    this.latestLocation = null;
  }

  private readonly onResize = (): void => {
    if (this.resizeFrame !== null || this.destroyPromise !== null) return;
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      if (!this.pagesInitialized || this.colorRebindActive || this.destroyPromise !== null) return;
      const viewer = this.viewer;
      if (viewer === null) return;
      const fitScale = this.fitScaleForResize(viewer);
      if (fitScale !== null) {
        this.requestedScale = fitScale;
        this.scaleRequestRevision += 1;
        this.applyScale(viewer, fitScale, this.scaleRequestRevision);
      }
    });
  };

  private fitScaleForResize(viewer: PdfViewer): ScaleRequest | null {
    let result: ScaleRequest | null = null;
    if (this.requestedScale === 'page-height') result = 'page-height';
    const scale = viewer.currentScaleValue;
    if (result === null && (scale === 'page-width' || scale === 'page-fit')) result = scale;
    return result;
  }

  private refitPageHeight(viewer: PdfViewer): void {
    if (
      this.requestedScale !== 'page-height' ||
      !this.pagesInitialized ||
      this.colorRebindActive ||
      this.destroyPromise !== null
    )
      return;
    this.scaleRequestRevision += 1;
    this.applyScale(viewer, 'page-height', this.scaleRequestRevision);
  }

  private disconnectResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeFrame === null) return;
    window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
  }

  private readonly onRootClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!isElementTarget(target)) return;
    const annotationId = this.annotationActivationId(target);
    if (annotationId !== null) {
      const pending = this.pendingPointerActivation;
      this.clearPendingPointerActivation();
      if (pending?.id === annotationId) return;
      const preserveNativeSelection = hasNativeSelectionModifier(event);
      this.activateRootAnnotation(annotationId, preserveNativeSelection);
      return;
    }
    const retry = target.closest<HTMLButtonElement>('[data-action="retry-page"]');
    if (retry === null) return;
    const page = target.closest<HTMLElement>('[data-page-number]');
    const pageNumber = positiveInteger(Number(page?.dataset['pageNumber']));
    if (page === null || pageNumber === null || this.viewer === null) return;
    this.retryPage(this.viewer, page, pageNumber, retry);
  };

  private readonly onRootPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!isElementTarget(target)) return;
    const annotationId = this.annotationActivationId(target);
    if (annotationId === null) return;
    this.clearPendingPointerActivation();
    const owner = target.ownerDocument.defaultView;
    if (owner === null) return;
    const pending = {
      id: annotationId,
      timeout: owner.setTimeout(() => {
        if (this.pendingPointerActivation === pending) this.pendingPointerActivation = null;
      }, 0),
    };
    this.pendingPointerActivation = pending;
    this.activateRootAnnotation(annotationId, hasNativeSelectionModifier(event));
  };

  private activateRootAnnotation(
    id: string,
    preserveNativeSelection: boolean,
    kind: 'root-click' | 'root-context' = 'root-click',
  ): void {
    this.annotationInteraction
      ?.focusAnnotation(id, {
        kind,
        ...(preserveNativeSelection ? { preserveNativeSelection: true } : {}),
      })
      .catch((cause: unknown) => {
        if (!isAbortFailure(cause))
          this.events.emit({ type: 'annotation-mutation-error', action: 'open-annotation', cause });
      });
  }

  private clearPendingPointerActivation(): void {
    const pending = this.pendingPointerActivation;
    if (pending === null) return;
    this.root?.ownerDocument.defaultView?.clearTimeout(pending.timeout);
    this.pendingPointerActivation = null;
  }

  private readonly onRootContextMenu = (event: MouseEvent): void => {
    const target = event.target;
    if (!isElementTarget(target)) return;
    const annotationId = this.annotationActivationId(target);
    if (annotationId === null) return;
    event.preventDefault();
    this.activateRootAnnotation(annotationId, false, 'root-context');
  };

  private annotationActivationId(target: Element): string | null {
    if (target.closest('a, button, input, select, textarea') !== null) return null;
    if (isNativeFreeTextEditingTarget(target)) return null;
    const node = target.closest<HTMLElement>(
      '.annotationLayer :is(.underlineAnnotation, .textAnnotation, .highlightAnnotation, .inkAnnotation, .freeTextAnnotation)[data-annotation-id], .annotationEditorLayer :is(.highlightEditor, .inkEditor, .freeTextEditor)[id]',
    );
    if (node === null) return null;
    const internalId = annotationNodeInternalId(node);
    if (internalId.length === 0) return null;
    const binding = this.annotationEditorInstance?.resolveNativeEditor(internalId) ?? null;
    const id = annotationNodeNativeId(node, binding?.id, internalId).trim();
    return id.length === 0 ? null : id;
  }

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

  private dispatchFindAndWait(
    eventBus: PdfEventBus,
    findController: PdfFindController,
    request: FindRequest,
  ): Promise<void> {
    const owner = this.requireMounted(this.root).win;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (failure?: Error): void => {
        if (settled) return;
        settled = true;
        eventBus.off('updatefindcontrolstate', onState);
        request.signal.removeEventListener('abort', onAbort);
        owner.clearTimeout(timeout);
        if (failure === undefined) resolve();
        else reject(failure);
      };
      const onAbort = (): void => {
        finish(this.selectionError('PDF search selection cancelled.', 'AbortError'));
      };
      const onState: PdfEventListener = (event) => {
        const data = record(event);
        if (data?.['source'] !== findController || data['rawQuery'] !== request.query) return;
        const state = data['state'];
        if (
          state === this.pdfjsViewer.FindState.FOUND ||
          state === this.pdfjsViewer.FindState.WRAPPED
        )
          finish();
        else if (state === this.pdfjsViewer.FindState.NOT_FOUND)
          finish(new Error(`PDF search could not find “${request.query}”.`));
      };
      const timeout = owner.setTimeout(() => {
        finish(this.selectionError('PDF search selection timed out.', 'TimeoutError'));
      }, FIND_SELECTION_TIMEOUT_MS);
      eventBus.on('updatefindcontrolstate', onState);
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      else this.dispatchFind(request.query, request.findPrevious, request.type);
    });
  }

  private abortSearches(): void {
    this.searchAbort?.abort();
    this.searchAbort = null;
    this.selectionAbort?.abort();
    this.selectionAbort = null;
  }

  private selectionError(message: string, name: 'AbortError' | 'TimeoutError'): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  private requireMounted<T>(value: T | null): T {
    if (value === null) throw new DOMException('PDF viewport is not mounted.', 'InvalidStateError');
    return value;
  }
}

function isAbortFailure(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function readingProfile(appearance: ReadingAppearance): ResolvedReadingProfile {
  if ('pageColors' in appearance) return appearance;
  return {
    pageColors: { background: appearance.background, foreground: appearance.foreground },
    brightness: appearance.brightness,
    contrast: appearance.contrast,
    imageDim: appearance.imageDim,
  };
}

export const createPdfDocumentViewport: PdfViewportFactory = (
  pdf,
  pdfjsViewer,
  textSearch,
  context,
) => new PdfDocumentViewport(pdf, pdfjsViewer, textSearch, context);
