import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import annotationImageData from 'pdfjs-dist/web/images/annotation-assets?data-url-map';
import type {
  DocumentLocation,
  DocumentViewport,
  SearchHit,
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
import { PdfDomSelectionObserver, type PdfSelectionObserver } from './pdf-selection-observer.js';
import type { PdfViewportContext, PdfViewportFactory } from './pdf-session.js';
import type { PdfTextSearch } from './pdf-text-search.js';

const TEXT_LAYER_MODE_ENABLE = 1;
const ANNOTATION_MODE_ENABLE_FORMS = 2;
const MAX_CANVAS_PIXELS = 16_777_216;
const FIND_SELECTION_TIMEOUT_MS = 2_000;
const CONTEXTUAL_SWITCH_CLICK_TIMEOUT_MS = 750;
const CONTEXTUAL_SWITCH_CLICK_COORDINATE_TOLERANCE = 4;
const CONTEXTUAL_SWITCH_DRAG_THRESHOLD_PX = 8;
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

interface FindRequest {
  readonly query: string;
  readonly findPrevious: boolean;
  readonly type: '' | 'again';
  readonly signal: AbortSignal;
}

interface PdfEditableAnnotationData {
  readonly annotationType?: unknown;
  readonly id?: unknown;
  readonly isEditable?: unknown;
  readonly it?: unknown;
}

interface ClickedAnnotationCandidate {
  readonly annotation: HTMLElement;
  readonly id: string;
  readonly inlineKind: PdfEditableAnnotationKind | null;
  readonly pageNumber: number;
}

interface ContextualSwitchCandidate {
  readonly expectedMode: number | null;
  readonly id: string;
  readonly kind: PdfEditableAnnotationKind | null;
  readonly pageNumber: number;
  readonly source: 'imported' | 'native';
}

interface ContextualSwitchClick {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly revision: number;
}

interface PendingContextualSwitchGesture extends ContextualSwitchClick {
  readonly candidate: ContextualSwitchCandidate;
  readonly editor: PdfAnnotationEditor;
  readonly root: HTMLDivElement;
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

function inlineEditableAnnotationKind(annotation: Element): PdfEditableAnnotationKind | null {
  if (annotation.querySelector('.annotationContent.highlight') !== null) return 'highlight';
  if (annotation.querySelector('.annotationContent.ink') !== null) return 'ink';
  if (annotation.querySelector('.annotationContent.freetext') !== null) return 'freetext';
  return null;
}

function importedEditableAnnotationKind(
  annotation: PdfEditableAnnotationData,
): PdfEditableAnnotationKind | null {
  if (annotation.isEditable !== true) return null;
  if (annotation.annotationType === 3) return 'freetext';
  if (annotation.annotationType === 9) return 'highlight';
  if (annotation.annotationType === 15) {
    return annotation.it === 'InkHighlight' ? 'highlight' : 'ink';
  }
  return null;
}

function clickedAnnotationCandidate(
  target: Element,
  root: Element,
): ClickedAnnotationCandidate | null {
  if (
    target.closest('.annotationEditorLayer') !== null ||
    target.closest(
      'a, button, input, textarea, select, [role="button"], .commentButton, .popupTriggerArea',
    ) !== null
  )
    return null;
  const annotation = target.closest<HTMLElement>('.annotationLayer [data-annotation-id]');
  if (annotation === null || !root.contains(annotation)) return null;
  const id = annotation.dataset['annotationId']?.trim();
  const pageNumber = positiveInteger(
    Number(annotation.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber']),
  );
  return id === undefined || id.length === 0 || pageNumber === null
    ? null
    : {
        annotation,
        id,
        inlineKind: inlineEditableAnnotationKind(annotation),
        pageNumber,
      };
}

function clickedNativeEditorCandidate(
  target: Element,
  root: Element,
  editor: PdfAnnotationEditor,
): ContextualSwitchCandidate | null {
  if (
    target.closest(
      'a, button, input, textarea, select, [role="button"], .editToolbar, .commentButton, .popupTriggerArea',
    ) !== null
  )
    return null;
  const native = target.closest<HTMLElement>(
    '.annotationEditorLayer :is(.highlightEditor, .inkEditor, .freeTextEditor)[id]',
  );
  if (native === null || !root.contains(native)) return null;
  const request = editor.resolveNativeEditor(native.id);
  const pageNumber = positiveInteger(
    Number(native.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber']),
  );
  return request === null || pageNumber === null
    ? null
    : {
        expectedMode: request.mode,
        id: request.id,
        kind: request.kind,
        pageNumber,
        source: 'native',
      };
}

function clickedContextualSwitchCandidate(
  target: Element,
  root: Element,
  editor: PdfAnnotationEditor,
): ContextualSwitchCandidate | null {
  const native = clickedNativeEditorCandidate(target, root, editor);
  if (native !== null) return native;
  const imported = clickedAnnotationCandidate(target, root);
  return imported === null
    ? null
    : {
        expectedMode: null,
        id: imported.id,
        kind: null,
        pageNumber: imported.pageNumber,
        source: 'imported',
      };
}

function modeForEditableAnnotationKind(kind: PdfEditableAnnotationKind): number {
  switch (kind) {
    case 'highlight':
      return PDFJS_ANNOTATION_EDITOR_TYPE.HIGHLIGHT;
    case 'ink':
      return PDFJS_ANNOTATION_EDITOR_TYPE.INK;
    case 'freetext':
      return PDFJS_ANNOTATION_EDITOR_TYPE.FREETEXT;
  }
}

function isSamePointer(
  event: PointerEvent,
  pending: Pick<ContextualSwitchClick, 'pointerId' | 'pointerType'>,
): boolean {
  if (event.pointerId > 0 && pending.pointerId > 0 && event.pointerId !== pending.pointerId)
    return false;
  return (
    event.pointerType.length === 0 ||
    pending.pointerType.length === 0 ||
    event.pointerType === pending.pointerType
  );
}

function exceedsContextualSwitchDragThreshold(
  event: PointerEvent,
  pending: Pick<ContextualSwitchClick, 'clientX' | 'clientY'>,
): boolean {
  return (
    Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) >
    CONTEXTUAL_SWITCH_DRAG_THRESHOLD_PX
  );
}

function isContextualSwitchClick(event: MouseEvent, pending: ContextualSwitchClick): boolean {
  if (event.button !== pending.button) return false;
  if (
    Math.abs(event.clientX - pending.clientX) > CONTEXTUAL_SWITCH_CLICK_COORDINATE_TOLERANCE ||
    Math.abs(event.clientY - pending.clientY) > CONTEXTUAL_SWITCH_CLICK_COORDINATE_TOLERANCE
  )
    return false;
  if (!event.instanceOf(PointerEvent)) return true;
  return isSamePointer(event, pending);
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
  private root: HTMLDivElement | null = null;
  private viewerElement: HTMLDivElement | null = null;
  private destroyPromise: Promise<void> | null = null;
  private searchAbort: AbortController | null = null;
  private selectionAbort: AbortController | null = null;
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
  private requestedLayout: ReaderLayout = { pages: 'single', scrolling: 'continuous' };
  private requestedScale: ScaleRequest = 'page-width';
  private scaleRequestRevision = 0;
  private explicitScaleRequest = false;
  private applyingScale: ScaleRequest | null = null;
  private applyingLayout = false;
  private annotationEditRevision = 0;
  private pendingContextualSwitchGesture: PendingContextualSwitchGesture | null = null;
  private contextualSwitchClick: ContextualSwitchClick | null = null;
  private contextualSwitchClickTimer: number | null = null;
  private readonly pageAnnotations = new Map<
    number,
    Promise<readonly PdfEditableAnnotationData[]>
  >();

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
        ? new PdfCommentBridge(
            root,
            {
              onFailure: ({ action, cause }) => {
                this.events.emit({ type: 'annotation-mutation-error', action, cause });
              },
              onNativeMutation: () => {
                this.annotationEditorInstance?.notifyNativeMutation();
              },
            },
            this.context.sourcePath,
            this.context.linkSuggestions ?? null,
          )
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
    this.invalidateAnnotationEditCandidate();
    this.requireMounted(this.linkService);
    await this.annotationEditorInstance?.abortInteraction(
      'PDF navigation cancelled the annotation interaction.',
    );
    this.selectionObserverInstance?.invalidate();
    this.latestLocation = { ...location };
    if (!this.pagesInitialized || this.colorRebindActive) {
      this.pendingLocation = { ...location };
      return;
    }
    this.navigateTo(location);
    const viewer = this.requireMounted(this.viewer);
    this.refitPageHeight(viewer);
  }

  setScale(scale: ScaleRequest): void {
    this.invalidateAnnotationEditCandidate();
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
    this.invalidateAnnotationEditCandidate();
    const viewer = this.requireMounted(this.viewer);
    this.selectionObserverInstance?.invalidate();
    this.requestedLayout = { ...layout };
    if (!this.pagesInitialized || this.colorRebindActive) {
      return;
    }
    this.applyLayout(viewer, layout);
  }

  setReadingColors(appearance: ReadingAppearance): void {
    this.invalidateAnnotationEditCandidate();
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
    this.invalidateAnnotationEditCandidate();
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
    this.invalidateAnnotationEditCandidate();
    if (this.lastQuery.length === 0 || this.eventBus === null) return;
    this.dispatchFind(this.lastQuery, direction === 'previous', 'again');
  }

  async selectSearchHit(hit: SearchHit, query: string): Promise<void> {
    this.invalidateAnnotationEditCandidate();
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
    attempt(() => {
      this.viewer?.cleanup();
    });
    if (this.viewer !== null) {
      attempt(() => {
        (this.viewer as unknown as RebindablePdfViewer).setDocument(null);
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
    this.clearOwnedViewerReferences();
    this.viewerElement = null;
    this.root = null;
    if (failure !== undefined) throw failure;
  }

  private destroyEditorBridges(attempt: (operation: () => void) => void): void {
    attempt(() => {
      this.selectionObserverInstance?.destroy();
    });
    attempt(() => {
      this.annotationEditorInstance?.destroy();
    });
    attempt(() => {
      this.commentBridge?.dispose();
    });
  }

  private resetDestroyedInteractionState(): void {
    this.colorRebindActive = false;
    this.requestedPageColors = null;
    this.preservedViewState = null;
    this.clearPendingInteractions();
    this.annotationEditRevision += 1;
    this.pageAnnotations.clear();
    this.clearPendingContextualSwitchGesture();
    this.clearContextualSwitchClick();
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
  }

  private registerRootListeners(root: HTMLElement): void {
    root.addEventListener('click', this.onRootClick, true);
    root.addEventListener('keydown', this.onRootKeyDown);
    root.addEventListener('pointercancel', this.onRootPointerCancel, true);
    root.addEventListener('pointerdown', this.onRootPointerDown, true);
    root.addEventListener('pointermove', this.onRootPointerMove, true);
    root.addEventListener('pointerup', this.onRootPointerUp, true);
    root.addEventListener('scroll', this.onRootReadingGesture);
    root.addEventListener('wheel', this.onRootReadingGesture, { passive: true });
  }

  private unregisterRootListeners(root: HTMLElement): void {
    root.removeEventListener('click', this.onRootClick, true);
    root.removeEventListener('keydown', this.onRootKeyDown);
    root.removeEventListener('pointercancel', this.onRootPointerCancel, true);
    root.removeEventListener('pointerdown', this.onRootPointerDown, true);
    root.removeEventListener('pointermove', this.onRootPointerMove, true);
    root.removeEventListener('pointerup', this.onRootPointerUp, true);
    root.removeEventListener('scroll', this.onRootReadingGesture);
    root.removeEventListener('wheel', this.onRootReadingGesture);
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

  private bindEvents(): void {
    this.bind('pagesinit', () => {
      this.invalidateAnnotationEditCandidate();
      this.pagesInitialized = true;
      if (this.colorRebindActive) return;
      if (this.viewer !== null) {
        this.applyLayout(this.viewer, this.requestedLayout);
        this.applyScale(this.viewer, this.requestedScale, this.scaleRequestRevision);
      }
      this.flushPendingLocation();
    });
    this.bind('pagechanging', (event) => {
      this.invalidateAnnotationEditCandidate();
      this.onPageChanging(event);
    });
    this.bind('scalechanging', (event) => {
      this.invalidateAnnotationEditCandidate();
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
    });
    this.bind('annotationeditoruimanager', () => {
      this.invalidateAnnotationEditCandidate();
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
      this.navigateTo(location);
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

  private navigateTo(location: DocumentLocation): void {
    const linkService = this.requireMounted(this.linkService);
    const pageNumber = location.pageIndex + 1;
    if (location.x === undefined && location.y === undefined) {
      linkService.goToPage(pageNumber);
      return;
    }
    linkService.goToXY(pageNumber, location.x ?? 0, location.y ?? 0);
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
    this.navigateTo(location);
  }

  private clearPendingInteractions(): void {
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
    if (this.consumeContextualSwitchClick(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    this.clearContextualSwitchClick();
    this.invalidateAnnotationEditCandidate();
    const retry = target.closest<HTMLButtonElement>('[data-action="retry-page"]');
    if (retry !== null) {
      const page = target.closest<HTMLElement>('[data-page-number]');
      const pageNumber = positiveInteger(Number(page?.dataset['pageNumber']));
      if (page === null || pageNumber === null || this.viewer === null) return;
      this.retryPage(this.viewer, page, pageNumber, retry);
      return;
    }
    this.editClickedAnnotation(target);
  };

  private readonly onRootPointerDown = (event: PointerEvent): void => {
    const revision = this.invalidateAnnotationEditCandidate();
    if (event.button !== 0) return;
    const editor = this.annotationEditorInstance;
    const target = event.target;
    if (editor?.hasContextualEdit !== true || !isElementTarget(target)) return;
    if (
      target.closest(
        '.annotationEditorLayer .selectedEditor, .editToolbar, .abyss-annotation-popover, .commentButton, .popupTriggerArea',
      ) !== null
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const root = this.root;
    const candidate = root === null ? null : clickedContextualSwitchCandidate(target, root, editor);
    if (candidate !== null && root !== null) {
      this.pendingContextualSwitchGesture = {
        button: event.button,
        candidate,
        clientX: event.clientX,
        clientY: event.clientY,
        editor,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        revision,
        root,
      };
      return;
    }
    void editor
      .abortInteraction('A pointer gesture outside the selected annotation closed its editor.')
      .catch((cause: unknown) => {
        console.error('[abyss-documents] Failed to close the PDF annotation editor', { cause });
      });
  };

  private readonly onRootPointerMove = (event: PointerEvent): void => {
    const pending = this.pendingContextualSwitchGesture;
    if (
      pending === null ||
      !isSamePointer(event, pending) ||
      !exceedsContextualSwitchDragThreshold(event, pending)
    )
      return;
    this.clearPendingContextualSwitchGesture();
  };

  private readonly onRootPointerCancel = (event: PointerEvent): void => {
    const pending = this.pendingContextualSwitchGesture;
    if (pending !== null && isSamePointer(event, pending)) {
      this.clearPendingContextualSwitchGesture();
    }
  };

  private readonly onRootPointerUp = (event: PointerEvent): void => {
    const pending = this.pendingContextualSwitchGesture;
    if (pending === null || !isSamePointer(event, pending)) return;
    this.clearPendingContextualSwitchGesture();
    if (
      event.button !== pending.button ||
      exceedsContextualSwitchDragThreshold(event, pending) ||
      !this.isContextualSwitchCurrent(
        pending.editor,
        pending.root,
        pending.candidate.pageNumber,
        pending.revision,
      )
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.armContextualSwitchClick(event, pending.revision);
    this.switchContextualAnnotation(
      pending.candidate,
      pending.editor,
      pending.root,
      pending.revision,
    );
  };

  private switchContextualAnnotation(
    candidate: ContextualSwitchCandidate,
    editor: PdfAnnotationEditor,
    root: HTMLDivElement,
    revision: number,
  ): void {
    void (async () => {
      await editor.abortInteraction('Selecting another PDF annotation closed its prior editor.');
      if (!this.isContextualSwitchCurrent(editor, root, candidate.pageNumber, revision)) return;
      let kind = candidate.kind;
      if (candidate.source === 'imported') {
        const annotation = this.findImportedAnnotation(root, candidate.id, candidate.pageNumber);
        if (annotation === null) return;
        kind = await this.resolveEditableAnnotation({
          annotation,
          id: candidate.id,
          inlineKind: null,
          pageNumber: candidate.pageNumber,
        });
      } else if (kind === null || candidate.expectedMode !== modeForEditableAnnotationKind(kind)) {
        return;
      }
      if (
        kind === null ||
        !this.isContextualSwitchCurrent(editor, root, candidate.pageNumber, revision)
      )
        return;
      await editor.editAnnotation({ editComment: false, id: candidate.id, kind });
    })().catch((cause: unknown) => {
      console.error('[abyss-documents] Failed to switch the selected PDF annotation', {
        cause,
        id: candidate.id,
        pageNumber: candidate.pageNumber,
      });
    });
  }

  private readonly onRootKeyDown = (event: KeyboardEvent): void => {
    this.clearContextualSwitchClick();
    this.invalidateAnnotationEditCandidate();
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!isElementTarget(target) || !this.editClickedAnnotation(target)) return;
    event.preventDefault();
  };

  private readonly onRootReadingGesture = (): void => {
    this.clearContextualSwitchClick();
    this.invalidateAnnotationEditCandidate();
  };

  private editClickedAnnotation(target: Element): boolean {
    const editor = this.annotationEditorInstance;
    const root = this.root;
    if (editor === null || root === null) return false;
    const candidate = clickedAnnotationCandidate(target, root);
    if (candidate === null) return false;
    const revision = this.invalidateAnnotationEditCandidate();
    void this.resolveEditableAnnotation(candidate)
      .then((kind) => {
        if (kind === null || !this.isAnnotationEditCandidateCurrent(candidate, root, revision))
          return;
        return editor.editAnnotation({ editComment: false, id: candidate.id, kind });
      })
      .catch((cause: unknown) => {
        console.error('[abyss-documents] Failed to open the PDF annotation editor', {
          cause,
          id: candidate.id,
          pageNumber: candidate.pageNumber,
        });
      });
    return true;
  }

  private async resolveEditableAnnotation(
    candidate: ClickedAnnotationCandidate,
  ): Promise<PdfEditableAnnotationKind | null> {
    if (candidate.inlineKind !== null) return candidate.inlineKind;
    let annotations = this.pageAnnotations.get(candidate.pageNumber);
    if (annotations === undefined) {
      annotations = this.pdf.getPage(candidate.pageNumber).then(async (page) => {
        return (await page.getAnnotations({ intent: 'display' })) as PdfEditableAnnotationData[];
      });
      this.pageAnnotations.set(candidate.pageNumber, annotations);
    }
    const annotation = (await annotations).find((item) => item.id === candidate.id);
    return annotation === undefined ? null : importedEditableAnnotationKind(annotation);
  }

  private invalidateAnnotationEditCandidate(): number {
    this.clearPendingContextualSwitchGesture();
    this.clearContextualSwitchClick();
    this.annotationEditRevision += 1;
    return this.annotationEditRevision;
  }

  private isAnnotationEditCandidateCurrent(
    candidate: ClickedAnnotationCandidate,
    root: HTMLDivElement,
    revision: number,
  ): boolean {
    return (
      revision === this.annotationEditRevision &&
      this.destroyPromise === null &&
      this.root === root &&
      root.contains(candidate.annotation)
    );
  }

  private isContextualSwitchCurrent(
    editor: PdfAnnotationEditor,
    root: HTMLDivElement,
    pageNumber: number,
    revision: number,
  ): boolean {
    return (
      revision === this.annotationEditRevision &&
      pageNumber <= this.pageCount &&
      this.destroyPromise === null &&
      this.root === root &&
      this.annotationEditorInstance === editor
    );
  }

  private findImportedAnnotation(
    root: HTMLDivElement,
    id: string,
    pageNumber: number,
  ): HTMLElement | null {
    const annotations = Array.from(
      root.querySelectorAll<HTMLElement>('.annotationLayer [data-annotation-id]'),
    );
    for (const annotation of annotations) {
      if (annotation.dataset['annotationId'] !== id) continue;
      const containingPage = positiveInteger(
        Number(annotation.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber']),
      );
      if (containingPage === pageNumber) return annotation;
    }
    return null;
  }

  private armContextualSwitchClick(event: PointerEvent, revision: number): void {
    this.clearContextualSwitchClick();
    this.contextualSwitchClick = {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      revision,
    };
    this.contextualSwitchClickTimer = window.setTimeout(() => {
      this.clearContextualSwitchClick();
    }, CONTEXTUAL_SWITCH_CLICK_TIMEOUT_MS);
  }

  private consumeContextualSwitchClick(event: MouseEvent): boolean {
    const pending = this.contextualSwitchClick;
    if (pending === null) return false;
    this.clearContextualSwitchClick();
    if (pending.revision !== this.annotationEditRevision) return false;
    return isContextualSwitchClick(event, pending);
  }

  private clearPendingContextualSwitchGesture(): void {
    this.pendingContextualSwitchGesture = null;
  }

  private clearContextualSwitchClick(): void {
    if (this.contextualSwitchClickTimer !== null) {
      window.clearTimeout(this.contextualSwitchClickTimer);
      this.contextualSwitchClickTimer = null;
    }
    this.contextualSwitchClick = null;
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
      highlightAll: false,
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
