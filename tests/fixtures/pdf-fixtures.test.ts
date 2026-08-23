import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFObject } from 'pdf-lib';
import {
  AnnotationEditorLayer,
  AnnotationEditorUIManager,
  AnnotationLayer,
  DrawLayer,
  getDocument,
  PermissionFlag,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EventBus } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfAnnotationEditor } from '../../src/adapters/pdf/pdf-annotation-editor.js';
import {
  PdfCommentBridge,
  type PdfCommentEditor,
} from '../../src/adapters/pdf/pdf-comment-bridge.js';
import { PdfEditableSession } from '../../src/adapters/pdf/pdf-editable-session.js';
import {
  PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE,
  PDFJS_ANNOTATION_EDITOR_TYPE,
} from '../../src/adapters/pdf/pdf-runtime.js';
import type { PdfSelectionObserver } from '../../src/adapters/pdf/pdf-selection-observer.js';
import { AutosaveScheduler, type SaveReason } from '../../src/autosave-scheduler.js';
import {
  DocumentSaveCoordinator,
  type BaseToken,
  type PdfWriteRequest,
} from '../../src/document-core/save-coordinator.js';
import {
  createReadonlyAnnotationFixture,
  FIXTURE_MANIFEST_FILE,
  generatePdfFixtures,
  type PdfFixtureManifest,
} from './pdf-fixtures.mjs';

function inactiveSelectionObserver(): PdfSelectionObserver {
  return {
    invalidate: () => undefined,
    onSelection: () => () => undefined,
    validate: () => 'stale',
  };
}

async function saveWithNativePdfjsEditors(
  original: Uint8Array,
  annotations: ReadonlyArray<Record<string, unknown>>,
): Promise<Uint8Array> {
  const loadingTask = getDocument({
    data: Uint8Array.from(original),
    isOffscreenCanvasSupported: true,
    standardFontDataUrl,
  });
  const pdf = await loadingTask.promise;
  const container = createDiv();
  const viewer = createDiv();
  const editorLayerElement = createDiv();
  const drawLayerElement = createDiv();
  container.append(viewer, editorLayerElement);
  editorLayerElement.append(drawLayerElement);
  document.body.append(container);
  Object.defineProperty(editorLayerElement, 'getBoundingClientRect', {
    value: () => new DOMRect(0, 0, 612, 792),
  });
  const eventBus = new EventBus();
  const commentBridge = new PdfCommentBridge(container);
  const uiManager = new AnnotationEditorUIManager(
    container,
    viewer,
    null,
    null,
    commentBridge,
    null,
    eventBus,
    pdf,
    null,
    'yellow=#FFDE00',
    false,
    false,
    false,
    null,
    null,
    true,
  );
  const page = await pdf.getPage(1);
  const drawLayer = new DrawLayer({ pageIndex: 0 });
  drawLayer.setParent(drawLayerElement);
  const l10n = {
    get: async (_ids: unknown, _args: unknown, fallback: unknown) => fallback,
    getDirection: () => 'ltr',
    getLanguage: () => 'en-us',
    pause: () => undefined,
    resume: () => undefined,
    translate: async () => undefined,
    translateOnce: async () => undefined,
  };
  const editorLayer = new AnnotationEditorLayer({
    div: editorLayerElement,
    drawLayer,
    enabled: true,
    l10n: l10n as never,
    mode: {},
    pageIndex: 0,
    structTreeLayer: null as never,
    uiManager,
    viewport: page.getViewport({ scale: 1 }),
  });
  const runtimeViewer = { annotationEditorMode: PDFJS_ANNOTATION_EDITOR_TYPE.NONE };
  const annotationEditor = new PdfAnnotationEditor({
    annotationEditorParamsType: PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE,
    annotationEditorType: PDFJS_ANNOTATION_EDITOR_TYPE,
    commentBridge,
    eventBus,
    pdf,
    selectionObserver: inactiveSelectionObserver(),
    viewer: runtimeViewer,
  });
  eventBus.dispatch('annotationeditoruimanager', { source: runtimeViewer, uiManager });
  try {
    for (const data of annotations) {
      const { commentText, ...nativeData } = data;
      const editor = await editorLayer.deserialize(nativeData);
      if (editor === null) throw new Error('PDF.js rejected native editor fixture data.');
      editorLayer.addOrRebuild(editor);
      if (typeof commentText === 'string') {
        const commentEditor = editor as unknown as PdfCommentEditor;
        commentEditor.comment = 'Initial comment';
        uiManager.setSelected(editor);
        await commentBridge.showDialog(uiManager, commentEditor, 0, 0);
        const input = container.querySelector<HTMLTextAreaElement>('textarea');
        if (input === null) throw new Error('Expected the native comment bridge input.');
        input.value = commentText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return await annotationEditor.save(new AbortController().signal);
  } finally {
    annotationEditor.destroy();
    commentBridge.dispose();
    editorLayer.destroy();
    drawLayer.destroy();
    uiManager.destroy();
    container.remove();
    await loadingTask.destroy();
  }
}

async function reopenedAnnotations(
  bytes: Uint8Array,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const loadingTask = getDocument({ data: Uint8Array.from(bytes), standardFontDataUrl });
  try {
    const pdf: PDFDocumentProxy = await loadingTask.promise;
    const annotations = await (await pdf.getPage(1)).getAnnotations();
    return annotations.map(
      (annotation) => normalizePdfjsValue(annotation) as Record<string, unknown>,
    );
  } finally {
    await loadingTask.destroy();
  }
}

async function editExistingNativeComment(
  original: Uint8Array,
  annotationType: number,
  comment: string,
): Promise<Uint8Array> {
  const loadingTask = getDocument({
    data: Uint8Array.from(original),
    isOffscreenCanvasSupported: true,
    standardFontDataUrl,
  });
  const pdf = await loadingTask.promise;
  const container = createDiv();
  const viewer = createDiv();
  const annotationLayerElement = createDiv({ cls: 'annotationLayer' });
  const editorLayerElement = createDiv();
  const drawLayerElement = createDiv();
  container.append(viewer, annotationLayerElement, editorLayerElement);
  editorLayerElement.append(drawLayerElement);
  document.body.append(container);
  Object.defineProperty(editorLayerElement, 'getBoundingClientRect', {
    value: () => new DOMRect(0, 0, 612, 792),
  });
  const eventBus = new EventBus();
  let annotationEditor: PdfAnnotationEditor | null = null;
  const commentBridge = new PdfCommentBridge(container, {
    onNativeMutation: () => {
      annotationEditor?.notifyNativeMutation();
    },
  });
  const uiManager = new AnnotationEditorUIManager(
    container,
    viewer,
    null,
    null,
    commentBridge,
    null,
    eventBus,
    pdf,
    null,
    'yellow=#FFDE00',
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
    commentManager: commentBridge,
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
  const l10n = {
    get: async (_ids: unknown, _args: unknown, fallback: unknown) => fallback,
    getDirection: () => 'ltr',
    getLanguage: () => 'en-us',
    pause: () => undefined,
    resume: () => undefined,
    translate: async () => undefined,
    translateOnce: async () => undefined,
  };
  const editorLayer = new AnnotationEditorLayer({
    annotationLayer,
    div: editorLayerElement,
    drawLayer,
    enabled: true,
    l10n: l10n as never,
    mode: {},
    pageIndex: 0,
    structTreeLayer: null as never,
    uiManager,
    viewport,
  });
  const runtimeViewer = { annotationEditorMode: PDFJS_ANNOTATION_EDITOR_TYPE.NONE };
  annotationEditor = new PdfAnnotationEditor({
    annotationEditorParamsType: PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE,
    annotationEditorType: PDFJS_ANNOTATION_EDITOR_TYPE,
    commentBridge,
    eventBus,
    pdf,
    selectionObserver: inactiveSelectionObserver(),
    viewer: runtimeViewer,
  });
  eventBus.dispatch('annotationeditoruimanager', { source: runtimeViewer, uiManager });
  const baseToken: BaseToken = {
    byteSize: original.byteLength,
    mtime: 1,
    sha256: createHash('sha256').update(original).digest('hex'),
  };
  let scheduler: AutosaveScheduler | null = null;
  let editable: PdfEditableSession | null = null;
  const writes: Uint8Array[] = [];
  const saveReasons: SaveReason[] = [];
  const verified = vi.fn(async (bytes: Uint8Array) => {
    await reopenedAnnotations(bytes);
  });
  const coordinator = new DocumentSaveCoordinator(
    {
      write: async (request: PdfWriteRequest) => {
        await request.verifyPdf(request.bytes, request.signal);
        writes.push(Uint8Array.from(request.bytes));
        return {
          token: {
            byteSize: request.bytes.byteLength,
            mtime: 2,
            sha256: createHash('sha256').update(request.bytes).digest('hex'),
          },
        };
      },
    },
    async (bytes) => verified(bytes),
  );
  try {
    await editorLayer.enable();
    const reopened = (await page.getAnnotations()) as Array<Record<string, unknown>>;
    const source = reopened.find((annotation) => annotation['annotationType'] === annotationType);
    if (source === undefined) throw new Error('Expected reopened native annotation.');
    const existing = editorLayer.getEditorByUID(source['id']) as unknown as PdfCommentEditor | null;
    if (existing === null) throw new Error('Expected deserialized existing native editor.');
    uiManager.setSelected(existing as never);
    editable = new PdfEditableSession(
      'Books/Existing.pdf',
      baseToken,
      annotationEditor,
      (revision) => {
        scheduler?.markDirty(revision);
      },
    );
    const activeEditable = editable;
    scheduler = new AutosaveScheduler(
      async (revision, reason) => {
        saveReasons.push(reason);
        await coordinator.save(
          {
            baseToken: activeEditable.baseToken,
            path: activeEditable.path,
            revision,
            source: activeEditable,
          },
          new AbortController().signal,
        );
      },
      { idleDelay: 0 },
    );
    await commentBridge.showDialog(uiManager, existing, 0, 0);
    const input = container.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected native comment editor for reopened annotation.');
    input.value = comment;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await scheduler.flush();
    expect(saveReasons).toContain('autosave');
    expect(verified).toHaveBeenCalledOnce();
    const written = writes[writes.length - 1];
    if (written === undefined) throw new Error('Expected a verified native comment autosave.');
    return written;
  } finally {
    scheduler?.destroy();
    editable?.destroy();
    annotationEditor.destroy();
    commentBridge.dispose();
    editorLayer.destroy();
    annotationLayer.destroy();
    drawLayer.destroy();
    uiManager.destroy();
    container.remove();
    await loadingTask.destroy();
  }
}

function normalizePdfjsValue(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as Uint8Array);
  if (Array.isArray(value)) return value.map(normalizePdfjsValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizePdfjsValue(nested)]),
  );
}

const temporaryDirectories: string[] = [];
const enumerableArrayDescriptors = new Map<string, PropertyDescriptor>();
let matchMediaDescriptor: PropertyDescriptor | undefined;
let innerTextDescriptor: PropertyDescriptor | undefined;
const standardFontDataUrl = `${path.join(
  path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))),
  'standard_fonts',
)}/`;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'abyss-pdf-fixtures-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

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
  innerTextDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
  if (innerTextDescriptor === undefined) {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent;
      },
      set(this: HTMLElement, value: string) {
        this.textContent = value;
      },
    });
  }
});

afterAll(() => {
  document.documentElement.style.removeProperty('--freetext-padding');
  document.documentElement.style.removeProperty('--outline-width');
  for (const [name, descriptor] of enumerableArrayDescriptors) {
    Object.defineProperty(Array.prototype, name, descriptor);
  }
  if (matchMediaDescriptor === undefined) Reflect.deleteProperty(window, 'matchMedia');
  else Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
  if (innerTextDescriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'innerText');
  else Object.defineProperty(HTMLElement.prototype, 'innerText', innerTextDescriptor);
});

function pageText(file: string): string[] {
  const script = `
    import { readFile } from 'node:fs/promises';
    import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
    const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(process.argv[1])), standardFontDataUrl: process.argv[2] });
    const document = await task.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      pages.push(content.items.flatMap((item) => 'str' in item ? [item.str] : []).join(' ').trim());
    }
    await task.destroy();
    process.stdout.write(JSON.stringify(pages));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', script, file, standardFontDataUrl],
      {
        cwd: path.resolve(import.meta.dirname, '..', '..'),
        encoding: 'utf8',
      },
    ),
  ) as string[];
}

function fixture(manifest: PdfFixtureManifest, name: string) {
  const value = manifest.files.find((candidate) => candidate.name === name);
  if (value === undefined) throw new Error(`Missing fixture metadata for ${name}.`);
  return value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('generatePdfFixtures', () => {
  it(
    'produces byte-identical PDFs and versioned metadata on repeated runs',
    { timeout: 20_000 },
    async () => {
      const firstDirectory = await temporaryDirectory();
      const secondDirectory = await temporaryDirectory();

      const first = await generatePdfFixtures(firstDirectory);
      const second = await generatePdfFixtures(secondDirectory);

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        schemaVersion: 1,
        generator: { name: 'pdf-lib', version: '1.17.1' },
        files: [
          { name: 'text-12-pages.pdf', pages: 12 },
          { name: 'outline-20-pages.pdf', pages: 20 },
          { name: 'text-700-pages.pdf', pages: 700 },
          { name: 'raster-heavy-24-pages.pdf', pages: 24 },
          { name: 'invalid.pdf', pages: null },
          {
            annotations: 10_000,
            bytes: 5_610_695,
            name: 'annotations-10000.pdf',
            pages: 100,
            sha256: '9cf3103bf1dd962e91d37084eb5434653ec54d2c0fa6f8983334224f6cbe70c4',
          },
          {
            annotations: 2,
            bytes: 2_239,
            name: 'annotation-qualification.pdf',
            pages: 1,
            sha256: '2973a59a35f36c273001e15b43e675144f6b10dc8ee6ac483d8fc394e5983bf3',
          },
          {
            annotations: 1,
            bytes: 2_992,
            name: 'signed-document.pdf',
            pages: 1,
            sha256: 'b324ab63f23bef22dd7b8c4fb213f5e12e40af7798ea456f7031b8f26908bb53',
          },
          {
            annotations: 1,
            bytes: 1_280,
            name: 'permission-restricted.pdf',
            pages: 1,
            sha256: 'f6926536e20e23bb9005257d95e3ec0d3e1ab5b804e6816391d501bd8e85a03f',
          },
        ],
      });
      for (const entry of first.files) {
        expect(await sha256(path.join(firstDirectory, entry.name))).toBe(entry.sha256);
        expect(await sha256(path.join(secondDirectory, entry.name))).toBe(entry.sha256);
      }
      expect(
        JSON.parse(await readFile(path.join(firstDirectory, FIXTURE_MANIFEST_FILE), 'utf8')),
      ).toEqual(first);
    },
  );

  it(
    'writes fixture paths containing URL-reserved characters as filesystem paths',
    {
      timeout: 15_000,
    },
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'abyss fixtures # ? %-'));
      temporaryDirectories.push(directory);

      const manifest = await generatePdfFixtures(directory);

      expect(await sha256(path.join(directory, 'text-12-pages.pdf'))).toBe(
        fixture(manifest, 'text-12-pages.pdf').sha256,
      );
      expect(
        JSON.parse(await readFile(path.join(directory, FIXTURE_MANIFEST_FILE), 'utf8')),
      ).toEqual(manifest);
    },
  );

  it(
    'places the known search term only on pages 2, 7, and 11 of the search fixture',
    {
      timeout: 15_000,
    },
    async () => {
      const directory = await temporaryDirectory();
      await generatePdfFixtures(directory);

      const pages = pageText(path.join(directory, 'text-12-pages.pdf'));

      expect(
        pages.flatMap((text, index) =>
          text.toLocaleLowerCase().includes('gradient') ? [index + 1] : [],
        ),
      ).toEqual([2, 7, 11]);
    },
  );

  it(
    'writes a linked two-level outline dictionary with explicit page destinations',
    {
      timeout: 15_000,
    },
    async () => {
      const directory = await temporaryDirectory();
      await generatePdfFixtures(directory);
      const document = await PDFDocument.load(
        Uint8Array.from(await readFile(path.join(directory, 'outline-20-pages.pdf'))),
      );

      const outlines = document.catalog.lookup(PDFName.of('Outlines'), PDFDict);
      const firstChapter = outlines.lookup(PDFName.of('First'), PDFDict);
      const firstSection = firstChapter.lookup(PDFName.of('First'), PDFDict);

      expect(outlines.lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(12);
      expect(firstChapter.get(PDFName.of('Parent'))).toBe(
        document.catalog.get(PDFName.of('Outlines')),
      );
      expect(firstSection.get(PDFName.of('Parent'))).toBe(outlines.get(PDFName.of('First')));
      const destination = firstSection.lookup(PDFName.of('Dest')) as PDFObject;
      expect(destination.toString()).toMatch(/^\[ \d+ 0 R \/Fit \]$/u);
    },
  );

  it('embeds one raster image and reuses it across all 24 pages', async () => {
    const directory = await temporaryDirectory();
    const manifest = await generatePdfFixtures(directory);
    const bytes = await readFile(path.join(directory, 'raster-heavy-24-pages.pdf'));
    const document = await PDFDocument.load(Uint8Array.from(bytes));
    const images = document.context
      .enumerateIndirectObjects()
      .filter(([, object]) =>
        object instanceof PDFRawStream
          ? object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
          : false,
      );

    expect(document.getPageCount()).toBe(24);
    expect(images).toHaveLength(1);
    expect(fixture(manifest, 'raster-heavy-24-pages.pdf').purpose).toContain('reused');
  });

  it('writes fixed invalid bytes instead of a parseable PDF', async () => {
    const directory = await temporaryDirectory();
    await generatePdfFixtures(directory);

    const bytes = await readFile(path.join(directory, 'invalid.pdf'));

    expect(bytes.toString('utf8')).toBe('ABYSS-DOCUMENTS INVALID PDF FIXTURE v1\n');
    await expect(PDFDocument.load(Uint8Array.from(bytes))).rejects.toThrow();
  });

  it(
    'produces rendered signed and permission-restricted PDFs that public PDF.js marks read-only',
    {
      timeout: 15_000,
    },
    async () => {
      const directory = await temporaryDirectory();
      await generatePdfFixtures(directory);
      const signedTask = getDocument({
        data: Uint8Array.from(await readFile(path.join(directory, 'signed-document.pdf'))),
        standardFontDataUrl,
      });
      const restrictedTask = getDocument({
        data: Uint8Array.from(await readFile(path.join(directory, 'permission-restricted.pdf'))),
        standardFontDataUrl,
      });
      try {
        const signed = await signedTask.promise;
        const restricted = await restrictedTask.promise;
        expect(await signed.getSignatures()).toEqual([
          expect.objectContaining({
            coversWholeDocument: true,
            reason: 'Read-only qualification',
            signerName: 'Fixture Signer',
          }),
        ]);
        const permissions = await restricted.getPermissions();
        expect(permissions).toContain(PermissionFlag.PRINT);
        expect(permissions).toContain(PermissionFlag.COPY);
        expect(permissions).not.toContain(PermissionFlag.MODIFY_CONTENTS);
        expect(permissions).not.toContain(PermissionFlag.MODIFY_ANNOTATIONS);
        expect(pageText(path.join(directory, 'signed-document.pdf'))[0]).toContain(
          'Signed document fixture',
        );
        expect(pageText(path.join(directory, 'permission-restricted.pdf'))[0]).toContain(
          'Permission restricted fixture',
        );
        expect(await (await restricted.getPage(1)).getAnnotations()).toEqual([
          expect.objectContaining({ contentsObj: { dir: 'ltr', str: 'Restricted #secure' } }),
        ]);
      } finally {
        await Promise.all([signedTask.destroy(), restrictedTask.destroy()]);
      }
    },
  );
});

describe('native PDF.js annotation save qualification', () => {
  it.each([
    {
      name: 'FreeText',
      data: {
        annotationType: 3,
        color: [20, 80, 220],
        fontSize: 18,
        isCopy: true,
        pageIndex: 0,
        rect: [72, 620, 252, 670],
        rotation: 0,
        value: 'Native FreeText',
      },
      expected: {
        annotationType: 3,
        contentsObj: { dir: 'ltr', str: 'Native FreeText' },
        defaultAppearanceData: {
          fontColor: [20, 79, 219],
          fontName: 'Helv',
          fontSize: 18,
        },
        rect: [252, 570, 432, 620],
      },
    },
    {
      name: 'Highlight',
      data: {
        annotationType: 9,
        color: [255, 222, 0],
        opacity: 0.75,
        isCopy: true,
        pageIndex: 0,
        quadPoints: new Float32Array([72, 590, 220, 590, 72, 568, 220, 568]),
        rect: [72, 568, 220, 590],
        rotation: 0,
      },
      expected: {
        annotationType: 9,
        color: [255, 222, 0],
        quadPoints: [72, 590, 220, 590, 72, 568, 220, 568],
        rect: [71.3591996133, 567.1511939764, 220.6260002553, 590.8319935799],
      },
    },
    {
      name: 'Ink',
      data: {
        annotationType: 15,
        color: [180, 30, 80],
        opacity: 0.8,
        isCopy: true,
        pageIndex: 0,
        paths: { points: [new Float32Array([90, 510, 130, 535, 170, 500])] },
        rect: [90, 500, 170, 535],
        rotation: 0,
        thickness: 3,
      },
      expected: {
        annotationType: 15,
        color: [180, 30, 80],
        inkLists: [[157.5, 495.0000305175781, 197.5, 520, 237.5, 485.0000305175781]],
        rect: [153.7499931157, 491.2500301301, 221.2499890924, 506.2500143498],
      },
    },
  ])(
    'saves and semantically reopens a native $name incremental update',
    async ({ data, expected }) => {
      const original = await createReadonlyAnnotationFixture(false);

      const saved = await saveWithNativePdfjsEditors(original, [data]);
      const annotations = await reopenedAnnotations(saved);

      expect(saved.slice(0, original.byteLength)).toEqual(original);
      const text = new TextDecoder('latin1').decode(saved);
      expect(text.match(/%%EOF/gu)).toHaveLength(2);
      expect(text.slice(original.byteLength)).toMatch(/\/Prev\s+\d+/u);
      expect(annotations).toEqual([expect.objectContaining(expected)]);
    },
  );

  it('preserves existing Underline and Text annotations after a native supported edit', async () => {
    const original = await createReadonlyAnnotationFixture(true);
    const before = await reopenedAnnotations(original);

    const saved = await saveWithNativePdfjsEditors(original, [
      {
        annotationType: 3,
        color: [30, 60, 190],
        fontSize: 14,
        isCopy: true,
        pageIndex: 0,
        rect: [72, 440, 240, 480],
        rotation: 0,
        value: 'Unrelated supported edit',
      },
    ]);
    const after = await reopenedAnnotations(saved);

    const readOnlyProjection = (annotations: ReadonlyArray<Record<string, unknown>>) =>
      annotations
        .filter(
          (annotation) => annotation['annotationType'] === 10 || annotation['annotationType'] === 1,
        )
        .map((annotation) => ({
          annotationType: annotation['annotationType'],
          color: annotation['color'],
          contentsObj: annotation['contentsObj'],
          id: annotation['id'],
          quadPoints: annotation['quadPoints'],
          rect: annotation['rect'],
        }));
    expect(readOnlyProjection(after)).toEqual(readOnlyProjection(before));
    expect(after).toHaveLength(before.length + 1);
  });

  it.each([
    {
      name: 'Highlight',
      annotationType: 9,
      data: {
        annotationType: 9,
        color: [255, 212, 0],
        isCopy: true,
        opacity: 0.75,
        pageIndex: 0,
        quadPoints: new Float32Array([72, 590, 220, 590, 72, 568, 220, 568]),
        rect: [72, 568, 220, 590],
        rotation: 0,
      },
    },
    {
      name: 'Ink',
      annotationType: 15,
      data: {
        annotationType: 15,
        color: [180, 30, 80],
        isCopy: true,
        opacity: 0.8,
        pageIndex: 0,
        paths: { points: [new Float32Array([90, 510, 130, 535, 170, 500])] },
        rect: [90, 500, 170, 535],
        rotation: 0,
        thickness: 3,
      },
    },
    {
      name: 'FreeText',
      annotationType: 3,
      data: {
        annotationType: 3,
        color: [20, 80, 220],
        fontSize: 18,
        isCopy: true,
        pageIndex: 0,
        rect: [72, 620, 252, 670],
        rotation: 0,
        value: 'Native FreeText',
      },
    },
  ])(
    'saves and reopens an edited native $name comment as ordinary text',
    async ({ annotationType, data }) => {
      const original = await createReadonlyAnnotationFixture(false);
      const comment = 'Key idea [[Gradient descent]] #important';

      const saved = await saveWithNativePdfjsEditors(original, [{ ...data, commentText: comment }]);
      const annotations = await reopenedAnnotations(saved);

      const parent = annotations.find(
        (annotation) => annotation['annotationType'] === annotationType,
      );
      const popup = annotations.find((annotation) => annotation['annotationType'] === 16);
      expect(parent?.['contentsObj']).toMatchObject({ str: comment });
      expect(popup?.['contentsObj']).toMatchObject({ str: comment });
    },
  );

  it('reopens, edits, resaves, and reopens an existing native Highlight comment', async () => {
    const original = await createReadonlyAnnotationFixture(false);
    const firstComment = 'First [[Idea]] #draft';
    const firstSave = await saveWithNativePdfjsEditors(original, [
      {
        annotationType: 9,
        color: [255, 212, 0],
        commentText: firstComment,
        isCopy: true,
        opacity: 0.75,
        pageIndex: 0,
        quadPoints: new Float32Array([72, 590, 220, 590, 72, 568, 220, 568]),
        rect: [72, 568, 220, 590],
        rotation: 0,
      },
    ]);

    const secondComment = 'Revised [[Idea]] #verified';
    const secondSave = await editExistingNativeComment(firstSave, 9, secondComment);
    const annotations = await reopenedAnnotations(secondSave);

    expect(secondSave.slice(0, firstSave.byteLength)).toEqual(firstSave);
    expect(new TextDecoder('latin1').decode(secondSave).match(/%%EOF/gu)).toHaveLength(3);
    expect(
      annotations.find((annotation) => annotation['annotationType'] === 9)?.['contentsObj'],
    ).toMatchObject({ str: secondComment });
    expect(
      annotations.find((annotation) => annotation['annotationType'] === 16)?.['contentsObj'],
    ).toMatchObject({ str: secondComment });
  });
});
