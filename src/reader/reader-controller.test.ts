import { Menu, type TFile } from 'obsidian';
import { App, TFile as MockTFile, Notice } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import type {
  PdfAnnotationEditor,
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfAnnotationTool,
  PdfSelectionAction,
} from '../adapters/pdf/pdf-annotation-editor.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import { StaleAnnotationCacheReadError, type AnnotationCache } from '../annotation-cache.js';
import type {
  AnnotationGeometry,
  AnnotationSink,
  DocumentAnnotation,
} from '../document-core/annotations.js';
import { asAnnotationId } from '../document-core/annotations.js';
import { DocumentAdapterRegistry } from '../document-core/document-adapter.js';
import type {
  DocumentAdapter,
  DocumentSession,
  DocumentViewport,
} from '../document-core/document.js';
import { DocumentOpenError } from '../document-core/errors.js';
import type { ReaderLayout, ReadingProfileId } from '../document-core/reading.js';
import {
  DocumentSaveCoordinator,
  NATIVE_RECOVERY_SOURCE,
  SaveConflictError,
  type BaseToken,
  type NativeDocumentSaveRequest,
  type NativeEditableSaveSession,
  type VerifiedReloadListener,
} from '../document-core/save-coordinator.js';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../reader-performance.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  ReaderController,
  type ReaderProfileState,
  type ShellFactory,
} from './reader-controller.js';
import type { ReaderShellIntent } from './reader-shell.js';
import { ReaderShell } from './reader-shell.js';
import { BUILTIN_PROFILES } from './reading-profiles.js';

function files(...paths: string[]): TFile[] {
  const app = App.createConfigured__({
    files: Object.fromEntries(paths.map((path) => [path, ''])),
  });
  return paths.map((path) => {
    const source = app.vault.getAbstractFileByPath(path);
    if (!(source instanceof MockTFile)) throw new Error(`Expected a test file at ${path}.`);
    return source.asOriginalType2__();
  });
}

function annotationRecord(
  id: string,
  pageIndex: number,
  geometry: AnnotationGeometry,
): DocumentAnnotation {
  return {
    identity: { kind: 'stable', id: asAnnotationId(id) },
    type: 'highlight',
    anchor: { kind: 'fixed-page', pageIndex, coordinateSpace: 'page-points-top-left', geometry },
    color: null,
    selectedText: id,
    author: '',
    createdAt: null,
    modifiedAt: null,
    comment: '',
    tags: [],
    links: [],
    capabilities: {} as DocumentAnnotation['capabilities'],
  };
}

function resolved(colors: (typeof BUILTIN_PROFILES)[keyof typeof BUILTIN_PROFILES]) {
  return {
    pageColors: { background: colors.background, foreground: colors.foreground },
    brightness: colors.brightness,
    contrast: colors.contrast,
    imageDim: colors.imageDim,
  };
}

function captureMenuChoices() {
  const choices: Array<{ checked: boolean | null; title: string }> = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
    this: Menu,
    callback: Parameters<Menu['addItem']>[0],
  ) {
    const choice = { checked: null as boolean | null, title: '' };
    const item = {
      onClick() {
        return item;
      },
      setChecked(checked: boolean | null) {
        choice.checked = checked;
        return item;
      },
      setIcon() {
        return item;
      },
      setIsLabel() {
        return item;
      },
      setSection() {
        return item;
      },
      setTitle(title: string) {
        choice.title = title;
        return item;
      },
    };
    callback(item as never);
    choices.push(choice);
    return this;
  });
  return choices;
}

function viewport(pageCount = 3) {
  const mount = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const goTo = vi.fn(async () => undefined);
  const focus = vi.fn();
  const search = vi.fn();
  const searchAgain = vi.fn();
  const selectSearchHit = vi.fn(async () => undefined);
  const setScale = vi.fn();
  const stepScale = vi.fn();
  const setLayout = vi.fn();
  const setReadingColors = vi.fn();
  let listener: Parameters<DocumentViewport['onEvent']>[0] | null = null;
  const unsubscribe = vi.fn();
  const value: DocumentViewport = {
    pageCount,
    mount,
    goTo,
    setScale,
    stepScale,
    setLayout,
    setReadingColors,
    search,
    searchAgain,
    selectSearchHit,
    onEvent: vi.fn((nextListener: Parameters<DocumentViewport['onEvent']>[0]) => {
      listener = nextListener;
      return unsubscribe;
    }),
    focus,
    destroy,
  };
  return {
    destroy,
    emit(event: Parameters<NonNullable<typeof listener>>[0]) {
      listener?.(event);
    },
    focus,
    goTo,
    mount,
    search,
    searchAgain,
    selectSearchHit,
    setReadingColors,
    setLayout,
    setScale,
    stepScale,
    unsubscribe,
    value,
  };
}

function editableViewport(pageCount = 3) {
  const created = viewport(pageCount);
  const deleteSelection = vi.fn(async (): Promise<void> => undefined);
  const redo = vi.fn(async (): Promise<void> => undefined);
  const setParameter = vi.fn(async (): Promise<void> => undefined);
  const setTool = vi.fn(async (_tool: PdfAnnotationTool): Promise<void> => undefined);
  const undo = vi.fn(async (): Promise<void> => undefined);
  const editor = {
    onDirty: vi.fn(() => () => undefined),
    redo,
    deleteSelection,
    save: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
    setParameter,
    setTool,
    undo,
  } as unknown as PdfAnnotationEditor;
  Object.assign(created.value, { annotationEditor: editor });
  return { ...created, deleteSelection, editor, redo, setParameter, setTool, undo };
}

function interactiveViewport(pageCount = 3) {
  const created = editableViewport(pageCount);
  const projectSelectionRects = vi.fn(() => [{ x: 10, y: 20, width: 100, height: 20 }]);
  let mode: PdfAnnotationLogicalMode = 'neutral';
  const annotationFocusListeners = new Set<
    Parameters<PdfAnnotationInteraction['onAnnotationFocus']>[0]
  >();
  const colorListeners = new Set<(value: string) => void>();
  const modeListeners = new Set<(value: PdfAnnotationLogicalMode) => void>();
  const selectionListeners = new Set<(value: PdfTextSelection | null) => void>();
  const commitSelection = vi.fn(
    async (_token: string, _action: PdfSelectionAction): Promise<DocumentAnnotation> =>
      annotationRecord('created-native', 0, { kind: 'point', point: { x: 0, y: 0 } }),
  );
  const setQuickHighlight = vi.fn(
    async (state: { readonly enabled: boolean; readonly color: string }) => {
      mode = state.enabled ? 'quick-highlight' : 'neutral';
      for (const listener of modeListeners) listener(mode);
    },
  );
  const updateAnnotations = vi.fn(() => true);
  const focusAnnotation = vi.fn(async (_nativeId: string, _signal?: AbortSignal) => true);
  const interaction: PdfAnnotationInteraction = {
    commitSelection,
    deleteAnnotations: () => true,
    focusAnnotation,
    onAnnotationFocus(listener) {
      annotationFocusListeners.add(listener);
      return () => annotationFocusListeners.delete(listener);
    },
    onColor(listener) {
      colorListeners.add(listener);
      return () => colorListeners.delete(listener);
    },
    onMode(listener) {
      modeListeners.add(listener);
      listener(mode);
      return () => modeListeners.delete(listener);
    },
    onSelection(listener) {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    setQuickHighlight,
    updateAnnotations,
  };
  created.setTool.mockImplementation(async (tool) => {
    mode = 'neutral';
    if (tool === 'ink') mode = 'ink';
    if (tool === 'freetext') mode = 'freetext';
    for (const listener of modeListeners) listener(mode);
  });
  Object.assign(created.value, { annotationInteraction: interaction, projectSelectionRects });
  return {
    ...created,
    commitSelection,
    focusAnnotation,
    projectSelectionRects,
    emitMode(next: PdfAnnotationLogicalMode) {
      mode = next;
      for (const listener of modeListeners) listener(next);
    },
    emitColor(color: string) {
      for (const listener of colorListeners) listener(color);
    },
    emitAnnotationFocus(
      focus: Parameters<Parameters<PdfAnnotationInteraction['onAnnotationFocus']>[0]>[0],
    ) {
      for (const listener of annotationFocusListeners) listener(focus);
    },
    emitSelection(selection: PdfTextSelection | null) {
      for (const listener of selectionListeners) listener(selection);
    },
    setQuickHighlight,
    updateAnnotations,
  };
}

function pdfSelection(token = 'selection-token'): PdfTextSelection {
  return {
    clientRect: { bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 },
    clientRects: [{ bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 }],
    input: 'pointer',
    pageIndex: 0,
    text: 'Selected text',
    token,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function session(path: string, createdViewport = viewport()) {
  const createViewport = vi.fn(async () => createdViewport.value);
  const close = vi.fn(async () => undefined);
  const value: DocumentSession = {
    descriptor: {
      path,
      name: path.split('/').slice(-1)[0] ?? path,
      fingerprint: path,
      pageCount: 3,
    },
    capabilities: new Set(['outline', 'text-search', 'existing-annotations']),
    getOutline: vi.fn(async () => []),
    createViewport,
    close,
  };
  return { close, createViewport, value };
}

function adapterFor(path: string, createdSession: ReturnType<typeof session>) {
  const open = vi.fn(async () => createdSession.value);
  const value: DocumentAdapter = {
    id: `adapter:${path}`,
    supports: (file) => file.path === path,
    open,
  };
  return { open, value };
}

function profileState(options?: {
  defaultLayout?: ReaderLayout;
  defaultProfile?: ReadingProfileId;
  layouts?: Record<string, ReaderLayout>;
  profiles?: Record<string, ReadingProfileId>;
  rememberLayoutPerDocument?: boolean;
  rememberPerDocument?: boolean;
}) {
  const layouts = { ...options?.layouts };
  const profiles = { ...options?.profiles };
  const updateLayout = vi.fn((fingerprint: string, layout: ReaderLayout) => {
    layouts[fingerprint] = layout;
  });
  const updateProfile = vi.fn((fingerprint: string, profile: ReadingProfileId) => {
    profiles[fingerprint] = profile;
  });
  const value: ReaderProfileState = {
    reading: {
      defaultProfile: options?.defaultProfile ?? 'default',
      rememberPerDocument: options?.rememberPerDocument ?? false,
      custom: {
        background: '#101820',
        foreground: '#f2f2f2',
        brightness: 1,
        contrast: 1,
        imageDim: 0,
      },
    },
    layout: {
      default: options?.defaultLayout ?? { pages: 'single', scrolling: 'continuous' },
      rememberPerDocument: options?.rememberLayoutPerDocument ?? false,
    },
    layoutByFingerprint: layouts,
    profileByFingerprint: profiles,
    updateLayoutForFingerprint: updateLayout,
    updateProfileForFingerprint: updateProfile,
  };
  return { layouts, profiles, updateLayout, updateProfile, value };
}

function capturingShellFactory() {
  let sendIntent: ((intent: ReaderShellIntent) => void) | null = null;
  let createdShell: ReaderShell | null = null;
  const createShell: ShellFactory = (host, onIntent) => {
    sendIntent = onIntent;
    createdShell = new ReaderShell(host, onIntent);
    return createdShell;
  };
  return {
    createShell,
    get created(): ReaderShell {
      if (createdShell === null) throw new Error('Expected the reader shell to be created.');
      return createdShell;
    },
    send(intent: ReaderShellIntent) {
      if (sendIntent === null) throw new Error('Expected the reader shell to be created.');
      sendIntent(intent);
    },
  };
}

describe('ReaderController', () => {
  it('activates the exact overlapping annotation through navigation and the unified editor', async () => {
    const [pdf] = files('Books/Overlapping-annotations.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = interactiveViewport();
    const createdSession = session(pdf.path, createdViewport);
    const extraction = deferred<void>();
    Object.assign(createdSession.value, { listAnnotations: async () => extraction.promise });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    for (const [nativeId, comment] of [
      ['overlap-first', 'First editor'],
      ['overlap-second', 'Second editor'],
    ] as const) {
      createdViewport.emit({
        type: 'annotation-change',
        change: {
          operation: 'upsert',
          annotation: {
            nativeId,
            pageIndex: 0,
            type: 'highlight',
            rects: [{ x: 10, y: 20, width: 100, height: 12 }],
            selectedText: 'Same geometry',
            color: '#ffd400',
            comment,
            tags: [],
            links: [],
            writable: true,
          },
        },
      });
    }
    createdViewport.focusAnnotation.mockImplementation(async (nativeId) => {
      const target = annotationRecord(nativeId, 0, {
        kind: 'rectangle',
        rectangle: { x: 10, y: 20, width: 100, height: 12 },
      });
      createdViewport.emitAnnotationFocus({
        annotations: [{ ...target, comment: `${nativeId} editor` }],
        editable: true,
        position: { x: 20, y: 32 },
      });
      return true;
    });

    const openEditor = vi.spyOn(shell.created, 'openAnnotationEditor');
    const secondCard =
      shell.created.sidebar?.annotationsPanel.root.querySelector<HTMLButtonElement>(
        '[data-annotation-id="overlap-second"]',
      );
    secondCard?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    secondCard?.focus();
    secondCard?.click();

    await vi.waitFor(() => {
      expect(createdViewport.focusAnnotation).toHaveBeenCalledWith(
        'overlap-second',
        expect.any(AbortSignal),
        expect.objectContaining({
          comment: 'Second editor',
          identity: { id: 'overlap-second', kind: 'stable' },
        }),
      );
    });
    expect(createdViewport.goTo).toHaveBeenCalledWith({ pageIndex: 0, x: 10, y: 20 });
    expect(
      shell.created.root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')
        ?.value,
    ).toBe('overlap-second editor');
    const selected = shell.created.sidebar?.annotationsPanel.root.querySelectorAll(
      '.abyss-annotation-card[aria-current="true"]',
    );
    expect(selected).toHaveLength(1);
    expect(selected?.[0]?.getAttribute('data-annotation-id')).toBe('overlap-second');
    expect(createdViewport.goTo).toHaveBeenCalledOnce();
    expect(createdViewport.focusAnnotation).toHaveBeenCalledOnce();

    createdViewport.emit({ type: 'page-change', pageIndex: 0 });
    createdViewport.emit({ type: 'page-change', pageIndex: 0 });
    createdViewport.emit({ type: 'page-change', pageIndex: 1 });

    expect(
      shell.created.root.querySelector<HTMLElement>('[data-annotation-editor-popover]')?.hidden,
    ).toBe(false);
    expect(
      shell.created.root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')
        ?.value,
    ).toBe('overlap-second editor');
    expect(openEditor).toHaveBeenCalledOnce();
    extraction.resolve();
  });

  it('cancels stale far-page annotation readiness and opens only the latest exact target', async () => {
    const [pdf] = files('Books/Far-page-annotations.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = interactiveViewport(100);
    const createdSession = session(pdf.path, createdViewport);
    const extraction = deferred<void>();
    Object.assign(createdSession.value, { listAnnotations: async () => extraction.promise });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const firstNavigation = deferred<void>();
    const secondNavigation = deferred<void>();
    createdViewport.goTo
      .mockImplementationOnce(async () => {
        await firstNavigation.promise;
        return undefined;
      })
      .mockImplementationOnce(async () => {
        await secondNavigation.promise;
        return undefined;
      });
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    for (const [nativeId, pageIndex] of [
      ['far-first', 70],
      ['far-second', 80],
    ] as const) {
      createdViewport.emit({
        type: 'annotation-change',
        change: {
          operation: 'upsert',
          annotation: {
            nativeId,
            pageIndex,
            type: 'highlight',
            rects: [{ x: 10, y: 20, width: 40, height: 8 }],
            selectedText: nativeId,
            color: '#ffd400',
            comment: nativeId,
            tags: [],
            links: [],
            writable: nativeId === 'far-first',
          },
        },
      });
    }
    let firstSignal: AbortSignal | undefined;
    createdViewport.focusAnnotation.mockImplementation(async (nativeId, signal) => {
      if (nativeId === 'far-first') {
        firstSignal = signal;
        return new Promise<boolean>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              resolve(false);
            },
            { once: true },
          );
        });
      }
      createdViewport.emitAnnotationFocus({
        annotations: [
          {
            ...annotationRecord('far-second', 80, { kind: 'point', point: { x: 10, y: 20 } }),
            comment: 'Latest exact target',
          },
        ],
        editable: false,
        position: { x: 10, y: 28 },
      });
      return true;
    });
    const cards = shell.created.sidebar?.annotationsPanel.root;
    cards?.querySelector<HTMLButtonElement>('[data-annotation-id="far-first"]')?.click();
    firstNavigation.resolve();
    await vi.waitFor(() => {
      expect(createdViewport.focusAnnotation).toHaveBeenCalledWith(
        'far-first',
        expect.any(AbortSignal),
        expect.objectContaining({
          comment: 'far-first',
          identity: { id: 'far-first', kind: 'stable' },
        }),
      );
    });

    cards?.querySelector<HTMLButtonElement>('[data-annotation-id="far-second"]')?.click();
    expect(firstSignal?.aborted).toBe(true);
    secondNavigation.resolve();

    await vi.waitFor(() => {
      expect(createdViewport.focusAnnotation).toHaveBeenLastCalledWith(
        'far-second',
        expect.any(AbortSignal),
        expect.objectContaining({
          comment: 'far-second',
          identity: { id: 'far-second', kind: 'stable' },
        }),
      );
      expect(
        shell.created.root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')
          ?.value,
      ).toBe('Latest exact target');
    });
    expect(createdViewport.focusAnnotation).toHaveBeenCalledTimes(2);
    extraction.resolve();
  });

  it('projects a native annotation event immediately without remounting the viewport', async () => {
    const [pdf] = files('Books/Immediate-annotation.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const extraction = deferred<void>();
    Object.assign(createdSession.value, {
      listAnnotations: async () => extraction.promise,
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });

    createdViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          nativeId: 'native-immediate',
          provisionalId: 'selection-immediate',
          pageIndex: 0,
          type: 'highlight',
          rects: [{ x: 10, y: 20, width: 30, height: 8 }],
          selectedText: 'Immediate annotation',
          color: '#ffd400',
          comment: '',
          tags: [],
          links: [],
          writable: true,
        },
      },
    });

    expect({
      visibleIds: shell.created.sidebar?.annotationsPanel.visibleIds(),
      viewportMounts: createdViewport.mount.mock.calls.length,
    }).toEqual({ visibleIds: ['native-immediate'], viewportMounts: 1 });
    extraction.resolve();
  });

  it('discards and retries verified extraction that races a newer live edit', async () => {
    const [pdf] = files('Books/Stale-edit-race.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const staleGate = deferred<void>();
    const retryGate = deferred<void>();
    const staleReturned = deferred<void>();
    const stale = {
      ...annotationRecord('same-native-id', 0, {
        kind: 'rectangle',
        rectangle: { x: 10, y: 20, width: 30, height: 8 },
      }),
      comment: 'Stale verified comment',
    };
    const fresh = { ...stale, comment: 'New live comment' };
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      if (listAnnotations.mock.calls.length === 1) {
        await staleGate.promise;
        sink([stale]);
        staleReturned.resolve();
        return;
      }
      await retryGate.promise;
      sink([fresh]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledOnce();
    });
    createdViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          nativeId: 'same-native-id',
          pageIndex: 0,
          type: 'highlight',
          rects: [{ x: 10, y: 20, width: 30, height: 8 }],
          selectedText: 'same-native-id',
          color: '#ffd400',
          comment: 'New live comment',
          tags: [],
          links: [],
          writable: true,
        },
      },
    });

    staleGate.resolve();
    await staleReturned.promise;
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledTimes(2);
    });
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).toContain('New live comment');
    retryGate.resolve();
  });

  it('does not let a theme refresh starve extraction during a pending mutation', async () => {
    const [pdf] = files('Books/Revision-aware-create.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const active = session(pdf.path, createdViewport);
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([]);
      },
    });
    const extractionGate = deferred<void>();
    const reopened = session(pdf.path);
    Object.assign(reopened.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        await extractionGate.promise;
        sink([]);
      },
    });
    let pendingRevision = 1;
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      committedRevision: 0,
      get pendingRevision() {
        return pendingRevision;
      },
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    const adapter = adapterFor(pdf.path, active);
    adapter.open.mockResolvedValueOnce(active.value).mockResolvedValueOnce(reopened.value);
    let broadcast: VerifiedReloadListener | undefined;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([]);
    });
    if (broadcast === undefined) throw new Error('Expected save listener.');

    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);
    await vi.waitFor(() => {
      expect(adapter.open).toHaveBeenCalledTimes(2);
    });
    pendingRevision = 2;
    createdViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          nativeId: 'created-at-revision-2',
          pageIndex: 0,
          type: 'highlight',
          rects: [{ x: 1, y: 2, width: 3, height: 4 }],
          selectedText: 'Created while extracting',
          color: '#ffd400',
          comment: '',
          tags: [],
          links: [],
          writable: true,
        },
      },
    });
    createdViewport.setReadingColors.mockImplementationOnce(() => {
      createdViewport.emit({
        type: 'annotation-snapshot',
        annotations: [
          {
            nativeId: 'created-at-revision-2',
            pageIndex: 0,
            type: 'highlight',
            rects: [{ x: 1, y: 2, width: 3, height: 4 }],
            selectedText: 'Created while extracting',
            color: '#ffd400',
            comment: '',
            tags: [],
            links: [],
            writable: false,
          },
        ],
      });
    });
    controller.refreshReadingSettings();
    extractionGate.resolve();

    await vi.waitFor(() => {
      expect(reopened.close).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(adapter.open).toHaveBeenCalledTimes(2);
    expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['created-at-revision-2']);
  });

  it('does not resurrect an unseen annotation removed during verified extraction', async () => {
    const [pdf] = files('Books/Stale-delete-race.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const staleGate = deferred<void>();
    const stale = annotationRecord('deleted-native-id', 0, {
      kind: 'rectangle',
      rectangle: { x: 10, y: 20, width: 30, height: 8 },
    });
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      if (listAnnotations.mock.calls.length === 1) {
        await staleGate.promise;
        sink([stale]);
        return;
      }
      sink([]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledOnce();
    });

    createdViewport.emit({
      type: 'annotation-change',
      change: { operation: 'remove', nativeId: 'deleted-native-id' },
    });
    staleGate.resolve();

    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledTimes(2);
    });
    expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([]);
  });

  it('carries projection row identity through controller provisional reconciliation', async () => {
    const [pdf] = files('Books/Controller-row-identity.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const extractionGate = deferred<void>();
    const geometry = {
      kind: 'rectangle' as const,
      rectangle: { x: 10, y: 20, width: 30, height: 8 },
    };
    const verified = {
      ...annotationRecord('stable-native-id', 0, geometry),
      color: '#ffd400',
      selectedText: 'Projected quote',
    };
    Object.assign(createdSession.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        await extractionGate.promise;
        sink([verified]);
      },
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const host = createDiv();
    host.doc.body.append(host);
    await controller.open(pdf, host);
    createdViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          nativeId: 'temporary-native-id',
          provisionalId: 'selection-token',
          pageIndex: 0,
          type: 'highlight',
          rects: [geometry.rectangle],
          selectedText: 'Projected quote',
          color: '#ffd400',
          comment: '',
          tags: [],
          links: [],
          writable: true,
        },
      },
    });
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    const panel = shell.created.sidebar?.annotationsPanel;
    const before = panel?.root.querySelector<HTMLElement>('.abyss-annotation-card');
    before?.focus();
    const scrollHost = panel?.root.querySelector<HTMLElement>('[data-annotation-scroll-host]');
    if (scrollHost === null || scrollHost === undefined)
      throw new Error('Expected annotation scroll host.');
    scrollHost.scrollTop = 137;
    const rowId = before?.dataset['annotationRowId'];

    extractionGate.resolve();
    await vi.waitFor(() => {
      expect(panel?.visibleIds()).toEqual(['stable-native-id']);
    });

    expect({
      focusedRowId: host.doc.activeElement?.getAttribute('data-annotation-row-id'),
      rowId:
        panel?.root.querySelector<HTMLElement>('.abyss-annotation-card')?.dataset[
          'annotationRowId'
        ],
      scrollTop: scrollHost.scrollTop,
    }).toEqual({ focusedRowId: rowId, rowId, scrollTop: 137 });
    host.remove();
  });

  it('renders unavailable without retry when annotation listing is unsupported', async () => {
    const [pdf] = files('Books/No-annotation-listing.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());

    shell.send({ type: 'open-sidebar', tab: 'annotations' });

    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]')?.textContent,
    ).toBe('Couldn’t load annotations');
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector(
        '[data-action="retry-annotations"]',
      ),
    ).toBeNull();
  });

  it('integrates selection-first actions and Quick Highlight without intercepting native drawing tools', async () => {
    const [pdf] = files('Books/Selection-first.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = interactiveViewport();
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['annotation-write']),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });

    createdViewport.emitSelection(pdfSelection());
    const comment = shell.created.root.querySelector<HTMLTextAreaElement>(
      '.abyss-annotation-editor-comment',
    );
    if (comment === null) throw new Error('Expected unified selection comment field.');
    comment.value = 'Résumé — #review [[Source]]';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    shell.created.root.querySelector<HTMLButtonElement>('[data-editor-color="#ffd400"]')?.click();
    expect(createdViewport.projectSelectionRects).toHaveBeenCalledWith(pdfSelection());
    expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['selection-token']);
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).toContain('Résumé —');
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('.abyss-annotation-card-tags')
        ?.textContent,
    ).toContain('#review');
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('.abyss-annotation-card-links')
        ?.textContent,
    ).toContain('Source');
    await vi.waitFor(() => {
      expect(createdViewport.commitSelection).toHaveBeenCalledExactlyOnceWith(
        'selection-token',
        { color: '#ffd400', kind: 'comment', seed: 'Résumé — #review [[Source]]' },
        expect.any(AbortSignal),
      );
    });

    shell.send({ tool: 'highlight', type: 'set-annotation-tool' });
    await vi.waitFor(() => {
      expect(createdViewport.setQuickHighlight).toHaveBeenCalledWith({
        color: '#ffd400',
        enabled: true,
      });
    });
    createdViewport.emitSelection(pdfSelection('quick-native'));
    expect(createdViewport.commitSelection).toHaveBeenCalledOnce();

    shell.send({ tool: 'ink', type: 'set-annotation-tool' });
    await vi.waitFor(() => {
      expect(createdViewport.setTool).toHaveBeenCalledWith('ink');
      expect(
        shell.created.annotationToolbar?.root
          .querySelector('[data-annotation-tool="ink"]')
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
    });
    controller.refreshReadingSettings();
    expect(
      shell.created.annotationToolbar?.root
        .querySelector('[data-annotation-tool="ink"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    createdViewport.emitMode('freetext');
    expect(
      shell.created.annotationToolbar?.root
        .querySelector('[data-annotation-tool="freetext"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    createdViewport.emitMode('disabled');
    expect(
      Array.from(
        shell.created.annotationToolbar?.root.querySelectorAll('[data-annotation-tool]') ?? [],
      ).every((button) => button.getAttribute('aria-pressed') === 'false'),
    ).toBe(true);
    await controller.close();
  });

  it('retains a selected semantic color and reports a current selection writer failure', async () => {
    const [pdf] = files('Books/Selection-failure.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = interactiveViewport();
    const cause = new Error('writer rejected annotation');
    createdViewport.commitSelection.mockRejectedValueOnce(cause);
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['annotation-write']),
    });
    const state = profileState();
    const palette = [
      { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
      { color: '#5fb236', meaning: 'Definition', name: 'Green' },
    ];
    const profileValue: ReaderProfileState = {
      ...state.value,
      annotations: { ...DEFAULT_SETTINGS.annotations, palette },
    };
    const shell = capturingShellFactory();
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      profileValue,
    );
    await controller.open(pdf, createDiv());

    createdViewport.emitSelection(pdfSelection('writer-failure'));
    shell.created.root.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not create selection annotation: writer rejected annotation',
        undefined,
      );
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to edit PDF annotation', {
      action: 'create selection annotation',
      path: pdf.path,
      token: 'writer-failure',
      cause,
    });

    shell.send({ tool: 'highlight', type: 'set-annotation-tool' });
    await vi.waitFor(() => {
      expect(createdViewport.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#5fb236',
        enabled: true,
      });
    });
    await controller.close();
  });
  it('exports lazily loaded canonical annotations only after explicit toolbar intent', async () => {
    const [pdf] = files('Books/Export.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const createdSession = session(pdf.path);
    const record = annotationRecord('export-id', 1, {
      kind: 'rectangle',
      rectangle: { x: 1, y: 2, width: 3, height: 4 },
    });
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      sink([record]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const exporter = { run: vi.fn(async () => null) };
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationExporter: exporter },
    );
    await controller.open(pdf, createDiv());
    expect(listAnnotations).not.toHaveBeenCalled();

    shell.send({ type: 'export-annotations' });
    await vi.waitFor(() => {
      expect(exporter.run).toHaveBeenCalledWith(pdf, [
        {
          documentPath: pdf.path,
          documentFingerprint: createdSession.value.descriptor.fingerprint,
          annotation: record,
        },
      ]);
    });
    expect(listAnnotations).toHaveBeenCalledOnce();
  });

  it('contains export preparation failures once, clears loading, and allows a panel retry', async () => {
    const [pdf] = files('Books/Export-failure.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const createdSession = session(pdf.path);
    const recovered = annotationRecord('recovered-id', 0, {
      kind: 'point',
      point: { x: 1, y: 2 },
    });
    const listAnnotations = vi
      .fn<(signal: AbortSignal, sink: AnnotationSink) => Promise<void>>()
      .mockRejectedValueOnce(new Error('annotation index failed'))
      .mockRejectedValueOnce(new Error('annotation index failed'))
      .mockImplementationOnce(async (_signal, sink) => {
        sink([recovered]);
      });
    Object.assign(createdSession.value, { listAnnotations });
    const exporter = { run: vi.fn(async () => null) };
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationExporter: exporter },
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'export-annotations' });
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledTimes(1);
    });
    shell.send({ type: 'export-annotations' });
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledTimes(2);
    });
    expect(exporter.run).not.toHaveBeenCalled();
    expect(notices).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[abyss-documents] Failed to prepare PDF annotations for export',
      expect.objectContaining({ path: pdf.path }),
    );
    const diagnostic = log.mock.calls.find(
      ([message]) => message === '[abyss-documents] Failed to prepare PDF annotations for export',
    )?.[1] as { readonly cause?: unknown } | undefined;
    expect(diagnostic?.cause).toBeInstanceOf(Error);

    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['recovered-id']);
    });
  });

  it('keeps a superseded export preparation cancellation silent', async () => {
    const [pdf] = files('Books/Cancelled-export.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Superseded', 'AbortError'));
        });
      });
    });
    Object.assign(createdSession.value, { listAnnotations });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationExporter: { run: vi.fn(async () => null) } },
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'export-annotations' });
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledOnce();
    });
    await controller.close();
    await Promise.resolve();

    expect(notices).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('never opens export after a failed persisted annotation refresh', async () => {
    const [pdf] = files('Books/Failed-refresh-export.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    Object.assign(active.value, {
      listAnnotations: vi.fn(async () => {
        throw new Error('The live pre-save session must never be exported.');
      }),
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      pendingRevision: 1,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    let broadcast: VerifiedReloadListener | undefined;
    const adapter = adapterFor(pdf.path, active);
    adapter.open
      .mockResolvedValueOnce(active.value)
      .mockRejectedValue(new Error('persisted reopen failed'));
    const cache = {
      generation: vi.fn(() => 1),
      read: vi.fn(async () => null),
      write: vi.fn(async () => true),
      invalidate: vi.fn(async () => undefined),
    } as unknown as AnnotationCache;
    const exporter = { run: vi.fn(async () => null) };
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        annotationCache: cache,
        annotationExporter: exporter,
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected save listener.');
    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);

    shell.send({ type: 'export-annotations' });
    await vi.waitFor(() => {
      expect(adapter.open).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(notices).toHaveBeenCalledOnce();
    });
    expect(exporter.run).not.toHaveBeenCalled();
  });

  it('keeps a projected card visible when verified extraction fails', async () => {
    const [pdf] = files('Books/Failed-refresh-projection.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const activeViewport = viewport();
    const active = session(pdf.path, activeViewport);
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([]);
      },
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      pendingRevision: 1,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    let broadcast: VerifiedReloadListener | undefined;
    const adapter = adapterFor(pdf.path, active);
    adapter.open
      .mockResolvedValueOnce(active.value)
      .mockRejectedValue(new Error('verified extraction failed'));
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([]);
    });
    activeViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          nativeId: 'visible-during-failure',
          pageIndex: 0,
          type: 'highlight',
          rects: [{ x: 1, y: 2, width: 3, height: 4 }],
          selectedText: 'Still visible',
          color: '#ffd400',
          comment: '',
          tags: [],
          links: [],
          writable: true,
        },
      },
    });
    if (broadcast === undefined) throw new Error('Expected save listener.');

    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);
    await vi.waitFor(() => {
      expect(adapter.open).toHaveBeenCalledTimes(2);
    });

    expect({
      visibleIds: shell.created.sidebar?.annotationsPanel.visibleIds(),
      loading: shell.created.sidebar?.annotationsPanel.root.textContent.includes('Loading'),
    }).toEqual({ visibleIds: ['visible-during-failure'], loading: false });
  });

  it('replaces an extraction failure with a later live annotation row', async () => {
    const [pdf] = files('Books/Live-after-extraction-failure.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      listAnnotations: vi.fn(async () => Promise.reject(new Error('extraction failed'))),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(
        shell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]')?.textContent,
      ).toBe('Couldn’t load annotations');
    });

    createdViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          nativeId: 'live-recovery',
          pageIndex: 0,
          type: 'highlight',
          rects: [{ x: 1, y: 2, width: 3, height: 4 }],
          selectedText: 'Recovered live row',
          color: '#ffd400',
          comment: '',
          tags: [],
          links: [],
          writable: true,
        },
      },
    });

    expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['live-recovery']);
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]'),
    ).toBeNull();
  });

  it('recovers automatically when a later verified extraction succeeds', async () => {
    const [pdf] = files('Books/Verified-extraction-recovery.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([]);
      },
    });
    const reopened = session(pdf.path);
    Object.assign(reopened.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([annotationRecord('recovered-id', 0, { kind: 'point', point: { x: 1, y: 2 } })]);
      },
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      committedRevision: 0,
      pendingRevision: 2,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    const adapter = adapterFor(pdf.path, active);
    adapter.open
      .mockResolvedValueOnce(active.value)
      .mockRejectedValueOnce(new Error('first extraction failed'))
      .mockResolvedValueOnce(reopened.value);
    let broadcast: VerifiedReloadListener | undefined;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([]);
    });
    if (broadcast === undefined) throw new Error('Expected save listener.');

    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);
    await vi.waitFor(() => {
      expect(
        shell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]')?.textContent,
      ).toBe('Couldn’t load annotations');
    });
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector(
        '[data-action="retry-annotations"]',
      ),
    ).toBeNull();

    await broadcast({ sha256: 'c'.repeat(64), byteSize: 6, mtime: 3 }, 2, source);
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['recovered-id']);
    });
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]'),
    ).toBeNull();
    expect(adapter.open).toHaveBeenCalledTimes(3);
  });

  it('opens annotations lazily and resolves id first or unique geometry fallback without arbitrary navigation', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const record = {
      identity: { kind: 'stable', id: asAnnotationId('99R') },
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 1,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'rectangle', rectangle: { x: 10, y: 20, width: 30, height: 4 } },
      },
      color: null,
      selectedText: 'Quote',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: '',
      tags: [],
      links: [],
      capabilities: {} as DocumentAnnotation['capabilities'],
    } satisfies DocumentAnnotation;
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      sink([record]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    await controller.resolveAnnotationLink({
      id: 'old-id',
      page: 2,
      fingerprint: 'highlight:rectangle:10,20,30,4',
    });
    expect(listAnnotations).toHaveBeenCalledOnce();
    expect(shell.created.sidebar?.activeTab).toBe('annotations');
    expect(createdViewport.goTo).toHaveBeenCalledWith({ pageIndex: 1, x: 10, y: 20 });

    await controller.resolveAnnotationLink({
      id: 'missing',
      page: 3,
      fingerprint: 'rectangle:0,0,1,1',
    });
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('[role="alert"]')?.textContent,
    ).toContain('could not be found');
  });
  it('navigates point, quadrilateral, ink, and reflowable deep links and diagnoses ambiguity', async () => {
    const [pdf] = files('Books/Geometry.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const createdViewport = viewport(8);
    const createdSession = session(pdf.path, createdViewport);
    const base = annotationRecord('point', 1, { kind: 'point', point: { x: 1, y: 2 } });
    const records: DocumentAnnotation[] = [
      base,
      annotationRecord('quad', 2, {
        kind: 'quadrilaterals',
        quadrilaterals: [
          {
            topLeft: { x: 3, y: 4 },
            topRight: { x: 5, y: 4 },
            bottomLeft: { x: 3, y: 6 },
            bottomRight: { x: 5, y: 6 },
          },
        ],
      }),
      annotationRecord('ink', 3, { kind: 'ink', paths: [[{ x: 7, y: 8 }]] }),
      {
        ...annotationRecord('flow', 0, { kind: 'point', point: { x: 0, y: 0 } }),
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 'x', prefix: '', suffix: '' },
          progression: 0.5,
        },
      },
      annotationRecord('dupe-a', 4, { kind: 'point', point: { x: 9, y: 10 } }),
      {
        ...annotationRecord('dupe-b', 4, { kind: 'point', point: { x: 9, y: 10 } }),
        selectedText: 'dupe-a',
      },
    ];
    Object.assign(createdSession.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink(records);
      },
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    await controller.resolveAnnotationLink({
      id: 'point',
      page: 2,
      fingerprint: 'highlight:point:1,2',
    });
    await controller.resolveAnnotationLink({
      id: 'quad',
      page: 3,
      fingerprint: 'highlight:quadrilaterals:3,4,5,4,3,6,5,6',
    });
    await controller.resolveAnnotationLink({
      id: 'ink',
      page: 4,
      fingerprint: 'highlight:ink:7,8',
    });
    await controller.resolveAnnotationLink({
      id: 'flow',
      page: 1,
      fingerprint: 'highlight:reflowable:x',
    });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(1, { pageIndex: 1, x: 1, y: 2 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(2, { pageIndex: 2, x: 3, y: 4 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 3, x: 7, y: 8 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(4, { pageIndex: 0 });
    await controller.resolveAnnotationLink({
      id: 'old',
      page: 5,
      fingerprint: 'highlight:point:9,10',
    });
    expect(log).toHaveBeenCalledWith(
      '[abyss-documents] Could not resolve PDF annotation link',
      expect.objectContaining({ status: 'ambiguous', candidates: ['dupe-a', 'dupe-b'] }),
    );
  });
  it('configures the native annotation toolbar and forwards only supported tools and colors', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = editableViewport();
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['outline', 'text-search', 'existing-annotations', 'annotation-write']),
    });
    const state = profileState();
    Object.assign(state.value, {
      annotations: {
        author: '',
        markdownTemplate: '',
        palette: [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      },
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      state.value,
    );

    await controller.open(pdf, createDiv());
    shell.created.annotationToolbar?.root
      .querySelector<HTMLButtonElement>('[data-annotation-tool="highlight"]')
      ?.click();
    shell.created.annotationToolbar?.root
      .querySelector<HTMLButtonElement>('[data-annotation-color="#ffd400"]')
      ?.click();
    shell.send({ type: 'undo-annotation' });
    shell.send({ type: 'redo-annotation' });
    shell.send({ type: 'delete-annotation' } as never);

    await vi.waitFor(() => {
      expect(createdViewport.setTool).toHaveBeenCalled();
    });
    expect(createdViewport.setTool).toHaveBeenCalledWith('highlight');
    expect(createdViewport.setParameter).toHaveBeenCalledWith('highlight-color', '#ffd400');
    expect(createdViewport.undo).toHaveBeenCalledOnce();
    expect(createdViewport.redo).toHaveBeenCalledOnce();
    expect(createdViewport.deleteSelection).not.toHaveBeenCalled();
  });

  it('refreshes the annotation palette and meanings in an already open reader', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = editableViewport();
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['existing-annotations', 'annotation-write']),
    });
    const state = profileState();
    Object.assign(state.value, {
      annotations: {
        author: '',
        markdownTemplate: '',
        palette: [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      },
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());
    Object.assign(state.value.annotations as object, {
      palette: [{ color: '#123456', meaning: 'Question to revisit', name: 'Ocean' }],
    });

    controller.refreshReadingSettings();

    const refreshed = shell.created.annotationToolbar;
    expect(refreshed?.root.querySelector('[data-annotation-color]')).toBeNull();
    expect(
      refreshed?.root
        .querySelector('[data-annotation-tool="highlight"]')
        ?.getAttribute('aria-label'),
    ).toContain('Ocean — Question to revisit');
    expect(refreshed?.color).toBe('#123456');
  });

  it('renders the exact read-only reason and never calls a missing native editor', async () => {
    const [pdf] = files('Books/Signed.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: {
        readOnlyReason: {
          code: 'signed-document',
          message: 'Signed PDF documents are opened read-only to preserve signatures.',
        },
      },
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );

    await controller.open(pdf, createDiv());

    expect(shell.created.annotationToolbar?.root.getAttribute('aria-description')).toContain(
      'Signed PDF',
    );
    expect(
      shell.created.annotationToolbar?.root.querySelector<HTMLButtonElement>(
        '[data-annotation-tool="highlight"]',
      )?.disabled,
    ).toBe(true);
  });

  it('maps Ink and FreeText colors and contains one failure boundary per annotation action', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = editableViewport();
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['annotation-write']),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-annotation-tool', tool: 'ink' });
    await vi.waitFor(() => {
      expect(createdViewport.setParameter).toHaveBeenCalledWith('ink-color', '#ffd400');
    });
    shell.created.annotationToolbar?.setTool('ink');
    shell.send({ type: 'set-annotation-color', color: '#111111' });
    expect(createdViewport.setParameter).toHaveBeenLastCalledWith('ink-color', '#111111');
    shell.send({ type: 'set-annotation-tool', tool: 'freetext' });
    await vi.waitFor(() => {
      expect(createdViewport.setParameter).toHaveBeenCalledWith('freetext-color', '#111111');
    });
    shell.created.annotationToolbar?.setTool('freetext');
    shell.send({ type: 'set-annotation-color', color: '#222222' });
    expect(createdViewport.setParameter).toHaveBeenLastCalledWith('freetext-color', '#222222');

    createdViewport.setTool
      .mockRejectedValueOnce(new Error('tool failed'))
      .mockRejectedValueOnce(new Error('tool failed'));
    createdViewport.setParameter.mockImplementationOnce(() => {
      throw new Error('color failed');
    });
    createdViewport.undo.mockImplementationOnce(() => {
      throw new Error('undo failed');
    });
    shell.send({ type: 'set-annotation-tool', tool: 'highlight' });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(1);
    });
    shell.send({ type: 'set-annotation-tool', tool: 'highlight' });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(2);
    });
    shell.send({ type: 'set-annotation-color', color: '#333333' });
    shell.send({ type: 'undo-annotation' });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(4);
    });
    expect(notices).toHaveBeenCalledTimes(3);
  });

  it('commits tool UI only after native mode success and reapplies the selected palette color', async () => {
    const [pdf] = files('Books/Transactional.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = editableViewport();
    const highlight = deferred<void>();
    const ink = deferred<void>();
    createdViewport.setTool.mockImplementation((tool) => {
      if (tool === 'highlight') return highlight.promise;
      if (tool === 'ink') return ink.promise;
      return Promise.resolve();
    });
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['annotation-write']),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'set-annotation-color', color: '#ff6666' });

    shell.send({ type: 'set-annotation-tool', tool: 'highlight' });
    expect(
      shell.created.annotationToolbar?.root
        .querySelector('[data-annotation-tool="highlight"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    shell.send({ type: 'set-annotation-tool', tool: 'ink' });
    highlight.reject(new DOMException('Superseded', 'AbortError'));
    ink.resolve();

    await vi.waitFor(() => {
      expect(
        shell.created.annotationToolbar?.root
          .querySelector('[data-annotation-tool="ink"]')
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
    });
    expect(createdViewport.setParameter).toHaveBeenLastCalledWith('ink-color', '#ff6666');
  });

  it('rolls back failed tool/color UI and keeps superseded AbortError silent', async () => {
    const [pdf] = files('Books/Failure.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = editableViewport();
    createdViewport.setTool.mockRejectedValueOnce(new DOMException('Superseded', 'AbortError'));
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['annotation-write']),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-annotation-tool', tool: 'highlight' });
    await new Promise((resolve) => {
      queueMicrotask(() => {
        resolve(undefined);
      });
    });
    expect(notices).not.toHaveBeenCalled();
    expect(
      shell.created.annotationToolbar?.root
        .querySelector('[data-annotation-tool="highlight"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');

    createdViewport.setTool.mockRejectedValueOnce(new Error('mode failed'));
    shell.send({ type: 'set-annotation-tool', tool: 'ink' });
    await vi.waitFor(() => {
      expect(notices).toHaveBeenCalledTimes(1);
    });
    expect(
      shell.created.annotationToolbar?.root
        .querySelector('[data-annotation-tool="ink"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('rolls native mode back when applying the committed tool color fails', async () => {
    const [pdf] = files('Books/Color-rollback.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = editableViewport();
    createdViewport.setParameter.mockImplementationOnce(() => {
      throw new Error('color failed');
    });
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['annotation-write']),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-annotation-tool', tool: 'highlight' });

    await vi.waitFor(() => {
      expect(createdViewport.setTool.mock.calls).toEqual([['highlight'], ['select']]);
      expect(notices).toHaveBeenCalledWith(
        'Could not change annotation tool: color failed',
        undefined,
      );
    });
    expect(
      shell.created.annotationToolbar?.root
        .querySelector('[data-annotation-tool="highlight"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
  });
  it('does zero annotation work until Annotations is explicitly requested and cancels stale work', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(
      async (_signal: AbortSignal, sink: (items: readonly never[]) => void) => {
        sink([]);
      },
    );
    Object.assign(createdSession.value, { listAnnotations });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    expect(listAnnotations).not.toHaveBeenCalled();

    shell.send({ type: 'toggle-sidebar' });
    expect(listAnnotations).not.toHaveBeenCalled();
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledOnce();
    });
    const signal = listAnnotations.mock.calls[0]?.[0];
    await controller.close();
    expect(signal?.aborted).toBe(true);
  });
  it('loads a matching derived cache without extracting and reports a background extraction failure once', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const cause = new Error('annotation read failed');
    const listAnnotations = vi.fn(async () => {
      throw cause;
    });
    Object.assign(createdSession.value, { listAnnotations });
    const cacheRead = vi.fn(async (): Promise<readonly DocumentAnnotation[] | null> => []);
    const cacheWrite = vi.fn(async () => true);
    const cache = {
      generation: vi.fn(() => 0),
      read: cacheRead,
      write: cacheWrite,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(cacheRead).toHaveBeenCalledOnce();
    });
    expect(listAnnotations).not.toHaveBeenCalled();

    cacheRead.mockResolvedValueOnce(null);
    await controller.close();
    const secondSession = session(pdf.path);
    Object.assign(secondSession.value, { listAnnotations });
    const secondShell = capturingShellFactory();
    const failed = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, secondSession).value]),
      secondShell.createShell,
      undefined,
      { annotationCache: cache },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await failed.open(pdf, createDiv());
    secondShell.send({ type: 'toggle-sidebar' });
    secondShell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(
        secondShell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]')
          ?.textContent,
      ).toBe('Couldn’t load annotations');
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to extract PDF annotations', {
      path: pdf.path,
      page: 1,
      cause,
    });
  });
  it('extracts annotations when the derived cache read fails', async () => {
    const [pdf] = files('Books/Cache-read-failure.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const extracted = annotationRecord('extracted-id', 0, {
      kind: 'point',
      point: { x: 1, y: 2 },
    });
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      sink([extracted]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const cause = new Error('cache read failed');
    const cache = {
      generation: vi.fn(() => 0),
      read: vi.fn(async () => {
        throw cause;
      }),
      write: vi.fn(async () => true),
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'open-sidebar', tab: 'annotations' });

    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['extracted-id']);
    });
    expect(listAnnotations).toHaveBeenCalledOnce();
    expect(shell.created.sidebar?.annotationsPanel.root.querySelector('[role="alert"]')).toBeNull();
    expect(log).toHaveBeenCalledWith('[abyss-documents] Annotation cache read failed', {
      path: pdf.path,
      cause,
    });
  });
  it('contains the narrow annotation-load test fault to cache fallback and extraction timing', async () => {
    const [pdf] = files('Books/Test-fault-fallback.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const extracted = annotationRecord('fault-fallback', 0, {
      kind: 'point',
      point: { x: 1, y: 2 },
    });
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      sink([extracted]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const cacheRead = vi.fn(async () => [
      annotationRecord('cached', 0, { kind: 'point', point: { x: 0, y: 0 } }),
    ]);
    const cache = {
      generation: vi.fn(() => 0),
      read: cacheRead,
      write: vi.fn(async () => true),
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    controller.setAnnotationLoadTestFault({ cacheRead: 'fail', extractionDelayMs: 10 });
    await controller.open(pdf, createDiv());

    shell.send({ type: 'open-sidebar', tab: 'annotations' });

    expect(shell.created.sidebar?.annotationsPanel.root.dataset['annotationState']).toBe('loading');
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['fault-fallback']);
    });
    expect(cacheRead).not.toHaveBeenCalled();
    expect(listAnnotations).toHaveBeenCalledOnce();
    expect(() => {
      controller.setAnnotationLoadTestFault({ extractionDelayMs: 5_001 });
    }).toThrow(RangeError);
  });
  it('keeps live rows visible when the narrow extraction fault is terminal', async () => {
    const [pdf] = files('Books/Test-fault-terminal.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const listAnnotations = vi.fn(async () => undefined);
    Object.assign(createdSession.value, { listAnnotations });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    controller.setAnnotationLoadTestFault({ extractionFailure: true });
    await controller.open(pdf, createDiv());
    createdViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          color: '#ffd400',
          comment: 'Visible native annotation',
          links: [],
          nativeId: 'native-visible-during-failure',
          pageIndex: 0,
          rects: [{ height: 8, width: 20, x: 1, y: 2 }],
          selectedText: 'Visible native annotation',
          tags: [],
          type: 'highlight',
          writable: false,
        },
      },
    });

    shell.send({ type: 'open-sidebar', tab: 'annotations' });

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        '[abyss-documents] Failed to extract PDF annotations',
        expect.objectContaining({ path: pdf.path }),
      );
    });
    expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([
      'native-visible-during-failure',
    ]);
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]'),
    ).toBeNull();
    createdViewport.emit({
      type: 'annotation-change',
      change: {
        operation: 'upsert',
        annotation: {
          color: '#ff6666',
          comment: 'Late native snapshot',
          links: [],
          nativeId: 'native-visible-after-failure',
          pageIndex: 0,
          rects: [{ height: 8, width: 20, x: 30, y: 2 }],
          selectedText: 'Late native snapshot',
          tags: [],
          type: 'highlight',
          writable: false,
        },
      },
    });
    expect(listAnnotations).not.toHaveBeenCalled();
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).not.toContain(
      'No annotations',
    );
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('[data-action*="retry"]'),
    ).toBeNull();
    expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([
      'native-visible-during-failure',
      'native-visible-after-failure',
    ]);
    expect(
      shell.created.sidebar?.annotationsPanel.root.querySelector('[role="status"]'),
    ).toBeNull();
    controller.setAnnotationLoadTestFault(null);
  });
  it('keeps extracted annotations when the derived cache write fails', async () => {
    const [pdf] = files('Books/Cache-write-failure.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const extracted = annotationRecord('extracted-id', 0, {
      kind: 'point',
      point: { x: 1, y: 2 },
    });
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      sink([extracted]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const cause = new Error('cache write failed');
    const cache = {
      generation: vi.fn(() => 0),
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        throw cause;
      }),
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'open-sidebar', tab: 'annotations' });

    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['extracted-id']);
    });
    expect(listAnnotations).toHaveBeenCalledOnce();
    expect(shell.created.sidebar?.annotationsPanel.root.querySelector('[role="alert"]')).toBeNull();
    expect(log).toHaveBeenCalledWith('[abyss-documents] Annotation cache write failed', {
      path: pdf.path,
      cause,
    });
  });
  it('logs the exact extraction page carried through the session error boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const pageFailure = Object.assign(new Error('page failed'), {
      name: 'PdfAnnotationExtractionError',
      pageNumber: 3,
    });
    const cause = new DocumentOpenError(pdf.path, 'Could not read annotations.', pageFailure);
    Object.assign(createdSession.value, {
      listAnnotations: vi.fn(async () => {
        throw cause;
      }),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalled();
    });

    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to extract PDF annotations', {
      path: pdf.path,
      page: 3,
      cause,
    });
  });
  it('keeps a confirmed empty extraction when its derived cache write is invalidated', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(
      async (_signal: AbortSignal, sink: (items: readonly never[]) => void) => {
        sink([]);
      },
    );
    Object.assign(createdSession.value, { listAnnotations });
    const cacheWrite = vi.fn(async () => false);
    const cache = {
      generation: vi.fn(() => 0),
      read: vi.fn(async () => null),
      write: cacheWrite,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(cacheWrite).toHaveBeenCalledOnce();
    });
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).toContain('No annotations');
    expect(log).not.toHaveBeenCalledWith(
      '[abyss-documents] Failed to extract PDF annotations',
      expect.anything(),
    );
  });
  it('retries extraction after a cache read is invalidated and never renders stale data', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      sink([]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const generation = vi.fn(() => 1);
    const cacheRead = vi.fn(async () => {
      throw new StaleAnnotationCacheReadError();
    });
    const cacheWrite = vi.fn(async () => true);
    const cache = {
      generation,
      read: cacheRead,
      write: cacheWrite,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();

    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledOnce();
    });
    expect(cacheRead).toHaveBeenCalledWith(pdf.path, pdf.path, 1);
    expect(cacheWrite).toHaveBeenCalledWith(expect.objectContaining({ annotations: [] }), 1);
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).toContain('No annotations');
  });
  it('mounts a session viewport into the shell document region', async () => {
    beginPluginActivation();
    endPluginActivation();
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    const host = createDiv();

    await controller.open(pdf, host);

    const documentHost = host.querySelector<HTMLElement>('[data-region="document"]');
    expect(documentHost).not.toBeNull();
    expect(createdViewport.mount).toHaveBeenCalledWith(documentHost);
    expect(host.querySelector('[data-region="sidebar"]')).toBeNull();
    expect(
      readerPerformanceSnapshot().marks.filter(({ name }) => name === 'reader-intent'),
    ).toHaveLength(1);
  });

  it('closes the previous viewport and session before loading another file', async () => {
    const [firstPdf, secondPdf] = files('Books/First.pdf', 'Books/Second.pdf');
    if (firstPdf === undefined || secondPdf === undefined)
      throw new Error('Expected PDF fixtures.');
    const firstViewport = viewport();
    const firstSession = session(firstPdf.path, firstViewport);
    const secondSession = session(secondPdf.path);
    const secondAdapter = adapterFor(secondPdf.path, secondSession);
    const firstAdapter = adapterFor(firstPdf.path, firstSession);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([firstAdapter.value, secondAdapter.value]),
    );
    const host = createDiv();

    await controller.open(firstPdf, host);
    await controller.open(secondPdf, host);

    expect(firstViewport.destroy).toHaveBeenCalledOnce();
    expect(firstSession.close).toHaveBeenCalledOnce();
    expect(firstSession.close.mock.invocationCallOrder[0]).toBeLessThan(
      secondAdapter.open.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('propagates an owned open failure after closing the partial session', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const cause = new DocumentOpenError(pdf.path, 'Could not create this PDF view.');
    const createdSession = session(pdf.path);
    createdSession.createViewport.mockRejectedValue(cause);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toBe(cause);

    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('destroys the active viewport and closes its session exactly once', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await Promise.all([controller.close(), controller.close()]);
    await controller.close();

    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('cancels a queued file before its adapter starts when a newer file wins', async () => {
    const [firstPdf, secondPdf] = files('Books/First.pdf', 'Books/Second.pdf');
    if (firstPdf === undefined || secondPdf === undefined)
      throw new Error('Expected PDF fixtures.');
    const firstSession = session(firstPdf.path);
    const secondSession = session(secondPdf.path);
    const firstAdapter = adapterFor(firstPdf.path, firstSession);
    const secondAdapter = adapterFor(secondPdf.path, secondSession);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([firstAdapter.value, secondAdapter.value]),
    );
    const host = createDiv();

    const firstOpen = controller.open(firstPdf, host);
    const secondOpen = controller.open(secondPdf, host);

    await expect(firstOpen).rejects.toMatchObject({ name: 'DocumentCancelledError' });
    await expect(secondOpen).resolves.toBeUndefined();
    expect(firstAdapter.open).not.toHaveBeenCalled();
    expect(secondAdapter.open).toHaveBeenCalledOnce();
  });

  it('maps an unowned adapter failure to a typed open error', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const adapter = adapterFor(pdf.path, createdSession);
    const cause = new Error('vault bridge failed');
    adapter.open.mockRejectedValue(cause);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toMatchObject({
      name: 'DocumentOpenError',
      path: pdf.path,
      cause,
    });
  });

  it('destroys and closes partial state when viewport mounting fails', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const cause = new Error('viewer mount failed');
    createdViewport.mount.mockRejectedValue(cause);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toMatchObject({
      name: 'DocumentOpenError',
      cause,
    });
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('preserves the primary open failure while logging partial cleanup failure', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const cause = new DocumentOpenError(pdf.path, 'Could not create this PDF view.');
    const createdSession = session(pdf.path);
    createdSession.createViewport.mockRejectedValue(cause);
    createdSession.close.mockRejectedValue(new Error('partial close failed'));
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(controller.open(pdf, createDiv())).rejects.toBe(cause);

    expect(log).toHaveBeenCalledOnce();
  });

  it('attempts both active cleanup operations and keeps the first error', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const firstCause = new Error('viewport cleanup failed');
    createdViewport.destroy.mockRejectedValue(firstCause);
    const createdSession = session(pdf.path, createdViewport);
    createdSession.close.mockRejectedValue(new Error('session cleanup failed'));
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await expect(controller.close()).rejects.toBe(firstCause);

    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
    await expect(controller.close()).resolves.toBeUndefined();
  });

  it('normalizes a non-error cleanup rejection', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    createdSession.close.mockRejectedValue('worker vanished');
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await expect(controller.close()).rejects.toThrow('Unknown reader cleanup failure');
  });

  it('restores a remembered reading profile after the fingerprint is known', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      defaultProfile: 'sepia',
      profiles: { [pdf.path]: 'dark' },
      rememberPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );

    await controller.open(pdf, createDiv());

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.dark),
    );
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  it('updates the fingerprint profile when the current profile changes', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ rememberPerDocument: true });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      profiles.value,
    );
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-profile', profile: 'light' });

    expect(profiles.profiles[pdf.path]).toBe('light');
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.light),
    );
    expect(shell.created.root.getAttribute('data-reading-profile')).toBe('light');
  });

  it('keeps the chosen layout reflected in the toolbar without creating a second reader setting surface', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const layout: ReaderLayout = { pages: 'facing', scrolling: 'page-by-page' };
    const menuChoices = captureMenuChoices();
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-layout', layout });

    expect(createdSession.createViewport).toHaveBeenCalledOnce();
    shell.created.root.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();
    expect(menuChoices.find((choice) => choice.title === 'Two pages')?.checked).toBe(true);
    expect(menuChoices.find((choice) => choice.title === 'Continuous scrolling')?.checked).toBe(
      false,
    );
  });

  it('applies the global layout and remembers later choices by fingerprint when enabled', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const state = profileState({
      defaultLayout: { pages: 'facing', scrolling: 'continuous' },
      rememberLayoutPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());

    expect(createdViewport.setLayout).toHaveBeenCalledWith({
      pages: 'facing',
      scrolling: 'continuous',
    });
    shell.send({
      type: 'set-layout',
      layout: { pages: 'single', scrolling: 'page-by-page' },
    });

    expect(createdViewport.setLayout).toHaveBeenLastCalledWith({
      pages: 'single',
      scrolling: 'page-by-page',
    });
    expect(state.layouts[pdf.path]).toEqual({ pages: 'single', scrolling: 'page-by-page' });
  });

  it('restores a fingerprint layout only when layout memory is enabled', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const remembered = { pages: 'facing', scrolling: 'page-by-page' } as const;
    for (const rememberLayoutPerDocument of [true, false]) {
      const createdViewport = viewport(8);
      const createdSession = session(pdf.path, createdViewport);
      const adapter = adapterFor(pdf.path, createdSession);
      const state = profileState({
        defaultLayout: { pages: 'single', scrolling: 'continuous' },
        layouts: { [pdf.path]: remembered },
        rememberLayoutPerDocument,
      });
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapter.value]),
        undefined,
        state.value,
      );

      await controller.open(pdf, createDiv());

      expect(createdViewport.setLayout).toHaveBeenCalledWith(
        rememberLayoutPerDocument ? remembered : { pages: 'single', scrolling: 'continuous' },
      );
      await controller.close();
    }
  });

  it('steps between facing spreads while direct even-page entry stays exact', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const state = profileState({
      defaultLayout: { pages: 'facing', scrolling: 'page-by-page' },
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());
    createdViewport.emit({ type: 'page-change', pageIndex: 3 });

    shell.send({ type: 'previous-page' });
    shell.send({ type: 'next-page' });
    shell.send({ type: 'go-to-page', pageIndex: 5 });
    shell.send({ type: 'zoom-step', direction: 1 });

    expect(createdViewport.goTo).toHaveBeenNthCalledWith(1, { pageIndex: 0 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(2, { pageIndex: 2 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 5 });
    expect(createdViewport.stepScale).toHaveBeenCalledWith(1);
  });

  it('does not let an older navigation failure roll back a newer request to the same page', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const navigationCause = new Error('first request failed');
    createdViewport.goTo.mockRejectedValueOnce(navigationCause).mockResolvedValue(undefined);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    createdViewport.emit({ type: 'page-change', pageIndex: 1 });

    shell.send({ type: 'previous-page' });
    shell.send({ type: 'previous-page' });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to navigate PDF page', {
        pageIndex: 0,
        cause: navigationCause,
      });
    });
    shell.send({ type: 'next-page' });

    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 1 });
  });

  it('keeps an active layout when unrelated reading settings refresh', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const state = profileState({
      defaultLayout: { pages: 'single', scrolling: 'continuous' },
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());
    shell.send({
      type: 'set-layout',
      layout: { pages: 'facing', scrolling: 'page-by-page' },
    });
    (state.value.reading.custom as { brightness: number }).brightness = 1.25;

    controller.refreshReadingSettings();

    expect(createdViewport.setLayout).toHaveBeenLastCalledWith({
      pages: 'facing',
      scrolling: 'page-by-page',
    });

    Object.assign(state.value.layout.default, {
      pages: 'single',
      scrolling: 'page-by-page',
    });
    controller.refreshReadingSettings();

    expect(createdViewport.setLayout).toHaveBeenLastCalledWith({
      pages: 'single',
      scrolling: 'page-by-page',
    });
  });

  it('contains synchronous scale, step, and layout failures at the reader boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    createdViewport.setScale.mockImplementationOnce(() => {
      throw new Error('scale failed');
    });
    createdViewport.stepScale.mockImplementationOnce(() => {
      throw new Error('step failed');
    });
    createdViewport.setLayout.mockImplementationOnce(() => {
      throw new Error('layout failed');
    });

    shell.send({ type: 'set-scale', scale: 1.25 });
    shell.send({ type: 'zoom-step', direction: 1 });
    shell.send({
      type: 'set-layout',
      layout: { pages: 'facing', scrolling: 'continuous' },
    });

    expect(notices).toHaveBeenCalledWith('Could not change zoom: scale failed', undefined);
    expect(notices).toHaveBeenCalledWith('Could not change zoom: step failed', undefined);
    expect(notices).toHaveBeenCalledWith('Could not change page layout: layout failed', undefined);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('reports a native comment mutation failure once at the reader Notice boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    const event = {
      type: 'annotation-mutation-error',
      action: 'save-comment',
      cause: new Error('comment setter rejected'),
    } as const;

    createdViewport.emit(event);
    createdViewport.emit(event);

    expect(notices).toHaveBeenCalledOnce();
    expect(notices).toHaveBeenCalledWith(
      'Could not save PDF annotation comment: comment setter rejected',
      undefined,
    );
    expect(log).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['change-color', 'Could not change PDF annotation color: native rejected'],
    ['delete-comment', 'Could not delete PDF annotation comment: native rejected'],
    ['delete-annotation', 'Could not delete PDF annotation: native rejected'],
  ] as const)('labels the %s native failure action precisely', async (action, message) => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    createdViewport.emit({
      type: 'annotation-mutation-error',
      action,
      cause: new Error('native rejected'),
    });

    expect(notices).toHaveBeenCalledWith(message, undefined);
  });

  it('retains the active annotation color when it remains in a refreshed palette', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = editableViewport();
    const createdSession = session(pdf.path, createdViewport);
    Object.assign(createdSession.value, {
      annotationCapabilities: { readOnlyReason: null },
      capabilities: new Set(['annotation-write']),
    });
    const state = profileState();
    Object.assign(state.value, {
      annotations: {
        author: '',
        markdownTemplate: '',
        palette: [
          { color: '#ffd400', meaning: '', name: 'Yellow' },
          { color: '#123456', meaning: '', name: 'Ocean' },
        ],
      },
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'set-annotation-color', color: '#123456' });

    controller.refreshReadingSettings();

    expect(shell.created.annotationToolbar?.color).toBe('#123456');
  });

  it('uses the global default and leaves the fingerprint map untouched when remembering is off', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      defaultProfile: 'sepia',
      profiles: { [pdf.path]: 'dark' },
      rememberPerDocument: false,
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      profiles.value,
    );

    await controller.open(pdf, createDiv());
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.sepia),
    );
    shell.send({ type: 'set-profile', profile: 'light' });

    expect(profiles.profiles).toEqual({ [pdf.path]: 'dark' });
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  it('falls back to the global default for an unknown fingerprint', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      defaultProfile: 'sepia',
      profiles: { 'another-fingerprint': 'dark' },
      rememberPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );

    await controller.open(pdf, createDiv());

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.sepia),
    );
  });

  it('updates Follow Obsidian for owner-document theme changes without rewriting stored profile state', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const host = createDiv();
    host.doc.body.removeClass('theme-light');
    host.doc.body.addClass('theme-dark');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      profiles: { [pdf.path]: 'follow-obsidian' },
      rememberPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );
    await controller.open(pdf, host);
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith({
      pageColors: {
        background: BUILTIN_PROFILES.dark.background,
        foreground: BUILTIN_PROFILES.dark.foreground,
      },
      brightness: BUILTIN_PROFILES.dark.brightness,
      contrast: BUILTIN_PROFILES.dark.contrast,
      imageDim: BUILTIN_PROFILES.dark.imageDim,
    });

    host.doc.body.removeClass('theme-dark');
    host.doc.body.addClass('theme-light');
    await vi.waitFor(() => {
      expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith({
        pageColors: {
          background: BUILTIN_PROFILES.light.background,
          foreground: BUILTIN_PROFILES.light.foreground,
        },
        brightness: BUILTIN_PROFILES.light.brightness,
        contrast: BUILTIN_PROFILES.light.contrast,
        imageDim: BUILTIN_PROFILES.light.imageDim,
      });
    });

    expect(profiles.profiles[pdf.path]).toBe('follow-obsidian');
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  it('reapplies bounded custom appearance settings to an active custom profile', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ defaultProfile: 'custom' });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );
    await controller.open(pdf, createDiv());
    (profiles.value.reading.custom as { brightness: number }).brightness = 9;

    controller.refreshReadingSettings();

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      expect.objectContaining({ brightness: 1.5 }),
    );
  });

  it('routes navigation and scale intents and follows viewport page events', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());

    createdViewport.emit({ type: 'page-change', pageIndex: 1 });
    shell.send({ type: 'previous-page' });
    shell.send({ type: 'next-page' });
    shell.send({ type: 'go-to-page', pageIndex: 99 });
    shell.send({ type: 'set-scale', scale: 'page-fit' });
    createdViewport.emit({ type: 'scale-change', scale: 1.25 });
    shell.send({ type: 'toggle-sidebar' });

    expect(createdViewport.goTo).toHaveBeenNthCalledWith(1, { pageIndex: 0 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(2, { pageIndex: 1 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 2 });
    expect(createdViewport.setScale).toHaveBeenCalledWith('page-fit');
  });

  it('opens the lazy outline from the toolbar but never for deep navigation', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    createdSession.value.getOutline = vi.fn(async () => [
      { id: 'chapter', label: 'Chapter', target: { pageIndex: 1 }, children: [] },
    ]);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());

    shell.send({ type: 'go-to-page', pageIndex: 1 });
    expect(shell.created.sidebar).toBeNull();

    shell.send({ type: 'toggle-sidebar' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.outlinePanel.root.textContent).toContain('Chapter');
    });
    expect(shell.created.sidebar?.activeTab).toBe('outline');
    shell.created.sidebar?.outlinePanel.root
      .querySelector<HTMLElement>('[data-outline-id="chapter"]')
      ?.click();
    expect(createdViewport.goTo).toHaveBeenLastCalledWith({ pageIndex: 1 });
    shell.send({ type: 'toggle-sidebar' });
    expect(shell.created.sidebar?.isOpen).toBe(false);
  });

  it('contains an outline-loading failure at one visible and diagnostic boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const cause = new Error('destination table is damaged');
    createdSession.value.getOutline = vi.fn(async () => {
      throw cause;
    });
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    controller.showOutline();

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not load document outline: destination table is damaged',
        undefined,
      );
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to load PDF outline', {
      path: pdf.path,
      cause,
    });
    expect(shell.created.sidebar?.outlinePanel.root.textContent).toContain('No outline available.');
  });

  it('keeps document search query, selected PDF match, and target page synchronized', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const host = createDiv();
    host.doc.body.append(host);
    await controller.open(pdf, host);
    const OwnerKeyboardEvent = (
      shell.created.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    const OwnerEvent = (shell.created.root.win as Window & { Event: typeof Event }).Event;
    shell.created.documentHost.dispatchEvent(
      new OwnerKeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        metaKey: true,
        key: 'f',
      }),
    );
    const input = shell.created.sidebar?.searchPanel.input;
    if (input === undefined) throw new Error('Expected document search input.');
    input.value = 'needle';
    input.dispatchEvent(new OwnerEvent('input', { bubbles: true }));
    createdViewport.emit({
      type: 'search-results',
      results: {
        query: 'needle',
        complete: true,
        hits: [
          {
            id: 'first',
            pageIndex: 0,
            matchIndex: 0,
            preview: 'First needle',
            previewMatches: [{ end: 12, start: 6 }],
          },
          {
            id: 'second',
            pageIndex: 2,
            matchIndex: 0,
            preview: 'Second needle',
            previewMatches: [{ end: 13, start: 7 }],
          },
        ],
      },
    });
    shell.created.sidebar?.searchPanel.root
      .querySelectorAll<HTMLButtonElement>('[data-search-result]')[1]
      ?.click();

    expect(createdViewport.search).toHaveBeenCalledWith('needle');
    await vi.waitFor(() => {
      expect(createdViewport.selectSearchHit).toHaveBeenCalledWith(
        {
          id: 'second',
          pageIndex: 2,
          matchIndex: 0,
          preview: 'Second needle',
          previewMatches: [{ end: 13, start: 7 }],
        },
        'needle',
      );
    });
    expect(createdViewport.goTo).not.toHaveBeenCalled();

    shell.created.sidebar?.searchPanel.root
      .querySelector<HTMLButtonElement>('[data-action="previous-result"]')
      ?.click();
    await vi.waitFor(() => {
      expect(createdViewport.selectSearchHit).toHaveBeenLastCalledWith(
        {
          id: 'first',
          pageIndex: 0,
          matchIndex: 0,
          preview: 'First needle',
          previewMatches: [{ end: 12, start: 6 }],
        },
        'needle',
      );
    });

    input.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(createdViewport.search).toHaveBeenLastCalledWith('');
    const restoreFocus = vi.spyOn(shell.created.toolbar.sidebarButton, 'focus');
    input.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(shell.created.sidebar?.isOpen).toBe(false);
    expect(createdViewport.focus).not.toHaveBeenCalled();
    expect(restoreFocus).toHaveBeenCalledOnce();
    await controller.close();
    host.remove();
  });

  it('loads the outline once when its tab is selected after Search opened first', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const getOutline = vi.fn(async () => [
      { id: 'chapter', label: 'Late outline', target: { pageIndex: 1 }, children: [] },
    ]);
    createdSession.value.getOutline = getOutline;
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    controller.searchDocument();

    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="outline"]')
      ?.click();

    await vi.waitFor(() => {
      expect(shell.created.sidebar?.outlinePanel.root.textContent).toContain('Late outline');
    });
    expect(getOutline).toHaveBeenCalledOnce();
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="search"]')
      ?.click();
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="outline"]')
      ?.click();
    expect(getOutline).toHaveBeenCalledOnce();
  });

  it('contains a timed-out search selection at the active reader boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const cause = new DOMException('PDF search selection timed out.', 'TimeoutError');
    createdViewport.selectSearchHit.mockRejectedValueOnce(cause);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    controller.searchDocument();
    const input = shell.created.sidebar?.searchPanel.input;
    if (input === undefined) throw new Error('Expected search input.');
    const OwnerEvent = (input.win as Window & { Event: typeof Event }).Event;
    input.value = 'needle';
    input.dispatchEvent(new OwnerEvent('input', { bubbles: true }));
    createdViewport.emit({
      type: 'search-results',
      results: {
        query: 'needle',
        complete: true,
        hits: [
          {
            id: 'hit',
            pageIndex: 1,
            matchIndex: 0,
            preview: 'Needle',
            previewMatches: [{ end: 6, start: 0 }],
          },
        ],
      },
    });
    shell.created.sidebar?.searchPanel.root
      .querySelector<HTMLButtonElement>('[data-search-result]')
      ?.click();

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not select search result: PDF search selection timed out.',
        undefined,
      );
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to select PDF search result', {
      hitId: 'hit',
      cause,
    });
  });

  it('ignores reader commands and render errors when no interactive action is needed', async () => {
    const controller = new ReaderController(new DocumentAdapterRegistry([]));
    controller.showOutline();
    controller.searchDocument();

    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const activeController = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    const host = createDiv();
    await activeController.open(pdf, host);
    createdViewport.emit({ type: 'render-error', pageIndex: 0, cause: new Error('render') });
    activeController.searchDocument();
    expect(host.querySelector('[data-sidebar-panel="search"]')).not.toBeNull();
    await activeController.close();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
  });

  it('reports a failed remembered-profile write without changing the active rendering', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ rememberPerDocument: true });
    const cause = new Error('settings write failed');
    profiles.updateProfile.mockRejectedValueOnce(cause);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      profiles.value,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-profile', profile: 'dark' });
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not remember reading profile: settings write failed',
        undefined,
      );
    });

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.dark),
    );
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to remember PDF reading profile', {
      fingerprint: pdf.path,
      profile: 'dark',
      cause,
    });
  });

  it('reports a failed remembered-layout write without changing the active layout', async () => {
    const [pdf] = files('Books/Layout-persistence-failure.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ rememberLayoutPerDocument: true });
    const cause = new Error('layout settings write failed');
    profiles.updateLayout.mockRejectedValueOnce(cause);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      profiles.value,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    const layout = { pages: 'facing', scrolling: 'page-by-page' } as const;

    shell.send({ type: 'set-layout', layout });
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not remember page layout: layout settings write failed',
        undefined,
      );
    });

    expect(createdViewport.setLayout).toHaveBeenLastCalledWith(layout);
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to remember PDF page layout', {
      fingerprint: pdf.path,
      layout,
      cause,
    });
    await controller.close();
  });

  it('falls back to Default when persisted settings contain an unknown profile id', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ defaultProfile: 'unknown' as ReadingProfileId });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );

    await controller.open(pdf, createDiv());

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith({
      pageColors: null,
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    });
  });

  it('cleans the viewport event subscription with the active reader', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await controller.close();

    expect(createdViewport.unsubscribe).toHaveBeenCalledOnce();
  });

  it('still closes the viewport and session when event unsubscription fails', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const cause = new Error('subscription cleanup failed');
    createdViewport.unsubscribe.mockImplementation(() => {
      throw cause;
    });
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await expect(controller.close()).rejects.toBe(cause);

    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('unsubscribes once and tears down resources when theme observation setup fails', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const cause = new Error('theme observation failed');
    vi.spyOn(ReaderShell.prototype, 'onThemeChange').mockImplementationOnce(() => {
      throw cause;
    });
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toMatchObject({ cause });

    expect(createdViewport.unsubscribe).toHaveBeenCalledOnce();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('shows one actionable failure when page navigation rejects', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const navigationCause = new Error('destination is unavailable');
    createdViewport.goTo.mockImplementation(async () => {
      throw navigationCause;
    });
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'go-to-page', pageIndex: 1 });
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not go to page 2: destination is unavailable',
        undefined,
      );
    });

    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to navigate PDF page', {
      pageIndex: 1,
      cause: navigationCause,
    });
  });

  it('connects native dirty revisions to invisible autosave and force-save verification', async () => {
    beginPluginActivation();
    endPluginActivation();
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdViewport = viewport();
      const createdSession = session(pdf.path, createdViewport);
      const baseToken: BaseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
      const dirtyListeners: Array<(revision: number) => void> = [];
      const source: NativeEditableSaveSession = {
        baseToken,
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(async () => ({ revision: 1, baseToken, bytes: new Uint8Array([1]) })),
        commit: vi.fn(),
        destroy: vi.fn(),
      };
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          dirtyListeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn(async (request: NativeDocumentSaveRequest) => ({
        verified: true as const,
        generation: request.revision,
        sha256: 'b'.repeat(64),
        byteSize: 5,
        committedAt: '2026-08-13T00:00:00.000Z' as never,
      }));
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());

      dirtyListeners[0]?.(1);
      await vi.advanceTimersByTimeAsync(749);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0]).toMatchObject({ path: pdf.path, revision: 1, source });

      dirtyListeners[0]?.(2);
      await controller.saveDocument();
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1]?.[0]).toMatchObject({ revision: 2 });
      expect(document.querySelector('[data-autosave]')).toBeNull();
      expect(readerPerformanceSnapshot()).toMatchObject({
        counters: { annotationSaves: 2 },
        samples: { annotationSaveMs: [expect.any(Number), expect.any(Number)] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a typed read-only annotation save lifecycle and resets it on close', async () => {
    beginPluginActivation();
    endPluginActivation();
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/Save-lifecycle.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const dirtyListeners: Array<(revision: number) => void> = [];
      let committedRevision = 0;
      let pendingRevision = 0;
      let dirty = false;
      const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
      const source: NativeEditableSaveSession = {
        baseToken,
        get committedRevision() {
          return committedRevision;
        },
        get pendingRevision() {
          return pendingRevision;
        },
        get isDirty() {
          return dirty;
        },
        prepare: vi.fn(async (revision: number) => ({
          revision,
          baseToken,
          bytes: new Uint8Array([1]),
        })),
        commit: vi.fn((_prepared, _token) => {
          committedRevision = pendingRevision;
          dirty = false;
        }),
        destroy: vi.fn(),
      };
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          dirtyListeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn(async (request: NativeDocumentSaveRequest) => {
        await request.source.commit(
          await request.source.prepare(request.revision, new AbortController().signal),
          baseToken,
        );
        return {
          verified: true as const,
          generation: request.revision,
          sha256: baseToken.sha256,
          byteSize: baseToken.byteSize,
          committedAt: '2026-08-27T00:00:00.000Z' as never,
        };
      });
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );

      expect(controller.annotationSaveLifecycleSnapshot()).toBeNull();
      await controller.open(pdf, createDiv());
      expect(controller.annotationSaveLifecycleSnapshot()).toMatchObject({
        activeSerializations: 0,
        activeWrites: 0,
        committedRevision: 0,
        isDirty: false,
        newestGeneration: 0,
        paused: false,
        pendingRevision: 0,
        savedGeneration: 0,
      });

      pendingRevision = 1;
      dirty = true;
      dirtyListeners[0]?.(1);
      expect(controller.annotationSaveLifecycleSnapshot()).toMatchObject({
        committedRevision: 0,
        isDirty: true,
        newestGeneration: 1,
        pendingRevision: 1,
        savedGeneration: 0,
      });
      await vi.advanceTimersByTimeAsync(750);
      expect(controller.annotationSaveLifecycleSnapshot()).toMatchObject({
        committedRevision: 1,
        isDirty: false,
        newestGeneration: 1,
        pendingRevision: 1,
        savedGeneration: 1,
      });

      await controller.close();
      expect(controller.annotationSaveLifecycleSnapshot()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes unified annotation metadata before manual save inside the debounce window', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/Manual-editor-flush.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdViewport = interactiveViewport();
      const createdSession = session(pdf.path, createdViewport);
      const baseToken: BaseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
      const dirtyListeners: Array<(revision: number) => void> = [];
      let dirty = false;
      const source: NativeEditableSaveSession = {
        baseToken,
        get pendingRevision() {
          return 1;
        },
        get isDirty() {
          return dirty;
        },
        prepare: vi.fn(async () => ({ revision: 1, baseToken, bytes: new Uint8Array([1]) })),
        commit: vi.fn(() => {
          dirty = false;
        }),
        destroy: vi.fn(),
      };
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          dirtyListeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn(async () => ({
        verified: true as const,
        generation: 1,
        sha256: 'b'.repeat(64),
        byteSize: 5,
        committedAt: '2026-08-28T00:00:00.000Z' as never,
      }));
      createdViewport.updateAnnotations.mockImplementation(() => {
        dirty = true;
        dirtyListeners[0]?.(1);
        return true;
      });
      const shell = capturingShellFactory();
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        shell.createShell,
        undefined,
        { saveCoordinator: { save } },
      );
      const host = createDiv();
      await controller.open(pdf, host);
      createdViewport.emitAnnotationFocus({
        annotations: [annotationRecord('manual-edit', 0, { kind: 'point', point: { x: 1, y: 2 } })],
        editable: true,
        position: { x: 10, y: 20 },
      });
      const comment = host.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
      if (comment === null) throw new Error('Expected unified annotation editor.');
      comment.value = 'Save immediately';
      comment.dispatchEvent(new Event('input', { bubbles: true }));

      await controller.saveDocument();

      expect(createdViewport.updateAnnotations).toHaveBeenCalledWith({
        annotations: [expect.objectContaining({ identity: { id: 'manual-edit', kind: 'stable' } })],
        comment: 'Save immediately',
      });
      expect(save).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a dirty debounce generation before controlled close', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const dirtyListeners: Array<(revision: number) => void> = [];
      const source = {
        baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          dirtyListeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn(async (request: NativeDocumentSaveRequest) => ({
        verified: true as const,
        generation: request.revision,
        sha256: 'b'.repeat(64),
        byteSize: 5,
        committedAt: '2026-08-13T00:00:00.000Z' as never,
      }));
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());
      dirtyListeners[0]?.(1);

      await controller.close();
      await vi.runAllTimersAsync();

      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0]).toMatchObject({ path: pdf.path, revision: 1, source });
      expect(source.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes unified metadata and keeps native lifecycle attached through an immediate close', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/Close-editor-flush.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdViewport = interactiveViewport();
      const createdSession = session(pdf.path, createdViewport);
      const baseToken: BaseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
      const dirtyListeners: Array<(revision: number) => void> = [];
      const operations: string[] = [];
      let dirty = false;
      const destroy = vi.fn(() => {
        operations.push('destroy');
      });
      const source: NativeEditableSaveSession = {
        baseToken,
        get pendingRevision() {
          return 1;
        },
        get isDirty() {
          return dirty;
        },
        prepare: vi.fn(async () => ({ revision: 1, baseToken, bytes: new Uint8Array([1]) })),
        commit: vi.fn(() => {
          dirty = false;
        }),
        destroy,
      };
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          dirtyListeners.push(onRevision);
          return source;
        },
      });
      createdViewport.updateAnnotations.mockImplementation(() => {
        operations.push('update');
        dirty = true;
        dirtyListeners[0]?.(1);
        return true;
      });
      const saved = deferred<{
        readonly verified: true;
        readonly generation: number;
        readonly sha256: string;
        readonly byteSize: number;
        readonly committedAt: never;
      }>();
      const save = vi.fn(() => {
        operations.push('save');
        return saved.promise;
      });
      const shell = capturingShellFactory();
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        shell.createShell,
        undefined,
        { saveCoordinator: { save } },
      );
      const host = createDiv();
      await controller.open(pdf, host);
      createdViewport.emitAnnotationFocus({
        annotations: [annotationRecord('close-edit', 0, { kind: 'point', point: { x: 1, y: 2 } })],
        editable: true,
        position: { x: 10, y: 20 },
      });
      const comment = host.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
      if (comment === null) throw new Error('Expected unified annotation editor.');
      comment.value = 'Close immediately';
      comment.dispatchEvent(new Event('input', { bubbles: true }));

      const closing = controller.close();
      await vi.waitFor(() => {
        expect(save).toHaveBeenCalledOnce();
      });
      expect(destroy).not.toHaveBeenCalled();
      saved.resolve({
        verified: true,
        generation: 1,
        sha256: 'b'.repeat(64),
        byteSize: 5,
        committedAt: '2026-08-28T00:00:00.000Z' as never,
      });
      await closing;

      expect(operations).toEqual(['update', 'save', 'destroy']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the dirty source view when a switch-boundary flush fails', async () => {
    const [first, second] = files('Books/First.pdf', 'Books/Second.pdf');
    if (first === undefined || second === undefined) throw new Error('Expected PDF fixtures.');
    const firstViewport = viewport();
    const firstSession = session(first.path, firstViewport);
    const secondSession = session(second.path);
    const dirtyListeners: Array<(revision: number) => void> = [];
    let dirty = true;
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 1,
      get isDirty() {
        return dirty;
      },
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(firstSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        dirtyListeners.push(onRevision);
        return source;
      },
    });
    const firstAdapter = adapterFor(first.path, firstSession);
    const secondAdapter = adapterFor(second.path, secondSession);
    const recoveredSession = session(first.path);
    firstAdapter.open
      .mockResolvedValueOnce(firstSession.value)
      .mockResolvedValueOnce(recoveredSession.value);
    const cause = new Error('verified write failed');
    let broadcast: VerifiedReloadListener | undefined;
    const controller = new ReaderController(
      new DocumentAdapterRegistry([firstAdapter.value, secondAdapter.value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(async () => Promise.reject(cause)),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(first, createDiv());
    dirtyListeners[0]?.(1);

    await expect(controller.open(second, createDiv())).rejects.toBe(cause);

    expect(firstViewport.destroy).not.toHaveBeenCalled();
    expect(firstSession.close).not.toHaveBeenCalled();
    expect(source.destroy).not.toHaveBeenCalled();
    expect(secondAdapter.open).not.toHaveBeenCalled();

    if (broadcast === undefined) throw new Error('Expected the preserved lifecycle listener.');
    dirty = false;
    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 }, 2, {
      pendingRevision: 0,
      isDirty: false,
    } as NativeEditableSaveSession);

    expect(firstAdapter.open).toHaveBeenCalledTimes(2);
    expect(controller).toHaveProperty('session', recoveredSession.value);
  });

  it('completes controlled close inline after an explicit reload-discard conflict decision', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const dirtyListeners: Array<(revision: number) => void> = [];
    const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
    const source = {
      baseToken,
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        dirtyListeners.push(onRevision);
        return source;
      },
    });
    const conflict = new SaveConflictError(pdf.path, baseToken, {
      sha256: 'b'.repeat(64),
      byteSize: 5,
      mtime: 20,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      {
        saveCoordinator: { save: vi.fn(async () => Promise.reject(conflict)) },
        resolveSaveConflict: vi.fn(async () => 'reload-discard' as const),
      },
    );
    await controller.open(pdf, createDiv());
    dirtyListeners[0]?.(1);

    await expect(controller.close()).resolves.toBeUndefined();

    expect(source.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('accepts an own-view token but never destroys pending edits after another view saves', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const baseToken: BaseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
    const acceptVerifiedReload = vi.fn();
    const source = {
      baseToken,
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload,
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    let broadcast: VerifiedReloadListener | undefined;
    const unregister = vi.fn();
    const register = vi.fn((_path: string, listener: VerifiedReloadListener) => {
      broadcast = listener;
      return unregister;
    });
    const createdAdapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([createdAdapter.value]),
      undefined,
      undefined,
      { saveCoordinator: { save: vi.fn(), register } },
    );
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected a verified-save listener.');
    const verifiedToken: BaseToken = { sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 };

    await broadcast(verifiedToken, 1, source);
    expect(acceptVerifiedReload).toHaveBeenCalledWith(verifiedToken);

    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    await broadcast(verifiedToken, 2, {
      prepare: vi.fn(),
      commit: vi.fn(),
    });
    await Promise.resolve();
    expect(createdAdapter.open).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('invalidates and cancellably replaces stale annotations with ids from a verified reopened PDF', async () => {
    const [pdf] = files('Books/Committed.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    const pending = {
      ...annotationRecord('temporary', 0, { kind: 'point', point: { x: 1, y: 2 } }),
      identity: { kind: 'legacy' as const, fingerprint: 'pending' },
    };
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([pending]);
      },
    });
    const reopened = session(pdf.path);
    const committed = annotationRecord('committed-id', 0, { kind: 'point', point: { x: 1, y: 2 } });
    Object.assign(reopened.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([committed]);
      },
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      pendingRevision: 1,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    let broadcast: VerifiedReloadListener | undefined;
    const adapter = adapterFor(pdf.path, active);
    adapter.open.mockResolvedValueOnce(active.value).mockResolvedValueOnce(reopened.value);
    const invalidate = vi.fn(async () => undefined);
    const cache = {
      generation: vi.fn(() => 1),
      read: vi.fn(async () => null),
      write: vi.fn(async () => true),
      invalidate,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        annotationCache: cache,
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected save listener.');
    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);
    expect(adapter.open).toHaveBeenCalledOnce();
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['committed-id']);
    });
    expect(invalidate).toHaveBeenCalledWith(pdf.path);
    expect(reopened.close).toHaveBeenCalledOnce();
  });

  it('joins an in-flight persisted refresh when a deep-link intent arrives', async () => {
    const [pdf] = files('Books/Intent.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    Object.assign(active.value, {
      listAnnotations: vi.fn(async () => {
        throw new Error('The pre-save session must not be scanned after verification.');
      }),
    });
    const reopened = session(pdf.path);
    const extractionGate = deferred<void>();
    const committed = annotationRecord('committed-id', 0, {
      kind: 'point',
      point: { x: 1, y: 2 },
    });
    Object.assign(reopened.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        await extractionGate.promise;
        sink([committed]);
      },
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      pendingRevision: 1,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    let broadcast: VerifiedReloadListener | undefined;
    const adapter = adapterFor(pdf.path, active);
    adapter.open.mockResolvedValueOnce(active.value).mockResolvedValueOnce(reopened.value);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected save listener.');
    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);

    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(adapter.open).toHaveBeenCalledTimes(2);
    });
    const navigation = controller.resolveAnnotationLink({
      id: 'committed-id',
      page: 1,
      fingerprint: 'highlight:point:1,2',
    });
    expect(adapter.open).toHaveBeenCalledTimes(2);
    extractionGate.resolve();
    await navigation;
    expect(adapter.open).toHaveBeenCalledTimes(2);
    expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['committed-id']);
    expect(reopened.close).toHaveBeenCalledOnce();
  });

  it('coalesces rapid verified saves into one persisted annotation scan', async () => {
    const [pdf] = files('Books/Coalesced.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([]);
      },
    });
    const reopened = session(pdf.path);
    Object.assign(reopened.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([annotationRecord('newest-id', 0, { kind: 'point', point: { x: 2, y: 2 } })]);
      },
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      pendingRevision: 2,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    let broadcast: VerifiedReloadListener | undefined;
    const adapter = adapterFor(pdf.path, active);
    adapter.open.mockResolvedValueOnce(active.value).mockResolvedValueOnce(reopened.value);
    const invalidateGate = deferred<void>();
    const invalidate = vi.fn(() => invalidateGate.promise);
    const cache = {
      generation: vi.fn(() => 1),
      read: vi.fn(async () => null),
      write: vi.fn(async () => true),
      invalidate,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        annotationCache: cache,
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([]);
    });
    if (broadcast === undefined) throw new Error('Expected save listener.');
    const first = broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);
    const second = broadcast({ sha256: 'c'.repeat(64), byteSize: 6, mtime: 3 }, 2, source);
    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledTimes(2);
    });
    expect(adapter.open).toHaveBeenCalledOnce();
    invalidateGate.resolve();
    await Promise.all([first, second]);
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['newest-id']);
    });
    expect(adapter.open).toHaveBeenCalledTimes(2);
    expect(reopened.close).toHaveBeenCalledOnce();
  });

  it('keeps verified annotation scans off the real coordinator save queue and coalesces revisions', async () => {
    const [pdf] = files('Books/Coordinator.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([]);
      },
    });
    const reopened = session(pdf.path);
    Object.assign(reopened.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([annotationRecord('newest-id', 0, { kind: 'point', point: { x: 2, y: 2 } })]);
      },
    });
    const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 };
    const source = {
      baseToken,
      pendingRevision: 2,
      isDirty: false,
      prepare: vi.fn(async (revision: number) => ({
        revision,
        baseToken,
        bytes: new Uint8Array([revision]),
      })),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    const adapter = adapterFor(pdf.path, active);
    adapter.open.mockResolvedValueOnce(active.value).mockResolvedValueOnce(reopened.value);
    const invalidations = [deferred<void>(), deferred<void>()];
    const invalidate = vi.fn(() => invalidations[invalidate.mock.calls.length - 1]?.promise);
    const cache = {
      generation: vi.fn(() => 1),
      read: vi.fn(async () => null),
      write: vi.fn(async () => true),
      invalidate,
    } as unknown as AnnotationCache;
    const write = vi.fn(async (request: { bytes: Uint8Array }) => ({
      token: {
        sha256: String(request.bytes[0]).repeat(64),
        byteSize: request.bytes.byteLength,
        mtime: request.bytes[0] ?? 0,
      },
    }));
    const coordinator = new DocumentSaveCoordinator(
      { write },
      vi.fn(async () => undefined),
    );
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      { annotationCache: cache, saveCoordinator: coordinator },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([]);
    });
    const signal = new AbortController().signal;
    const first = coordinator.save({ path: pdf.path, baseToken, revision: 1, source }, signal);
    await expect(first).resolves.toMatchObject({ generation: 1 });
    const second = coordinator.save({ path: pdf.path, baseToken, revision: 2, source }, signal);
    await expect(second).resolves.toMatchObject({ generation: 2 });
    expect(adapter.open).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledTimes(2);

    invalidations.forEach((gate) => {
      gate.resolve();
    });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['newest-id']);
    });
    expect(adapter.open).toHaveBeenCalledTimes(2);
    expect(reopened.close).toHaveBeenCalledOnce();
  });

  it('refreshes verified annotations when derived cache invalidation fails', async () => {
    const [pdf] = files('Books/Refresh-failure.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([annotationRecord('stale-id', 0, { kind: 'point', point: { x: 1, y: 2 } })]);
      },
    });
    const reopened = session(pdf.path);
    Object.assign(reopened.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([annotationRecord('refreshed-id', 0, { kind: 'point', point: { x: 3, y: 4 } })]);
      },
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      pendingRevision: 1,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    let broadcast: VerifiedReloadListener | undefined;
    const adapter = adapterFor(pdf.path, active);
    adapter.open.mockResolvedValueOnce(active.value).mockResolvedValueOnce(reopened.value);
    const cause = new Error('annotation cache invalidation failed');
    const invalidate = vi.fn<AnnotationCache['invalidate']>().mockRejectedValue(cause);
    const cache = {
      generation: vi.fn(() => 1),
      read: vi.fn(async () => null),
      write: vi.fn(async () => true),
      invalidate,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        annotationCache: cache,
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['stale-id']);
    });
    if (broadcast === undefined) throw new Error('Expected save listener.');

    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('[abyss-documents] Annotation cache invalidation failed', {
        path: pdf.path,
        cause,
      });
    });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['refreshed-id']);
    });
    expect(adapter.open).toHaveBeenCalledTimes(2);
    expect(shell.created.sidebar?.annotationsPanel.root.querySelector('[role="alert"]')).toBeNull();
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).not.toMatch(
      /index|cache|reopen/i,
    );
    expect(reopened.close).toHaveBeenCalledOnce();
  });

  it('suppresses an older verified annotation refresh when a newer save finishes first', async () => {
    const [pdf] = files('Books/Race.pdf');
    if (pdf === undefined) throw new Error('Expected PDF.');
    const active = session(pdf.path);
    Object.assign(active.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([]);
      },
    });
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 1 },
      pendingRevision: 2,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload: vi.fn(),
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(active.value, { createNativeEditableSession: () => source });
    const first = session(pdf.path);
    const firstGate = deferred<void>();
    Object.assign(first.value, {
      listAnnotations: async (_signal: AbortSignal, _sink: AnnotationSink) => {
        await firstGate.promise;
        throw new Error('The stale adapter ignored cancellation.');
      },
    });
    const second = session(pdf.path);
    Object.assign(second.value, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([annotationRecord('newest-id', 0, { kind: 'point', point: { x: 2, y: 2 } })]);
      },
    });
    const adapter = adapterFor(pdf.path, active);
    adapter.open
      .mockResolvedValueOnce(active.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    let broadcast: VerifiedReloadListener | undefined;
    const cache = {
      generation: vi.fn(() => 1),
      read: vi.fn(async () => null),
      write: vi.fn(async () => true),
      invalidate: vi.fn(async () => undefined),
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      undefined,
      {
        annotationCache: cache,
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'open-sidebar', tab: 'annotations' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual([]);
    });
    if (broadcast === undefined) throw new Error('Expected listener.');
    const saveOne = broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 2 }, 1, source);
    await vi.waitFor(() => {
      expect(adapter.open).toHaveBeenCalledTimes(2);
    });
    const saveTwo = broadcast({ sha256: 'c'.repeat(64), byteSize: 6, mtime: 3 }, 2, source);
    await saveTwo;
    firstGate.resolve();
    await saveOne;
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.annotationsPanel.visibleIds()).toEqual(['newest-id']);
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('keeps dirty edits conflicted and reloads a clean peer after explicit recovery broadcasts', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    let broadcast: VerifiedReloadListener | undefined;
    const createdAdapter = adapterFor(pdf.path, createdSession);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const controller = new ReaderController(
      new DocumentAdapterRegistry([createdAdapter.value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected a verified-save listener.');
    const recovered = { sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 };

    await broadcast(recovered, 0, NATIVE_RECOVERY_SOURCE);
    expect(createdAdapter.open).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();

    Object.defineProperty(source, 'isDirty', { value: false });
    const reloadGate = deferred<void>();
    const reloaded = session(pdf.path);
    createdAdapter.open.mockImplementationOnce(async () => {
      await reloadGate.promise;
      return reloaded.value;
    });
    const reload = Promise.resolve(broadcast(recovered, 0, NATIVE_RECOVERY_SOURCE));
    let settled = false;
    reload.then(
      () => {
        settled = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    reloadGate.resolve();
    await reload;
    expect(createdAdapter.open).toHaveBeenCalledTimes(2);
    expect(createdSession.close).toHaveBeenCalledOnce();
    expect(controller).toHaveProperty('session', reloaded.value);
  });

  it('ignores a stale verified-reload listener after a different document lifecycle replaces it', async () => {
    const [first, second] = files('Books/First.pdf', 'Books/Second.pdf');
    if (first === undefined || second === undefined) throw new Error('Expected PDF fixtures.');
    const firstSession = session(first.path);
    const secondSession = session(second.path);
    const firstNative = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 0,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    const secondNative = {
      baseToken: { sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 },
      pendingRevision: 0,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(firstSession.value, { createNativeEditableSession: () => firstNative });
    Object.assign(secondSession.value, { createNativeEditableSession: () => secondNative });
    const opened = vi.fn(async (file: TFile) =>
      file.path === first.path ? firstSession.value : secondSession.value,
    );
    const adapter: DocumentAdapter = {
      id: 'lifecycle-adapter',
      supports: () => true,
      open: opened,
    };
    const listeners: VerifiedReloadListener[] = [];
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            listeners.push(listener);
            return vi.fn();
          }),
        },
      },
    );
    const host = createDiv();
    await controller.open(first, host);
    const stale = listeners[0];
    if (stale === undefined) throw new Error('Expected the first lifecycle listener.');
    await controller.open(second, host);

    await stale({ sha256: 'c'.repeat(64), byteSize: 6, mtime: 30 }, 0, {
      pendingRevision: 0,
      isDirty: false,
    } as NativeEditableSaveSession);

    expect(opened).toHaveBeenCalledTimes(2);
    expect(controller).toHaveProperty('session', secondSession.value);
    expect(secondSession.close).not.toHaveBeenCalled();
  });

  it.each(['switch', 'close'] as const)(
    'does not let a clean peer reload supersede a newer user %s intent',
    async (intent) => {
      const [first, second] = files('Books/First.pdf', 'Books/Second.pdf');
      if (first === undefined || second === undefined) throw new Error('Expected PDF fixtures.');
      const firstSession = session(first.path);
      const secondSession = session(second.path);
      const firstNative = {
        baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
        pendingRevision: 0,
        isDirty: false,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      const secondNative = {
        baseToken: { sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 },
        pendingRevision: 0,
        isDirty: false,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(firstSession.value, { createNativeEditableSession: () => firstNative });
      Object.assign(secondSession.value, { createNativeEditableSession: () => secondNative });
      const listeners: VerifiedReloadListener[] = [];
      const controller = new ReaderController(
        new DocumentAdapterRegistry([
          {
            id: 'user-intent-wins-adapter',
            supports: () => true,
            open: vi.fn(async (file: TFile) =>
              file.path === first.path ? firstSession.value : secondSession.value,
            ),
          },
        ]),
        undefined,
        undefined,
        {
          saveCoordinator: {
            save: vi.fn(),
            register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
              listeners.push(listener);
              return vi.fn();
            }),
          },
        },
      );
      await controller.open(first, createDiv());
      const broadcast = listeners[0];
      if (broadcast === undefined) throw new Error('Expected first lifecycle listener.');

      const userIntent =
        intent === 'switch' ? controller.open(second, createDiv()) : controller.close();
      const peerReload = broadcast({ sha256: 'c'.repeat(64), byteSize: 6, mtime: 30 }, 1, {
        pendingRevision: 0,
        isDirty: false,
      } as NativeEditableSaveSession);
      await Promise.all([userIntent, peerReload]);

      if (intent === 'switch') {
        expect(controller).toHaveProperty('session', secondSession.value);
        expect(secondSession.close).not.toHaveBeenCalled();
      } else {
        expect(controller).toHaveProperty('session', null);
      }
    },
  );

  it('rechecks clean peer state inside the queued reload before discarding new edits', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected PDF fixture.');
    const createdSession = session(pdf.path);
    let dirty = false;
    const native = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 0,
      get isDirty() {
        return dirty;
      },
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, { createNativeEditableSession: () => native });
    const createdAdapter = adapterFor(pdf.path, createdSession);
    let broadcast: VerifiedReloadListener | undefined;
    const controller = new ReaderController(
      new DocumentAdapterRegistry([createdAdapter.value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected verified reload listener.');

    const peerReload = broadcast({ sha256: 'c'.repeat(64), byteSize: 6, mtime: 30 }, 1, {
      pendingRevision: 0,
      isDirty: false,
    } as NativeEditableSaveSession);
    dirty = true;
    await peerReload;

    expect(createdAdapter.open).toHaveBeenCalledOnce();
    expect(createdSession.close).not.toHaveBeenCalled();
    expect(controller).toHaveProperty('session', createdSession.value);
  });

  it('shows actionable conflict state when clean-peer reload throws an unexpected AbortError', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 0,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    let broadcast: VerifiedReloadListener | undefined;
    const recoveredSession = session(pdf.path);
    const unexpectedAbort = new Error('reload cleanup aborted unexpectedly');
    unexpectedAbort.name = 'AbortError';
    createdSession.close.mockRejectedValueOnce(unexpectedAbort);
    const createdAdapter = adapterFor(pdf.path, createdSession);
    createdAdapter.open
      .mockResolvedValueOnce(createdSession.value)
      .mockResolvedValueOnce(recoveredSession.value);
    const host = createDiv();
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([createdAdapter.value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, host);
    if (broadcast === undefined) throw new Error('Expected a verified-save listener.');

    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 }, 1, {
      prepare: vi.fn(),
      commit: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(createdSession.close).toHaveBeenCalledOnce();
    });
    expect(createdAdapter.open).toHaveBeenCalledOnce();

    expect(host.dataset['saveConflict']).toBe('true');
    const message = notice.mock.calls[0]?.[0];
    expect(message).toBeInstanceOf(DocumentFragment);
    const retry = (message as DocumentFragment).querySelector<HTMLButtonElement>('button');
    expect(retry?.textContent).toBe('Retry');
    retry?.click();
    await vi.waitFor(() => {
      expect(createdAdapter.open).toHaveBeenCalledTimes(2);
    });
    expect(host.dataset['saveConflict']).toBeUndefined();
  });

  it('does not report a failed peer reload after a newer open request supersedes it', async () => {
    const [first, second] = files('Books/First.pdf', 'Books/Second.pdf');
    if (first === undefined || second === undefined) throw new Error('Expected PDF fixtures.');
    const firstSession = session(first.path);
    const secondSession = session(second.path);
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 0,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(firstSession.value, { createNativeEditableSession: () => source });
    const reloadGate = deferred<void>();
    const opened = vi
      .fn<(file: TFile) => Promise<DocumentSession>>()
      .mockResolvedValueOnce(firstSession.value)
      .mockImplementationOnce(async () => {
        await reloadGate.promise;
        throw new Error('stale reload parser failed');
      })
      .mockResolvedValueOnce(secondSession.value);
    const adapter: DocumentAdapter = {
      id: 'overlapping-reload-adapter',
      supports: () => true,
      open: opened,
    };
    let broadcast: VerifiedReloadListener | undefined;
    const host = createDiv();
    const newerHost = createDiv();
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(first, host);
    if (broadcast === undefined) throw new Error('Expected a verified-save listener.');

    const staleReload = broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 }, 1, {
      prepare: vi.fn(),
      commit: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(opened).toHaveBeenCalledTimes(2);
    });
    const newerOpen = controller.open(second, newerHost);
    reloadGate.resolve();
    await staleReload;
    await newerOpen;

    expect(host.dataset['saveConflict']).toBeUndefined();
    expect(notice).not.toHaveBeenCalled();
    expect(controller).toHaveProperty('session', secondSession.value);
  });

  it('requires explicit conflict action before overwrite and forwards the destructive flag', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
    const source = {
      baseToken,
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const conflict = new SaveConflictError(pdf.path, baseToken, {
      sha256: 'c'.repeat(64),
      byteSize: 9,
      mtime: 30,
    });
    const save = vi
      .fn<(request: NativeDocumentSaveRequest) => Promise<never>>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({} as never);
    const resolveSaveConflict = vi.fn(async () => 'overwrite' as const);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      { saveCoordinator: { save }, resolveSaveConflict },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);

    await controller.saveDocument();

    expect(resolveSaveConflict).toHaveBeenCalledWith(pdf.path);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[0].overwrite).not.toBe(true);
    expect(save.mock.calls[1]?.[0].overwrite).toBe(true);
  });

  it('pauses failed background autosave with one deduplicated Notice and diagnostic', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const listeners: Array<(revision: number) => void> = [];
      const source = {
        baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          listeners.push(onRevision);
          return source;
        },
      });
      const cause = new Error('disk full');
      const save = vi.fn(async () => Promise.reject(cause));
      const notice = vi.spyOn(Notice.prototype, 'constructor__');
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());
      listeners[0]?.(1);
      await vi.advanceTimersByTimeAsync(750);

      const message = notice.mock.calls[0]?.[0];
      expect(message).toBeInstanceOf(DocumentFragment);
      expect((message as DocumentFragment).textContent).toContain(
        'Could not autosave PDF annotations: disk full',
      );
      expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to autosave PDF annotations', {
        path: pdf.path,
        cause,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(notice).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a real Retry action that resumes the paused scheduler snapshot', async () => {
    vi.useFakeTimers();
    try {
      beginPluginActivation();
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const listeners: Array<(revision: number) => void> = [];
      const source = {
        baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          listeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({});
      const notice = vi.spyOn(Notice.prototype, 'constructor__');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());
      listeners[0]?.(1);
      await vi.advanceTimersByTimeAsync(750);
      const message = notice.mock.calls[0]?.[0];
      expect(message).toBeInstanceOf(DocumentFragment);
      const retry = (message as DocumentFragment).querySelector<HTMLButtonElement>('button');
      expect(retry?.textContent).toBe('Retry');
      expect(readerPerformanceSnapshot().counters).toMatchObject({
        annotationSaveFailures: 1,
        annotationSaves: 0,
      });

      retry?.click();
      await vi.waitFor(() => {
        expect(save).toHaveBeenCalledTimes(2);
        expect(readerPerformanceSnapshot().counters).toMatchObject({
          annotationSaveRecoveries: 1,
          annotationSaves: 1,
        });
      });
    } finally {
      endPluginActivation();
      vi.useRealTimers();
    }
  });

  it('routes a manual save failure through the shared actionable Retry boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const save = vi.fn(async () => Promise.reject(new Error('manual disk failure')));
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      { saveCoordinator: { save } },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);

    await expect(controller.saveDocument()).rejects.toThrow('manual disk failure');

    const message = notice.mock.calls[0]?.[0];
    expect(message).toBeInstanceOf(DocumentFragment);
    expect((message as DocumentFragment).querySelector('button')?.textContent).toBe('Retry');
  });

  it('offers explicitly confirmed last-verified recovery for an ambiguous write', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const failure = Object.assign(new Error('ambiguous write'), {
      path: pdf.path,
      preimage: new Uint8Array([1, 2, 3, 4]),
      preparedBytes: new Uint8Array([5, 6, 7]),
      restored: false,
    });
    const current = { sha256: 'c'.repeat(64), byteSize: 2, mtime: 30 };
    const inspectRecovery = vi.fn(async () => current);
    const recover = vi.fn(async () => source.baseToken);
    const confirmSaveRecovery = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(async () => Promise.reject(failure)),
          inspectRecovery,
          recover,
        },
        confirmSaveRecovery,
      },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);
    await expect(controller.saveDocument()).rejects.toBe(failure);
    const message = notice.mock.calls[0]?.[0] as DocumentFragment;
    const restore = message.querySelector<HTMLButtonElement>('button');
    expect(restore?.textContent).toBe('Restore last verified copy');

    restore?.click();
    await vi.waitFor(() => {
      expect(confirmSaveRecovery).toHaveBeenCalledOnce();
    });
    expect(recover).not.toHaveBeenCalled();
    restore?.click();
    await vi.waitFor(() => {
      expect(confirmSaveRecovery).toHaveBeenCalledTimes(2);
      expect(confirmSaveRecovery).toHaveBeenLastCalledWith(pdf.path, current);
      expect(recover).toHaveBeenCalledWith(failure, current, expect.any(AbortSignal));
    });
  });

  it.each(['cancel', 'reload-discard'] as const)(
    'does not overwrite after a %s conflict action',
    async (action) => {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const listeners: Array<(revision: number) => void> = [];
      const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
      const source = {
        baseToken,
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          listeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn(async () =>
        Promise.reject(
          new SaveConflictError(pdf.path, baseToken, {
            sha256: 'c'.repeat(64),
            byteSize: 9,
            mtime: 30,
          }),
        ),
      );
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save }, resolveSaveConflict: vi.fn(async () => action) },
      );
      await controller.open(pdf, createDiv());
      listeners[0]?.(1);

      await expect(controller.saveDocument()).rejects.toBeInstanceOf(SaveConflictError);
      expect(save).toHaveBeenCalledOnce();
      await Promise.resolve();
    },
  );

  it('does not present Retry after an explicitly confirmed reload-discard', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
    const source = {
      baseToken,
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const save = vi.fn(async () =>
      Promise.reject(
        new SaveConflictError(pdf.path, baseToken, {
          sha256: 'b'.repeat(64),
          byteSize: 5,
          mtime: 20,
        }),
      ),
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      {
        saveCoordinator: { save },
        resolveSaveConflict: vi.fn(async () => 'reload-discard' as const),
      },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);

    await expect(controller.saveDocument()).rejects.toBeInstanceOf(SaveConflictError);
    expect(notice).not.toHaveBeenCalled();
  });

  it('cleans a partially activated native save lifecycle when broadcast registration throws', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 0,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn(() => {
            throw new Error('register rejected');
          }),
        },
      },
    );

    const failure = await controller.open(pdf, createDiv()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(DocumentOpenError);
    const activationCause = (failure as DocumentOpenError).cause;
    expect(activationCause).toBeInstanceOf(Error);
    expect((activationCause as Error).message).toBe('register rejected');
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
    await controller.close();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });
});
