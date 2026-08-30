import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfAnnotationEditor as PdfAnnotationEditorType } from '../../src/adapters/pdf/pdf-annotation-editor.js';
import type { PdfCommentEditor } from '../../src/adapters/pdf/pdf-comment-bridge.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  beforeParse(window) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (media: string): MediaQueryList => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: false,
        media,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
  },
});
const realm = dom.window;
const unresolvedGlobals: unknown = runInThisContext('this');
if (typeof unresolvedGlobals !== 'object' || unresolvedGlobals === null)
  throw new Error('Expected the isolated runner global object.');
const runnerGlobals = unresolvedGlobals as Record<PropertyKey, unknown>;
for (const name of [
  'AbortController',
  'AbortSignal',
  'CSSStyleDeclaration',
  'CustomEvent',
  'DOMException',
  'DOMMatrix',
  'DOMPoint',
  'DOMRect',
  'Document',
  'Element',
  'Event',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLCanvasElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'MutationObserver',
  'Node',
  'NodeList',
  'Range',
  'Selection',
  'SVGElement',
  'Text',
] as const) {
  const value: unknown = Reflect.get(realm, name);
  Reflect.set(runnerGlobals, name, value);
}
Reflect.set(runnerGlobals, 'window', realm);
Reflect.set(runnerGlobals, 'document', realm.document);
Reflect.set(runnerGlobals, 'navigator', realm.navigator);
Reflect.set(runnerGlobals, 'getComputedStyle', realm.getComputedStyle.bind(realm));
Reflect.set(runnerGlobals, 'requestAnimationFrame', realm.requestAnimationFrame.bind(realm));
Reflect.set(runnerGlobals, 'cancelAnimationFrame', realm.cancelAnimationFrame.bind(realm));

const {
  AnnotationEditorLayer,
  AnnotationEditorUIManager,
  AnnotationLayer,
  DrawLayer,
  getDocument,
} = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { EventBus } = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs');
const { PdfAnnotationEditor } = await import('../../src/adapters/pdf/pdf-annotation-editor.js');
const { PdfCommentBridge } = await import('../../src/adapters/pdf/pdf-comment-bridge.js');
const { PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE, PDFJS_ANNOTATION_EDITOR_TYPE } =
  await import('../../src/adapters/pdf/pdf-runtime.js');
const { createReadonlyAnnotationFixture } = await import('./pdf-fixtures.mjs');

const standardFontDataUrl = `${path.join(
  path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))),
  'standard_fonts',
)}/`;

const l10n = {
  get: async (_ids: unknown, _args: unknown, fallback: unknown) => fallback,
  getDirection: () => 'ltr',
  getLanguage: () => 'en-us',
  pause: () => undefined,
  resume: () => undefined,
  translate: async () => undefined,
  translateOnce: async () => undefined,
};

interface NativeSession {
  readonly annotationEditor: PdfAnnotationEditorType;
  readonly annotationLayer: InstanceType<typeof AnnotationLayer>;
  readonly bridge: InstanceType<typeof PdfCommentBridge>;
  readonly container: HTMLElement;
  readonly drawLayer: InstanceType<typeof DrawLayer>;
  readonly editorLayer: InstanceType<typeof AnnotationEditorLayer>;
  readonly loadingTask: ReturnType<typeof getDocument>;
  readonly pdf: PDFDocumentProxy;
  readonly uiManager: InstanceType<typeof AnnotationEditorUIManager>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalize(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as Uint8Array);
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalize(nested)]));
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K];
}

function createDiv(className?: string): HTMLDivElement {
  const element = createElement('div');
  if (className !== undefined) element.className = className;
  return element;
}

async function reopenedHighlights(
  bytes: Uint8Array,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const loadingTask = getDocument({ data: Uint8Array.from(bytes), standardFontDataUrl });
  try {
    const pdf = await loadingTask.promise;
    const highlights: Array<Record<string, unknown>> = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      for (const annotation of await (await pdf.getPage(pageNumber)).getAnnotations()) {
        if ((annotation as { readonly annotationType?: unknown }).annotationType !== 9) continue;
        highlights.push({
          ...(normalize(annotation) as Record<string, unknown>),
          pageIndex: pageNumber - 1,
        });
      }
    }
    return highlights;
  } finally {
    await loadingTask.destroy();
  }
}

function createRuntimeViewer(
  uiManager: InstanceType<typeof AnnotationEditorUIManager>,
  eventBus: InstanceType<typeof EventBus>,
) {
  const viewer: {
    annotationEditorMode: number | { readonly mode: number };
    currentMode: number;
  } = {
    annotationEditorMode: PDFJS_ANNOTATION_EDITOR_TYPE.NONE,
    currentMode: PDFJS_ANNOTATION_EDITOR_TYPE.NONE,
  };
  Object.defineProperty(viewer, 'annotationEditorMode', {
    configurable: true,
    get: () => viewer.currentMode,
    set: (request: number | { readonly mode: number }) => {
      const mode = typeof request === 'number' ? request : request.mode;
      void uiManager.updateMode(mode).then(
        () => {
          viewer.currentMode = mode;
          eventBus.dispatch('annotationeditormodechanged', { source: viewer, mode });
        },
        () => undefined,
      );
    },
  });
  return viewer;
}

async function nativeSession(bytes: Uint8Array, includeTextLayer = false): Promise<NativeSession> {
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    isOffscreenCanvasSupported: true,
    standardFontDataUrl,
  });
  const pdf = await loadingTask.promise;
  const container = createDiv();
  Object.defineProperty(container, 'win', {
    configurable: true,
    value: { createDiv: () => createDiv() },
  });
  const viewerElement = createDiv();
  const textLayerElement = createDiv('textLayer');
  const annotationLayerElement = createDiv('annotationLayer');
  const editorLayerElement = createDiv('annotationEditorLayer');
  const drawLayerElement = createDiv();
  container.append(viewerElement);
  if (includeTextLayer) container.append(textLayerElement);
  container.append(annotationLayerElement, editorLayerElement);
  editorLayerElement.append(drawLayerElement);
  document.body.append(container);
  for (const element of [textLayerElement, editorLayerElement]) {
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 612, 792),
    });
  }
  const eventBus = new EventBus();
  let annotationEditor: PdfAnnotationEditorType | null = null;
  const bridge = new PdfCommentBridge(container, {
    onNativeMutation: () => annotationEditor?.notifyNativeMutation(),
  });
  const uiManager = new AnnotationEditorUIManager(
    container,
    viewerElement,
    null,
    null,
    bridge,
    null,
    eventBus,
    pdf,
    null,
    'yellow=#FFD400,green=#64D8CB',
    false,
    false,
    false,
    null,
    null,
    true,
  );
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const annotationLayer = new AnnotationLayer({
    accessibilityManager: null,
    annotationCanvasMap: null,
    annotationEditorUIManager: uiManager,
    annotationStorage: pdf.annotationStorage,
    commentManager: bridge,
    div: annotationLayerElement,
    linkService: {},
    page,
    structTreeLayer: null,
    viewport: viewport.clone({ dontFlip: true }),
  });
  await annotationLayer.render({
    annotations: await page.getAnnotations(),
    div: annotationLayerElement,
    imageResourcesPath: '',
    linkService: {} as never,
    page,
    renderForms: false,
    viewport: viewport.clone({ dontFlip: true }),
  });
  const drawLayer = new DrawLayer({ pageIndex: 0 });
  drawLayer.setParent(drawLayerElement);
  const editorLayer = new AnnotationEditorLayer({
    annotationLayer,
    div: editorLayerElement,
    drawLayer,
    enabled: true,
    l10n: l10n as never,
    mode: {},
    pageIndex: 0,
    structTreeLayer: null as never,
    ...(includeTextLayer ? { textLayer: { div: textLayerElement } as never } : {}),
    uiManager,
    viewport,
  });
  const runtimeViewer = createRuntimeViewer(uiManager, eventBus);
  annotationEditor = new PdfAnnotationEditor({
    annotationEditorParamsType: PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE,
    annotationEditorType: PDFJS_ANNOTATION_EDITOR_TYPE,
    commentBridge: bridge,
    eventBus,
    pdf,
    selectionObserver: {
      invalidate: () => undefined,
      onSelection: () => () => undefined,
      validate: () => 'current',
    },
    viewer: runtimeViewer,
  });
  eventBus.dispatch('annotationeditoruimanager', { source: runtimeViewer, uiManager });
  return {
    annotationEditor,
    annotationLayer,
    bridge,
    container,
    drawLayer,
    editorLayer,
    loadingTask,
    pdf,
    uiManager,
  };
}

async function destroySession(session: NativeSession): Promise<void> {
  session.annotationEditor.destroy();
  session.bridge.dispose();
  session.editorLayer.destroy();
  session.annotationLayer.destroy();
  session.drawLayer.destroy();
  session.uiManager.destroy();
  session.container.remove();
  await session.loadingTask.destroy();
}

async function createHighlight(
  original: Uint8Array,
  options: {
    readonly color: string;
    readonly comment: string;
    readonly rect: DOMRect;
    readonly text: string;
  },
): Promise<Uint8Array> {
  const session = await nativeSession(original, true);
  const textLayer = session.container.querySelector<HTMLElement>('.textLayer');
  if (textLayer === null) throw new Error('Expected a real text-layer host.');
  const text = createElement('span');
  text.textContent = options.text;
  textLayer.append(text);
  const selection = document.getSelection();
  if (selection === null) throw new Error('Expected Selection support.');
  const range = document.createRange();
  range.selectNodeContents(text);
  Object.defineProperty(range, 'getClientRects', { value: () => [options.rect] });
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    const annotation = await session.annotationEditor.commitSelection('selection-token', {
      color: options.color,
      kind: 'highlight',
    });
    if (annotation === 'dismissed') throw new Error('The native selection was dismissed.');
    if (
      options.comment.length > 0 &&
      !session.bridge.updateAnnotations({ annotations: [annotation], comment: options.comment })
    )
      throw new Error('The native comment update was rejected.');
    return await session.annotationEditor.save(new AbortController().signal);
  } finally {
    selection.removeAllRanges();
    await destroySession(session);
  }
}

function waitForSelector(root: HTMLElement, selector: string, action: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (root.querySelector(selector) === null) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    try {
      action();
      if (root.querySelector(selector) !== null) {
        observer.disconnect();
        resolve();
      }
    } catch (cause) {
      observer.disconnect();
      reject(semanticError(cause));
    }
  });
}

function requireNativeMutation(
  annotationEditor: PdfAnnotationEditorType,
  mutation: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    unsubscribe = annotationEditor.onMutation(() => {
      unsubscribe();
      resolve();
    });
    try {
      if (mutation()) return;
      unsubscribe();
      reject(new Error('The native mutation was rejected.'));
    } catch (cause) {
      unsubscribe();
      reject(semanticError(cause));
    }
  });
}

async function mutateOnlyHighlight(
  original: Uint8Array,
  mutation:
    | { readonly kind: 'delete' }
    | { readonly color: string; readonly comment: string; readonly kind: 'edit' },
): Promise<Uint8Array> {
  const session = await nativeSession(original);
  try {
    await session.editorLayer.enable();
    const annotations = (await (await session.pdf.getPage(1)).getAnnotations()) as Array<
      Record<string, unknown> & { readonly annotationType: number; readonly id: string }
    >;
    const source = annotations.find((annotation) => annotation.annotationType === 9);
    if (source === undefined) throw new Error('Expected one reopened Highlight.');
    const native = session.editorLayer.getEditorByUID(
      source.id,
    ) as unknown as PdfCommentEditor | null;
    if (native === null) throw new Error('Expected a materialized native Highlight editor.');
    await waitForSelector(session.container, '.selectedEditor .deleteButton', () => {
      session.uiManager.setSelected(native as never);
    });
    const annotation = session.bridge.normalizeCreatedAnnotation(session.uiManager);
    if (annotation === null) throw new Error('Expected a normalized native Highlight.');
    await requireNativeMutation(session.annotationEditor, () =>
      mutation.kind === 'delete'
        ? session.bridge.deleteAnnotations([annotation])
        : session.bridge.updateAnnotations({
            annotations: [annotation],
            color: mutation.color,
            comment: mutation.comment,
          }),
    );
    return await session.annotationEditor.save(new AbortController().signal);
  } finally {
    await destroySession(session);
  }
}

async function failedRealSave(
  bytes: Uint8Array,
  kind: 'abort' | 'reject',
): Promise<{ readonly after: string; readonly before: string; readonly rejected: boolean }> {
  const before = sha256(bytes);
  const session = await nativeSession(bytes);
  let rejected = false;
  try {
    if (kind === 'reject') await session.loadingTask.destroy();
    const signal =
      kind === 'abort' ? AbortSignal.abort('semantic cancellation') : new AbortController().signal;
    try {
      await session.annotationEditor.save(signal);
    } catch {
      rejected = true;
    }
  } finally {
    await destroySession(session).catch(() => undefined);
  }
  return { after: sha256(bytes), before, rejected };
}

function semanticError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

const setRealmStyle = document.documentElement.style.setProperty.bind(
  document.documentElement.style,
);
setRealmStyle('--freetext-padding', '0');
setRealmStyle('--outline-width', '0px');
const original = await createReadonlyAnnotationFixture(false);
const first = await createHighlight(original, {
  color: '#ffd400',
  comment: 'First [[Idea]] #draft',
  rect: new DOMRect(72, 202, 148, 22),
  text: 'First native selection',
});
const firstReopen = await reopenedHighlights(first);
const edited = await mutateOnlyHighlight(first, {
  color: '#64d8cb',
  comment: 'Revised [[Idea]] #verified',
  kind: 'edit',
});
const editedReopen = await reopenedHighlights(edited);
const failures = await Promise.all(
  (['abort', 'reject'] as const).map(async (kind) => ({
    kind,
    ...(await failedRealSave(edited, kind)),
  })),
);
const deleted = await mutateOnlyHighlight(edited, { kind: 'delete' });
const repeatFirst = await createHighlight(original, {
  color: '#ffd400',
  comment: '',
  rect: new DOMRect(72, 202, 148, 22),
  text: 'First repeated selection',
});
const repeatSecond = await createHighlight(repeatFirst, {
  color: '#64d8cb',
  comment: '',
  rect: new DOMRect(96, 252, 164, 22),
  text: 'Second repeated selection',
});

const result = {
  deletedReopen: await reopenedHighlights(deleted),
  editedReopen,
  failures,
  firstHash: sha256(first),
  firstReopen,
  originalHash: sha256(original),
  repeatFirstReopen: await reopenedHighlights(repeatFirst),
  repeatedReopen: await reopenedHighlights(repeatSecond),
};
process.stdout.write(`ABYSS_SEMANTIC_RESULT=${JSON.stringify(result)}\n`);
dom.window.close();
