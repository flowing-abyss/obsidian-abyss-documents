import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnnotationEditorLayer,
  AnnotationEditorUIManager,
  AnnotationLayer,
  DrawLayer,
  getDocument,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EventBus } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfAnnotationEditor } from '../../src/adapters/pdf/pdf-annotation-editor.js';
import {
  PdfCommentBridge,
  type PdfCommentEditor,
} from '../../src/adapters/pdf/pdf-comment-bridge.js';
import {
  PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE,
  PDFJS_ANNOTATION_EDITOR_TYPE,
} from '../../src/adapters/pdf/pdf-runtime.js';
import { createReadonlyAnnotationFixture } from './pdf-fixtures.mjs';

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
  readonly annotationEditor: PdfAnnotationEditor;
  readonly annotationLayer: AnnotationLayer;
  readonly bridge: PdfCommentBridge;
  readonly container: HTMLElement;
  readonly drawLayer: DrawLayer;
  readonly editorLayer: AnnotationEditorLayer;
  readonly loadingTask: ReturnType<typeof getDocument>;
  readonly pdf: PDFDocumentProxy;
  readonly uiManager: AnnotationEditorUIManager;
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

function createRuntimeViewer(uiManager: AnnotationEditorUIManager, eventBus: EventBus) {
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
  const viewerElement = createDiv();
  const textLayerElement = createDiv({ cls: 'textLayer' });
  const annotationLayerElement = createDiv({ cls: 'annotationLayer' });
  const editorLayerElement = createDiv({ cls: 'annotationEditorLayer' });
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
  let annotationEditor: PdfAnnotationEditor | null = null;
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
  const text = textLayer.createSpan({ text: options.text });
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
    session.uiManager.setSelected(native as never);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const annotation = session.bridge.normalizeCreatedAnnotation(session.uiManager);
    if (annotation === null) throw new Error('Expected a normalized native Highlight.');
    const accepted =
      mutation.kind === 'delete'
        ? session.bridge.deleteAnnotations([annotation])
        : session.bridge.updateAnnotations({
            annotations: [annotation],
            color: mutation.color,
            comment: mutation.comment,
          });
    if (!accepted) throw new Error(`The native ${mutation.kind} mutation was rejected.`);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    return await session.annotationEditor.save(new AbortController().signal);
  } finally {
    await destroySession(session);
  }
}

async function expectFailedRealSave(bytes: Uint8Array, kind: 'abort' | 'reject'): Promise<void> {
  const session = await nativeSession(bytes);
  try {
    if (kind === 'reject') await session.loadingTask.destroy();
    const signal =
      kind === 'abort' ? AbortSignal.abort('semantic cancellation') : new AbortController().signal;
    await expect(session.annotationEditor.save(signal)).rejects.toBeDefined();
  } finally {
    await destroySession(session).catch(() => undefined);
  }
}

let matchMediaDescriptor: PropertyDescriptor | undefined;
const enumerableArrayDescriptors = new Map<string, PropertyDescriptor>();

beforeAll(() => {
  document.documentElement.setCssProps({ '--freetext-padding': '0', '--outline-width': '0px' });
  for (const name of Object.keys(Array.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, name);
    if (descriptor?.enumerable !== true) continue;
    enumerableArrayDescriptors.set(name, descriptor);
    Object.defineProperty(Array.prototype, name, { ...descriptor, enumerable: false });
  }
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false }),
  });
});

afterAll(() => {
  document.documentElement.style.removeProperty('--freetext-padding');
  document.documentElement.style.removeProperty('--outline-width');
  for (const [name, descriptor] of enumerableArrayDescriptors) {
    Object.defineProperty(Array.prototype, name, descriptor);
  }
  if (matchMediaDescriptor === undefined) Reflect.deleteProperty(window, 'matchMedia');
  else Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
});

describe('real PDF.js annotation semantic bytes oracle', () => {
  it(
    'preserves page, quadPoints, fill, comment, edit, delete, hash, and repeat semantics',
    { timeout: 30_000 },
    async () => {
      const original = await createReadonlyAnnotationFixture(false);
      const firstComment = 'First [[Idea]] #draft';
      const first = await createHighlight(original, {
        color: '#ffd400',
        comment: firstComment,
        rect: new DOMRect(72, 202, 148, 22),
        text: 'First native selection',
      });
      const firstReopen = await reopenedHighlights(first);

      expect(firstReopen).toHaveLength(1);
      expect(firstReopen[0]).toMatchObject({
        annotationType: 9,
        color: [255, 212, 0],
        contentsObj: { str: firstComment },
        pageIndex: 0,
      });
      expect(firstReopen[0]?.['quadPoints']).toEqual([72, 590, 220, 590, 72, 568, 220, 568]);
      expect(sha256(first)).not.toBe(sha256(original));

      const revisedComment = 'Revised [[Idea]] #verified';
      const edited = await mutateOnlyHighlight(first, {
        color: '#64d8cb',
        comment: revisedComment,
        kind: 'edit',
      });
      const editedReopen = await reopenedHighlights(edited);

      expect(editedReopen).toHaveLength(1);
      expect(editedReopen[0]).toMatchObject({
        annotationType: 9,
        color: [100, 216, 203],
        contentsObj: { str: revisedComment },
        pageIndex: 0,
      });
      expect(editedReopen[0]?.['quadPoints']).toEqual(firstReopen[0]?.['quadPoints']);

      for (const failure of ['abort', 'reject'] as const) {
        const before = sha256(edited);
        await expectFailedRealSave(edited, failure);
        expect(sha256(edited)).toBe(before);
      }

      const deleted = await mutateOnlyHighlight(edited, { kind: 'delete' });
      expect(await reopenedHighlights(deleted)).toHaveLength(0);

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
      const repeated = await reopenedHighlights(repeatSecond);

      expect(await reopenedHighlights(repeatFirst)).toHaveLength(1);
      expect(repeated).toHaveLength(2);
      expect(repeated.map((annotation) => annotation['color'])).toEqual([
        [255, 212, 0],
        [100, 216, 203],
      ]);
    },
  );
});
