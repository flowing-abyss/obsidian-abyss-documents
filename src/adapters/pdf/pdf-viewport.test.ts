import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import type { ViewportEvent } from '../../document-core/document.js';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../../reader-performance.js';
import type { PdfAnnotationCapabilities } from './pdf-annotation-capabilities.js';
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

interface TestPdfAnnotation {
  readonly annotationType: number;
  readonly id: string;
  readonly isEditable: boolean;
  readonly it?: string | undefined;
}

function pdf(pageCount = 700, annotations: readonly TestPdfAnnotation[] = []): PDFDocumentProxy {
  return {
    annotationStorage: { onResetModified: null, onSetModified: null },
    numPages: pageCount,
    getPage: vi.fn(async () => ({
      getAnnotations: vi.fn(async () => annotations),
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
    saveDocument: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  } as unknown as PDFDocumentProxy;
}

function annotationManager(
  selected: {
    readonly editorType: string;
    readonly mode: number;
    readonly uid: string;
  } | null = null,
  nativeEditors: ReadonlyArray<
    readonly [string, { readonly editorType: string; readonly mode: number; readonly uid: string }]
  > = [],
) {
  const layers = Array.from({ length: 3 }, () => ({
    disableClick: vi.fn(),
    disableTextSelection: vi.fn(),
  }));
  const editors = new Map(nativeEditors);
  return {
    commentSelection: vi.fn(),
    delete: vi.fn(),
    disableUserSelect: vi.fn(),
    endCurrentEditing: vi.fn(),
    editors,
    firstSelectedEditor: selected ?? undefined,
    getEditor: vi.fn((id: string) => editors.get(id)),
    getLayer: vi.fn((pageIndex: number) => layers[pageIndex]),
    highlightSelection: vi.fn(),
    layers,
    redo: vi.fn(),
    undo: vi.fn(),
    updateParams: vi.fn(),
  };
}

interface ViewerRuntimeOptions {
  readonly annotations?: readonly TestPdfAnnotation[];
  readonly findDelay?: number;
  readonly findState?: number;
  readonly layoutScaleChange?: { readonly presetValue?: string; readonly scale: number };
  readonly suppressFindState?: boolean;
}

function viewerRuntime(findOptions: ViewerRuntimeOptions = {}) {
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
    readonly annotationEditorRequests: Array<Record<string, unknown>> = [];
    annotationEditorRequestHook:
      ((request: number | { readonly editId?: string; readonly mode: number }) => void) | null =
      null;
    currentPageNumber = 1;
    currentScale = 1;
    currentScaleValue = 'auto';
    pagesRotation = 0;
    pageColors: object | null;
    private currentAnnotationEditorMode: number;
    private currentScrollMode = 0;
    private currentSpreadMode = 0;

    constructor(
      readonly options: {
        container: HTMLDivElement;
        viewer: HTMLDivElement;
        eventBus: FakeEventBus;
        linkService: FakeLinkService;
        findController: FakeFindController;
        textLayerMode: number;
        annotationMode: number;
        annotationEditorMode: number;
        annotationEditorHighlightColors?: string;
        enablePermissions: boolean;
        supportsPinchToZoom: boolean;
        maxCanvasPixels: number;
        pageColors: object;
        commentManager?: unknown;
      },
    ) {
      this.pageColors = options.pageColors;
      this.currentAnnotationEditorMode = options.annotationEditorMode;
      state.viewer = this;
    }

    get annotationEditorMode(): number {
      return this.currentAnnotationEditorMode;
    }

    set annotationEditorMode(
      request: number | { readonly editId?: string; readonly mode: number },
    ) {
      const mode = typeof request === 'number' ? request : request.mode;
      this.annotationEditorRequests.push(
        typeof request === 'number' ? { mode: request } : { ...request },
      );
      this.currentAnnotationEditorMode = mode;
      this.annotationEditorRequestHook?.(request);
      this.options.eventBus.dispatch('annotationeditormodechanged', { source: this, mode });
    }

    get scrollMode(): number {
      return this.currentScrollMode;
    }

    set scrollMode(mode: number) {
      if (this.currentScrollMode === mode) return;
      this.currentScrollMode = mode;
      this.dispatchLayoutScaleChange();
    }

    get spreadMode(): number {
      return this.currentSpreadMode;
    }

    set spreadMode(mode: number) {
      if (this.currentSpreadMode === mode) return;
      this.currentSpreadMode = mode;
      this.dispatchLayoutScaleChange();
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
        this.currentScrollMode = 0;
        this.currentSpreadMode = 0;
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

    private dispatchLayoutScaleChange(): void {
      const event = findOptions.layoutScaleChange;
      if (event === undefined || this.documents[this.documents.length - 1] === null) return;
      this.currentScale = event.scale;
      this.currentScaleValue = event.presetValue ?? String(event.scale);
      this.options.eventBus.dispatch('scalechanging', {
        scale: event.scale,
        presetValue: event.presetValue,
      });
    }
  }

  const module = {
    EventBus,
    FindState: { FOUND: 0, NOT_FOUND: 1, PENDING: 3, WRAPPED: 2 },
    PDFLinkService: FakeLinkService,
    PDFFindController: FakeFindController,
    PDFViewer: FakeViewer,
    ScrollMode: { UNKNOWN: -1, VERTICAL: 0, HORIZONTAL: 1, WRAPPED: 2, PAGE: 3 },
    SpreadMode: { UNKNOWN: -1, NONE: 0, ODD: 1, EVEN: 2 },
  } as unknown as PdfRuntime['pdfjsViewer'];
  return { module, state };
}

async function mountedViewport(pageCount = 700, options: ViewerRuntimeOptions = {}) {
  const documentProxy = pdf(pageCount, options.annotations);
  const runtime = viewerRuntime(options);
  const search = new PdfTextSearch(documentProxy);
  const viewport = new PdfDocumentViewport(documentProxy, runtime.module, search, {
    annotationCapabilities: {
      editing: {} as never,
      readOnlyReason: null,
      types: {} as never,
    } satisfies PdfAnnotationCapabilities,
    sourcePath: 'Books/Guide.pdf',
  });
  const host = createDiv();
  host.setCssProps({ '--background-primary': '#fafafa', '--text-normal': '#202020' });
  await viewport.mount(host);
  return { documentProxy, host, runtime, search, viewport };
}

interface ContextualSwitchFixtureOptions {
  readonly annotationClassName: string;
  readonly annotationType: number;
  readonly className: string;
  readonly editorType: string;
  readonly mode: number;
}

async function mountedContextualSwitchFixture(options: ContextualSwitchFixtureOptions) {
  const fixture = await mountedViewport(3, {
    annotations: [
      { annotationType: 9, id: 'annotation-a', isEditable: true },
      {
        annotationType: options.annotationType,
        id: `annotation-b-${options.editorType}`,
        isEditable: true,
      },
    ],
  });
  const eventBus = fixture.runtime.state.eventBus;
  const viewer = fixture.runtime.state.viewer;
  if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
  const selectedA = { editorType: 'highlight', mode: 9, uid: 'annotation-a' };
  const selectedB = {
    editorType: options.editorType,
    mode: options.mode,
    uid: `annotation-b-${options.editorType}`,
  };
  const uiManager = annotationManager(selectedA, [['internal-b', selectedB]]);
  eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
  const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
  if (root === null) throw new Error('Expected PDF root.');
  const page = root.createDiv();
  page.dataset['pageNumber'] = '1';
  const annotationA = page
    .createDiv({ cls: 'annotationLayer' })
    .createEl('section', { cls: 'highlightAnnotation' });
  annotationA.dataset['annotationId'] = 'annotation-a';
  annotationA.click();
  await vi.waitFor(() => {
    expect(viewer.annotationEditorRequests).toHaveLength(1);
  });

  const editorB = page
    .createDiv({ cls: 'annotationEditorLayer' })
    .createDiv({ cls: options.className });
  editorB.id = 'internal-b';
  const retargetedNativeAction = vi.fn();
  viewer.annotationEditorRequestHook = (request) => {
    const requestedMode = typeof request === 'number' ? request : request.mode;
    if (requestedMode === 0) {
      editorB.remove();
      uiManager.editors.delete('internal-b');
      uiManager.firstSelectedEditor = undefined;
      const restoredAnnotation = page
        .createDiv({ cls: 'annotationLayer' })
        .createEl('section', { cls: options.annotationClassName });
      restoredAnnotation.dataset['annotationId'] = `annotation-b-${options.editorType}`;
      restoredAnnotation.addEventListener('click', retargetedNativeAction);
      return;
    }
    if (
      requestedMode === options.mode &&
      typeof request !== 'number' &&
      request.editId === `annotation-b-${options.editorType}`
    ) {
      uiManager.firstSelectedEditor = selectedB;
    }
  };
  const nativeCreatorGesture = vi.fn();
  editorB.addEventListener('pointerdown', nativeCreatorGesture);
  return {
    ...fixture,
    editorB,
    eventBus,
    nativeCreatorGesture,
    page,
    retargetedNativeAction,
    root,
    uiManager,
    viewer,
  };
}

describe('PdfDocumentViewport', () => {
  it('delegates one supported annotation click without pointer double firing', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'highlight-1', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager({ editorType: 'highlight', mode: 9, uid: 'highlight-1' }),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const layer = page.createDiv({ cls: 'annotationLayer' });
    const annotation = layer.createEl('section', { cls: 'highlightAnnotation' });
    annotation.dataset['annotationId'] = 'highlight-1';

    annotation.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    annotation.click();
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toContainEqual({
        editComment: false,
        editId: 'highlight-1',
        mode: 9,
      });
    });
    expect(viewer.annotationEditorRequests).toHaveLength(1);
  });

  it('opens a supported annotation from contextmenu without a duplicate click transaction', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'highlight-1', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager({ editorType: 'highlight', mode: 9, uid: 'highlight-1' }),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotation = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotation.dataset['annotationId'] = 'highlight-1';
    annotation.createDiv({ cls: 'annotationContent highlight' });

    const contextmenu = new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    annotation.dispatchEvent(contextmenu);
    annotation.click();

    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toContainEqual({
        editComment: false,
        editId: 'highlight-1',
        mode: 9,
      });
    });
    expect(contextmenu.defaultPrevented).toBe(true);
    expect(viewer.annotationEditorRequests).toHaveLength(1);
  });

  it('returns to NONE before a dismissing pointer gesture can create another annotation', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'highlight-1', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager({ editorType: 'highlight', mode: 9, uid: 'highlight-1' }),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotation = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotation.dataset['annotationId'] = 'highlight-1';
    annotation.click();
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toHaveLength(1);
    });

    const textLayer = page.createDiv({ cls: 'textLayer' });
    const nativeCreatorGesture = vi.fn();
    textLayer.addEventListener('pointerdown', nativeCreatorGesture);
    const dismiss = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    textLayer.dispatchEvent(dismiss);
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests[viewer.annotationEditorRequests.length - 1]).toEqual({
        mode: 0,
      });
    });

    expect(dismiss.defaultPrevented).toBe(true);
    expect(nativeCreatorGesture).not.toHaveBeenCalled();
  });

  it.each([
    {
      annotationClassName: 'highlightAnnotation',
      annotationType: 9,
      className: 'highlightEditor',
      editorType: 'highlight',
      mode: 9,
      pointerType: 'mouse',
    },
    {
      annotationClassName: 'highlightAnnotation',
      annotationType: 9,
      className: 'highlightEditor',
      editorType: 'highlight',
      mode: 9,
      pointerType: 'touch',
    },
    {
      annotationClassName: 'inkAnnotation',
      annotationType: 15,
      className: 'inkEditor',
      editorType: 'ink',
      mode: 15,
      pointerType: 'mouse',
    },
    {
      annotationClassName: 'inkAnnotation',
      annotationType: 15,
      className: 'inkEditor',
      editorType: 'ink',
      mode: 15,
      pointerType: 'touch',
    },
    {
      annotationClassName: 'freeTextAnnotation',
      annotationType: 3,
      className: 'freeTextEditor',
      editorType: 'freetext',
      mode: 3,
      pointerType: 'mouse',
    },
    {
      annotationClassName: 'freeTextAnnotation',
      annotationType: 3,
      className: 'freeTextEditor',
      editorType: 'freetext',
      mode: 3,
      pointerType: 'touch',
    },
  ] as const)(
    'switches from annotation A to restored native $editorType editor B after one completed pointer gesture ($pointerType)',
    async ({ annotationClassName, annotationType, className, editorType, mode, pointerType }) => {
      const fixture = await mountedContextualSwitchFixture({
        annotationClassName,
        annotationType,
        className,
        editorType,
        mode,
      });
      const switchDown = new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: 42,
        clientY: 24,
        pointerId: 7,
        pointerType,
      });
      fixture.editorB.dispatchEvent(switchDown);
      expect(fixture.viewer.annotationEditorRequests).toHaveLength(1);
      const switchUp = new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: 42,
        clientY: 24,
        pointerId: 7,
        pointerType,
      });
      fixture.editorB.dispatchEvent(switchUp);
      const restoredAnnotation = fixture.page.querySelector<HTMLElement>(
        `[data-annotation-id="annotation-b-${editorType}"]`,
      );
      if (restoredAnnotation === null)
        throw new Error('Expected NONE to restore the imported annotation element.');
      const retargetedClick = new PointerEvent('click', {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: 42,
        clientY: 24,
        pointerId: 7,
        pointerType,
      });
      restoredAnnotation.dispatchEvent(retargetedClick);
      await vi.waitFor(() => {
        expect(fixture.viewer.annotationEditorRequests).toEqual([
          { editComment: false, editId: 'annotation-a', mode: 9 },
          { mode: 0 },
          { editComment: false, editId: `annotation-b-${editorType}`, mode },
        ]);
      });

      expect(switchDown.defaultPrevented).toBe(true);
      expect(switchUp.defaultPrevented).toBe(true);
      expect(retargetedClick.defaultPrevented).toBe(true);
      expect(fixture.root.contains(fixture.editorB)).toBe(false);
      expect(fixture.nativeCreatorGesture).not.toHaveBeenCalled();
      expect(fixture.retargetedNativeAction).not.toHaveBeenCalled();
    },
  );

  it.each(['mouse', 'touch'] as const)(
    'does not switch contextual annotations after a $pointerType drag beyond the threshold',
    async (pointerType) => {
      const fixture = await mountedContextualSwitchFixture({
        annotationClassName: 'highlightAnnotation',
        annotationType: 9,
        className: 'highlightEditor',
        editorType: 'highlight',
        mode: 9,
      });
      fixture.editorB.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 42,
          clientY: 24,
          pointerId: 7,
          pointerType,
        }),
      );
      fixture.root.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 64,
          clientY: 24,
          pointerId: 7,
          pointerType,
        }),
      );
      fixture.root.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 64,
          clientY: 24,
          pointerId: 7,
          pointerType,
        }),
      );
      await Promise.resolve();

      expect(fixture.viewer.annotationEditorRequests).toEqual([
        { editComment: false, editId: 'annotation-a', mode: 9 },
      ]);
      expect(fixture.root.contains(fixture.editorB)).toBe(true);
    },
  );

  it.each(['mouse', 'touch'] as const)(
    'does not switch contextual annotations after a $pointerType pointercancel',
    async (pointerType) => {
      const fixture = await mountedContextualSwitchFixture({
        annotationClassName: 'highlightAnnotation',
        annotationType: 9,
        className: 'highlightEditor',
        editorType: 'highlight',
        mode: 9,
      });
      fixture.editorB.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 42,
          clientY: 24,
          pointerId: 7,
          pointerType,
        }),
      );
      fixture.root.dispatchEvent(
        new PointerEvent('pointercancel', {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 42,
          clientY: 24,
          pointerId: 7,
          pointerType,
        }),
      );
      await Promise.resolve();

      expect(fixture.viewer.annotationEditorRequests).toEqual([
        { editComment: false, editId: 'annotation-a', mode: 9 },
      ]);
      expect(fixture.root.contains(fixture.editorB)).toBe(true);
    },
  );

  it.each(['mouse', 'touch'] as const)(
    'suppresses the retargeted click after a $pointerType long press completes',
    async (pointerType) => {
      const fixture = await mountedContextualSwitchFixture({
        annotationClassName: 'highlightAnnotation',
        annotationType: 9,
        className: 'highlightEditor',
        editorType: 'highlight',
        mode: 9,
      });
      vi.useFakeTimers();
      try {
        fixture.editorB.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            cancelable: true,
            clientX: 42,
            clientY: 24,
            pointerId: 7,
            pointerType,
          }),
        );
        await vi.advanceTimersByTimeAsync(751);
        fixture.root.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            cancelable: true,
            clientX: 42,
            clientY: 24,
            pointerId: 7,
            pointerType,
          }),
        );
        await vi.waitFor(() => {
          expect(fixture.viewer.annotationEditorRequests).toHaveLength(3);
        });
        const restoredAnnotation = fixture.page.querySelector<HTMLElement>(
          '[data-annotation-id="annotation-b-highlight"]',
        );
        if (restoredAnnotation === null) throw new Error('Expected restored annotation B.');
        const retargetedClick = new PointerEvent('click', {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 42,
          clientY: 24,
          pointerId: 7,
          pointerType,
        });
        restoredAnnotation.dispatchEvent(retargetedClick);

        expect(retargetedClick.defaultPrevented).toBe(true);
        expect(fixture.retargetedNativeAction).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('does not consume an unrelated click while switching contextual annotations', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'annotation-a', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    const selectedA = { editorType: 'highlight', mode: 9, uid: 'annotation-a' };
    const selectedB = { editorType: 'highlight', mode: 9, uid: 'annotation-b' };
    const uiManager = annotationManager(selectedA, [['internal-b', selectedB]]);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotationA = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotationA.dataset['annotationId'] = 'annotation-a';
    annotationA.click();
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toHaveLength(1);
    });

    const editorB = page
      .createDiv({ cls: 'annotationEditorLayer' })
      .createDiv({ cls: 'highlightEditor' });
    editorB.id = 'internal-b';
    editorB.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: 42,
        clientY: 24,
        pointerId: 7,
        pointerType: 'mouse',
      }),
    );
    root.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: 42,
        clientY: 24,
        pointerId: 7,
        pointerType: 'mouse',
      }),
    );
    const unrelated = page.createEl('button', { text: 'Unrelated action' });
    const unrelatedAction = vi.fn();
    unrelated.addEventListener('click', unrelatedAction);
    const unrelatedClick = new PointerEvent('click', {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 180,
      clientY: 96,
      pointerId: 8,
      pointerType: 'mouse',
    });
    unrelated.dispatchEvent(unrelatedClick);
    await Promise.resolve();

    expect(unrelatedClick.defaultPrevented).toBe(false);
    expect(unrelatedAction).toHaveBeenCalledOnce();
  });

  it('does not consume a matching click after the contextual switch lifecycle is invalidated', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'annotation-a', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    const selectedA = { editorType: 'highlight', mode: 9, uid: 'annotation-a' };
    const selectedB = { editorType: 'highlight', mode: 9, uid: 'annotation-b' };
    const uiManager = annotationManager(selectedA, [['internal-b', selectedB]]);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotationA = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotationA.dataset['annotationId'] = 'annotation-a';
    annotationA.click();
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toHaveLength(1);
    });

    const editorB = page
      .createDiv({ cls: 'annotationEditorLayer' })
      .createDiv({ cls: 'highlightEditor' });
    editorB.id = 'internal-b';
    editorB.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientX: 42,
        clientY: 24,
        pointerId: 7,
        pointerType: 'mouse',
      }),
    );
    eventBus.dispatch('pagechanging', { source: viewer, pageNumber: 2, previous: 1 });
    const stalePointerUp = new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 42,
      clientY: 24,
      pointerId: 7,
      pointerType: 'mouse',
    });
    root.dispatchEvent(stalePointerUp);
    const unrelated = page.createEl('button', { text: 'New lifecycle action' });
    const unrelatedAction = vi.fn();
    unrelated.addEventListener('click', unrelatedAction);
    const matchingClick = new PointerEvent('click', {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: 42,
      clientY: 24,
      pointerId: 7,
      pointerType: 'mouse',
    });
    unrelated.dispatchEvent(matchingClick);

    expect(stalePointerUp.defaultPrevented).toBe(false);
    expect(matchingClick.defaultPrevented).toBe(false);
    expect(unrelatedAction).toHaveBeenCalledOnce();
    expect(viewer.annotationEditorRequests).toHaveLength(1);
  });

  it('keeps non-primary pointer gestures passive while a contextual annotation is open', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'annotation-a', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    const selectedA = { editorType: 'highlight', mode: 9, uid: 'annotation-a' };
    const selectedB = { editorType: 'highlight', mode: 9, uid: 'annotation-b' };
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager(selectedA, [['internal-b', selectedB]]),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotationA = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotationA.dataset['annotationId'] = 'annotation-a';
    annotationA.click();
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toHaveLength(1);
    });

    const editorB = page
      .createDiv({ cls: 'annotationEditorLayer' })
      .createDiv({ cls: 'highlightEditor' });
    editorB.id = 'internal-b';
    const nativeContextGesture = vi.fn();
    editorB.addEventListener('pointerdown', nativeContextGesture);
    const secondaryPointer = new PointerEvent('pointerdown', {
      bubbles: true,
      button: 2,
      cancelable: true,
      pointerId: 7,
      pointerType: 'mouse',
    });
    editorB.dispatchEvent(secondaryPointer);

    expect(secondaryPointer.defaultPrevented).toBe(false);
    expect(nativeContextGesture).toHaveBeenCalledOnce();
    expect(viewer.annotationEditorRequests).toHaveLength(1);
  });

  it.each([
    ['locked', 'highlightAnnotation', { annotationType: 9, isEditable: false }],
    ['unsupported', 'underlineAnnotation', { annotationType: 10, isEditable: true }],
  ] as const)(
    'closes annotation A but keeps a %s annotation B passive',
    async (_case, className, annotationB) => {
      const fixture = await mountedViewport(3, {
        annotations: [
          { annotationType: 9, id: 'annotation-a', isEditable: true },
          { ...annotationB, id: 'annotation-b' },
        ],
      });
      const eventBus = fixture.runtime.state.eventBus;
      const viewer = fixture.runtime.state.viewer;
      if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
      const uiManager = annotationManager({
        editorType: 'highlight',
        mode: 9,
        uid: 'annotation-a',
      });
      eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
      const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
      if (root === null) throw new Error('Expected PDF root.');
      const page = root.createDiv();
      page.dataset['pageNumber'] = '1';
      const layer = page.createDiv({ cls: 'annotationLayer' });
      const annotationA = layer.createEl('section', { cls: 'highlightAnnotation' });
      annotationA.dataset['annotationId'] = 'annotation-a';
      const annotationBElement = layer.createEl('section', { cls: className });
      annotationBElement.dataset['annotationId'] = 'annotation-b';
      annotationA.click();
      await vi.waitFor(() => {
        expect(viewer.annotationEditorRequests).toHaveLength(1);
      });

      annotationBElement.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          cancelable: true,
          pointerId: 7,
          pointerType: 'mouse',
        }),
      );
      annotationBElement.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          cancelable: true,
          pointerId: 7,
          pointerType: 'mouse',
        }),
      );
      annotationBElement.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(viewer.annotationEditorRequests).toEqual([
        { editComment: false, editId: 'annotation-a', mode: 9 },
        { mode: 0 },
      ]);
    },
  );

  it('ignores links and unsupported annotations', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'highlight-1', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager(),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const layer = page.createDiv({ cls: 'annotationLayer' });
    const highlight = layer.createEl('section', { cls: 'highlightAnnotation' });
    highlight.dataset['annotationId'] = 'highlight-1';
    highlight.createEl('a', { text: 'Linked text' }).click();
    highlight.createEl('button', { text: 'Comment' }).click();
    for (const className of ['underlineAnnotation', 'textAnnotation', 'stampAnnotation']) {
      const annotation = layer.createEl('section', { cls: className });
      annotation.dataset['annotationId'] = className;
      const contextmenu = new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
      });
      annotation.dispatchEvent(contextmenu);
      expect(contextmenu.defaultPrevented).toBe(false);
      annotation.click();
    }
    await Promise.resolve();

    expect(viewer.annotationEditorRequests).toEqual([]);
  });

  it('keeps locked class-only annotations passive', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 9, id: 'locked-highlight', isEditable: false }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager(),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotation = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotation.dataset['annotationId'] = 'locked-highlight';

    const contextmenu = new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    annotation.dispatchEvent(contextmenu);
    annotation.click();
    await Promise.resolve();

    expect(contextmenu.defaultPrevented).toBe(false);
    expect(viewer.annotationEditorRequests).toEqual([]);
  });

  it('maps InkHighlight subtype to Highlight editor', async () => {
    const fixture = await mountedViewport(3, {
      annotations: [
        {
          annotationType: 15,
          id: 'ink-highlight-1',
          isEditable: true,
          it: 'InkHighlight',
        },
      ],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager({
        editorType: 'highlight',
        mode: 9,
        uid: 'ink-highlight-1',
      }),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotation = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'inkAnnotation' });
    annotation.dataset['annotationId'] = 'ink-highlight-1';

    annotation.click();
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toContainEqual({
        editComment: false,
        editId: 'ink-highlight-1',
        mode: 9,
      });
    });
  });

  it.each(['Enter', ' '] as const)('opens a focused editable annotation with %s', async (key) => {
    const fixture = await mountedViewport(3, {
      annotations: [{ annotationType: 3, id: 'freetext-1', isEditable: true }],
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager({ editorType: 'freetext', mode: 3, uid: 'freetext-1' }),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotation = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'freeTextAnnotation' });
    annotation.dataset['annotationId'] = 'freetext-1';
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });

    annotation.dispatchEvent(event);
    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toContainEqual({
        editComment: false,
        editId: 'freetext-1',
        mode: 3,
      });
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['navigation', 'pointer', 'layout', 'session', 'rebind'] as const)(
    'invalidates deferred annotation qualification after a subsequent %s gesture',
    async (invalidation) => {
      const fixture = await mountedViewport(3);
      const pendingAnnotations = deferred<readonly TestPdfAnnotation[]>();
      const getPage = vi.spyOn(fixture.documentProxy, 'getPage').mockResolvedValue({
        getAnnotations: vi.fn(() => pendingAnnotations.promise),
      } as never);
      const eventBus = fixture.runtime.state.eventBus;
      const viewer = fixture.runtime.state.viewer;
      if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
      eventBus.dispatch('annotationeditoruimanager', {
        source: viewer,
        uiManager: annotationManager({ editorType: 'highlight', mode: 9, uid: 'deferred-1' }),
      });
      const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
      if (root === null) throw new Error('Expected PDF root.');
      const page = root.createDiv();
      page.dataset['pageNumber'] = '1';
      const annotation = page
        .createDiv({ cls: 'annotationLayer' })
        .createEl('section', { cls: 'highlightAnnotation' });
      annotation.dataset['annotationId'] = 'deferred-1';
      annotation.click();
      await vi.waitFor(() => {
        expect(getPage).toHaveBeenCalledWith(1);
      });

      if (invalidation === 'navigation') await fixture.viewport.goTo({ pageIndex: 1 });
      else if (invalidation === 'pointer') {
        root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      } else if (invalidation === 'layout') {
        fixture.viewport.setLayout({ pages: 'facing', scrolling: 'continuous' });
      } else if (invalidation === 'session') eventBus.dispatch('pagesinit', { source: viewer });
      else {
        eventBus.dispatch('annotationeditoruimanager', {
          source: viewer,
          uiManager: annotationManager({ editorType: 'highlight', mode: 9, uid: 'deferred-1' }),
        });
      }
      pendingAnnotations.resolve([{ annotationType: 9, id: 'deferred-1', isEditable: true }]);
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(root.contains(annotation)).toBe(true);
      expect(viewer.annotationEditorRequests).toEqual([]);
    },
  );

  it('evicts a rejected annotation metadata lookup so a second click can succeed', async () => {
    const fixture = await mountedViewport(3);
    const cause = new Error('transient annotation metadata failure');
    const getPage = vi
      .spyOn(fixture.documentProxy, 'getPage')
      .mockResolvedValueOnce({
        getAnnotations: vi.fn(async () => Promise.reject(cause)),
      } as never)
      .mockResolvedValue({
        getAnnotations: vi.fn(async () => [
          { annotationType: 9, id: 'retry-highlight', isEditable: true },
        ]),
      } as never);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager({ editorType: 'highlight', mode: 9, uid: 'retry-highlight' }),
    });
    const root = fixture.host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (root === null) throw new Error('Expected PDF root.');
    const page = root.createDiv();
    page.dataset['pageNumber'] = '1';
    const annotation = page
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotation.dataset['annotationId'] = 'retry-highlight';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    annotation.click();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        '[abyss-documents] Failed to open the PDF annotation editor',
        expect.objectContaining({ cause, id: 'retry-highlight', pageNumber: 1 }),
      );
    });
    annotation.click();

    await vi.waitFor(() => {
      expect(viewer.annotationEditorRequests).toContainEqual({
        editComment: false,
        editId: 'retry-highlight',
        mode: 9,
      });
    });
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('dismisses stale tokens without a failure Notice', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) {
      throw new Error('Expected a mounted PDF annotation runtime.');
    }
    const uiManager = annotationManager();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));
    const interaction = (
      fixture.viewport as PdfDocumentViewport & {
        readonly annotationInteraction: {
          commitSelection(
            token: string,
            action: { readonly kind: 'highlight'; readonly color: string },
          ): Promise<'created' | 'dismissed'>;
        } | null;
      }
    ).annotationInteraction;
    if (interaction === null) throw new Error('Expected writable PDF annotation interaction.');

    await expect(
      interaction.commitSelection('stale-token', { kind: 'highlight', color: '#ffd400' }),
    ).resolves.toBe('dismissed');

    expect(uiManager.updateParams).not.toHaveBeenCalled();
    expect(uiManager.highlightSelection).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'annotation-mutation-error')).toEqual([]);
  });

  it('aborts a one-shot annotation interaction before navigation', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const interaction = fixture.viewport.annotationInteraction;
    if (eventBus === undefined || viewer === undefined || interaction === null) {
      throw new Error('Expected a mounted PDF annotation runtime.');
    }
    const uiManager = annotationManager();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    vi.spyOn(fixture.viewport.selectionObserver, 'validate').mockReturnValue('current');
    let outcome: unknown = 'pending';
    void interaction
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => {
        outcome = cause;
      });
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });

    await fixture.viewport.goTo({ pageIndex: 1 });

    await vi.waitFor(() => {
      expect(outcome).not.toBe('pending');
    });
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(viewer.annotationEditorMode).toBe(0);
  });

  it('does not navigate before source-confirmed native NONE', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const interaction = fixture.viewport.annotationInteraction;
    if (eventBus === undefined || viewer === undefined || interaction === null) {
      throw new Error('Expected a mounted PDF annotation runtime.');
    }
    const uiManager = annotationManager();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    vi.spyOn(fixture.viewport.selectionObserver, 'validate').mockReturnValue('current');
    const committing = interaction
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => cause);
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    let currentMode = viewer.annotationEditorMode;
    Object.defineProperty(viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => currentMode,
      set: (request: number | { readonly mode: number }) => {
        currentMode = typeof request === 'number' ? request : request.mode;
      },
    });
    const invalidate = vi.spyOn(fixture.viewport.selectionObserver, 'invalidate');
    let navigated = false;

    const navigating = fixture.viewport.goTo({ pageIndex: 1 }).finally(() => {
      navigated = true;
    });
    await Promise.resolve();

    expect(currentMode).toBe(0);
    expect(navigated).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    eventBus.dispatch('annotationeditormodechanged', { source: {}, mode: 0 });
    await Promise.resolve();
    expect(navigated).toBe(false);

    eventBus.dispatch('annotationeditormodechanged', { source: viewer, mode: 0 });

    await navigating;
    await expect(committing).resolves.toMatchObject({ name: 'AbortError' });
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('stops navigation when neutral mode restoration fails', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const interaction = fixture.viewport.annotationInteraction;
    if (eventBus === undefined || viewer === undefined || interaction === null) {
      throw new Error('Expected a mounted PDF annotation runtime.');
    }
    const uiManager = annotationManager();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    vi.spyOn(fixture.viewport.selectionObserver, 'validate').mockReturnValue('current');
    const committing = interaction
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => cause);
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    const failure = new Error('neutral mode setter failed before navigation');
    Object.defineProperty(viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => 9,
      set: () => {
        throw failure;
      },
    });
    const invalidate = vi.spyOn(fixture.viewport.selectionObserver, 'invalidate');

    await expect(fixture.viewport.goTo({ pageIndex: 1 })).rejects.toBe(failure);
    await expect(committing).resolves.toBe(failure);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates on rerender zoom layout navigation save and session change', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    if (eventBus === undefined) throw new Error('Expected a fake event bus.');
    const observer = (
      fixture.viewport as unknown as { readonly selectionObserver: { invalidate(): void } }
    ).selectionObserver;
    const invalidate = vi.spyOn(observer, 'invalidate');

    eventBus.dispatch('pagerendered', { pageNumber: 1 });
    eventBus.dispatch('textlayerrendered', { pageNumber: 1 });
    fixture.viewport.setScale(1.5);
    fixture.viewport.setLayout({ pages: 'facing', scrolling: 'page-by-page' });
    await fixture.viewport.goTo({ pageIndex: 1 });
    observer.invalidate(); // save
    observer.invalidate(); // session change

    expect(invalidate).toHaveBeenCalledTimes(7);
  });

  it('does not expose an annotation editor for a read-only qualified document', async () => {
    const documentProxy = pdf(3);
    const runtime = viewerRuntime();
    const viewport = new PdfDocumentViewport(
      documentProxy,
      runtime.module,
      new PdfTextSearch(documentProxy),
      {
        annotationCapabilities: {
          editing: {} as never,
          readOnlyReason: {
            code: 'signed-document',
            message: 'Signed PDF documents are opened read-only to preserve signatures.',
          },
          types: {} as never,
        },
        sourcePath: 'Books/Signed.pdf',
      },
    );
    const host = createDiv();
    host.setCssProps({ '--background-primary': '#fafafa', '--text-normal': '#202020' });

    await viewport.mount(host);

    expect(viewport.annotationEditor).toBeNull();
    expect(viewport.annotationCapabilities.readOnlyReason?.code).toBe('signed-document');
    const viewer = runtime.state.viewer;
    const root = host.querySelector<HTMLElement>('.pdfViewerContainer');
    if (viewer === undefined || root === null)
      throw new Error('Expected mounted read-only viewer.');
    const annotation = root
      .createDiv({ cls: 'annotationLayer' })
      .createEl('section', { cls: 'highlightAnnotation' });
    annotation.dataset['annotationId'] = 'signed-highlight';
    annotation.click();
    await Promise.resolve();
    expect(viewer.annotationEditorRequests).toEqual([]);

    await viewport.destroy();
    host.remove();
  });

  it('constructs the public PDF.js viewer stack with text, annotations, and bounded canvases', async () => {
    beginPluginActivation();
    endPluginActivation();
    const fixture = await mountedViewport();
    const viewer = fixture.runtime.state.viewer;
    if (viewer === undefined) throw new Error('Expected a fake viewer.');

    expect(viewer.options).toMatchObject({
      textLayerMode: 1,
      annotationMode: 2,
      annotationEditorMode: 0,
      annotationEditorHighlightColors:
        'yellow=#ffd400,red=#ff6666,green=#5fb236,blue=#2ea8e5,purple=#a28ae5,magenta=#e56eee,orange=#f19837,gray=#aaaaaa',
      enablePermissions: true,
      supportsPinchToZoom: true,
      maxCanvasPixels: 16_777_216,
      pageColors: { background: '#fafafa', foreground: '#202020' },
    });
    const commentManager = viewer.options.commentManager;
    expect(commentManager).toBeTypeOf('object');
    expect((commentManager as { dialogElement?: unknown }).dialogElement).toBeInstanceOf(
      HTMLElement,
    );
    expect((commentManager as { showDialog?: unknown }).showDialog).toBeTypeOf('function');
    expect(fixture.runtime.state.linkService?.viewer).toBe(viewer);
    expect(viewer.documents).toEqual([fixture.documentProxy]);
    expect(viewer.findDocumentsBeforeViewerOwnership).toEqual([[]]);
    expect(fixture.host.querySelectorAll('.page')).toHaveLength(3);
    expect(
      fixture.host.querySelector('.pdfViewerContainer')?.getAttribute('data-pinch-capable'),
    ).toBe('true');
    fixture.runtime.state.eventBus?.dispatch('textlayerrendered', { pageNumber: 1 });
    fixture.runtime.state.eventBus?.dispatch('pagerendered', { pageNumber: 1 });
    fixture.runtime.state.eventBus?.dispatch('textlayerrendered', { pageNumber: 2 });
    fixture.runtime.state.eventBus?.dispatch('pagerendered', { pageNumber: 2 });
    const annotationImage = createEl('img');
    annotationImage.src = 'annotation-comment.svg';
    fixture.host.querySelector<HTMLElement>('.page[data-page-number="1"]')?.append(annotationImage);
    fixture.runtime.state.eventBus?.dispatch('annotationlayerrendered', { pageNumber: 1 });
    expect(annotationImage.src).toBe('data:image/svg+xml;base64,Y29tbWVudA==');
    const marks = readerPerformanceSnapshot().marks.map(({ name }) => name);
    expect(marks).toEqual(expect.arrayContaining(['first-text-layer', 'first-usable-page']));
    expect(marks.filter((name) => name === 'text-layer')).toHaveLength(2);
    expect(marks.filter((name) => name === 'usable-page')).toHaveLength(2);
  });

  it('routes successful native comment mutation to dirty autosave and failures to a viewport event', async () => {
    const fixture = await mountedViewport(3);
    const viewer = fixture.runtime.state.viewer;
    const eventBus = fixture.runtime.state.eventBus;
    const annotationEditor = fixture.viewport.annotationEditor;
    if (viewer === undefined || eventBus === undefined || annotationEditor === null)
      throw new Error('Expected mounted native annotation runtime.');
    const dirty = vi.fn();
    annotationEditor.onDirty(dirty);
    const native = {
      comment: 'Original',
      editorType: 'highlight',
      getData: () => ({ color: [255, 212, 0], contentsObj: { str: 'Original' } }),
      mode: 9,
      propertiesToUpdate: [],
      select: vi.fn(),
      uid: 'native-highlight',
    };
    const uiManager = {
      ...annotationManager(),
      deleteComment: vi.fn(),
      firstSelectedEditor: native,
      setSelected: vi.fn(),
    };
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    const commentManager = viewer.options.commentManager as {
      showDialog(manager: unknown, editor: typeof native, x: number, y: number): Promise<void>;
    };

    await commentManager.showDialog(uiManager, native, 0, 0);
    const input = fixture.host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected native comment input.');
    input.value = 'Updated';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(dirty).toHaveBeenCalledWith(true);

    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));
    Object.defineProperty(native, 'comment', {
      configurable: true,
      get: () => 'Original',
      set: () => {
        throw new Error('comment setter rejected');
      },
    });
    await commentManager.showDialog(uiManager, native, 0, 0);
    const failingInput = fixture.host.querySelector<HTMLTextAreaElement>('textarea');
    if (failingInput === null) throw new Error('Expected native comment input.');
    failingInput.value = 'Rejected';
    failingInput.dispatchEvent(new Event('input', { bubbles: true }));

    const failure = events.find((event) => event.type === 'annotation-mutation-error');
    expect(failure?.type).toBe('annotation-mutation-error');
    if (failure?.type !== 'annotation-mutation-error')
      throw new Error('Expected native annotation mutation failure.');
    expect(failure.action).toBe('save-comment');
    expect(failure.cause).toMatchObject({ message: 'comment setter rejected' });
    expect(dirty).toHaveBeenCalledTimes(1);
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
    eventBus.dispatch('scalechanging', { scale: 0.9, presetValue: 'page-height' });

    expect(events).toEqual([
      { type: 'page-change', pageIndex: 1 },
      { type: 'scale-change', scale: 1.5 },
      { type: 'scale-change', scale: 'page-width' },
      { type: 'scale-change', scale: 'page-height' },
    ]);
  });

  it('delegates navigation and focus while applying the latest initial scale', async () => {
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

    expect(linkService.pages).toEqual([]);
    expect(linkService.positions).toEqual([[1, 0, 24]]);
    expect(viewer.currentScale).toBe(1);
    expect(viewer.currentScaleValue).toBe('page-fit');
    expect(viewer.focus).toHaveBeenCalledOnce();
  });

  it('maps every pages and scrolling combination through public PDF.js setters', async () => {
    const fixture = await mountedViewport(8);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('pagesinit', {});
    viewer.currentPageNumber = 4;

    const cases = [
      [{ pages: 'single', scrolling: 'continuous' }, 0, 0],
      [{ pages: 'facing', scrolling: 'continuous' }, 1, 0],
      [{ pages: 'single', scrolling: 'page-by-page' }, 0, 3],
      [{ pages: 'facing', scrolling: 'page-by-page' }, 1, 3],
    ] as const;
    for (const [layout, spreadMode, scrollMode] of cases) {
      fixture.viewport.setLayout(layout);
      expect(viewer.spreadMode).toBe(spreadMode);
      expect(viewer.scrollMode).toBe(scrollMode);
      expect(viewer.currentPageNumber).toBe(4);
    }
  });

  it('coalesces pre-pagesinit location, scale, and layout so the latest requests win', async () => {
    const fixture = await mountedViewport(8);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const linkService = fixture.runtime.state.linkService;
    if (eventBus === undefined || viewer === undefined || linkService === undefined) {
      throw new Error('Expected viewer state.');
    }

    await fixture.viewport.goTo({ pageIndex: 2 });
    await fixture.viewport.goTo({ pageIndex: 5 });
    fixture.viewport.setScale(1.25);
    fixture.viewport.setScale(1.75);
    fixture.viewport.setLayout({ pages: 'single', scrolling: 'continuous' });
    fixture.viewport.setLayout({ pages: 'facing', scrolling: 'page-by-page' });

    expect(linkService.pages).toEqual([]);
    eventBus.dispatch('pagesinit', {});

    expect(linkService.pages).toEqual([6]);
    expect(viewer.currentScale).toBe(1.75);
    expect(viewer.spreadMode).toBe(1);
    expect(viewer.scrollMode).toBe(3);
  });

  it('computes Fit height numerically from the current public page viewport and rotation', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    const getViewport = vi.fn(({ scale, rotation }: { scale: number; rotation: number }) => ({
      width: (rotation % 180 === 0 ? 600 : 800) * scale,
      height: (rotation % 180 === 0 ? 800 : 600) * scale,
    }));
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the Vitest mock is inspected, never invoked detached
    const getPage = vi.mocked(fixture.documentProxy.getPage);
    getPage.mockResolvedValue({
      rotate: 90,
      getViewport,
    } as unknown as Awaited<ReturnType<PDFDocumentProxy['getPage']>>);
    Object.defineProperty(viewer.options.container, 'clientHeight', {
      configurable: true,
      value: 1_005,
    });
    viewer.currentPageNumber = 2;
    viewer.pagesRotation = 90;
    eventBus.dispatch('pagesinit', {});

    fixture.viewport.setScale('page-height');

    await vi.waitFor(() => {
      expect(viewer.currentScale).toBeCloseTo(0.9375, 5);
    });
    expect(getPage).toHaveBeenLastCalledWith(2);
    expect(getViewport).toHaveBeenLastCalledWith({ scale: 4 / 3, rotation: 180 });
  });

  it('keeps a deferred Fit-height request through synchronous layout scale events', async () => {
    const fixture = await mountedViewport(3, {
      layoutScaleChange: { scale: 0.75, presetValue: 'page-width' },
    });
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    const page = deferred<Awaited<ReturnType<PDFDocumentProxy['getPage']>>>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the Vitest mock is configured, never invoked detached
    vi.mocked(fixture.documentProxy.getPage).mockReturnValue(page.promise);
    Object.defineProperty(viewer.options.container, 'clientHeight', {
      configurable: true,
      value: 1_005,
    });
    eventBus.dispatch('pagesinit', {});

    fixture.viewport.setScale('page-height');
    fixture.viewport.setLayout({ pages: 'facing', scrolling: 'page-by-page' });
    page.resolve({
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 800, height: 800 })),
    } as unknown as Awaited<ReturnType<PDFDocumentProxy['getPage']>>);

    await vi.waitFor(() => {
      expect(viewer.currentScale).toBeCloseTo(1.25, 5);
    });
  });

  it('steps fit and numeric scales with PDF.js rounding and clamps at public bounds', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('pagesinit', {});

    viewer.currentScale = 1;
    fixture.viewport.stepScale(1);
    expect(viewer.currentScale).toBeCloseTo(1.1, 5);
    fixture.viewport.stepScale(-1);
    expect(viewer.currentScale).toBe(1);

    fixture.viewport.setScale(25);
    fixture.viewport.stepScale(1);
    expect(viewer.currentScale).toBe(25);
    fixture.viewport.setScale(0.1);
    fixture.viewport.stepScale(-1);
    expect(viewer.currentScale).toBeCloseTo(0.1, 5);
  });

  it('recomputes fit presets when the document host resizes and disconnects on destroy', async () => {
    let resize: (() => void) | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    let scheduledFrame: FrameRequestCallback | undefined;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        scheduledFrame = callback;
        return 17;
      });
    const cancelFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = () => {
          callback([], this as unknown as ResizeObserver);
        };
      }

      readonly observe = observe;
      readonly disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      const fixture = await mountedViewport(4);
      const eventBus = fixture.runtime.state.eventBus;
      const viewer = fixture.runtime.state.viewer;
      if (eventBus === undefined || viewer === undefined || resize === undefined) {
        throw new Error('Expected viewer components and a resize observer.');
      }
      let currentScaleValue = 'page-width';
      const assignScale = vi.fn((value: string) => {
        currentScaleValue = value;
      });
      Object.defineProperty(viewer, 'currentScaleValue', {
        configurable: true,
        get: () => currentScaleValue,
        set: assignScale,
      });
      eventBus.dispatch('pagesinit', {});
      assignScale.mockClear();

      resize();
      resize();

      expect(observe).toHaveBeenCalledWith(viewer.options.container);
      expect(requestFrame).toHaveBeenCalledOnce();
      expect(assignScale).not.toHaveBeenCalled();
      scheduledFrame?.(0);
      expect(assignScale).toHaveBeenCalledWith('page-width');
      currentScaleValue = 'page-fit';
      assignScale.mockClear();
      resize();
      scheduledFrame?.(1);
      expect(assignScale).toHaveBeenCalledWith('page-fit');
      resize();
      await fixture.viewport.destroy();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(cancelFrame).toHaveBeenCalledWith(17);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
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

  it('keeps authored PDF page colors when the Default profile supplies null pageColors', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined)
      throw new Error('Expected viewer components.');
    eventBus.dispatch('pagesinit', {});

    fixture.viewport.setReadingColors({
      pageColors: null,
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    });

    expect(viewer.pageColors).toBeNull();
    expect(viewer.documents).toEqual([fixture.documentProxy, null, fixture.documentProxy]);
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

  it('keeps every annotation operation unavailable until a new manager replaces the retired one', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const editor = fixture.viewport.annotationEditor;
    if (eventBus === undefined || viewer === undefined || editor === null) {
      throw new Error('Expected writable annotation viewer state.');
    }
    const retiredManager = annotationManager();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: retiredManager });
    eventBus.dispatch('pagesinit', {});

    fixture.viewport.setReadingColors({
      pageColors: null,
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    });

    await expect(editor.setTool('ink')).rejects.toThrow('not ready');
    expect(() => {
      editor.setParameter('ink-thickness', 3).catch(() => undefined);
    }).toThrow('not ready');
    expect(() => {
      editor.undo().catch(() => undefined);
    }).toThrow('not ready');
    await expect(editor.save(new AbortController().signal)).rejects.toThrow('not ready');
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: retiredManager });
    expect(() => {
      editor.redo().catch(() => undefined);
    }).toThrow('not ready');

    const replacementManager = annotationManager();
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: replacementManager,
    });
    await editor.setParameter('ink-thickness', 5);

    expect(replacementManager.updateParams).toHaveBeenCalledWith(22, 5);
  });

  it('does not accept a replacement manager after destroy wins a profile rebind', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const editor = fixture.viewport.annotationEditor;
    if (eventBus === undefined || viewer === undefined || editor === null) {
      throw new Error('Expected writable annotation viewer state.');
    }
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager(),
    });
    eventBus.dispatch('pagesinit', {});
    fixture.viewport.setReadingColors({
      pageColors: null,
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    });

    await fixture.viewport.destroy();
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: annotationManager(),
    });

    await expect(editor.setTool('highlight')).rejects.toThrow('destroyed');
    await expect(editor.save(new AbortController().signal)).rejects.toThrow('destroyed');
  });

  it.each(['detach', 'reattach'] as const)(
    'recovers manager lifecycle when profile %s throws without reviving the retired manager',
    async (failurePoint) => {
      const fixture = await mountedViewport(3);
      const eventBus = fixture.runtime.state.eventBus;
      const viewer = fixture.runtime.state.viewer;
      const editor = fixture.viewport.annotationEditor;
      if (eventBus === undefined || viewer === undefined || editor === null) {
        throw new Error('Expected writable annotation viewer state.');
      }
      const retiredManager = annotationManager();
      eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: retiredManager });
      eventBus.dispatch('pagesinit', {});
      const originalSetDocument = viewer.setDocument.bind(viewer);
      let calls = 0;
      vi.spyOn(viewer, 'setDocument').mockImplementation((document) => {
        calls += 1;
        if (
          (failurePoint === 'detach' && calls === 1) ||
          (failurePoint === 'reattach' && calls === 2)
        ) {
          throw new Error(`${failurePoint} failed`);
        }
        originalSetDocument(document);
      });

      fixture.viewport.setReadingColors({
        pageColors: null,
        brightness: 1,
        contrast: 1,
        imageDim: 0,
      });

      eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: retiredManager });
      expect(() => {
        editor.undo().catch(() => undefined);
      }).toThrow('not ready');
      const replacementManager = annotationManager();
      eventBus.dispatch('annotationeditoruimanager', {
        source: viewer,
        uiManager: replacementManager,
      });
      await editor.undo();
      await fixture.viewport.destroy();
      eventBus.dispatch('annotationeditoruimanager', {
        source: viewer,
        uiManager: annotationManager(),
      });

      expect(replacementManager.undo).toHaveBeenCalledOnce();
      await expect(editor.save(new AbortController().signal)).rejects.toThrow('destroyed');
    },
  );

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

  it('coalesces racing Follow Obsidian theme colors so the latest rebuild wins', async () => {
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

  it('queues a scale selected while reading colors are rebinding', async () => {
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

    fixture.viewport.setReadingColors({
      background: '#f4ecd8',
      foreground: '#2d281f',
      brightness: 0.95,
      contrast: 1.05,
      imageDim: 0.1,
    });
    const scaleDuringRebind = viewer.currentScale;
    fixture.viewport.setScale(1.75);
    fixture.viewport.stepScale(1);

    expect(viewer.currentScale).toBe(scaleDuringRebind);
    eventBus.dispatch('pagesinit', {});
    expect(viewer.currentScale).toBe(2);
    expect(viewer.currentPageNumber).toBe(2);
    fixture.viewport.stepScale(1);
    expect(viewer.currentScale).toBeCloseTo(2.2, 5);
    fixture.viewport.setScale(2.5);
    fixture.viewport.stepScale(1);
    expect(viewer.currentScale).toBeCloseTo(2.8, 5);
  });

  it('queues navigation while reading colors are rebinding and applies the latest destination', async () => {
    const fixture = await mountedViewport(4);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    const linkService = fixture.runtime.state.linkService;
    if (eventBus === undefined || viewer === undefined || linkService === undefined) {
      throw new Error('Expected viewer components.');
    }
    eventBus.dispatch('pagesinit', {});
    viewer.currentPageNumber = 2;
    fixture.viewport.setReadingColors({
      background: '#f4ecd8',
      foreground: '#2d281f',
      brightness: 0.95,
      contrast: 1.05,
      imageDim: 0.1,
    });

    await fixture.viewport.goTo({ pageIndex: 2, x: 12, y: 34 });
    await fixture.viewport.goTo({ pageIndex: 3, x: 56, y: 78 });

    expect(linkService.positions).toEqual([]);
    expect(linkService.pages).toEqual([]);
    eventBus.dispatch('pagesinit', {});
    expect(linkService.positions).toEqual([[4, 56, 78]]);
    expect(linkService.pages).toEqual([]);
    expect(viewer.currentPageNumber).toBe(4);
  });

  it('restores an applied full logical location after a reading-color rebind', async () => {
    const fixture = await mountedViewport(4);
    const eventBus = fixture.runtime.state.eventBus;
    const linkService = fixture.runtime.state.linkService;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || linkService === undefined || viewer === undefined) {
      throw new Error('Expected viewer components.');
    }
    eventBus.dispatch('pagesinit', {});
    await fixture.viewport.goTo({ pageIndex: 2, x: 12, y: 34 });
    viewer.currentPageNumber = 1;

    fixture.viewport.setReadingColors({
      background: '#f4ecd8',
      foreground: '#2d281f',
      brightness: 0.95,
      contrast: 1.05,
      imageDim: 0.1,
    });
    eventBus.dispatch('pagesinit', {});

    expect(linkService.positions).toEqual([
      [3, 12, 34],
      [3, 12, 34],
    ]);
  });

  it('restores the latest layout after a reading-color document rebind resets PDF.js', async () => {
    const fixture = await mountedViewport(6);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('pagesinit', {});
    fixture.viewport.setLayout({ pages: 'facing', scrolling: 'page-by-page' });
    viewer.currentPageNumber = 4;

    fixture.viewport.setReadingColors({
      background: '#202020',
      foreground: '#e6e1d8',
      brightness: 0.86,
      contrast: 0.95,
      imageDim: 0.18,
    });
    expect(viewer.spreadMode).toBe(0);
    expect(viewer.scrollMode).toBe(0);
    eventBus.dispatch('pagesinit', {});

    expect(viewer.spreadMode).toBe(1);
    expect(viewer.scrollMode).toBe(3);
    expect(viewer.currentPageNumber).toBe(4);
  });

  it('preserves a newer public scale event over an earlier requested preset during rebind', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    eventBus.dispatch('pagesinit', {});
    fixture.viewport.setScale('page-fit');
    viewer.currentScale = 1.6;
    viewer.currentScaleValue = '1.6';
    eventBus.dispatch('scalechanging', { scale: 1.6, presetValue: undefined });

    fixture.viewport.setReadingColors({
      background: '#202020',
      foreground: '#e6e1d8',
      brightness: 0.86,
      contrast: 0.95,
      imageDim: 0.18,
    });
    eventBus.dispatch('pagesinit', {});

    expect(viewer.currentScale).toBeCloseTo(1.6, 5);
  });

  it('cancels an unresolved Fit-height calculation during teardown', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    const page = deferred<Awaited<ReturnType<PDFDocumentProxy['getPage']>>>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the Vitest mock is configured, never invoked detached
    const getPage = vi.mocked(fixture.documentProxy.getPage);
    getPage.mockReturnValue(page.promise);
    eventBus.dispatch('pagesinit', {});
    let scale = viewer.currentScale;
    const assignScale = vi.fn((next: number) => {
      scale = next;
    });
    Object.defineProperty(viewer, 'currentScale', {
      configurable: true,
      get: () => scale,
      set: assignScale,
    });

    fixture.viewport.setScale('page-height');
    await fixture.viewport.destroy();
    assignScale.mockClear();
    page.resolve({
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
    } as unknown as Awaited<ReturnType<PDFDocumentProxy['getPage']>>);
    await Promise.resolve();

    expect(assignScale).not.toHaveBeenCalled();
  });

  it('contains a current public-page failure while computing Fit height', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    if (eventBus === undefined) throw new Error('Expected an event bus.');
    const cause = new Error('page viewport unavailable');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the Vitest mock is configured, never invoked detached
    vi.mocked(fixture.documentProxy.getPage).mockRejectedValueOnce(cause);
    const events: ViewportEvent[] = [];
    fixture.viewport.onEvent((event) => events.push(event));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    eventBus.dispatch('pagesinit', {});

    fixture.viewport.setScale('page-height');

    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: 'render-error', pageIndex: 0, cause });
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to render PDF page', {
      pageIndex: 0,
      cause,
    });
  });

  it('discards an old-page Fit-height result after navigating to a differently sized page', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) throw new Error('Expected viewer state.');
    Object.defineProperty(viewer.options.container, 'clientHeight', {
      configurable: true,
      value: 1_005,
    });
    const firstPage = deferred<Awaited<ReturnType<PDFDocumentProxy['getPage']>>>();
    const secondPage = deferred<Awaited<ReturnType<PDFDocumentProxy['getPage']>>>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the Vitest mock is configured, never invoked detached
    vi.mocked(fixture.documentProxy.getPage)
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise);
    eventBus.dispatch('pagesinit', {});

    fixture.viewport.setScale('page-height');
    await fixture.viewport.goTo({ pageIndex: 1 });
    secondPage.resolve({
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 800, height: 400 })),
    } as unknown as Awaited<ReturnType<PDFDocumentProxy['getPage']>>);
    await vi.waitFor(() => {
      expect(viewer.currentScale).toBeCloseTo(2.5, 5);
    });
    firstPage.resolve({
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 400, height: 800 })),
    } as unknown as Awaited<ReturnType<PDFDocumentProxy['getPage']>>);
    await Promise.resolve();

    expect(viewer.currentPageNumber).toBe(2);
    expect(viewer.currentScale).toBeCloseTo(2.5, 5);
  });

  it('queues a scale selected before initial pages are ready', async () => {
    const fixture = await mountedViewport(3);
    const eventBus = fixture.runtime.state.eventBus;
    const viewer = fixture.runtime.state.viewer;
    if (eventBus === undefined || viewer === undefined) {
      throw new Error('Expected viewer components.');
    }
    fixture.viewport.setReadingColors({
      background: '#f4ecd8',
      foreground: '#2d281f',
      brightness: 0.95,
      contrast: 1.05,
      imageDim: 0.1,
    });

    fixture.viewport.setScale(1.75);

    expect(viewer.currentScale).toBe(1);
    eventBus.dispatch('pagesinit', {});
    eventBus.dispatch('pagesinit', {});
    expect(viewer.currentScale).toBe(1.75);
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
    const viewport = await createPdfDocumentViewport(documentProxy, runtime.module, search, {
      annotationCapabilities: {
        editing: {} as never,
        readOnlyReason: null,
        types: {} as never,
      },
      sourcePath: 'Books/Guide.pdf',
    });

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
