import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { asAnnotationId, type DocumentAnnotation } from '../../document-core/annotations.js';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../../reader-performance.js';
import {
  PdfAnnotationEditor,
  type PdfAnnotationActivationResult,
  type PdfAnnotationToolOptions,
} from './pdf-annotation-editor.js';
import type { PdfAnnotationFocus, PdfCommentDialogReservation } from './pdf-comment-bridge.js';

type Listener = (event: unknown) => void;

function createdAnnotation(
  comment = '',
  options: {
    readonly id?: string;
    readonly type?: DocumentAnnotation['type'];
    readonly writable?: boolean;
  } = {},
): DocumentAnnotation {
  const reason = { code: 'document-read-only' as const, message: 'Locked.' };
  const available =
    options.writable === false
      ? ({ available: false, reason } as const)
      : ({ available: true } as const);
  return {
    anchor: {
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 0, y: 0 } },
      kind: 'fixed-page',
      pageIndex: 0,
    },
    author: '',
    capabilities: {
      color: available,
      comment: available,
      conversions: { highlight: available, underline: available },
      deletion: available,
      geometry: available,
      metadata: available,
    },
    color: '#ffd400',
    comment,
    createdAt: null,
    identity: { id: asAnnotationId(options.id ?? 'created-native'), kind: 'stable' },
    links: [],
    modifiedAt: null,
    selectedText: null,
    tags: [],
    type: options.type ?? 'highlight',
  };
}

function annotationFocus(
  id: string,
  editable: boolean,
  options: { readonly writable?: boolean } = {},
): PdfAnnotationFocus {
  return {
    annotations: [createdAnnotation('', { id, writable: options.writable ?? editable })],
    editable,
    position: { x: 10, y: 20 },
  };
}

class FakeEventBus {
  readonly listeners = new Map<string, Set<Listener>>();

  on(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  off(name: string, listener: Listener): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }
}

interface MutableAnnotationStorage {
  [Symbol.iterator](): IterableIterator<[string, unknown]>;
  addEditor: ReturnType<typeof vi.fn<(type: number, id?: string) => void>>;
  editorSnapshot(id: string): Record<string, unknown> | null;
  isModified(): boolean;
  mutateEditor(id: string, value: Record<string, unknown>): void;
  onAnnotationEditor: ((type: number | null) => void) | null;
  onResetModified: (() => void) | null;
  onSetModified: (() => void) | null;
  resetModified: ReturnType<typeof vi.fn<() => void>>;
  setValue(id: string, value: Record<string, unknown>): void;
  readonly serializable?: never;
}

function storage(): MutableAnnotationStorage {
  let modified = false;
  let editorSequence = 0;
  const entries = new Map<string, unknown>();
  const markModified = (): void => {
    if (modified) return;
    modified = true;
    value.onSetModified?.();
  };
  const value: MutableAnnotationStorage = {
    [Symbol.iterator]: () => entries.entries(),
    addEditor: vi.fn((type: number, id = `fixture-editor-${++editorSequence}`) => {
      entries.set(id, selectedEditor(id, type));
      markModified();
      value.onAnnotationEditor?.(type);
    }),
    editorSnapshot: (id) => {
      const editor = entries.get(id);
      return typeof editor === 'object' && editor !== null ? { ...editor } : null;
    },
    isModified: () => modified,
    mutateEditor: (id, patch) => {
      const editor = entries.get(id);
      if (typeof editor !== 'object' || editor === null)
        throw new Error(`Expected a stored editor for ${id}.`);
      Object.assign(editor, patch);
      markModified();
    },
    onAnnotationEditor: null,
    onResetModified: null,
    onSetModified: null,
    resetModified: vi.fn(() => {
      if (!modified) return;
      modified = false;
      value.onResetModified?.();
    }),
    setValue: (id, entry) => {
      entries.set(id, { ...entry });
      markModified();
    },
  };
  Object.defineProperty(value, 'serializable', {
    configurable: false,
    get: () => {
      throw new Error('AnnotationStorage.serializable must stay private to PDF.js.');
    },
  });
  return value;
}

function selectedEditor(uid: string, mode: number, elementBeforePopup?: Element) {
  let editorType = 'ink';
  if (mode === 3) editorType = 'freetext';
  else if (mode === 9) editorType = 'highlight';
  return {
    editorType,
    elementBeforePopup,
    mode,
    uid,
  };
}

function manager(selected: ReturnType<typeof selectedEditor> | null = null) {
  const layers = Array.from({ length: 3 }, () => ({
    disableClick: vi.fn(),
    disableTextSelection: vi.fn(),
  }));
  return {
    commentSelection: vi.fn(),
    delete: vi.fn(),
    disableUserSelect: vi.fn(),
    endCurrentEditing: vi.fn(),
    firstSelectedEditor: selected ?? undefined,
    getEditor: vi.fn(),
    getLayer: vi.fn((pageIndex: number) => layers[pageIndex]),
    highlightSelection: vi.fn(),
    layers,
    redo: vi.fn(),
    setSelected: vi.fn(),
    undo: vi.fn(),
    updateParams: vi.fn(),
  };
}

function fixture(fixtureOptions: { readonly dispatchModeChanges?: boolean } = {}) {
  const annotationStorage = storage();
  const saveDocument = vi.fn(async () => new Uint8Array([37, 80, 68, 70, 45]));
  const pdf = {
    annotationStorage,
    numPages: 3,
    saveDocument,
  } as unknown as PDFDocumentProxy;
  const eventBus = new FakeEventBus();
  const changedModes: number[] = [];
  const modeRequests: Array<Record<string, unknown>> = [];
  const viewer = {
    currentMode: 0,
    annotationEditorMode: 0 as number | { readonly mode: number },
  };
  Object.defineProperty(viewer, 'annotationEditorMode', {
    configurable: true,
    get: () => viewer.currentMode,
    set: (options: { readonly mode: number }) => {
      modeRequests.push({ ...options });
      if (viewer.currentMode === options.mode) return;
      viewer.currentMode = options.mode;
      changedModes.push(options.mode);
      if (fixtureOptions.dispatchModeChanges === false) return;
      queueMicrotask(() => {
        eventBus.dispatch('annotationeditormodechanged', { source: viewer, mode: options.mode });
      });
    },
  });
  const selectionObserver = {
    invalidate: vi.fn(),
    onSelection: vi.fn(() => () => undefined),
    validate: vi.fn<(token: string) => 'current' | 'stale'>(() => 'current'),
  };
  let editorAddBaseline = 0;
  let annotationFocusListener: ((focus: PdfAnnotationFocus | null) => void) | null = null;
  const commentBridge = {
    beginPersistence: vi.fn(),
    deleteAnnotations: vi.fn(() => true),
    endPersistence: vi.fn(),
    focusAnnotation: vi.fn<
      (
        id: string,
        signal?: AbortSignal,
        projected?: DocumentAnnotation,
        options?: {
          readonly clientPosition?: { readonly x: number; readonly y: number };
          readonly editableOnly?: boolean;
          readonly forceReadonly?: boolean;
          readonly preserveSelection?: boolean;
        },
      ) => Promise<boolean>
    >(async () => true),
    nativeEditorIds: vi.fn(() => {
      editorAddBaseline = annotationStorage.addEditor.mock.calls.length;
      return new Set<string>();
    }),
    nativeEditorUidForAnnotation: vi.fn((_id: string) => null as string | null),
    normalizeCreatedAnnotation: vi.fn<(_uiManager: unknown) => DocumentAnnotation | null>(() =>
      annotationStorage.addEditor.mock.calls.length > editorAddBaseline
        ? createdAnnotation()
        : null,
    ),
    normalizeSelectionHighlight: vi.fn<(_uiManager: unknown) => DocumentAnnotation | null>(() =>
      annotationStorage.addEditor.mock.calls.length > editorAddBaseline
        ? createdAnnotation()
        : null,
    ),
    onAnnotationFocus: vi.fn((listener: (focus: PdfAnnotationFocus | null) => void) => {
      annotationFocusListener = listener;
      return () => {
        if (annotationFocusListener === listener) annotationFocusListener = null;
      };
    }),
    reserveNextDialog: vi.fn<(seed: string, signal?: AbortSignal) => PdfCommentDialogReservation>(
      () => ({
        closed: Promise.resolve('external' as const),
        opened: Promise.resolve(createdAnnotation()),
      }),
    ),
    resolveAnnotationAnchor: vi.fn(() => null as DOMRect | null),
    synchronizeAnnotationSelection: vi.fn(() => true),
    updateAnnotations: vi.fn(() => true),
  };
  const editor = new PdfAnnotationEditor({
    annotationEditorParamsType: {
      FREETEXT_COLOR: 12,
      FREETEXT_OPACITY: 13,
      FREETEXT_SIZE: 11,
      HIGHLIGHT_COLOR: 31,
      HIGHLIGHT_FREE: 33,
      HIGHLIGHT_THICKNESS: 32,
      INK_COLOR: 21,
      INK_OPACITY: 23,
      INK_THICKNESS: 22,
    },
    annotationEditorType: { DISABLE: -1, FREETEXT: 3, HIGHLIGHT: 9, INK: 15, NONE: 0 },
    eventBus,
    pdf,
    commentBridge,
    selectionObserver,
    viewer,
  });
  return {
    annotationStorage,
    changedModes,
    commentBridge,
    editor,
    emitBridgeFocus: (focus: PdfAnnotationFocus | null) => {
      annotationFocusListener?.(focus);
    },
    eventBus,
    modeRequests,
    pdf,
    saveDocument,
    selectionObserver,
    viewer,
  };
}

function requestPdfJsSelectionMode(
  fixtureValue: ReturnType<typeof fixture>,
  uiManager: ReturnType<typeof manager>,
  kind: 'comment' | 'highlight' = 'highlight',
): void {
  uiManager[`${kind}Selection`].mockImplementation(() => {
    fixtureValue.viewer.annotationEditorMode = { mode: 9 };
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

interface AnnotationActivationInternals {
  readonly activeActivation: {
    readonly contextualFailureOwner: {
      removeActivationAbort(): void;
    } | null;
  } | null;
  readonly contextualActivationFailureOwner: unknown;
}

function activationInternals(editor: PdfAnnotationEditor): AnnotationActivationInternals {
  return editor as unknown as AnnotationActivationInternals;
}

describe('PdfAnnotationEditor lifecycle', () => {
  it('dismisses a stale token before requiring a live manager', async () => {
    const fixtureValue = fixture();
    fixtureValue.selectionObserver.validate.mockReturnValue('stale');

    await expect(
      fixtureValue.editor.commitSelection('stale', {
        kind: 'highlight',
        color: '#ffd400',
      }),
    ).resolves.toBe('dismissed');

    expect(fixtureValue.modeRequests).toEqual([]);
  });

  it('sets color before one-shot highlight or comment', async () => {
    for (const kind of ['highlight', 'comment'] as const) {
      const fixtureValue = fixture();
      const calls: string[] = [];
      const uiManager = manager();
      uiManager.updateParams.mockImplementation(() => calls.push('color'));
      uiManager.highlightSelection.mockImplementation(() => {
        calls.push('highlight');
        fixtureValue.annotationStorage.addEditor(9);
      });
      uiManager.commentSelection.mockImplementation(() => calls.push('comment'));
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });
      const editor = fixtureValue.editor;

      await expect(
        editor.commitSelection(
          'current',
          kind === 'highlight' ? { kind, color: '#ffd400' } : { kind, color: '#ffd400', seed: '' },
        ),
      ).resolves.toMatchObject({ identity: { id: 'created-native', kind: 'stable' } });

      expect(calls).toEqual(['color', kind]);
    }
  });

  it('hands the live selection to PDF.js before the commit promise yields', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    uiManager.highlightSelection.mockImplementation(() => {
      fixtureValue.annotationStorage.addEditor(9);
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    const committing = fixtureValue.editor.commitSelection('current', {
      kind: 'highlight',
      color: '#ffd400',
    });

    expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    await expect(committing).resolves.toMatchObject({
      identity: { id: 'created-native', kind: 'stable' },
    });
  });

  it('routes a throwing highlight accessor to the commit boundary exactly once', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    const failure = new Error('PDF.js public highlight color failed');
    const accessor = vi.fn(() => {
      throw failure;
    });
    const transactionEditor = selectedEditor('throwing-runtime', 9);
    const unrelatedEditor = selectedEditor('unrelated-runtime', 9);
    let transactionEditorReady = false;
    let unrelatedEditorReady = false;
    fixtureValue.commentBridge.nativeEditorIds.mockImplementation(
      () =>
        new Set([
          ...(transactionEditorReady ? ['throwing-runtime'] : []),
          ...(unrelatedEditorReady ? ['unrelated-runtime'] : []),
        ]),
    );
    uiManager.getEditor.mockImplementation((id) => {
      if (id === 'throwing-runtime') return transactionEditor;
      if (id === 'unrelated-runtime') return unrelatedEditor;
      return undefined;
    });
    let selectedForDelete: ReturnType<typeof selectedEditor> | null = null;
    uiManager.setSelected.mockImplementation((editor: ReturnType<typeof selectedEditor>) => {
      selectedForDelete = editor;
    });
    uiManager.delete.mockImplementation(() => {
      if (selectedForDelete === transactionEditor) transactionEditorReady = false;
      if (selectedForDelete === unrelatedEditor) unrelatedEditorReady = false;
    });
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() => {
      if (!transactionEditorReady) return null;
      return accessor();
    });
    uiManager.highlightSelection.mockImplementation(() => {
      transactionEditorReady = true;
      uiManager.firstSelectedEditor = transactionEditor;
      fixtureValue.annotationStorage.addEditor(9);
      unrelatedEditorReady = true;
      uiManager.firstSelectedEditor = unrelatedEditor;
      fixtureValue.annotationStorage.addEditor(9);
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await expect(
      fixtureValue.editor.commitSelection('current', {
        kind: 'highlight',
        color: '#ffd400',
      }),
    ).rejects.toBe(failure);
    await Promise.resolve();

    expect(accessor).toHaveBeenCalledOnce();
    expect(uiManager.setSelected).toHaveBeenCalledExactlyOnceWith(transactionEditor);
    expect(uiManager.delete).toHaveBeenCalledOnce();
    expect(transactionEditorReady).toBe(false);
    expect(unrelatedEditorReady).toBe(true);
  });

  it('fails closed when a rollback diff cannot prove one transaction-owned editor', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    const failure = new Error('PDF.js public highlight color failed');
    const firstEditor = selectedEditor('ambiguous-first', 9);
    const secondEditor = selectedEditor('ambiguous-second', 9);
    let firstEditorReady = false;
    let secondEditorReady = false;
    fixtureValue.commentBridge.nativeEditorIds.mockImplementation(
      () =>
        new Set([
          ...(firstEditorReady ? ['ambiguous-first'] : []),
          ...(secondEditorReady ? ['ambiguous-second'] : []),
        ]),
    );
    uiManager.getEditor.mockImplementation((id) => {
      if (id === 'ambiguous-first') return firstEditor;
      if (id === 'ambiguous-second') return secondEditor;
      return undefined;
    });
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() => {
      if (!firstEditorReady) return null;
      throw failure;
    });
    uiManager.highlightSelection.mockImplementation(() => {
      firstEditorReady = true;
      secondEditorReady = true;
      uiManager.firstSelectedEditor = secondEditor;
      fixtureValue.annotationStorage.addEditor(9);
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    const rejected = await fixtureValue.editor
      .commitSelection('current', {
        kind: 'highlight',
        color: '#ffd400',
      })
      .catch((cause: unknown) => cause);

    expect(rejected).toBeInstanceOf(AggregateError);
    expect((rejected as AggregateError).errors as unknown[]).toContain(failure);

    expect(uiManager.setSelected).not.toHaveBeenCalled();
    expect(uiManager.delete).not.toHaveBeenCalled();
    expect(firstEditorReady).toBe(true);
    expect(secondEditorReady).toBe(true);
  });

  it('resolves highlight after dirty and NONE', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    let settled = false;
    const committing = fixtureValue.editor
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }]);
    });
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 9,
    });
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    fixtureValue.annotationStorage.addEditor(9);
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
    });
    expect(settled).toBe(false);
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await expect(committing).resolves.toMatchObject({
      identity: { id: 'created-native', kind: 'stable' },
    });
  });

  it('adopts exactly one highlight created while PDF.js enters highlight mode', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager);
    fixtureValue.commentBridge.normalizeSelectionHighlight
      .mockReturnValueOnce(null)
      .mockReturnValue(createdAnnotation());
    fixtureValue.eventBus.on('annotationeditormodechanged', (event: unknown) => {
      if ((event as { readonly mode?: number }).mode !== 9) return;
      fixtureValue.selectionObserver.validate.mockReturnValue('stale');
      window.setTimeout(() => {
        fixtureValue.annotationStorage.addEditor(9);
      }, 0);
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await expect(
      fixtureValue.editor.commitSelection('current', {
        kind: 'highlight',
        color: '#ffd400',
      }),
    ).resolves.toMatchObject({ identity: { id: 'created-native', kind: 'stable' } });

    expect(fixtureValue.annotationStorage.addEditor).toHaveBeenCalledOnce();
    expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
  });

  it('adopts the highlight even when PDF.js omits its editor-added callback', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager);
    let created = false;
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() =>
      created ? createdAnnotation() : null,
    );
    fixtureValue.eventBus.on('annotationeditormodechanged', (event: unknown) => {
      if ((event as { readonly mode?: number }).mode !== 9) return;
      fixtureValue.selectionObserver.validate.mockReturnValue('stale');
      window.requestAnimationFrame(() => {
        created = true;
      });
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await expect(
      fixtureValue.editor.commitSelection('current', {
        kind: 'highlight',
        color: '#ffd400',
      }),
    ).resolves.toMatchObject({ identity: { id: 'created-native', kind: 'stable' } });

    expect(fixtureValue.annotationStorage.addEditor).not.toHaveBeenCalled();
    expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
  });

  it('applies a comment seed through PDF.js selection comment creation from NONE mode', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager, 'comment');
    fixtureValue.commentBridge.reserveNextDialog.mockImplementation((seed) => ({
      closed: Promise.resolve('external'),
      opened: Promise.resolve(createdAnnotation(seed)),
    }));
    fixtureValue.eventBus.on('annotationeditormodechanged', (event: unknown) => {
      if ((event as { readonly mode?: number }).mode !== 9) return;
      fixtureValue.selectionObserver.validate.mockReturnValue('stale');
      fixtureValue.annotationStorage.addEditor(9);
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await expect(
      fixtureValue.editor.commitSelection('current', {
        kind: 'comment',
        color: '#ffd400',
        seed: 'Résumé — #review [[Source]]',
      }),
    ).resolves.toMatchObject({
      comment: 'Résumé — #review [[Source]]',
      identity: { id: 'created-native', kind: 'stable' },
    });

    expect(fixtureValue.annotationStorage.addEditor).toHaveBeenCalledOnce();
    expect(uiManager.commentSelection).toHaveBeenCalledOnce();
    expect(fixtureValue.commentBridge.updateAnnotations).not.toHaveBeenCalled();
  });

  it('resolves a created highlight when annotation storage was already dirty', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    fixtureValue.annotationStorage.addEditor(3);
    uiManager.highlightSelection.mockImplementation(() => {
      fixtureValue.annotationStorage.addEditor(9);
    });

    await expect(
      fixtureValue.editor.commitSelection('current', {
        kind: 'highlight',
        color: '#ffd400',
      }),
    ).resolves.toMatchObject({ identity: { id: 'created-native', kind: 'stable' } });

    expect(fixtureValue.annotationStorage.addEditor).toHaveBeenCalledTimes(2);
  });

  it('suppresses transient native highlight mode', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const modes: string[] = [];
    const interaction = fixtureValue.editor as PdfAnnotationEditor & {
      onMode(listener: (mode: string) => void): () => void;
    };
    interaction.onMode((mode) => modes.push(mode));

    const committing = interaction.commitSelection('current', {
      kind: 'highlight',
      color: '#ffd400',
    });
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }]);
    });
    expect(modes).toEqual(['neutral', 'one-shot']);
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 9,
    });
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    expect(modes).toEqual(['neutral', 'one-shot']);
    fixtureValue.annotationStorage.addEditor(9);
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
    });
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await committing;
    expect(modes).toEqual(['neutral', 'one-shot', 'neutral']);
  });

  it('synchronizes external Ink Text neutral and disabled modes', () => {
    const fixtureValue = fixture();
    const modes: string[] = [];
    fixtureValue.editor.onMode((mode) => modes.push(mode));

    for (const mode of [15, 3, 0, -1]) {
      fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
        source: fixtureValue.viewer,
        mode,
      });
    }

    expect(modes).toEqual(['neutral', 'ink', 'freetext', 'neutral', 'disabled']);
  });

  it('hardens public selection, mode, id, and native-editor boundaries', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    uiManager.getEditor.mockImplementation((internalId: string) => {
      if (internalId === 'valid')
        return {
          ...selectedEditor('public-id', 9),
          getData: () => ({ id: 'persisted-id' }),
        };
      if (internalId === 'uid-only') return selectedEditor('public-id', 9);
      if (internalId === 'non-hcm-color')
        return {
          ...selectedEditor('non-hcm-color', 9),
          getNonHCMColor: () => [300, -3, Number.NaN],
        };
      if (internalId === 'authored-color')
        return {
          ...selectedEditor('authored-color', 15),
          color: ' #AaBbCc ',
        };
      if (internalId === 'blank-uid') return selectedEditor('   ', 9);
      if (internalId === 'unknown-mode') return selectedEditor('public-id', 99);
      if (internalId === 'invalid-mode') return { mode: '9', uid: 'public-id' };
      return undefined;
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await expect(
      fixtureValue.editor.editAnnotation({ editComment: false, id: '   ', kind: 'highlight' }),
    ).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(fixtureValue.editor.resolveNativeEditor(' valid ')).toEqual({
      color: null,
      id: 'persisted-id',
      kind: 'highlight',
      mode: 9,
    });
    expect(fixtureValue.editor.resolveNativeEditor('uid-only')).toEqual({
      color: null,
      id: 'public-id',
      kind: 'highlight',
      mode: 9,
    });
    expect(fixtureValue.editor.resolveNativeEditor('non-hcm-color')).toEqual({
      color: '#ff0000',
      id: 'non-hcm-color',
      kind: 'highlight',
      mode: 9,
    });
    expect(fixtureValue.editor.resolveNativeEditor('authored-color')).toEqual({
      color: '#aabbcc',
      id: 'authored-color',
      kind: 'ink',
      mode: 15,
    });
    expect(fixtureValue.editor.resolveNativeEditor('missing')).toBeNull();
    expect(fixtureValue.editor.resolveNativeEditor('blank-uid')).toBeNull();
    expect(fixtureValue.editor.resolveNativeEditor('invalid-mode')).toBeNull();
    expect(fixtureValue.editor.resolveNativeEditor('unknown-mode')).toBeNull();

    await expect(fixtureValue.editor.focusAnnotation('   ', { kind: 'sidebar' })).resolves.toBe(
      'cancelled',
    );
    await expect(
      fixtureValue.editor.focusAnnotation('cancelled-before-start', {
        kind: 'sidebar',
        signal: AbortSignal.abort(),
      }),
    ).resolves.toBe('cancelled');

    const selectionListener = vi.fn();
    fixtureValue.editor.onSelection(selectionListener);
    expect(fixtureValue.selectionObserver.onSelection).toHaveBeenCalledExactlyOnceWith(
      selectionListener,
    );

    const modes: string[] = [];
    const unsubscribe = fixtureValue.editor.onMode((mode) => modes.push(mode));
    expect(modes).toEqual(['neutral']);
    unsubscribe();
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 15,
    });
    expect(modes).toEqual(['neutral']);

    const focusListener = vi.fn();
    const removeFocusListener = fixtureValue.editor.onAnnotationFocus(focusListener);
    removeFocusListener();
    fixtureValue.emitBridgeFocus(annotationFocus('unsubscribed-focus', false, { writable: false }));
    expect(focusListener).not.toHaveBeenCalled();

    fixtureValue.editor.destroy();
    expect(fixtureValue.editor.resolveNativeEditor('valid')).toBeNull();
    await expect(
      fixtureValue.editor.focusAnnotation('destroyed-focus', { kind: 'sidebar' }),
    ).resolves.toBe('cancelled');
    const inertCleanup = fixtureValue.editor.onMode(() => {
      throw new Error('Destroyed mode listeners must stay inert.');
    });
    inertCleanup();
  });

  it('keeps native mode neutral while Sticky Highlight is armed and commits through PDF.js once', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await fixtureValue.editor.setQuickHighlight({ enabled: true, color: '#5fb236' });
    const committing = fixtureValue.editor.commitSelection('current', {
      kind: 'highlight',
      color: '#5fb236',
    });
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockReturnValue(
      createdAnnotation('', { id: 'sticky-native' }),
    );
    fixtureValue.annotationStorage.onAnnotationEditor?.(9);
    await expect(committing).resolves.toMatchObject({
      identity: { id: 'sticky-native', kind: 'stable' },
    });

    expect(uiManager.updateParams).toHaveBeenNthCalledWith(1, 31, '#5fb236');
    expect(uiManager.updateParams).toHaveBeenNthCalledWith(2, 31, '#5fb236');
    expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    expect(fixtureValue.viewer.annotationEditorMode).toBe(0);
  });

  it('rolls back a materialized native highlight before an aborted selection transaction settles', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
    const abort = new AbortController();
    const dirty: boolean[] = [];
    let nativePresent = false;
    fixtureValue.editor.onDirty((value) => dirty.push(value));
    fixtureValue.commentBridge.nativeEditorIds.mockImplementation(() =>
      nativePresent ? new Set(['sticky-runtime']) : new Set(),
    );
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() =>
      nativePresent ? createdAnnotation('', { id: 'sticky-native' }) : null,
    );
    fixtureValue.commentBridge.deleteAnnotations.mockImplementation(() => {
      fixtureValue.annotationStorage.setValue('unrelated-native-edit', {
        id: 'unrelated-native-edit',
        mode: 15,
      });
      return true;
    });
    uiManager.highlightSelection.mockImplementation(() => {
      fixtureValue.viewer.annotationEditorMode = { mode: 9 };
      nativePresent = true;
      fixtureValue.annotationStorage.addEditor(9, 'sticky-runtime');
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    let settled = false;
    const committing = fixtureValue.editor
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' }, abort.signal)
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (cause: unknown) => {
          settled = true;
          return cause;
        },
      );
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
    });

    abort.abort(new DOMException('Select requested.', 'AbortError'));
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await vi.waitFor(() => {
      expect(fixtureValue.commentBridge.deleteAnnotations).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    nativePresent = false;

    await expect(committing).resolves.toMatchObject({ name: 'AbortError' });
    expect(fixtureValue.commentBridge.deleteAnnotations).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ identity: { id: 'sticky-native', kind: 'stable' } }),
    ]);
    expect(nativePresent).toBe(false);
    expect(fixtureValue.annotationStorage.isModified()).toBe(true);
    expect(fixtureValue.annotationStorage.editorSnapshot('unrelated-native-edit')).toEqual({
      id: 'unrelated-native-edit',
      mode: 15,
    });
    expect(dirty).toEqual([true]);
  });

  it('rolls back a materialized native highlight when the commit cannot return to NONE', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    const failure = new Error('neutral mode transition failed');
    let nativePresent = false;
    fixtureValue.commentBridge.nativeEditorIds.mockImplementation(() =>
      nativePresent ? new Set(['sticky-runtime']) : new Set(),
    );
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() =>
      nativePresent ? createdAnnotation('', { id: 'sticky-native' }) : null,
    );
    fixtureValue.commentBridge.deleteAnnotations.mockImplementation(() => {
      nativePresent = false;
      return true;
    });
    uiManager.highlightSelection.mockImplementation(() => {
      fixtureValue.viewer.annotationEditorMode = { mode: 9 };
      nativePresent = true;
      fixtureValue.annotationStorage.addEditor(9, 'sticky-runtime');
      Object.defineProperty(fixtureValue.viewer, 'annotationEditorMode', {
        configurable: true,
        get: () => 9,
        set: () => {
          throw failure;
        },
      });
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await expect(
      fixtureValue.editor.commitSelection('current', {
        kind: 'highlight',
        color: '#ffd400',
      }),
    ).rejects.toBe(failure);

    expect(fixtureValue.commentBridge.deleteAnnotations).toHaveBeenCalledOnce();
    expect(nativePresent).toBe(false);
    expect(fixtureValue.annotationStorage.isModified()).toBe(true);
  });

  it('rolls back a materialized native highlight when its transaction times out', async () => {
    vi.useFakeTimers();
    try {
      const fixtureValue = fixture({ dispatchModeChanges: false });
      const uiManager = manager();
      let nativePresent = false;
      fixtureValue.commentBridge.nativeEditorIds.mockImplementation(() =>
        nativePresent ? new Set(['sticky-runtime']) : new Set(),
      );
      fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() =>
        nativePresent ? createdAnnotation('', { id: 'sticky-native' }) : null,
      );
      fixtureValue.commentBridge.deleteAnnotations.mockImplementation(() => {
        nativePresent = false;
        return true;
      });
      uiManager.highlightSelection.mockImplementation(() => {
        fixtureValue.viewer.annotationEditorMode = { mode: 9 };
        nativePresent = true;
        fixtureValue.annotationStorage.addEditor(9, 'sticky-runtime');
      });
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });

      const committing = fixtureValue.editor
        .commitSelection('current', {
          kind: 'highlight',
          color: '#ffd400',
        })
        .catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(committing).resolves.toMatchObject({ name: 'TimeoutError' });
      expect(fixtureValue.commentBridge.deleteAnnotations).toHaveBeenCalledOnce();
      expect(nativePresent).toBe(false);
      expect(fixtureValue.annotationStorage.isModified()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['ink', 15],
    ['freetext', 3],
  ] as const)(
    'settles and rolls back a pending Sticky Highlight before the newer %s tool wins',
    async (tool, mode) => {
      const fixtureValue = fixture({ dispatchModeChanges: false });
      const uiManager = manager();
      let nativePresent = false;
      fixtureValue.commentBridge.nativeEditorIds.mockImplementation(() =>
        nativePresent ? new Set(['sticky-runtime']) : new Set(),
      );
      fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() =>
        nativePresent ? createdAnnotation('', { id: 'sticky-native' }) : null,
      );
      fixtureValue.commentBridge.deleteAnnotations.mockImplementation(() => {
        nativePresent = false;
        return true;
      });
      uiManager.highlightSelection.mockImplementation(() => {
        fixtureValue.viewer.annotationEditorMode = { mode: 9 };
        nativePresent = true;
        fixtureValue.annotationStorage.addEditor(9, 'sticky-runtime');
      });
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });

      const committing = fixtureValue.editor
        .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
        .catch((cause: unknown) => cause);
      await vi.waitFor(() => {
        expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
      });
      const supersededTool = fixtureValue.editor
        .setTool(tool === 'ink' ? 'freetext' : 'ink')
        .catch((cause: unknown) => cause);
      const changingTool = fixtureValue.editor.setTool(tool);
      await vi.waitFor(() => {
        expect(fixtureValue.modeRequests[fixtureValue.modeRequests.length - 1]).toEqual({
          mode: 0,
        });
      });
      fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
        source: fixtureValue.viewer,
        mode: 0,
      });
      await vi.waitFor(() => {
        expect(fixtureValue.modeRequests[fixtureValue.modeRequests.length - 1]).toEqual({ mode });
      });
      fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
        source: fixtureValue.viewer,
        mode,
      });

      await expect(changingTool).resolves.toBeUndefined();
      await expect(supersededTool).resolves.toMatchObject({ name: 'AbortError' });
      await expect(committing).resolves.toMatchObject({ name: 'AbortError' });
      expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }, { mode }]);
      expect(fixtureValue.viewer.annotationEditorMode).toBe(mode);
      expect(fixtureValue.commentBridge.deleteAnnotations).toHaveBeenCalledOnce();
      expect(nativePresent).toBe(false);
    },
  );

  it.each([
    ['ink', 15],
    ['freetext', 3],
  ] as const)(
    'does not let delayed Sticky Highlight arming restore NONE over newer %s',
    async (tool, mode) => {
      const fixtureValue = fixture();
      const saveGate = deferred<Uint8Array<ArrayBuffer>>();
      const uiManager = manager();
      fixtureValue.saveDocument.mockImplementationOnce(() => saveGate.promise);
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });
      const saving = fixtureValue.editor.save(new AbortController().signal);
      await vi.waitFor(() => {
        expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
      });

      const delayedArming = fixtureValue.editor
        .setQuickHighlight({ color: '#5fb236', enabled: true })
        .catch((cause: unknown) => cause);
      const newerTool = fixtureValue.editor.setTool(tool);
      saveGate.resolve(new Uint8Array([37, 80, 68, 70, 45]));

      await expect(saving).resolves.toEqual(new Uint8Array([37, 80, 68, 70, 45]));
      await expect(newerTool).resolves.toBeUndefined();
      await expect(delayedArming).resolves.toMatchObject({ name: 'AbortError' });
      expect(fixtureValue.modeRequests).toEqual([{ mode }]);
      expect(fixtureValue.viewer.annotationEditorMode).toBe(mode);
      expect(uiManager.updateParams).toHaveBeenCalledExactlyOnceWith(31, '#5fb236');
    },
  );

  it('resolves comment after bridge open close and NONE', async () => {
    const fixtureValue = fixture();
    const opened = deferred<DocumentAnnotation>();
    const closed = deferred<'escape'>();
    fixtureValue.commentBridge.reserveNextDialog.mockReturnValue({
      opened: opened.promise,
      closed: closed.promise,
    });
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager, 'comment');
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    let settled = false;

    const committing = fixtureValue.editor
      .commitSelection('current', {
        kind: 'comment',
        color: '#a28ae5',
        seed: '#',
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => {
      expect(uiManager.commentSelection).toHaveBeenCalledOnce();
    });
    expect(fixtureValue.commentBridge.reserveNextDialog).toHaveBeenCalledWith(
      '#',
      expect.any(AbortSignal),
    );
    expect(settled).toBe(false);
    opened.resolve(createdAnnotation('#'));
    await Promise.resolve();
    expect(settled).toBe(false);
    closed.resolve('escape');

    await expect(committing).resolves.toMatchObject({
      identity: { id: 'created-native', kind: 'stable' },
    });
    expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
  });

  it('does not time out while an open comment waits for the user', async () => {
    vi.useFakeTimers();
    try {
      const fixtureValue = fixture();
      const closed = deferred<'escape'>();
      fixtureValue.commentBridge.reserveNextDialog.mockReturnValue({
        opened: Promise.resolve(createdAnnotation()),
        closed: closed.promise,
      });
      const uiManager = manager();
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });
      let outcome: unknown = 'pending';
      const committing = fixtureValue.editor
        .commitSelection('current', {
          kind: 'comment',
          color: '#a28ae5',
          seed: '',
        })
        .then(
          (value) => {
            outcome = value;
          },
          (cause: unknown) => {
            outcome = cause;
          },
        );
      await vi.advanceTimersByTimeAsync(0);
      expect(uiManager.commentSelection).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(2_001);

      expect(outcome).toBe('pending');
      closed.resolve('escape');
      await committing;
      expect(outcome).toMatchObject({ identity: { id: 'created-native', kind: 'stable' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the native transition timeout after the user closes a comment', async () => {
    vi.useFakeTimers();
    try {
      const fixtureValue = fixture({ dispatchModeChanges: false });
      const closed = deferred<'escape'>();
      fixtureValue.commentBridge.reserveNextDialog.mockReturnValue({
        opened: Promise.resolve(createdAnnotation()),
        closed: closed.promise,
      });
      const uiManager = manager();
      requestPdfJsSelectionMode(fixtureValue, uiManager, 'comment');
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });
      let outcome: unknown = 'pending';
      void fixtureValue.editor
        .commitSelection('current', {
          kind: 'comment',
          color: '#a28ae5',
          seed: '',
        })
        .catch((cause: unknown) => {
          outcome = cause;
        });
      fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
        source: fixtureValue.viewer,
        mode: 9,
      });
      await vi.advanceTimersByTimeAsync(2_001);
      expect(outcome).toBe('pending');

      closed.resolve('escape');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts pending transactions on lifecycle changes', async () => {
    for (const lifecycle of ['detach', 'destroy'] as const) {
      const fixtureValue = fixture();
      const uiManager = manager();
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });
      let outcome: unknown = 'pending';
      void fixtureValue.editor
        .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
        .then(
          () => {
            outcome = new Error('Unexpected transaction resolution.');
          },
          (cause: unknown) => {
            outcome = cause;
          },
        );
      await vi.waitFor(() => {
        expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
      });

      if (lifecycle === 'detach') fixtureValue.editor.detachFromDocument();
      else fixtureValue.editor.destroy();

      await vi.waitFor(() => {
        expect(outcome).not.toBe('pending');
      });
      expect(outcome).toMatchObject({ name: 'AbortError' });
      expect(fixtureValue.viewer.annotationEditorMode).toBe(0);
    }
  });

  it('waits for source-confirmed NONE before an aborted interaction settles', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const modes: string[] = [];
    fixtureValue.editor.onMode((mode) => modes.push(mode));
    let commitOutcome: unknown = 'pending';
    const committing = fixtureValue.editor
      .commitSelection('current', {
        kind: 'highlight',
        color: '#ffd400',
      })
      .catch((cause: unknown) => {
        commitOutcome = cause;
      });
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 9,
    });
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    let aborted = false;

    const aborting = fixtureValue.editor
      .abortInteraction('Navigation aborted the annotation interaction.')
      .finally(() => {
        aborted = true;
      });
    await Promise.resolve();

    expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
    expect(aborted).toBe(false);
    expect(modes).toEqual(['neutral', 'one-shot']);
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', { source: {}, mode: 0 });
    await Promise.resolve();
    expect(aborted).toBe(false);

    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await aborting;
    await committing;
    expect(commitOutcome).toMatchObject({ name: 'AbortError' });
    expect(modes).toEqual(['neutral', 'one-shot', 'neutral']);
  });

  it('propagates a neutral mode setter failure from interaction abort', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const committing = fixtureValue.editor
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => cause);
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    const failure = new Error('neutral mode setter failed');
    Object.defineProperty(fixtureValue.viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => 9,
      set: () => {
        throw failure;
      },
    });

    await expect(
      fixtureValue.editor.abortInteraction('Navigation aborted the annotation interaction.'),
    ).rejects.toBe(failure);
    await expect(committing).resolves.toBe(failure);
  });

  it('aborts the reserved comment dialog with its transaction', async () => {
    const fixtureValue = fixture();
    let reservationSignal: AbortSignal | undefined;
    fixtureValue.commentBridge.reserveNextDialog.mockImplementation(
      (_seed: string, signal?: AbortSignal) => {
        reservationSignal = signal;
        return {
          opened: new Promise<DocumentAnnotation>(() => undefined),
          closed: new Promise<'external'>(() => undefined),
        };
      },
    );
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const abortController = new AbortController();

    const committing = fixtureValue.editor.commitSelection(
      'current',
      { kind: 'comment', color: '#ffd400', seed: '[[' },
      abortController.signal,
    );
    const rejected = expect(committing).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => {
      expect(uiManager.commentSelection).toHaveBeenCalledOnce();
    });
    abortController.abort(new DOMException('cancelled', 'AbortError'));

    await rejected;
    expect(reservationSignal?.aborted).toBe(true);
  });

  it('rejects a native transaction timeout and restores neutral', async () => {
    vi.useFakeTimers();
    try {
      const fixtureValue = fixture();
      const uiManager = manager();
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });
      let outcome: unknown = 'pending';
      void fixtureValue.editor
        .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
        .catch((cause: unknown) => {
          outcome = cause;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(fixtureValue.viewer.annotationEditorMode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signals a successful native comment mutation without writing parallel annotation state', () => {
    const { annotationStorage, editor, eventBus, viewer } = fixture();
    const notifications: string[] = [];
    const removeMutation = editor.onMutation(() => notifications.push('mutation'));
    const removeDirty = editor.onDirty((dirty) => notifications.push(`dirty:${String(dirty)}`));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });

    (editor as PdfAnnotationEditor & { notifyNativeMutation(): void }).notifyNativeMutation();

    expect(notifications).toEqual(['mutation', 'dirty:true']);
    expect(annotationStorage.resetModified).not.toHaveBeenCalled();
    removeMutation();
    removeDirty();
    (editor as PdfAnnotationEditor & { notifyNativeMutation(): void }).notifyNativeMutation();
    expect(notifications).toEqual(['mutation', 'dirty:true']);
  });
  it('does not widen generic setTool edit options', () => {
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('editId');
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('editComment');
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('mustEnterInEditMode');
    expectTypeOf<PdfAnnotationToolOptions>().toHaveProperty('isFromKeyboard');
  });

  it('activates a direct native editor request through the guarded contextual lifecycle', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'direct-highlight' });
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('direct-highlight', 9)),
    });

    await expect(
      current.editor.activateAnnotation({
        anchor: annotation.anchor,
        editComment: true,
        id: ' direct-highlight ',
        kind: 'highlight',
      }),
    ).resolves.toBe('editable');

    expect(current.modeRequests).toEqual([
      { editComment: true, editId: 'direct-highlight', mode: 9 },
    ]);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledExactlyOnceWith(
      'direct-highlight',
      expect.any(AbortSignal),
      undefined,
      { editableOnly: true, preserveSelection: true },
    );
  });

  it('materializes a verified persisted annotation before publishing editable focus', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'persisted-highlight' });
    current.editor.setAnnotationProjection([
      {
        annotation,
        stableId: 'persisted-highlight',
        ...({ editorUid: 'pdfjs_internal_editor_0' } as Record<string, string>),
      },
    ]);
    const uiManager = manager(selectedEditor('persisted-highlight', 9));
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });

    await expect(
      current.editor.focusAnnotation('persisted-highlight', { kind: 'sidebar' }),
    ).resolves.toBe('editable');

    expect(current.modeRequests).toEqual([
      { editComment: false, editId: 'persisted-highlight', mode: 9 },
    ]);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
      'persisted-highlight',
      expect.any(AbortSignal),
      annotation,
      {
        editableOnly: true,
        preserveSelection: true,
      },
    );
  });

  it('prefers the currently mounted PDF editor identity over a stale projected runtime id', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: '369R' });
    current.editor.setAnnotationProjection([
      {
        annotation,
        editorUid: 'pdfjs_internal_editor_0',
        stableId: '369R',
      },
    ]);
    current.commentBridge.nativeEditorUidForAnnotation.mockReturnValue('369R');
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('369R', 9)),
    });

    await expect(current.editor.focusAnnotation('369R', { kind: 'root-click' })).resolves.toBe(
      'editable',
    );

    expect(current.modeRequests).toEqual([{ editComment: false, editId: '369R', mode: 9 }]);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
      '369R',
      expect.any(AbortSignal),
      annotation,
      { editableOnly: true, preserveSelection: true },
    );
  });

  it('canonicalizes a live runtime activation through its projected stable target', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: '29R' });
    current.editor.setAnnotationProjection([
      {
        aliases: ['selection-1'],
        annotation,
        editorUid: 'pdfjs_internal_editor_0',
        stableId: '29R',
      },
    ]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('29R', 9)),
    });

    await expect(
      current.editor.focusAnnotation('pdfjs_internal_editor_0', { kind: 'root-click' }),
    ).resolves.toBe('editable');

    expect(current.modeRequests).toEqual([{ editComment: false, editId: '29R', mode: 9 }]);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
      '29R',
      expect.any(AbortSignal),
      annotation,
      {
        editableOnly: true,
        preserveSelection: true,
      },
    );
  });

  it('canonicalizes cheap selection without requesting a mode or materializing contextual focus', () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: '29R' });
    current.editor.setAnnotationProjection([
      {
        aliases: ['selection-1'],
        annotation,
        editorUid: 'pdfjs_internal_editor_0',
        stableId: '29R',
      },
    ]);

    expect(current.editor.selectAnnotation('selection-1')).toBe(true);

    expect(current.commentBridge.synchronizeAnnotationSelection).toHaveBeenCalledExactlyOnceWith(
      '29R',
      'pdfjs_internal_editor_0',
    );
    expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalled();
    expect(current.modeRequests).toEqual([]);
  });

  it('returns the real cheap-selection bridge result for a not-yet-mounted far-page node', () => {
    const current = fixture();
    current.commentBridge.synchronizeAnnotationSelection.mockReturnValue(false);

    expect(current.editor.selectAnnotation('far-page')).toBe(false);
    expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalled();
    expect(current.modeRequests).toEqual([]);
  });

  it.each(['select', 'clear'] as const)(
    '%s cancels a deferred contextual resolver without changing native mode',
    async (action) => {
      const current = fixture();
      const uiManager = manager();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      const resolution = deferred<DocumentAnnotation | null>();
      current.editor.setAnnotationResolver(async () => resolution.promise);
      const activation = current.editor.focusAnnotation('annotation-a', { kind: 'sidebar' });
      await Promise.resolve();

      if (action === 'select') current.editor.selectAnnotation('annotation-b');
      else current.editor.clearAnnotationSelection();
      resolution.resolve(createdAnnotation('', { id: 'annotation-a' }));

      await expect(activation).resolves.toBe('cancelled');
      expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalled();
      expect(current.modeRequests).toEqual([]);
    },
  );

  it('never lets a historical alias override another projected canonical id', async () => {
    const current = fixture();
    const first = createdAnnotation('First', { id: '30R' });
    const second = createdAnnotation('Second', { id: '31R' });
    current.editor.setAnnotationProjection([
      {
        aliases: ['29R'],
        annotation: first,
        editorUid: 'pdfjs_internal_editor_0',
        stableId: '30R',
      },
      {
        aliases: ['30R'],
        annotation: second,
        editorUid: 'pdfjs_internal_editor_1',
        stableId: '31R',
      },
    ]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('30R', 9)),
    });

    await expect(current.editor.focusAnnotation('30R', { kind: 'sidebar' })).resolves.toBe(
      'editable',
    );

    expect(current.modeRequests).toEqual([{ editComment: false, editId: '30R', mode: 9 }]);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
      '30R',
      expect.any(AbortSignal),
      first,
      {
        editableOnly: true,
        preserveSelection: true,
      },
    );
  });

  it('forwards the fresh sidebar anchor through one native annotation activation', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'sidebar-anchored-highlight' });
    current.editor.setAnnotationProjection([
      { annotation, stableId: 'sidebar-anchored-highlight' },
    ]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('sidebar-anchored-highlight', 9)),
    });

    await expect(
      current.editor.focusAnnotation('sidebar-anchored-highlight', {
        clientPosition: { x: 72, y: 288 },
        kind: 'sidebar',
      }),
    ).resolves.toBe('editable');

    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
      'sidebar-anchored-highlight',
      expect.any(AbortSignal),
      annotation,
      {
        clientPosition: { x: 72, y: 288 },
        editableOnly: true,
        preserveSelection: true,
      },
    );
  });

  it('indexes projected annotations through their available stable identifier', async () => {
    const current = fixture();
    const sidecarAddressed = {
      ...createdAnnotation('', { id: 'legacy-pdf-id', writable: false }),
      identity: { fingerprint: 'legacy-pdf-fingerprint', kind: 'legacy' as const },
    };
    const identityAddressed = createdAnnotation('', { id: 'identity-pdf-id', writable: false });
    current.editor.setAnnotationProjection([
      { annotation: sidecarAddressed, stableId: ' sidebar-stable-id ' },
      { annotation: identityAddressed, stableId: '   ' },
    ]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });

    await expect(
      current.editor.focusAnnotation('sidebar-stable-id', { kind: 'sidebar' }),
    ).resolves.toBe('readonly');
    await expect(
      current.editor.focusAnnotation('identity-pdf-id', { kind: 'sidebar' }),
    ).resolves.toBe('readonly');

    expect(current.commentBridge.focusAnnotation).toHaveBeenNthCalledWith(
      1,
      'sidebar-stable-id',
      expect.any(AbortSignal),
      sidecarAddressed,
      { forceReadonly: true },
    );
    expect(current.commentBridge.focusAnnotation).toHaveBeenNthCalledWith(
      2,
      'identity-pdf-id',
      expect.any(AbortSignal),
      identityAddressed,
      { forceReadonly: true },
    );
  });

  it('cleans a successful activation before its public continuation starts the same id again', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'settled-readonly-retry';
    const external = new AbortController();
    const removeExternalAbort = vi.spyOn(external.signal, 'removeEventListener');
    let retry: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id, writable: false }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });

      const activation = current.editor.focusAnnotation(id, {
        kind: 'sidebar',
        signal: external.signal,
      });
      const observed = activation.then((result) => {
        const internals = activationInternals(current.editor);
        expect(result).toBe('readonly');
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(false);
        expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
        expect(current.eventBus.listeners.get('editorsrendered') ?? new Set()).toHaveLength(0);
        expect(removeExternalAbort).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);

        retry = current.editor.focusAnnotation(id, { kind: 'sidebar' });
        void retry.catch(() => undefined);
        expect(retry).not.toBe(activation);
      });
      const observation = expect(observed).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(0);
      await observation;
      await expect(retry).resolves.toBe('readonly');
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledTimes(2);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      removeExternalAbort.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cleans a genuine activation failure before its public rejection continuation', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'settled-mode-failure';
    const cause = new Error('native mode failed before public rejection');
    const external = new AbortController();
    const removeExternalAbort = vi.spyOn(external.signal, 'removeEventListener');
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(selectedEditor(id, 9)),
      });
      const descriptor = Object.getOwnPropertyDescriptor(current.viewer, 'annotationEditorMode');
      if (descriptor?.get === undefined || descriptor.set === undefined)
        throw new Error('Expected the fixture viewer mode accessor.');
      const getMode = descriptor.get.bind(current.viewer);
      const setMode = descriptor.set.bind(current.viewer);
      Object.defineProperty(current.viewer, 'annotationEditorMode', {
        configurable: true,
        get: getMode,
        set(request: { readonly mode: number }) {
          if (request.mode === 9) throw cause;
          setMode(request);
        },
      });

      const activation = current.editor.focusAnnotation(id, {
        kind: 'root-click',
        signal: external.signal,
      });
      const observed = activation.catch((rejection: unknown) => {
        const internals = activationInternals(current.editor);
        expect(rejection).toBe(cause);
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(false);
        expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
        expect(current.eventBus.listeners.get('editorsrendered') ?? new Set()).toHaveLength(0);
        expect(removeExternalAbort).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        return 'observed' as const;
      });
      const observation = expect(observed).resolves.toBe('observed');

      await vi.advanceTimersByTimeAsync(0);
      await observation;
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      removeExternalAbort.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('preserves an editable UI when one cleanup step fails before public success', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'editable-cleanup-failure';
    const cause = new Error('editable activation cleanup failed');
    const external = new AbortController();
    const removeExternalAbort = vi
      .spyOn(external.signal, 'removeEventListener')
      .mockImplementation(() => {
        throw cause;
      });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(selectedEditor(id, 9)),
      });

      const activation = current.editor.focusAnnotation(id, {
        kind: 'root-click',
        signal: external.signal,
      });
      const observed = activation.then((result) => {
        const internals = activationInternals(current.editor);
        expect(result).toBe('editable');
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(true);
        expect(current.modeRequests.filter((request) => request['mode'] === 0)).toHaveLength(0);
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          '[abyss-documents] Failed to clean up the PDF annotation activation',
          { annotationId: id, cause },
        );
        expect(vi.getTimerCount()).toBe(0);
        return result;
      });
      const observation = expect(observed).resolves.toBe('editable');

      await vi.advanceTimersByTimeAsync(0);
      await observation;
      expect(current.editor.hasContextualEdit).toBe(true);
    } finally {
      warning.mockRestore();
      removeExternalAbort.mockRestore();
      await current.editor.abortInteraction('Test cleanup.');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('attempts every cleanup step and preserves editable success with one aggregate warning', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'multiple-editable-cleanup-failures';
    const externalFailure = new Error('external abort cleanup failed');
    const ownerFailure = new Error('owner abort cleanup failed');
    const external = new AbortController();
    const removeExternalAbort = vi
      .spyOn(external.signal, 'removeEventListener')
      .mockImplementation(() => {
        throw externalFailure;
      });
    const removeOwnerAbort = vi.fn(() => {
      throw ownerFailure;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(selectedEditor(id, 9)),
      });
      current.commentBridge.focusAnnotation.mockImplementation(async () => {
        const owner = activationInternals(current.editor).activeActivation?.contextualFailureOwner;
        if (owner === null || owner === undefined)
          throw new Error('Expected an activation failure owner before bridge focus.');
        owner.removeActivationAbort = removeOwnerAbort;
        return true;
      });

      const activation = current.editor.focusAnnotation(id, {
        kind: 'root-click',
        signal: external.signal,
      });
      const observed = activation.then((result) => {
        const internals = activationInternals(current.editor);
        expect(result).toBe('editable');
        expect(removeExternalAbort).toHaveBeenCalledOnce();
        expect(removeOwnerAbort).toHaveBeenCalledOnce();
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(true);
        expect(current.modeRequests.filter((request) => request['mode'] === 0)).toHaveLength(0);
        expect(warning).toHaveBeenCalledOnce();
        const warningContext = warning.mock.calls[0]?.[1] as
          { readonly annotationId?: unknown; readonly cause?: unknown } | undefined;
        expect(warningContext?.annotationId).toBe(id);
        expect(warningContext?.cause).toBeInstanceOf(AggregateError);
        expect((warningContext?.cause as AggregateError).errors).toEqual([
          externalFailure,
          ownerFailure,
        ]);
        expect(vi.getTimerCount()).toBe(0);
        return result;
      });
      const observation = expect(observed).resolves.toBe('editable');

      await vi.advanceTimersByTimeAsync(0);
      await observation;
    } finally {
      warning.mockRestore();
      removeExternalAbort.mockRestore();
      await current.editor.abortInteraction('Test cleanup.');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('preserves the primary rejection and releases ownership when cleanup also fails', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'settled-cleanup-failure';
    const primary = new Error('native focus failed before cleanup');
    const secondary = new Error('external abort cleanup failed');
    const external = new AbortController();
    const removeExternalAbort = vi
      .spyOn(external.signal, 'removeEventListener')
      .mockImplementation(() => {
        throw secondary;
      });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(selectedEditor(id, 9)),
      });
      current.commentBridge.focusAnnotation.mockRejectedValueOnce(primary);

      const activation = current.editor.focusAnnotation(id, {
        kind: 'root-click',
        signal: external.signal,
      });
      const observed = activation.catch((cause: unknown) => {
        const internals = activationInternals(current.editor);
        expect(cause).toBe(primary);
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(false);
        expect(current.modeRequests.filter((request) => request['mode'] === 0)).toHaveLength(1);
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          '[abyss-documents] Failed to clean up the PDF annotation activation',
          { annotationId: id, cause: secondary },
        );
        expect(vi.getTimerCount()).toBe(0);
        return 'observed' as const;
      });
      const observation = expect(observed).resolves.toBe('observed');

      await vi.advanceTimersByTimeAsync(0);
      await observation;
    } finally {
      warning.mockRestore();
      removeExternalAbort.mockRestore();
      await current.editor.abortInteraction('Test cleanup.');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('preserves a successful readonly UI when cleanup fails', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'successful-cleanup-failure';
    const cause = new Error('successful activation cleanup failed');
    const external = new AbortController();
    const removeExternalAbort = vi
      .spyOn(external.signal, 'removeEventListener')
      .mockImplementation(() => {
        throw cause;
      });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id, writable: false }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });

      const activation = current.editor.focusAnnotation(id, {
        kind: 'sidebar',
        signal: external.signal,
      });
      const observed = activation.then((result) => {
        const internals = activationInternals(current.editor);
        expect(result).toBe('readonly');
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(false);
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          '[abyss-documents] Failed to clean up the PDF annotation activation',
          { annotationId: id, cause },
        );
        expect(vi.getTimerCount()).toBe(0);
        return result;
      });

      await vi.advanceTimersByTimeAsync(0);
      await expect(observed).resolves.toBe('readonly');
    } finally {
      warning.mockRestore();
      removeExternalAbort.mockRestore();
      await current.editor.abortInteraction('Test cleanup.');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects cleanup failure after cancellation because no annotation UI was established', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'cancelled-cleanup-failure';
    const cause = new Error('cancelled activation cleanup failed');
    const external = new AbortController();
    const removeExternalAbort = vi
      .spyOn(external.signal, 'removeEventListener')
      .mockImplementation(() => {
        throw cause;
      });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id, writable: false }), stableId: id },
      ]);
      current.commentBridge.focusAnnotation.mockResolvedValueOnce(false);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });

      const activation = current.editor.focusAnnotation(id, {
        kind: 'sidebar',
        signal: external.signal,
      });
      const observed = activation.catch((rejection: unknown) => {
        const internals = activationInternals(current.editor);
        expect(rejection).toBe(cause);
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(false);
        expect(warning).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        return 'observed' as const;
      });
      const observation = expect(observed).resolves.toBe('observed');

      await vi.advanceTimersByTimeAsync(0);
      await observation;
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      removeExternalAbort.mockRestore();
      await current.editor.abortInteraction('Test cleanup.');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('routes an editing-state failure from a public success continuation outside activation', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const id = 'settled-editing-state-failure';
    const cause = new Error('settled selected editor accessor failed');
    const selected = selectedEditor(id, 9);
    let failSelectionChecks = false;
    const uiManager = manager();
    Object.defineProperty(uiManager, 'firstSelectedEditor', {
      configurable: true,
      get: () => {
        if (failSelectionChecks) throw cause;
        return selected;
      },
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });

      const activation = current.editor.focusAnnotation(id, { kind: 'root-click' });
      const observed = activation.then((result) => {
        const internals = activationInternals(current.editor);
        expect(result).toBe('editable');
        expect(internals.activeActivation).toBeNull();
        expect(internals.contextualActivationFailureOwner).toBeNull();
        expect(current.editor.hasContextualEdit).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        failSelectionChecks = true;

        expect(() => {
          current.eventBus.dispatch('editingstateschanged', {
            source: uiManager,
            details: { hasSelectedEditor: true },
          });
          current.eventBus.dispatch('editingstateschanged', {
            source: uiManager,
            details: { hasSelectedEditor: true },
          });
        }).not.toThrow();
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          '[abyss-documents] Failed to synchronize the PDF annotation editor selection',
          { annotationId: id, cause },
        );
        return result;
      });
      const observation = expect(observed).resolves.toBe('editable');

      await vi.advanceTimersByTimeAsync(0);
      await observation;
      expect(current.editor.hasContextualEdit).toBe(true);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('normalizes an authoritative modifier selection without replacing the native selection', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const annotation = createdAnnotation('', { id: 'selected-highlight' });
      current.editor.setAnnotationProjection([{ annotation, stableId: 'selected-highlight' }]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(selectedEditor('selected-highlight', 9)),
      });
      let nativeSelectionSettled = false;
      window.setTimeout(() => {
        nativeSelectionSettled = true;
      }, 0);
      current.commentBridge.focusAnnotation.mockImplementation(async () => {
        expect(nativeSelectionSettled).toBe(true);
        return true;
      });

      const activation = current.editor.focusAnnotation('selected-highlight', {
        kind: 'root-click',
        preserveNativeSelection: true,
      });
      await vi.runOnlyPendingTimersAsync();

      await expect(activation).resolves.toBe('editable');
      expect(current.modeRequests).toEqual([]);
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
        'selected-highlight',
        expect.any(AbortSignal),
        annotation,
        { editableOnly: true, includeSelectedPeers: true, preserveSelection: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses the duplicate PDF.js toolbar while unified controls are active and restores it on teardown', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'toolbar-highlight' });
    current.editor.setAnnotationProjection([{ annotation, stableId: 'toolbar-highlight' }]);
    const layer = document.body.createDiv({ cls: 'annotationEditorLayer' });
    const anchor = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    const toolbar = anchor.createDiv({ cls: 'editToolbar' });
    toolbar.setCssProps({ display: 'flex' });
    for (const label of ['color', 'comment', 'delete'])
      toolbar.createEl('button', { attr: { 'aria-label': label } });
    const uiManager = manager(selectedEditor('toolbar-highlight', 9, anchor));
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    current.commentBridge.focusAnnotation.mockImplementation(async () => {
      expect(toolbar.hidden).toBe(true);
      expect(toolbar.style.getPropertyValue('display')).toBe('none');
      return true;
    });

    await expect(
      current.editor.focusAnnotation('toolbar-highlight', { kind: 'root-click' }),
    ).resolves.toBe('editable');

    const secondAnchor = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    const secondToolbar = secondAnchor.createDiv({ cls: 'editToolbar' });
    secondToolbar.setCssProps({ display: 'grid' });
    await vi.waitFor(() => {
      expect(secondToolbar.hidden).toBe(true);
      expect(secondToolbar.style.getPropertyValue('display')).toBe('none');
    });

    current.editor.detachFromDocument();
    expect(toolbar.hidden).toBe(false);
    expect(toolbar.style.getPropertyValue('display')).toBe('flex');
    expect(toolbar.style.getPropertyPriority('display')).toBe('');
    expect(secondToolbar.hidden).toBe(false);
    expect(secondToolbar.style.getPropertyValue('display')).toBe('grid');
    layer.remove();
  });

  it('uses one activation deadline when pinned PDF.js dispatches mode after deserialization', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const annotation = createdAnnotation('', { id: 'slow-ink', type: 'ink' });
      current.editor.setAnnotationProjection([{ annotation, stableId: 'slow-ink' }]);
      const uiManager = manager();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      Object.defineProperty(current.viewer, 'annotationEditorMode', {
        configurable: true,
        get: () => current.viewer.currentMode,
        set: (request: { readonly mode: number }) => {
          current.modeRequests.push({ ...request });
          window.setTimeout(() => {
            current.viewer.currentMode = request.mode;
            if (request.mode === 15) {
              uiManager.firstSelectedEditor = selectedEditor('slow-ink', 15);
              current.eventBus.dispatch('editorsrendered', { pageNumber: 1, source: {} });
            }
            current.eventBus.dispatch('annotationeditormodechanged', {
              mode: request.mode,
              source: current.viewer,
            });
          }, 12_500);
        },
      });

      const activation = current.editor.focusAnnotation('slow-ink', { kind: 'root-click' });
      await vi.advanceTimersByTimeAsync(12_500);
      await vi.runOnlyPendingTimersAsync();

      await expect(activation).resolves.toBe('editable');
      expect(current.modeRequests).toEqual([{ editComment: false, editId: 'slow-ink', mode: 15 }]);
      expect(current.eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for PDF.js to select the requested editor after it confirms the native mode', async () => {
    const current = fixture({ dispatchModeChanges: false });
    const annotation = createdAnnotation('', { id: 'post-mode-highlight' });
    const uiManager = manager();
    current.editor.setAnnotationProjection([{ annotation, stableId: 'post-mode-highlight' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    Object.defineProperty(current.viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => current.viewer.currentMode,
      set: (request: { readonly mode: number }) => {
        current.modeRequests.push({ ...request });
        current.viewer.currentMode = request.mode;
        queueMicrotask(() => {
          current.eventBus.dispatch('annotationeditormodechanged', {
            mode: request.mode,
            source: current.viewer,
          });
          if (request.mode !== 9) return;
          window.setTimeout(() => {
            uiManager.firstSelectedEditor = selectedEditor('post-mode-highlight', 9);
            current.eventBus.dispatch('editorsrendered', { pageNumber: 1, source: {} });
          }, 0);
        });
      },
    });

    await expect(
      current.editor.focusAnnotation('post-mode-highlight', { kind: 'root-click' }),
    ).resolves.toBe('editable');
    expect(current.modeRequests).toEqual([
      { editComment: false, editId: 'post-mode-highlight', mode: 9 },
    ]);
    expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(1);
  });

  it('rejects a later throwing selection check promptly and leaves late events inert', async () => {
    vi.useFakeTimers();
    const current = fixture();
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const annotation = createdAnnotation('', { id: 'throwing-selection-check' });
      const uiManager = manager();
      const cause = new Error('selected editor accessor failed');
      let failNextCheck = false;
      const selectedAccessor = vi.fn(() => {
        if (failNextCheck) {
          failNextCheck = false;
          throw cause;
        }
        return undefined;
      });
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: selectedAccessor,
      });
      current.editor.setAnnotationProjection([
        { annotation, stableId: 'throwing-selection-check' },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });

      activation = current.editor.focusAnnotation('throwing-selection-check', {
        kind: 'root-click',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(1);
      failNextCheck = true;

      expect(() => {
        current.eventBus.dispatch('editorsrendered', { pageNumber: 1, source: {} });
      }).not.toThrow();
      await expect(activation).rejects.toBe(cause);
      await vi.advanceTimersByTimeAsync(0);

      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(current.editor.hasContextualEdit).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      const checksAfterSettlement = selectedAccessor.mock.calls.length;
      current.eventBus.dispatch('editorsrendered', { pageNumber: 1, source: {} });
      expect(selectedAccessor).toHaveBeenCalledTimes(checksAfterSettlement);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects an editing-state failure during mode change before waiter installation', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    const id = 'pre-waiter-editing-state-failure';
    const cause = new Error('pre-waiter selected editor accessor failed');
    let failDuringModeChange = false;
    let failed = false;
    const selected = selectedEditor(id, 9);
    const selectedAccessor = vi.fn(() => {
      if (failDuringModeChange && !failed) {
        failed = true;
        throw cause;
      }
      return failed ? selected : undefined;
    });
    const onModeChange = (event: unknown): void => {
      if ((event as { readonly mode?: number }).mode !== 9) return;
      failDuringModeChange = true;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
    };
    const uiManager = manager();
    try {
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: selectedAccessor,
      });
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      current.eventBus.on('annotationeditormodechanged', onModeChange);
      const rejections: unknown[] = [];

      activation = current.editor.focusAnnotation(id, { kind: 'root-click' });
      void activation.catch((failure: unknown) => {
        rejections.push(failure);
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).rejects.toBe(cause);
      expect(rejections).toEqual([cause]);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      current.eventBus.off('annotationeditormodechanged', onModeChange);
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects the first selection inspection failure while installing the waiter', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    const id = 'waiter-installation-selection-failure';
    const cause = new Error('initial waiter selection inspection failed');
    let failSelectionChecks = false;
    const uiManager = manager();
    const onModeChange = (event: unknown): void => {
      if ((event as { readonly mode?: number }).mode === 9) failSelectionChecks = true;
    };
    try {
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: () => {
          if (failSelectionChecks) throw cause;
          return undefined;
        },
      });
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      current.eventBus.on('annotationeditormodechanged', onModeChange);

      activation = current.editor.focusAnnotation(id, { kind: 'root-click' });
      void activation.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).rejects.toBe(cause);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      current.eventBus.off('annotationeditormodechanged', onModeChange);
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects an editing-state failure after waiter cleanup before focus settlement', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const id = 'post-waiter-editing-state-failure';
      const cause = new Error('post-waiter selected editor accessor failed');
      const selected = selectedEditor(id, 9);
      const focused = deferred<boolean>();
      let selectedReady = false;
      let failNextCheck = false;
      const selectedAccessor = vi.fn(() => {
        if (failNextCheck) {
          failNextCheck = false;
          throw cause;
        }
        return selectedReady ? selected : undefined;
      });
      const uiManager = manager();
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: selectedAccessor,
      });
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.commentBridge.focusAnnotation.mockImplementation(() => focused.promise);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });

      activation = current.editor.focusAnnotation(id, { kind: 'root-click' });
      void activation.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(2);
      selectedReady = true;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledOnce();
      focused.resolve(true);
      await Promise.resolve();

      failNextCheck = true;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).rejects.toBe(cause);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledOnce();
      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('preserves an editing-state failure over an immediate activation abort', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const id = 'failure-before-immediate-abort';
      const cause = new Error('selection failure must beat abort');
      let failNextCheck = false;
      const selectedAccessor = vi.fn(() => {
        if (failNextCheck) {
          failNextCheck = false;
          throw cause;
        }
        return undefined;
      });
      const uiManager = manager();
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: selectedAccessor,
      });
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      const external = new AbortController();

      activation = current.editor.focusAnnotation(id, {
        kind: 'root-click',
        signal: external.signal,
      });
      void activation.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      failNextCheck = true;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      external.abort(new DOMException('Superseded immediately after failure.', 'AbortError'));
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).rejects.toBe(cause);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('settles repeated editing-state failures from the first cause and clears resources', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const id = 'repeated-editing-state-failure';
      const firstCause = new Error('first selection accessor failure');
      const secondCause = new Error('second selection accessor failure');
      const thrownCauses: Error[] = [];
      let failSelectionChecks = false;
      let nestedFailureDispatched = false;
      const selectedAccessor = vi.fn(() => {
        if (!failSelectionChecks) return undefined;
        if (!nestedFailureDispatched) {
          nestedFailureDispatched = true;
          current.eventBus.dispatch('editingstateschanged', {
            source: uiManager,
            details: { hasSelectedEditor: true },
          });
          thrownCauses.push(secondCause);
          throw secondCause;
        }
        const cause = firstCause;
        thrownCauses.push(cause);
        throw cause;
      });
      const uiManager = manager();
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: selectedAccessor,
      });
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      const rejections: unknown[] = [];

      activation = current.editor.focusAnnotation(id, { kind: 'root-click' });
      void activation.catch((failure: unknown) => {
        rejections.push(failure);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(2);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(1);
      failSelectionChecks = true;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).rejects.toBe(firstCause);
      expect(rejections).toEqual([firstCause]);
      expect(thrownCauses).toEqual([firstCause, secondCause]);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);

      const checksAfterSettlement = selectedAccessor.mock.calls.length;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      expect(selectedAccessor).toHaveBeenCalledTimes(checksAfterSettlement);
      expect(rejections).toEqual([firstCause]);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      warning.mockRestore();
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('routes the earlier editing-state selection failure to its activation exactly once', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const id = 'throwing-editing-state-selection';
      const annotation = createdAnnotation('', { id });
      const uiManager = manager();
      const cause = new Error('editing-state selected editor accessor failed');
      let failSelectionChecks = false;
      const selectedAccessor = vi.fn(() => {
        if (failSelectionChecks) throw cause;
        return undefined;
      });
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: selectedAccessor,
      });
      current.editor.setAnnotationProjection([{ annotation, stableId: id }]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      const rejections: unknown[] = [];

      activation = current.editor.focusAnnotation(id, { kind: 'root-click' });
      void activation.catch((failure: unknown) => {
        rejections.push(failure);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(2);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(1);
      failSelectionChecks = true;

      expect(() => {
        current.eventBus.dispatch('editingstateschanged', {
          source: uiManager,
          details: { hasSelectedEditor: true },
        });
      }).not.toThrow();
      await expect(activation).rejects.toBe(cause);
      await vi.advanceTimersByTimeAsync(0);

      expect(rejections).toEqual([cause]);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(current.editor.hasContextualEdit).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      const checksAfterSettlement = selectedAccessor.mock.calls.length;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      expect(selectedAccessor).toHaveBeenCalledTimes(checksAfterSettlement);
      expect(rejections).toEqual([cause]);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('contains an editing-state selection failure outside activation with one diagnostic', async () => {
    const current = fixture();
    const uiManager = manager(selectedEditor('direct-contextual-highlight', 9));
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    await current.editor.editAnnotation({
      editComment: false,
      id: 'direct-contextual-highlight',
      kind: 'highlight',
    });
    const cause = new Error('outside activation selection accessor failed');
    Object.defineProperty(uiManager, 'firstSelectedEditor', {
      configurable: true,
      get: () => {
        throw cause;
      },
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => {
        current.eventBus.dispatch('editingstateschanged', {
          source: uiManager,
          details: { hasSelectedEditor: true },
        });
        current.eventBus.dispatch('editingstateschanged', {
          source: uiManager,
          details: { hasSelectedEditor: true },
        });
      }).not.toThrow();

      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        '[abyss-documents] Failed to synchronize the PDF annotation editor selection',
        { annotationId: 'direct-contextual-highlight', cause },
      );
    } finally {
      diagnostic.mockRestore();
      current.editor.destroy();
    }
  });

  it('keeps an abort-shaped editing-state failure quiet during activation', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const id = 'abort-shaped-editing-state-failure';
      const abort = new Error('Selection inspection was cancelled.');
      abort.name = 'AbortError';
      let failSelectionChecks = false;
      const uiManager = manager();
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: () => {
          if (failSelectionChecks) throw abort;
          return undefined;
        },
      });
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });

      activation = current.editor.focusAnnotation(id, { kind: 'root-click' });
      void activation.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      failSelectionChecks = true;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).resolves.toBe('cancelled');
      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.editor.hasContextualEdit).toBe(true);
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps a superseded editing-state accessor failure quiet', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const id = 'superseded-editing-state-failure';
      const external = new AbortController();
      const cause = new Error('stale selection accessor failed');
      let failSelectionChecks = false;
      const uiManager = manager();
      Object.defineProperty(uiManager, 'firstSelectedEditor', {
        configurable: true,
        get: () => {
          if (!failSelectionChecks) return undefined;
          external.abort(new DOMException('Activation was superseded.', 'AbortError'));
          throw cause;
        },
      });
      current.editor.setAnnotationProjection([
        { annotation: createdAnnotation('', { id }), stableId: id },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });

      activation = current.editor.focusAnnotation(id, {
        kind: 'root-click',
        signal: external.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      failSelectionChecks = true;
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).resolves.toBe('cancelled');
      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.eventBus.listeners.get('editingstateschanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      diagnostic.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps an abort-shaped editing-state failure quiet outside activation', async () => {
    const current = fixture();
    const uiManager = manager(selectedEditor('direct-contextual-abort', 9));
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    await current.editor.editAnnotation({
      editComment: false,
      id: 'direct-contextual-abort',
      kind: 'highlight',
    });
    Object.defineProperty(uiManager, 'firstSelectedEditor', {
      configurable: true,
      get: () => {
        const abort = new Error('Selection inspection was cancelled.');
        abort.name = 'AbortError';
        throw abort;
      },
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      current.eventBus.dispatch('editingstateschanged', {
        source: uiManager,
        details: { hasSelectedEditor: true },
      });

      expect(diagnostic).not.toHaveBeenCalled();
      expect(current.editor.hasContextualEdit).toBe(true);
    } finally {
      diagnostic.mockRestore();
      current.editor.destroy();
    }
  });

  it('keeps one absolute activation timeout and removes mode readiness resources', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture({ dispatchModeChanges: false });
      const annotation = createdAnnotation('', { id: 'timed-out-highlight' });
      current.editor.setAnnotationProjection([{ annotation, stableId: 'timed-out-highlight' }]);
      const uiManager = manager();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      Object.defineProperty(current.viewer, 'annotationEditorMode', {
        configurable: true,
        get: () => current.viewer.currentMode,
        set: (request: { readonly mode: number }) => {
          current.modeRequests.push({ ...request });
          current.viewer.currentMode = request.mode;
          if (request.mode === 0)
            queueMicrotask(() => {
              current.eventBus.dispatch('annotationeditormodechanged', {
                mode: request.mode,
                source: current.viewer,
              });
            });
        },
      });
      current.commentBridge.focusAnnotation.mockResolvedValue(true);
      let result: string | null = null;
      const activation = current.editor
        .focusAnnotation('timed-out-highlight', { kind: 'root-click' })
        .then((value) => {
          result = value;
          return value;
        });

      await vi.advanceTimersByTimeAsync(19_999);
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await vi.runOnlyPendingTimersAsync();

      await expect(activation).resolves.toBe('cancelled');
      expect(current.editor.hasContextualEdit).toBe(true);
      expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalledWith(
        'timed-out-highlight',
        expect.any(AbortSignal),
        annotation,
        { forceReadonly: true },
      );
      expect(current.eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      current.viewer.currentMode = 0;
      current.eventBus.dispatch('annotationeditormodechanged', {
        mode: 0,
        source: current.viewer,
      });

      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(uiManager.disableUserSelect.mock.calls).toEqual([[true], [false]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a never-resolving authoritative lookup at the one activation deadline', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const resolver = deferred<DocumentAnnotation | null>();
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const locked = createdAnnotation('', { id: 'deadline-locked', writable: false });
      current.editor.setAnnotationProjection([{ annotation: locked, stableId: 'deadline-locked' }]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });
      let resolverSignal: AbortSignal | null = null;
      current.editor.setAnnotationResolver(async (_id, signal) => {
        resolverSignal = signal;
        return resolver.promise;
      });
      let outcome: string = 'pending';
      activation = current.editor
        .focusAnnotation('deadline-locked', { kind: 'sidebar' })
        .then((result) => {
          outcome = result;
          return result;
        });

      await vi.advanceTimersByTimeAsync(19_999);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);

      await expect(activation).resolves.toBe('readonly');
      expect((resolverSignal as AbortSignal | null)?.aborted).toBe(true);
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledExactlyOnceWith(
        'deadline-locked',
        expect.any(AbortSignal),
        locked,
        { forceReadonly: true },
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resolver.resolve(null);
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels an unresolved descriptor at deadline and ignores its late resolution', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const resolver = deferred<DocumentAnnotation | null>();
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });
      current.editor.setAnnotationResolver(async () => resolver.promise);
      activation = current.editor.focusAnnotation('late-unprojected', { kind: 'sidebar' });

      await vi.advanceTimersByTimeAsync(20_000);

      await expect(activation).resolves.toBe('cancelled');
      const requestsAtDeadline = [...current.modeRequests];
      resolver.resolve(createdAnnotation('', { id: 'late-unprojected' }));
      await vi.runOnlyPendingTimersAsync();
      expect(current.modeRequests).toEqual(requestsAtDeadline);
      expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resolver.resolve(null);
      await current.editor.abortInteraction('Test cleanup.');
      await activation?.catch(() => 'cancelled');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not renew the budget while closing a previous contextual session', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const uiManager = manager(selectedEditor('previous', 9));
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      await current.editor.editAnnotation({
        editComment: false,
        id: 'previous',
        kind: 'highlight',
      });
      const projected = createdAnnotation('', { id: 'after-previous' });
      current.editor.setAnnotationProjection([
        { annotation: projected, stableId: 'after-previous' },
      ]);
      Object.defineProperty(current.viewer, 'annotationEditorMode', {
        configurable: true,
        get: () => current.viewer.currentMode,
        set: (request: { readonly mode: number }) => {
          current.modeRequests.push({ ...request });
          current.viewer.currentMode = request.mode;
          if (request.mode !== 0) return;
          window.setTimeout(() => {
            current.eventBus.dispatch('annotationeditormodechanged', {
              mode: request.mode,
              source: current.viewer,
            });
          }, 19_999);
        },
      });
      let outcome: string = 'pending';
      const activation = current.editor
        .focusAnnotation('after-previous', { kind: 'root-click' })
        .then((result) => {
          outcome = result;
          return result;
        });

      await vi.advanceTimersByTimeAsync(19_998);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(2);

      await expect(activation).resolves.toBe('cancelled');
      expect(current.editor.hasContextualEdit).toBe(true);
      expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalledWith(
        'after-previous',
        expect.any(AbortSignal),
        projected,
        { forceReadonly: true },
      );
      expect(vi.getTimerCount()).toBe(0);

      current.viewer.currentMode = 0;
      current.eventBus.dispatch('annotationeditormodechanged', {
        mode: 0,
        source: current.viewer,
      });

      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(uiManager.disableUserSelect).toHaveBeenLastCalledWith(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps getter-only NONE containment guarded until a late confirmed NONE releases once', async () => {
    vi.useFakeTimers();
    const layer = document.body.createDiv({ cls: 'annotationEditorLayer' });
    const anchor = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    const toolbar = anchor.createDiv({ cls: 'editToolbar' });
    toolbar.setCssProps({ display: 'flex' });
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    try {
      const current = fixture({ dispatchModeChanges: false });
      const projected = createdAnnotation('', { id: 'containment-deadline' });
      current.editor.setAnnotationProjection([
        { annotation: projected, stableId: 'containment-deadline' },
      ]);
      const uiManager = manager();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      current.commentBridge.focusAnnotation.mockImplementation(
        async (_id, _signal, _annotation, options) => options?.forceReadonly === true,
      );
      Object.defineProperty(current.viewer, 'annotationEditorMode', {
        configurable: true,
        get: () => current.viewer.currentMode,
        set: (request: { readonly mode: number }) => {
          current.modeRequests.push({ ...request });
          current.viewer.currentMode = request.mode;
          if (request.mode === 0) return;
          window.setTimeout(() => {
            uiManager.firstSelectedEditor = selectedEditor('containment-deadline', 9, anchor);
            current.eventBus.dispatch('annotationeditormodechanged', {
              mode: request.mode,
              source: current.viewer,
            });
          }, 19_998);
        },
      });
      let outcome: string = 'pending';
      const activation = current.editor
        .focusAnnotation('containment-deadline', { kind: 'root-click' })
        .then((result) => {
          outcome = result;
          return result;
        });

      await vi.advanceTimersByTimeAsync(19_999);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);

      await expect(activation).resolves.toBe('cancelled');
      expect(current.editor.hasContextualEdit).toBe(true);
      expect(current.viewer.annotationEditorMode).toBe(0);
      expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalledWith(
        'containment-deadline',
        expect.any(AbortSignal),
        projected,
        { forceReadonly: true },
      );
      expect(current.eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(1);
      expect(uiManager.disableUserSelect.mock.calls).toEqual([[true]]);
      expect(toolbar.hidden).toBe(true);
      expect(disconnect).not.toHaveBeenCalled();

      current.eventBus.dispatch('annotationeditormodechanged', {
        mode: 0,
        source: current.viewer,
      });
      current.eventBus.dispatch('annotationeditormodechanged', {
        mode: 0,
        source: current.viewer,
      });

      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(uiManager.disableUserSelect.mock.calls).toEqual([[true], [false]]);
      expect(toolbar.hidden).toBe(false);
      expect(toolbar.style.getPropertyValue('display')).toBe('flex');
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      disconnect.mockRestore();
      layer.remove();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps unsafe containment cancelled until a late confirmed NONE releases its guard', async () => {
    vi.useFakeTimers();
    const layer = document.body.createDiv({ cls: 'annotationEditorLayer' });
    const anchor = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    const toolbar = anchor.createDiv({ cls: 'editToolbar' });
    toolbar.setCssProps({ display: 'grid' });
    try {
      const current = fixture({ dispatchModeChanges: false });
      const projected = createdAnnotation('', { id: 'late-none-containment' });
      current.editor.setAnnotationProjection([
        { annotation: projected, stableId: 'late-none-containment' },
      ]);
      const uiManager = manager();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      current.commentBridge.focusAnnotation.mockImplementation(
        async (_id, _signal, _annotation, options) => options?.forceReadonly === true,
      );
      Object.defineProperty(current.viewer, 'annotationEditorMode', {
        configurable: true,
        get: () => current.viewer.currentMode,
        set: (request: { readonly mode: number }) => {
          current.modeRequests.push({ ...request });
          if (request.mode === 0) return;
          current.viewer.currentMode = request.mode;
          window.setTimeout(() => {
            uiManager.firstSelectedEditor = selectedEditor('late-none-containment', 9, anchor);
            current.eventBus.dispatch('annotationeditormodechanged', {
              mode: request.mode,
              source: current.viewer,
            });
          }, 19_999);
        },
      });

      const activation = current.editor.focusAnnotation('late-none-containment', {
        kind: 'root-click',
      });
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(activation).resolves.toBe('cancelled');
      expect(current.editor.hasContextualEdit).toBe(true);
      expect(current.eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(1);
      expect(uiManager.disableUserSelect.mock.calls).toEqual([[true]]);
      expect(toolbar.hidden).toBe(true);
      expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalledWith(
        'late-none-containment',
        expect.any(AbortSignal),
        projected,
        { forceReadonly: true },
      );

      current.viewer.currentMode = 0;
      current.eventBus.dispatch('annotationeditormodechanged', {
        mode: 0,
        source: current.viewer,
      });

      expect(current.editor.hasContextualEdit).toBe(false);
      expect(current.eventBus.listeners.get('editorsrendered')).toHaveLength(0);
      expect(uiManager.disableUserSelect.mock.calls).toEqual([[true], [false]]);
      expect(toolbar.hidden).toBe(false);
      expect(toolbar.style.getPropertyValue('display')).toBe('grid');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      layer.remove();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects a genuine annotation resolver failure to its caller', async () => {
    const current = fixture();
    const cause = new Error('annotation resolver failed');
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });
    current.editor.setAnnotationResolver(async () => {
      throw cause;
    });

    await expect(
      current.editor.focusAnnotation('resolver-failure', { kind: 'root-click' }),
    ).rejects.toBe(cause);
  });

  it('rejects a genuine native mode failure instead of presenting a read-only fallback', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'mode-failure' });
    const cause = new Error('native mode failed');
    current.editor.setAnnotationProjection([{ annotation, stableId: 'mode-failure' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('mode-failure', 9)),
    });
    const descriptor = Object.getOwnPropertyDescriptor(current.viewer, 'annotationEditorMode');
    if (descriptor?.get === undefined || descriptor.set === undefined)
      throw new Error('Expected the fixture viewer mode accessor.');
    const getMode = descriptor.get.bind(current.viewer);
    const setMode = descriptor.set.bind(current.viewer);
    Object.defineProperty(current.viewer, 'annotationEditorMode', {
      configurable: true,
      get: getMode,
      set(request: { readonly mode: number }) {
        if (request.mode === 9) throw cause;
        setMode(request);
      },
    });

    await expect(
      current.editor.focusAnnotation('mode-failure', { kind: 'root-click' }),
    ).rejects.toBe(cause);
    expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalled();
  });

  it('rejects a genuine native focus failure without retrying it as read-only', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'focus-failure' });
    const cause = new Error('native focus failed');
    current.editor.setAnnotationProjection([{ annotation, stableId: 'focus-failure' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('focus-failure', 9)),
    });
    current.commentBridge.focusAnnotation.mockRejectedValueOnce(cause);

    await expect(
      current.editor.focusAnnotation('focus-failure', { kind: 'root-click' }),
    ).rejects.toBe(cause);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledOnce();
  });

  it('preserves the primary native failure when contextual containment also fails', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'containment-failure' });
    const primary = new Error('native focus failed');
    const secondary = new Error('native containment failed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    current.editor.setAnnotationProjection([{ annotation, stableId: 'containment-failure' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('containment-failure', 9)),
    });
    current.commentBridge.focusAnnotation.mockRejectedValueOnce(primary);
    const descriptor = Object.getOwnPropertyDescriptor(current.viewer, 'annotationEditorMode');
    if (descriptor?.get === undefined || descriptor.set === undefined)
      throw new Error('Expected the fixture viewer mode accessor.');
    const getMode = descriptor.get.bind(current.viewer);
    const setMode = descriptor.set.bind(current.viewer);
    let failedNoneRequests = 0;
    Object.defineProperty(current.viewer, 'annotationEditorMode', {
      configurable: true,
      get: getMode,
      set(request: { readonly mode: number }) {
        if (request.mode === 0 && getMode() === 9) {
          failedNoneRequests += 1;
          throw secondary;
        }
        setMode(request);
      },
    });

    const activation = current.editor.focusAnnotation('containment-failure', {
      kind: 'root-click',
    });
    const observed = activation.catch((cause: unknown) => {
      const internals = activationInternals(current.editor);
      expect(cause).toBe(primary);
      expect(internals.activeActivation).toBeNull();
      expect(internals.contextualActivationFailureOwner).toBeNull();
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        '[abyss-documents] Failed to contain the PDF annotation editor after activation failure',
        { cause: secondary },
      );
      expect(failedNoneRequests).toBe(1);
      return 'observed' as const;
    });

    try {
      await expect(observed).resolves.toBe('observed');
      expect(failedNoneRequests).toBe(1);
    } finally {
      warning.mockRestore();
      current.editor.destroy();
    }
  });

  it('settles a rejecting deadline fallback as cancelled exactly once', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const resolver = deferred<DocumentAnnotation | null>();
    try {
      const locked = createdAnnotation('', { id: 'rejecting-fallback', writable: false });
      current.editor.setAnnotationProjection([
        { annotation: locked, stableId: 'rejecting-fallback' },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });
      current.editor.setAnnotationResolver(async () => resolver.promise);
      current.commentBridge.focusAnnotation.mockRejectedValue(new Error('fallback failed'));
      const outcomes: PdfAnnotationActivationResult[] = [];
      const activation = current.editor.focusAnnotation('rejecting-fallback', { kind: 'sidebar' });
      void activation.then((result) => outcomes.push(result)).catch(() => undefined);

      await vi.advanceTimersByTimeAsync(20_000);
      await Promise.resolve();

      await expect(activation).resolves.toBe('cancelled');
      expect(outcomes).toEqual(['cancelled']);
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledExactlyOnceWith(
        'rejecting-fallback',
        expect.any(AbortSignal),
        locked,
        { forceReadonly: true },
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resolver.resolve(null);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('aborts delayed mode readiness immediately and removes its timer and listener', async () => {
    vi.useFakeTimers();
    const current = fixture({ dispatchModeChanges: false });
    let activation: Promise<PdfAnnotationActivationResult> | null = null;
    try {
      const annotation = createdAnnotation('', { id: 'aborted-highlight' });
      current.editor.setAnnotationProjection([{ annotation, stableId: 'aborted-highlight' }]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });
      Object.defineProperty(current.viewer, 'annotationEditorMode', {
        configurable: true,
        get: () => current.viewer.currentMode,
        set: (request: { readonly mode: number }) => {
          current.modeRequests.push({ ...request });
          current.viewer.currentMode = request.mode;
          if (request.mode === 0)
            queueMicrotask(() => {
              current.eventBus.dispatch('annotationeditormodechanged', {
                mode: request.mode,
                source: current.viewer,
              });
            });
        },
      });
      const external = new AbortController();
      let settled = false;
      activation = current.editor
        .focusAnnotation('aborted-highlight', {
          kind: 'root-click',
          signal: external.signal,
        })
        .finally(() => {
          settled = true;
        });
      await Promise.resolve();

      external.abort('Navigation superseded activation.');
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(activation).resolves.toBe('cancelled');
      expect(current.eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      current.eventBus.dispatch('annotationeditormodechanged', {
        mode: current.viewer.currentMode,
        source: current.viewer,
      });
      current.editor.detachFromDocument();
      await activation?.catch(() => 'cancelled');
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels A when its bridge focus resolves after B', async () => {
    const current = fixture();
    const first = createdAnnotation('', { id: 'first' });
    const second = createdAnnotation('', { id: 'second' });
    current.editor.setAnnotationProjection([
      { annotation: first, stableId: 'first' },
      { annotation: second, stableId: 'second' },
    ]);
    const uiManager = manager(selectedEditor('first', 9));
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    const firstFocus = deferred<boolean>();
    const secondFocus = deferred<boolean>();
    current.commentBridge.focusAnnotation.mockImplementation((id: string) =>
      id === 'first' ? firstFocus.promise : secondFocus.promise,
    );

    const activatingFirst = current.editor.focusAnnotation('first', { kind: 'root-click' });
    await vi.waitFor(() => {
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledOnce();
    });
    uiManager.firstSelectedEditor = selectedEditor('second', 9);
    const activatingSecond = current.editor.focusAnnotation('second', { kind: 'root-click' });
    await vi.waitFor(() => {
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledTimes(2);
    });
    secondFocus.resolve(true);
    await expect(activatingSecond).resolves.toBe('editable');
    firstFocus.resolve(true);
    await expect(activatingFirst).resolves.toBe('cancelled');
  });

  it('cancels activation after destroy or manager rebind', async () => {
    for (const lifecycle of ['destroy', 'rebind'] as const) {
      const current = fixture();
      const annotation = createdAnnotation('', { id: `stale-${lifecycle}` });
      current.editor.setAnnotationProjection([{ annotation, stableId: `stale-${lifecycle}` }]);
      const uiManager = manager(selectedEditor(`stale-${lifecycle}`, 9));
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      const bridgeFocus = deferred<boolean>();
      current.commentBridge.focusAnnotation.mockReturnValue(bridgeFocus.promise);
      const activation = current.editor.focusAnnotation(`stale-${lifecycle}`, {
        kind: 'sidebar',
      });
      await vi.waitFor(() => {
        expect(current.commentBridge.focusAnnotation).toHaveBeenCalledOnce();
      });

      if (lifecycle === 'destroy') current.editor.destroy();
      else
        current.eventBus.dispatch('annotationeditoruimanager', {
          source: current.viewer,
          uiManager: manager(),
        });
      bridgeFocus.resolve(true);

      await expect(activation).resolves.toBe('cancelled');
    }
  });

  it('coalesces a double activation of the same persisted id', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'double' });
    current.editor.setAnnotationProjection([{ annotation, stableId: 'double' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('double', 9)),
    });
    const bridgeFocus = deferred<boolean>();
    current.commentBridge.focusAnnotation.mockReturnValue(bridgeFocus.promise);

    const first = current.editor.focusAnnotation('double', { kind: 'root-click' });
    const second = current.editor.focusAnnotation('double', { kind: 'root-click' });
    await vi.waitFor(() => {
      expect(current.commentBridge.focusAnnotation).toHaveBeenCalledOnce();
    });
    bridgeFocus.resolve(true);

    await expect(Promise.all([first, second])).resolves.toEqual(['editable', 'editable']);
    expect(current.modeRequests.filter((request) => request['editId'] === 'double')).toHaveLength(
      1,
    );
  });

  it('falls back read-only exactly once after current materialization failure then retries', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', { id: 'retry' });
    current.editor.setAnnotationProjection([{ annotation, stableId: 'retry' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(selectedEditor('retry', 9)),
    });
    let editableAttempts = 0;
    current.commentBridge.focusAnnotation.mockImplementation(
      async (
        _id,
        _signal,
        _projected,
        options?: {
          readonly editableOnly?: boolean;
          readonly forceReadonly?: boolean;
          readonly preserveSelection?: boolean;
        },
      ) => {
        if (options?.forceReadonly === true) return true;
        editableAttempts += 1;
        return editableAttempts > 1;
      },
    );

    await expect(current.editor.focusAnnotation('retry', { kind: 'root-click' })).resolves.toBe(
      'readonly',
    );
    await expect(current.editor.focusAnnotation('retry', { kind: 'root-context' })).resolves.toBe(
      'editable',
    );

    expect(current.modeRequests.filter((request) => request['editId'] === 'retry')).toHaveLength(2);
    expect(
      current.commentBridge.focusAnnotation.mock.calls.filter(
        ([, , , options]) =>
          (options as { readonly forceReadonly?: boolean } | undefined)?.forceReadonly === true,
      ),
    ).toHaveLength(1);
  });

  it('cancels a deferred resolver before navigation, tool intent, or lifecycle replacement', async () => {
    for (const lifecycle of ['abort', 'set-tool', 'detach', 'destroy', 'rebind'] as const) {
      const current = fixture();
      const uiManager = manager();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      const resolved = deferred<DocumentAnnotation | null>();
      current.editor.setAnnotationResolver(async () => resolved.promise);
      const activation = current.editor.focusAnnotation(`resolver-${lifecycle}`, {
        kind: 'sidebar',
      });
      await Promise.resolve();

      if (lifecycle === 'abort') await current.editor.abortInteraction('Navigation closed reader.');
      else if (lifecycle === 'set-tool') await current.editor.setTool('ink');
      else if (lifecycle === 'detach') current.editor.detachFromDocument();
      else if (lifecycle === 'destroy') current.editor.destroy();
      else
        current.eventBus.dispatch('annotationeditoruimanager', {
          source: current.viewer,
          uiManager: manager(),
        });
      const requestsAfterCancellation = [...current.modeRequests];
      uiManager.firstSelectedEditor = selectedEditor(`resolver-${lifecycle}`, 9);
      resolved.resolve(createdAnnotation('', { id: `resolver-${lifecycle}` }));

      await expect(activation).resolves.toBe('cancelled');
      expect(current.modeRequests).toEqual(requestsAfterCancellation);
      expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalled();
    }
  });

  it('drops the reviewer-probe readonly relay when its activation is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });
      const resolver = deferred<DocumentAnnotation | null>();
      current.editor.setAnnotationResolver(async () => resolver.promise);
      const relayed: Array<PdfAnnotationFocus | null> = [];
      current.editor.onAnnotationFocus((focus) => relayed.push(focus));
      const activation = current.editor.focusAnnotation('cancelled-relay', { kind: 'sidebar' });
      await Promise.resolve();

      current.emitBridgeFocus(annotationFocus('cancelled-relay', false, { writable: false }));
      await current.editor.abortInteraction('Navigation cancelled the activation.');
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).resolves.toBe('cancelled');
      expect(relayed).toEqual([]);
      resolver.resolve(null);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('drops a provisional pre-click readonly focus when activation starts in the same task', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const projected = createdAnnotation('', { id: 'hover-then-activate' });
      current.editor.setAnnotationProjection([
        { annotation: projected, stableId: 'hover-then-activate' },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(selectedEditor('hover-then-activate', 9)),
      });
      const relayed: Array<PdfAnnotationFocus | null> = [];
      current.editor.onAnnotationFocus((focus) => relayed.push(focus));

      current.emitBridgeFocus(annotationFocus('hover-then-activate', false, { writable: false }));
      const activation = current.editor.focusAnnotation('hover-then-activate', {
        kind: 'root-click',
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(activation).resolves.toBe('editable');
      expect(relayed).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retains selected contextual focus through native FreeText edit-mode null events', async () => {
    const current = fixture();
    const projected = createdAnnotation('', {
      id: 'native-freetext-edit',
      type: 'free-text',
    });
    current.editor.setAnnotationProjection([
      { annotation: projected, stableId: 'native-freetext-edit' },
    ]);
    const uiManager = manager(selectedEditor('native-freetext-edit', 3));
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    const relayed: Array<PdfAnnotationFocus | null> = [];
    current.editor.onAnnotationFocus((focus) => relayed.push(focus));

    await expect(
      current.editor.focusAnnotation('native-freetext-edit', { kind: 'root-click' }),
    ).resolves.toBe('editable');
    current.emitBridgeFocus(annotationFocus('native-freetext-edit', true));
    relayed.splice(0);

    for (let index = 0; index < 5; index += 1) current.emitBridgeFocus(null);

    expect(relayed).toEqual([]);
    uiManager.firstSelectedEditor = undefined;
    current.emitBridgeFocus(null);
    expect(relayed).toEqual([null]);
  });

  it('drops editable and null bridge events that are not owned by the current activation', async () => {
    const current = fixture();
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });
    const resolver = deferred<DocumentAnnotation | null>();
    current.editor.setAnnotationResolver(async () => resolver.promise);
    const relayed: Array<PdfAnnotationFocus | null> = [];
    current.editor.onAnnotationFocus((focus) => relayed.push(focus));
    const activation = current.editor.focusAnnotation('owned-focus', { kind: 'sidebar' });
    await Promise.resolve();

    current.emitBridgeFocus(annotationFocus('different-focus', true));
    current.emitBridgeFocus(null);
    await current.editor.abortInteraction('Activation superseded.');
    resolver.resolve(null);

    await expect(activation).resolves.toBe('cancelled');
    expect(relayed).toEqual([]);
  });

  it('does not release A readonly focus after B completes', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(),
      });
      const resolver = deferred<DocumentAnnotation | null>();
      current.editor.setAnnotationResolver(async () => resolver.promise);
      const relayed: Array<PdfAnnotationFocus | null> = [];
      current.editor.onAnnotationFocus((focus) => relayed.push(focus));
      const activationA = current.editor.focusAnnotation('focus-a', { kind: 'sidebar' });
      await Promise.resolve();
      current.emitBridgeFocus(annotationFocus('focus-a', false, { writable: false }));

      const lockedB = createdAnnotation('', { id: 'focus-b', writable: false });
      current.editor.setAnnotationProjection([{ annotation: lockedB, stableId: 'focus-b' }]);
      current.editor.setAnnotationResolver(async (id) =>
        id === 'focus-a' ? resolver.promise : lockedB,
      );
      const activationB = current.editor.focusAnnotation('focus-b', { kind: 'sidebar' });

      await expect(activationB).resolves.toBe('readonly');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(activationA).resolves.toBe('cancelled');
      expect(relayed).toEqual([]);
      resolver.resolve(null);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('releases the verified current readonly fallback exactly once', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const projected = createdAnnotation('', { id: 'verified-fallback' });
      current.editor.setAnnotationProjection([
        { annotation: projected, stableId: 'verified-fallback' },
      ]);
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager: manager(selectedEditor('verified-fallback', 9)),
      });
      const relayed: Array<PdfAnnotationFocus | null> = [];
      current.editor.onAnnotationFocus((focus) => relayed.push(focus));
      current.commentBridge.focusAnnotation.mockImplementation(
        async (_id, _signal, _projected, options) => {
          if (options?.forceReadonly !== true) return false;
          current.emitBridgeFocus(annotationFocus('verified-fallback', false, { writable: false }));
          return true;
        },
      );

      const activation = current.editor.focusAnnotation('verified-fallback', {
        kind: 'root-click',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(activation).resolves.toBe('readonly');
      await vi.advanceTimersByTimeAsync(0);

      expect(relayed).toEqual([annotationFocus('verified-fallback', false, { writable: false })]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels a pending activation and its staged focus before deleting', async () => {
    const current = fixture();
    const uiManager = manager();
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    const resolver = deferred<DocumentAnnotation | null>();
    current.editor.setAnnotationResolver(async () => resolver.promise);
    const relayed: Array<PdfAnnotationFocus | null> = [];
    current.editor.onAnnotationFocus((focus) => relayed.push(focus));
    const activation = current.editor.focusAnnotation('delete-pending', { kind: 'sidebar' });
    await Promise.resolve();
    current.emitBridgeFocus(annotationFocus('delete-pending', true));

    const projected = createdAnnotation('', { id: 'delete-pending' });
    expect(current.editor.deleteAnnotations([projected])).toBe(true);
    uiManager.firstSelectedEditor = selectedEditor('delete-pending', 9);
    resolver.resolve(projected);

    await expect(activation).resolves.toBe('cancelled');
    expect(relayed).toEqual([]);
    expect(current.commentBridge.deleteAnnotations).toHaveBeenCalledExactlyOnceWith([projected]);
    expect(current.commentBridge.focusAnnotation).not.toHaveBeenCalled();
    expect(current.modeRequests).toEqual([]);
  });

  it('neutralizes every creator mode before persisted activation', async () => {
    for (const activeMode of [9, 15, 3] as const) {
      const current = fixture();
      const annotation = createdAnnotation('', { id: `from-${String(activeMode)}` });
      current.editor.setAnnotationProjection([
        { annotation, stableId: `from-${String(activeMode)}` },
      ]);
      const uiManager = manager(selectedEditor(`from-${String(activeMode)}`, 9));
      current.eventBus.dispatch('annotationeditoruimanager', {
        source: current.viewer,
        uiManager,
      });
      current.viewer.currentMode = activeMode;
      current.eventBus.dispatch('annotationeditormodechanged', {
        source: current.viewer,
        mode: activeMode,
      });

      await expect(
        current.editor.focusAnnotation(`from-${String(activeMode)}`, {
          kind: 'root-click',
        }),
      ).resolves.toBe('editable');

      expect(current.modeRequests).toEqual([
        { mode: 0 },
        { editComment: false, editId: `from-${String(activeMode)}`, mode: 9 },
      ]);
    }
  });

  it('keeps a verified locked writable type read-only without materialization', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', {
      id: 'locked-highlight',
      writable: false,
    });
    current.editor.setAnnotationProjection([{ annotation, stableId: 'locked-highlight' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });

    await expect(
      current.editor.focusAnnotation('locked-highlight', { kind: 'sidebar' }),
    ).resolves.toBe('readonly');

    expect(current.modeRequests).toEqual([]);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
      'locked-highlight',
      expect.any(AbortSignal),
      annotation,
      { forceReadonly: true },
    );
  });

  it('keeps a verified unsupported annotation read-only without guessing an editor mode', async () => {
    const current = fixture();
    const annotation = createdAnnotation('', {
      id: 'readonly-underline',
      type: 'underline',
    });
    current.editor.setAnnotationProjection([{ annotation, stableId: 'readonly-underline' }]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });

    await expect(
      current.editor.focusAnnotation('readonly-underline', { kind: 'sidebar' }),
    ).resolves.toBe('readonly');

    expect(current.modeRequests).toEqual([]);
    expect(current.commentBridge.focusAnnotation).toHaveBeenCalledWith(
      'readonly-underline',
      expect.any(AbortSignal),
      annotation,
      { forceReadonly: true },
    );
  });

  it('re-arms a clean imported-editor activation so the first native edit becomes a saved revision', async () => {
    const current = fixture();
    const projected = createdAnnotation('', { id: 'imported-highlight' });
    const selected = selectedEditor('imported-highlight', 9);
    const uiManager = manager(selected);
    const mutations = vi.fn();
    let revision = 0;
    const dirtyStates: boolean[] = [];
    current.editor.onMutation(mutations);
    current.editor.onDirty((dirty) => {
      dirtyStates.push(dirty);
      if (dirty) revision += 1;
    });
    current.editor.setAnnotationProjection([
      { annotation: projected, stableId: 'imported-highlight' },
    ]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    const descriptor = Object.getOwnPropertyDescriptor(current.viewer, 'annotationEditorMode');
    if (descriptor?.get === undefined || descriptor.set === undefined)
      throw new Error('Expected the fixture viewer mode accessor.');
    const getMode = descriptor.get.bind(current.viewer);
    const setMode = descriptor.set.bind(current.viewer);
    Object.defineProperty(current.viewer, 'annotationEditorMode', {
      configurable: true,
      get: getMode,
      set(request: { readonly editId?: string; readonly mode: number }) {
        if (request.editId === 'imported-highlight') {
          current.annotationStorage.addEditor(9, request.editId);
        }
        setMode(request);
      },
    });
    uiManager.updateParams.mockImplementation(() => {
      current.annotationStorage.mutateEditor('imported-highlight', { color: '#64d8cb' });
    });
    current.saveDocument.mockImplementation(async () => {
      const snapshot = current.annotationStorage.editorSnapshot('imported-highlight');
      current.annotationStorage.resetModified();
      return new TextEncoder().encode(JSON.stringify(snapshot));
    });

    await expect(
      current.editor.focusAnnotation('imported-highlight', { kind: 'sidebar' }),
    ).resolves.toBe('editable');
    await Promise.resolve();

    expect(mutations).not.toHaveBeenCalled();
    expect(dirtyStates).toEqual([]);
    expect(current.annotationStorage.resetModified).toHaveBeenCalledOnce();
    expect(current.annotationStorage.isModified()).toBe(false);

    await current.editor.setParameter('highlight-color', '#64d8cb');

    expect(uiManager.updateParams).toHaveBeenCalledExactlyOnceWith(31, '#64d8cb');
    expect(mutations).toHaveBeenCalledOnce();
    expect(dirtyStates).toEqual([true]);
    expect(revision).toBe(1);
    expect(current.annotationStorage.isModified()).toBe(true);

    const saved = await current.editor.save(new AbortController().signal);
    expect(JSON.parse(new TextDecoder().decode(saved))).toMatchObject({ color: '#64d8cb' });
  });

  it('never clears a genuine dirty baseline while materializing an imported editor', async () => {
    const current = fixture();
    const projected = createdAnnotation('', { id: 'imported-highlight' });
    const selected = selectedEditor('imported-highlight', 9);
    const uiManager = manager(selected);
    current.annotationStorage.setValue('genuine-dirty-baseline', { value: 1 });
    current.editor.setAnnotationProjection([
      { annotation: projected, stableId: 'imported-highlight' },
    ]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    const descriptor = Object.getOwnPropertyDescriptor(current.viewer, 'annotationEditorMode');
    if (descriptor?.get === undefined || descriptor.set === undefined)
      throw new Error('Expected the fixture viewer mode accessor.');
    const getMode = descriptor.get.bind(current.viewer);
    const setMode = descriptor.set.bind(current.viewer);
    Object.defineProperty(current.viewer, 'annotationEditorMode', {
      configurable: true,
      get: getMode,
      set(request: { readonly editId?: string; readonly mode: number }) {
        if (request.editId === 'imported-highlight') {
          current.annotationStorage.addEditor(9, request.editId);
        }
        setMode(request);
      },
    });

    await expect(
      current.editor.focusAnnotation('imported-highlight', { kind: 'sidebar' }),
    ).resolves.toBe('editable');

    expect(current.annotationStorage.resetModified).not.toHaveBeenCalled();
    expect(current.annotationStorage.isModified()).toBe(true);
  });

  it('owns only the target callbacks after asynchronous PDF.js editor materialization', async () => {
    const current = fixture();
    const projected = createdAnnotation('', { id: 'deferred-highlight' });
    const selected = selectedEditor('deferred-highlight', 9);
    const uiManager = manager(selected);
    const rendering = deferred<void>();
    const setterStarted = deferred<void>();
    let materialization = Promise.resolve();
    const mutations = vi.fn();
    const dirty = vi.fn();
    current.editor.onMutation(mutations);
    current.editor.onDirty(dirty);
    current.editor.setAnnotationProjection([
      { annotation: projected, stableId: 'deferred-highlight' },
    ]);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager,
    });
    const descriptor = Object.getOwnPropertyDescriptor(current.viewer, 'annotationEditorMode');
    if (descriptor?.get === undefined || descriptor.set === undefined)
      throw new Error('Expected the fixture viewer mode accessor.');
    const getMode = descriptor.get.bind(current.viewer);
    const setMode = descriptor.set.bind(current.viewer);
    Object.defineProperty(current.viewer, 'annotationEditorMode', {
      configurable: true,
      get: getMode,
      set(request: { readonly editId?: string; readonly mode: number }) {
        setterStarted.resolve();
        materialization = rendering.promise.then(() => {
          if (request.editId !== undefined)
            current.annotationStorage.addEditor(request.mode, request.editId);
          setMode(request);
        });
      },
    });

    const activation = current.editor.focusAnnotation('deferred-highlight', { kind: 'sidebar' });
    await setterStarted.promise;

    // A genuine storage mutation races while PDF.js is still awaiting editor deserialization.
    current.annotationStorage.setValue('concurrent-genuine-mutation', { value: 1 });
    rendering.resolve();
    await materialization;

    await expect(activation).resolves.toBe('editable');
    await Promise.resolve();

    expect(mutations).toHaveBeenCalledOnce();
    expect(dirty).toHaveBeenCalledExactlyOnceWith(true);
    expect(current.annotationStorage.resetModified).not.toHaveBeenCalled();
    expect(current.annotationStorage.isModified()).toBe(true);
  });

  it('does not suppress a genuine mutation while activation resolution is pending', async () => {
    const current = fixture();
    const projected = createdAnnotation('', { id: 'pending-highlight', writable: false });
    const resolved = deferred<DocumentAnnotation | null>();
    const mutations = vi.fn();
    const dirty = vi.fn();
    current.editor.onMutation(mutations);
    current.editor.onDirty(dirty);
    current.editor.setAnnotationProjection([
      { annotation: projected, stableId: 'pending-highlight' },
    ]);
    current.editor.setAnnotationResolver(async () => resolved.promise);
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });

    const activation = current.editor.focusAnnotation('pending-highlight', { kind: 'sidebar' });
    await Promise.resolve();
    current.annotationStorage.onAnnotationEditor?.(9);
    current.annotationStorage.onSetModified?.();

    expect(mutations).toHaveBeenCalledTimes(2);
    expect(dirty).toHaveBeenCalledExactlyOnceWith(true);

    current.editor.destroy();
    resolved.resolve(null);
    await expect(activation).resolves.toBe('cancelled');
  });

  it('selects supported annotations from NONE', async () => {
    const cases = [
      ['highlight', 9],
      ['ink', 15],
      ['freetext', 3],
    ] as const;

    for (const [kind, mode] of cases) {
      const { editor, eventBus, modeRequests, viewer } = fixture();
      eventBus.dispatch('annotationeditoruimanager', {
        source: viewer,
        uiManager: manager(selectedEditor(`${kind}-1`, mode)),
      });

      await editor.editAnnotation({ editComment: false, id: `${kind}-1`, kind });

      expect(modeRequests).toEqual([{ editComment: false, editId: `${kind}-1`, mode }]);
    }
  });

  it('opens comment mode when requested', async () => {
    const { editor, eventBus, modeRequests, viewer } = fixture();
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: manager(selectedEditor('highlight-with-comment', 9)),
    });

    await editor.editAnnotation({
      editComment: true,
      id: 'highlight-with-comment',
      kind: 'highlight',
    });

    expect(modeRequests).toEqual([
      { editComment: true, editId: 'highlight-with-comment', mode: 9 },
    ]);
  });

  it('keeps contextual editing out of the global tool state', async () => {
    const { editor, eventBus, viewer } = fixture();
    eventBus.dispatch('annotationeditoruimanager', {
      source: viewer,
      uiManager: manager(selectedEditor('highlight-1', 9)),
    });
    const modes: string[] = [];
    editor.onMode((mode) => modes.push(mode));

    await editor.editAnnotation({
      editComment: false,
      id: 'highlight-1',
      kind: 'highlight',
    });

    expect(modes).toEqual(['neutral']);
  });

  it('closes a contextual editor before applying a new global tool', async () => {
    const { editor, eventBus, modeRequests, viewer } = fixture();
    const uiManager = manager(selectedEditor('contextual-highlight', 9));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    await editor.editAnnotation({
      editComment: false,
      id: 'contextual-highlight',
      kind: 'highlight',
    });
    await editor.setTool('ink');

    expect(editor.hasContextualEdit).toBe(false);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'contextual-highlight', mode: 9 },
      { mode: 0 },
      { mode: 15 },
    ]);
    expect(uiManager.disableUserSelect.mock.calls).toEqual([[true], [false]]);
  });

  it('gates every native creator surface until NONE is source-confirmed', async () => {
    const { editor, eventBus, viewer } = fixture();
    const uiManager = manager(selectedEditor('highlight-1', 9));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    await editor.editAnnotation({
      editComment: false,
      id: 'highlight-1',
      kind: 'highlight',
    });

    expect(uiManager.disableUserSelect).toHaveBeenCalledWith(true);
    for (const layer of uiManager.layers) {
      expect(layer.disableClick).toHaveBeenCalledOnce();
      expect(layer.disableTextSelection).toHaveBeenCalledOnce();
    }
    uiManager.layers[1]?.disableClick.mockClear();
    uiManager.layers[1]?.disableTextSelection.mockClear();
    eventBus.dispatch('editorsrendered', { pageNumber: 2, source: {} });
    expect(uiManager.layers[1]?.disableClick).toHaveBeenCalledOnce();
    expect(uiManager.layers[1]?.disableTextSelection).toHaveBeenCalledOnce();

    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: false },
    });
    await vi.waitFor(() => {
      expect(uiManager.disableUserSelect).toHaveBeenLastCalledWith(false);
    });
  });

  it('bounds a missing mode confirmation and still requests NONE behind the creator gate', async () => {
    vi.useFakeTimers();
    try {
      const { editor, eventBus, modeRequests, viewer } = fixture({ dispatchModeChanges: false });
      const uiManager = manager(selectedEditor('highlight-1', 9));
      eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
      let outcome: unknown = 'pending';
      void editor
        .editAnnotation({ editComment: false, id: 'highlight-1', kind: 'highlight' })
        .catch((cause: unknown) => {
          outcome = cause;
        });

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(modeRequests).toEqual([
        { editComment: false, editId: 'highlight-1', mode: 9 },
        { mode: 0 },
      ]);
      expect(viewer.annotationEditorMode).toBe(0);
      expect(editor.hasContextualEdit).toBe(true);
      expect(uiManager.disableUserSelect).toHaveBeenCalledWith(true);
      expect(uiManager.disableUserSelect).not.toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a rejected NONE confirmation and releases every contextual gate', async () => {
    vi.useFakeTimers();
    try {
      const { editor, eventBus, modeRequests, viewer } = fixture({ dispatchModeChanges: false });
      const uiManager = manager(selectedEditor('highlight-1', 9));
      eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
      let firstFailure: unknown = 'pending';
      void editor
        .editAnnotation({ editComment: false, id: 'highlight-1', kind: 'highlight' })
        .catch((cause: unknown) => {
          firstFailure = cause;
        });
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(firstFailure).toMatchObject({ name: 'TimeoutError' });
      expect(eventBus.listeners.get('editorsrendered')?.size).toBe(1);

      viewer.currentMode = 9;
      const recovery = editor.abortInteraction('Retry contextual cleanup.');
      await Promise.resolve();
      expect(modeRequests[modeRequests.length - 1]).toEqual({ mode: 0 });
      eventBus.dispatch('annotationeditormodechanged', { source: viewer, mode: 0 });
      await expect(recovery).resolves.toBeUndefined();

      expect(editor.hasContextualEdit).toBe(false);
      expect(uiManager.disableUserSelect).toHaveBeenLastCalledWith(false);
      expect(eventBus.listeners.get('editorsrendered')?.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns neutral after the selected contextual editor tears down', async () => {
    const { editor, eventBus, modeRequests, viewer } = fixture();
    const uiManager = manager(selectedEditor('highlight-1', 9));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    const editing = editor.editAnnotation({
      editComment: false,
      id: 'highlight-1',
      kind: 'highlight',
    });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: false },
    });
    await editing;
    expect(modeRequests).toEqual([{ editComment: false, editId: 'highlight-1', mode: 9 }]);

    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: false },
    });
    await vi.waitFor(() => {
      expect(modeRequests).toEqual([
        { editComment: false, editId: 'highlight-1', mode: 9 },
        { mode: 0 },
      ]);
    });
  });

  it('re-arms the same contextual annotation target after autosave', async () => {
    const { editor, eventBus, modeRequests, viewer } = fixture();
    const uiManager = manager(selectedEditor('highlight-1', 9));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    await editor.editAnnotation({
      editComment: false,
      id: 'highlight-1',
      kind: 'highlight',
    });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });

    await editor.save(new AbortController().signal);

    expect(viewer.annotationEditorMode).toBe(9);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'highlight-1', mode: 9 },
      { mode: 0 },
      { editComment: false, editId: 'highlight-1', mode: 9 },
    ]);
  });

  it('returns captured bytes when the contextual target is missing during restore', async () => {
    const { editor, eventBus, modeRequests, saveDocument, viewer } = fixture();
    const selected = selectedEditor('missing-after-save', 9);
    const uiManager = manager(selected);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    await editor.editAnnotation({
      editComment: false,
      id: 'missing-after-save',
      kind: 'highlight',
    });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });
    const captured = new Uint8Array([37, 80, 68, 70, 45, 49]);
    saveDocument.mockImplementation(async () => {
      (uiManager as { firstSelectedEditor: typeof selected | undefined }).firstSelectedEditor =
        undefined;
      return captured;
    });

    await expect(editor.save(new AbortController().signal)).resolves.toBe(captured);

    expect(viewer.annotationEditorMode).toBe(0);
    expect(editor.hasContextualEdit).toBe(false);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'missing-after-save', mode: 9 },
      { mode: 0 },
      { editComment: false, editId: 'missing-after-save', mode: 9 },
      { mode: 0 },
    ]);
  });

  it('restores a renumbered target through its stable native editor uid', async () => {
    const { editor, eventBus, modeRequests, saveDocument, viewer } = fixture();
    let persistedId = '363R';
    const selected = {
      editorType: 'highlight',
      elementBeforePopup: undefined,
      getData: () => ({ id: persistedId }),
      mode: 9,
      uid: 'pdfjs_internal_editor_4',
    };
    const uiManager = manager(selected);
    uiManager.getEditor.mockReturnValue(selected);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    await editor.editAnnotation({ editComment: false, id: '363R', kind: 'highlight' });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });
    const captured = new Uint8Array([37, 80, 68, 70, 45, 50]);
    saveDocument.mockImplementation(async () => {
      persistedId = '365R';
      return captured;
    });

    await expect(editor.save(new AbortController().signal)).resolves.toBe(captured);

    expect(editor.hasContextualEdit).toBe(true);
    expect(editor.resolveNativeEditor('pdfjs_internal_editor_4')).toMatchObject({ id: '365R' });
    expect(modeRequests).toEqual([
      { editComment: false, editId: '363R', mode: 9 },
      { mode: 0 },
      { editComment: false, editId: 'pdfjs_internal_editor_4', mode: 9 },
    ]);
  });

  it('does not restore a save-owned contextual target after navigation aborts it', async () => {
    const { editor, eventBus, modeRequests, saveDocument, viewer } = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    saveDocument.mockReturnValue(pending.promise);
    const uiManager = manager(selectedEditor('highlight-1', 9));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    await editor.editAnnotation({
      editComment: false,
      id: 'highlight-1',
      kind: 'highlight',
    });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });

    const saving = editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(saveDocument).toHaveBeenCalledOnce();
    });
    await editor.abortInteraction('Navigation cancelled the saved contextual target.');
    pending.resolve(new Uint8Array([37, 80, 68, 70]));
    await saving;

    expect(viewer.annotationEditorMode).toBe(0);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'highlight-1', mode: 9 },
      { mode: 0 },
    ]);
  });

  it('releases the save queue when contextual restore cleanup throws', async () => {
    const { editor, eventBus, saveDocument, viewer } = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    saveDocument.mockReturnValue(pending.promise);
    const selected = selectedEditor('restore-cleanup', 9);
    const uiManager = manager(selected);
    let userSelectCalls = 0;
    const cleanupFailure = new Error('contextual cleanup failed');
    uiManager.disableUserSelect.mockImplementation(() => {
      userSelectCalls += 1;
      if (userSelectCalls >= 3) throw cleanupFailure;
    });
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    await editor.editAnnotation({
      editComment: false,
      id: 'restore-cleanup',
      kind: 'highlight',
    });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const saving = editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(saveDocument).toHaveBeenCalledOnce();
    });
    const queuedUndo = editor.undo();
    pending.resolve(new Uint8Array([37, 80, 68, 70]));

    await expect(saving).resolves.toEqual(new Uint8Array([37, 80, 68, 70]));
    await expect(queuedUndo).resolves.toBeUndefined();
    expect(uiManager.undo).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  it('restores an in-flight contextual selection when an exact multi delete is rejected', async () => {
    const { commentBridge, editor, eventBus, modeRequests, saveDocument, viewer } = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    saveDocument.mockReturnValue(pending.promise);
    commentBridge.deleteAnnotations.mockReturnValue(false);
    const selected = selectedEditor('multi-first', 9);
    const uiManager = manager(selected);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    await editor.editAnnotation({ editComment: false, id: 'multi-first', kind: 'highlight' });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });
    const annotations = [
      createdAnnotation('', { id: 'multi-first' }),
      createdAnnotation('', { id: 'multi-second' }),
    ];

    const saving = editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(saveDocument).toHaveBeenCalledOnce();
    });
    expect(editor.deleteAnnotations(annotations)).toBe(false);
    pending.resolve(new Uint8Array([37, 80, 68, 70]));
    await saving;

    expect(commentBridge.deleteAnnotations).toHaveBeenCalledExactlyOnceWith(annotations);
    expect(viewer.annotationEditorMode).toBe(9);
    expect(editor.hasContextualEdit).toBe(true);
    expect(uiManager.firstSelectedEditor).toBe(selected);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'multi-first', mode: 9 },
      { mode: 0 },
      { editComment: false, editId: 'multi-first', mode: 9 },
    ]);
  });

  it('does not resurrect an in-flight contextual target after an accepted delete', async () => {
    const { commentBridge, editor, eventBus, modeRequests, saveDocument, viewer } = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    saveDocument.mockReturnValue(pending.promise);
    commentBridge.deleteAnnotations.mockReturnValue(true);
    const uiManager = manager(selectedEditor('deleted-during-save', 9));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });
    await editor.editAnnotation({
      editComment: false,
      id: 'deleted-during-save',
      kind: 'highlight',
    });
    eventBus.dispatch('editingstateschanged', {
      source: uiManager,
      details: { hasSelectedEditor: true },
    });
    const deleted = createdAnnotation('', { id: 'deleted-during-save' });

    const saving = editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(saveDocument).toHaveBeenCalledOnce();
    });
    expect(editor.deleteAnnotations([deleted])).toBe(true);
    pending.resolve(new Uint8Array([37, 80, 68, 70]));
    await saving;

    expect(commentBridge.deleteAnnotations).toHaveBeenCalledExactlyOnceWith([deleted]);
    expect(viewer.annotationEditorMode).toBe(0);
    expect(editor.hasContextualEdit).toBe(false);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'deleted-during-save', mode: 9 },
      { mode: 0 },
    ]);
  });

  it('rolls back when PDF.js selects a different editor identity', async () => {
    const { editor, eventBus, modeRequests, viewer } = fixture();
    const uiManager = manager(selectedEditor('other-highlight', 9));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    await editor.editAnnotation({
      editComment: false,
      id: 'requested-highlight',
      kind: 'highlight',
    });

    expect(viewer.annotationEditorMode).toBe(0);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'requested-highlight', mode: 9 },
      { mode: 0 },
    ]);
  });

  it('rolls back when PDF.js cannot select the requested editor', async () => {
    const { editor, eventBus, modeRequests, viewer } = fixture();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });

    await editor.editAnnotation({
      editComment: false,
      id: 'locked-highlight',
      kind: 'highlight',
    });

    expect(viewer.annotationEditorMode).toBe(0);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'locked-highlight', mode: 9 },
      { mode: 0 },
    ]);
  });

  it.each(['ink', 'freetext'] as const)(
    'keeps contextual delegation passive while %s is active',
    async (tool) => {
      const { editor, eventBus, modeRequests, viewer } = fixture();
      eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
      await editor.setTool(tool);
      modeRequests.splice(0);

      await editor.editAnnotation({
        editComment: false,
        id: 'another-highlight',
        kind: 'highlight',
      });

      expect(modeRequests).toEqual([]);
    },
  );

  it.each([
    ['Underline', 'readonly-underline'],
    ['Text Note', 'readonly-text-note'],
  ])('preserves passive Underline and Text Note for %s', async (_type, editId) => {
    const { editor, eventBus, modeRequests, viewer } = fixture();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });

    await editor.setTool('highlight', {
      editComment: true,
      editId,
      mustEnterInEditMode: true,
    } as never);

    expect(modeRequests).toEqual([{ mode: 9 }]);
  });

  it('captures only the viewer-owned UI manager lifecycle event and starts in NONE mode', async () => {
    const { editor, eventBus, viewer } = fixture();
    const uiManager = manager();

    expect(viewer.annotationEditorMode).toBe(0);
    await expect(editor.setTool('ink')).rejects.toThrow('not ready');
    eventBus.dispatch('annotationeditoruimanager', { source: {}, uiManager });
    await expect(editor.setTool('ink')).rejects.toThrow('not ready');
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    await editor.setTool('ink');
    expect(viewer.annotationEditorMode).toBe(15);
  });

  it('maps native tools and parameters without underline or text-note modes', async () => {
    const { changedModes, editor, eventBus, viewer } = fixture();
    const uiManager = manager();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    await editor.setTool('highlight');
    await editor.setTool('freetext', { isFromKeyboard: true });
    await editor.setTool('select');
    const parameters = [
      ['freetext-size', 14],
      ['freetext-color', '#112233'],
      ['freetext-opacity', 75],
      ['ink-color', '#445566'],
      ['ink-thickness', 4],
      ['ink-opacity', 80],
      ['highlight-color', '#ffee00'],
      ['highlight-thickness', 12],
      ['highlight-free', true],
    ] as const;
    for (const [parameter, value] of parameters) await editor.setParameter(parameter, value);
    await editor.undo();
    await editor.redo();
    await editor.deleteSelection();

    expect(changedModes).toEqual([9, 3, 0]);
    expect(uiManager.updateParams.mock.calls).toEqual([
      [11, 14],
      [12, '#112233'],
      [13, 75],
      [21, '#445566'],
      [22, 4],
      [23, 80],
      [31, '#ffee00'],
      [32, 12],
      [33, true],
    ]);
    expect(uiManager.undo).toHaveBeenCalledOnce();
    expect(uiManager.redo).toHaveBeenCalledOnce();
    expect(uiManager.delete).toHaveBeenCalledOnce();
  });

  it('emits one session color for direct and external native color changes', async () => {
    const { editor, eventBus, viewer } = fixture();
    const uiManager = manager();
    const colors: string[] = [];
    const removeColor = editor.onColor((color) => colors.push(color));
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    await editor.setParameter('ink-color', '#112233');
    eventBus.dispatch('switchannotationeditorparams', {
      source: {},
      type: 31,
      value: '#ff6666',
    });
    eventBus.dispatch('switchannotationeditorparams', { source: {}, type: 31, value: 42 });
    eventBus.dispatch('switchannotationeditorparams', { source: {}, type: 31, value: ' ' });
    eventBus.dispatch('switchannotationeditorparams', { source: {}, type: 22, value: 4 });
    editor.notifyNativeColorChange('#5fb236');
    editor.notifyNativeColorChange(' ');

    expect(colors).toEqual(['#112233', '#ff6666', '#5fb236']);
    removeColor();
    editor.notifyNativeColorChange('#000000');
    editor.destroy();
    eventBus.dispatch('switchannotationeditorparams', {
      source: {},
      type: 12,
      value: '#000000',
    });
    editor.notifyNativeColorChange('#000000');
    expect(colors).toEqual(['#112233', '#ff6666', '#5fb236']);
  });

  it('accepts a replacement PDF.js manager only after the document lifecycle resumes', async () => {
    const current = fixture();
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });

    current.editor.detachFromDocument();
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });
    await expect(current.editor.setTool('ink')).rejects.toThrow('not ready');

    current.editor.resumeDocumentLifecycle();
    current.eventBus.dispatch('annotationeditoruimanager', {
      source: current.viewer,
      uiManager: manager(),
    });
    await current.editor.setTool('ink');

    expect(current.viewer.annotationEditorMode).toBe(15);
  });

  it('does not request a mode change when the requested tool is already active', async () => {
    const { changedModes, editor, eventBus, viewer } = fixture();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });

    await editor.setTool('select');

    expect(changedModes).toEqual([]);
    expect(eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
  });

  it('ignores unrelated mode events and rejects a superseded tool request', async () => {
    const { editor, eventBus, viewer } = fixture({ dispatchModeChanges: false });
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });

    const highlight = editor.setTool('highlight');
    const rejectedHighlight = expect(highlight).rejects.toMatchObject({ name: 'AbortError' });
    eventBus.dispatch('annotationeditormodechanged', { source: {}, mode: 9 });
    eventBus.dispatch('annotationeditormodechanged', { source: viewer, mode: 15 });
    const ink = editor.setTool('ink');
    await rejectedHighlight;
    eventBus.dispatch('annotationeditormodechanged', { source: viewer, mode: 15 });

    await ink;
    expect(eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
  });

  it('propagates a mode setter failure and removes the pending listener', async () => {
    const { editor, eventBus, viewer } = fixture();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    Object.defineProperty(viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => 0,
      set: () => {
        throw new Error('mode setter failed');
      },
    });

    await expect(editor.setTool('highlight')).rejects.toThrow('mode setter failed');
    expect(eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(1);
  });

  it.each([
    null,
    {},
    { delete: vi.fn(), endCurrentEditing: vi.fn(), redo: vi.fn(), undo: vi.fn() },
    { delete: vi.fn(), endCurrentEditing: vi.fn(), redo: vi.fn(), updateParams: vi.fn() },
    { delete: vi.fn(), endCurrentEditing: vi.fn(), undo: vi.fn(), updateParams: vi.fn() },
    { delete: vi.fn(), redo: vi.fn(), undo: vi.fn(), updateParams: vi.fn() },
    { endCurrentEditing: vi.fn(), redo: vi.fn(), undo: vi.fn(), updateParams: vi.fn() },
  ])('ignores an invalid UI manager payload %#', async (uiManager) => {
    const { editor, eventBus, viewer } = fixture();

    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager });

    await expect(editor.setTool('ink')).rejects.toThrow('not ready');
  });

  it('chains and restores prior dirty callbacks across manager rebind and destroy', () => {
    const { annotationStorage, editor, eventBus, viewer } = fixture();
    const previousEditor = vi.fn();
    const previousSet = vi.fn();
    const previousReset = vi.fn();
    annotationStorage.onAnnotationEditor = previousEditor;
    annotationStorage.onSetModified = previousSet;
    annotationStorage.onResetModified = previousReset;
    const dirty = vi.fn();
    const unsubscribe = editor.onDirty(dirty);

    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    annotationStorage.onAnnotationEditor(9);
    annotationStorage.onSetModified();
    annotationStorage.onResetModified();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    annotationStorage.onAnnotationEditor(3);
    annotationStorage.onSetModified();
    editor.destroy();

    expect(previousSet).toHaveBeenCalledTimes(2);
    expect(previousReset).toHaveBeenCalledOnce();
    expect(previousEditor.mock.calls).toEqual([[9], [3]]);
    expect(dirty.mock.calls).toEqual([[true], [false], [true]]);
    expect(annotationStorage.onAnnotationEditor).toBe(previousEditor);
    expect(annotationStorage.onSetModified).toBe(previousSet);
    expect(annotationStorage.onResetModified).toBe(previousReset);
    expect(eventBus.listeners.get('annotationeditoruimanager')).toHaveLength(0);
    unsubscribe();
  });

  it('does not overwrite a foreign callback that replaces an owned callback', () => {
    const { annotationStorage, editor, eventBus, viewer } = fixture();
    const previousSet = vi.fn();
    const foreignSet = vi.fn();
    annotationStorage.onSetModified = previousSet;

    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    annotationStorage.onSetModified = foreignSet;
    editor.destroy();

    expect(annotationStorage.onSetModified).toBe(foreignSet);
  });

  it('preserves a foreign reset callback and makes subscriptions inert after destroy', () => {
    const { annotationStorage, editor, eventBus, viewer } = fixture();
    const foreignReset = vi.fn();
    const dirty = vi.fn();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    annotationStorage.onResetModified = foreignReset;

    editor.destroy();
    editor.destroy();
    const unsubscribe = editor.onDirty(dirty);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    unsubscribe();

    expect(annotationStorage.onResetModified).toBe(foreignReset);
    expect(dirty).not.toHaveBeenCalled();
  });
});

describe('PdfAnnotationEditor save boundary', () => {
  it('waits for an in-flight selection before autosave', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    const nativeReady = deferred<DocumentAnnotation>();
    let annotation: DocumentAnnotation | null = null;
    void nativeReady.promise.then(
      (value) => {
        annotation = value;
      },
      () => undefined,
    );
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockImplementation(() => annotation);
    uiManager.highlightSelection.mockImplementation(() => {
      fixtureValue.annotationStorage.addEditor(9);
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    const creating = fixtureValue.editor.commitSelection('current', {
      kind: 'highlight',
      color: '#ffd400',
    });
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    const transaction = (
      fixtureValue.editor as unknown as {
        readonly pendingSelectionTransaction: {
          readonly controller: AbortController;
        } | null;
      }
    ).pendingSelectionTransaction;
    expect(transaction).not.toBeNull();

    const saving = fixtureValue.editor.save(new AbortController().signal);
    const abortedBeforeReady = transaction?.controller.signal.aborted;
    nativeReady.resolve(createdAnnotation());
    const outcomes = await Promise.allSettled([creating, saving]);

    expect(abortedBeforeReady).toBe(false);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
  });

  it('waits for source-confirmed NONE before saving a completed interaction', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
    requestPdfJsSelectionMode(fixtureValue, uiManager);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const committing = fixtureValue.editor
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => cause);
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 9,
    });
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });

    const saving = fixtureValue.editor.save(new AbortController().signal);
    await Promise.resolve();

    expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }]);
    expect(uiManager.endCurrentEditing).not.toHaveBeenCalled();
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
    fixtureValue.commentBridge.normalizeSelectionHighlight.mockReturnValue(createdAnnotation());
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
    });
    expect(uiManager.endCurrentEditing).not.toHaveBeenCalled();
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await expect(saving).resolves.toEqual(new Uint8Array([37, 80, 68, 70, 45]));
    await expect(committing).resolves.toMatchObject({
      identity: { id: 'created-native', kind: 'stable' },
    });
    expect(uiManager.endCurrentEditing).toHaveBeenCalledOnce();
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
  });

  it('propagates neutral mode failure after the pending selection settles', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const committing = fixtureValue.editor
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => cause);
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });
    const failure = new Error('neutral mode setter failed before save');
    Object.defineProperty(fixtureValue.viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => 9,
      set: () => {
        throw failure;
      },
    });

    await expect(fixtureValue.editor.save(new AbortController().signal)).rejects.toBe(failure);
    await expect(committing).resolves.toBe(failure);
    expect(uiManager.endCurrentEditing).toHaveBeenCalledOnce();
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
  });

  it('revalidates the manager after waiting for an interaction abort', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const initialManager = manager();
    const replacementManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: initialManager,
    });
    const committing = fixtureValue.editor
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => cause);
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 9,
    });
    await vi.waitFor(() => {
      expect(initialManager.highlightSelection).toHaveBeenCalledOnce();
    });

    const saving = fixtureValue.editor.save(new AbortController().signal);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: replacementManager,
    });
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await expect(saving).rejects.toMatchObject({ name: 'InvalidStateError' });
    await committing;
    expect(initialManager.endCurrentEditing).not.toHaveBeenCalled();
    expect(replacementManager.endCurrentEditing).not.toHaveBeenCalled();
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
  });

  it('does not enter the save boundary when destroyed during interaction abort', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const committing = fixtureValue.editor
      .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
      .catch((cause: unknown) => cause);
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 9,
    });
    await vi.waitFor(() => {
      expect(uiManager.highlightSelection).toHaveBeenCalledOnce();
    });

    const saving = fixtureValue.editor.save(new AbortController().signal);
    fixtureValue.editor.destroy();
    expect(fixtureValue.eventBus.listeners.get('annotationeditormodechanged')?.size ?? 0).toBe(0);
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await expect(saving).rejects.toMatchObject({ name: 'InvalidStateError' });
    await committing;
    expect(uiManager.endCurrentEditing).not.toHaveBeenCalled();
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
  });

  it.each(['rebind', 'same-manager rebind', 'destroy'] as const)(
    'revalidates the prepared save before native work when the editor %s occurs in its continuation',
    async (lifecycle) => {
      const fixtureValue = fixture({ dispatchModeChanges: false });
      const initialManager = manager();
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager: initialManager,
      });
      const committing = fixtureValue.editor
        .commitSelection('current', { kind: 'highlight', color: '#ffd400' })
        .catch((cause: unknown) => cause);
      fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
        source: fixtureValue.viewer,
        mode: 9,
      });
      await vi.waitFor(() => {
        expect(initialManager.highlightSelection).toHaveBeenCalledOnce();
      });
      const controller = new AbortController();
      let lifecycleScheduled = false;
      const signal: AbortSignal = {
        get aborted() {
          if (!lifecycleScheduled) {
            lifecycleScheduled = true;
            queueMicrotask(() => {
              if (lifecycle === 'destroy') fixtureValue.editor.destroy();
              else {
                fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
                  source: fixtureValue.viewer,
                  uiManager: lifecycle === 'same-manager rebind' ? initialManager : manager(),
                });
              }
            });
          }
          return controller.signal.aborted;
        },
        addEventListener: controller.signal.addEventListener.bind(controller.signal),
        dispatchEvent: controller.signal.dispatchEvent.bind(controller.signal),
        onabort: null,
        reason: undefined,
        removeEventListener: controller.signal.removeEventListener.bind(controller.signal),
        throwIfAborted: controller.signal.throwIfAborted.bind(controller.signal),
      };

      const saving = fixtureValue.editor.save(signal);
      fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
        source: fixtureValue.viewer,
        mode: 0,
      });

      await expect(saving).rejects.toMatchObject({ name: 'InvalidStateError' });
      await committing;
      expect(lifecycleScheduled).toBe(true);
      expect(initialManager.endCurrentEditing).not.toHaveBeenCalled();
      expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
    },
  );

  it.each(['parameter', 'undo', 'redo', 'delete'] as const)(
    'defers %s mutations until the active PDF.js snapshot has settled',
    async (mutation) => {
      const fixtureValue = fixture();
      const pending = deferred<Uint8Array<ArrayBuffer>>();
      const uiManager = manager();
      const dirty = vi.fn();
      fixtureValue.editor.onDirty(dirty);
      uiManager.updateParams.mockImplementation(() => {
        fixtureValue.annotationStorage.onSetModified?.();
      });
      uiManager.undo.mockImplementation(() => {
        fixtureValue.annotationStorage.onSetModified?.();
      });
      uiManager.redo.mockImplementation(() => {
        fixtureValue.annotationStorage.onSetModified?.();
      });
      uiManager.delete.mockImplementation(() => {
        fixtureValue.annotationStorage.onSetModified?.();
      });
      fixtureValue.saveDocument.mockReturnValue(pending.promise);
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager,
      });
      const saving = fixtureValue.editor.save(new AbortController().signal);
      await vi.waitFor(() => {
        expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
      });

      let mutationPromise: Promise<void>;
      switch (mutation) {
        case 'parameter':
          mutationPromise = fixtureValue.editor.setParameter('highlight-color', '#ffee00');
          break;
        case 'undo':
          mutationPromise = fixtureValue.editor.undo();
          break;
        case 'redo':
          mutationPromise = fixtureValue.editor.redo();
          break;
        case 'delete':
          mutationPromise = fixtureValue.editor.deleteSelection();
          break;
      }
      let mutationSettled = false;
      const mutationOutcome = mutationPromise.finally(() => {
        mutationSettled = true;
      });
      await Promise.resolve();
      expect(uiManager.updateParams).not.toHaveBeenCalled();
      expect(uiManager.undo).not.toHaveBeenCalled();
      expect(uiManager.redo).not.toHaveBeenCalled();
      expect(uiManager.delete).not.toHaveBeenCalled();
      expect(dirty).not.toHaveBeenCalled();
      expect(mutationSettled).toBe(false);

      pending.resolve(new Uint8Array(new ArrayBuffer(3)));
      await Promise.all([saving, mutationOutcome]);

      const expected = {
        parameter: [uiManager.updateParams, [31, '#ffee00']],
        undo: [uiManager.undo, []],
        redo: [uiManager.redo, []],
        delete: [uiManager.delete, []],
      } as const;
      const [operation, argumentsValue] = expected[mutation];
      expect(operation).toHaveBeenCalledOnce();
      expect(operation).toHaveBeenCalledWith(...argumentsValue);
      expect(dirty).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it('replays deferred native mutations in user order after byte capture', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const uiManager = manager();
    const calls: string[] = [];
    uiManager.updateParams.mockImplementation(() => calls.push('parameter'));
    uiManager.undo.mockImplementation(() => calls.push('undo'));
    uiManager.redo.mockImplementation(() => calls.push('redo'));
    uiManager.delete.mockImplementation(() => calls.push('delete'));
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });

    const mutations = [
      fixtureValue.editor.setParameter('ink-thickness', 5),
      fixtureValue.editor.undo(),
      fixtureValue.editor.redo(),
      fixtureValue.editor.deleteSelection(),
    ];
    expect(calls).toEqual([]);
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await Promise.all([saving, ...mutations]);
    expect(calls).toEqual(['parameter', 'undo', 'redo', 'delete']);
  });

  it('queues annotation activation behind byte capture so later native input becomes dirty', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const projected = createdAnnotation('', { id: 'queued-freetext', type: 'free-text' });
    const uiManager = manager(selectedEditor('queued-freetext', 3));
    const dirty = vi.fn();
    fixtureValue.editor.onDirty(dirty);
    fixtureValue.editor.setAnnotationProjection([
      { annotation: projected, stableId: 'queued-freetext' },
    ]);
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });

    const focusing = fixtureValue.editor.focusAnnotation('queued-freetext', {
      kind: 'root-click',
    });
    await Promise.resolve();
    expect(fixtureValue.commentBridge.focusAnnotation).not.toHaveBeenCalled();

    pending.resolve(new Uint8Array(new ArrayBuffer(3)));
    await expect(saving).resolves.toHaveLength(3);
    await expect(focusing).resolves.toBe('editable');
    fixtureValue.annotationStorage.onSetModified?.();

    expect(dirty).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('lets an activation already in flight settle before byte capture starts', async () => {
    const fixtureValue = fixture();
    const resolver = deferred<DocumentAnnotation | null>();
    fixtureValue.editor.setAnnotationResolver(async () => resolver.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(selectedEditor('slow-activation', 9)),
    });
    const focusing = fixtureValue.editor.focusAnnotation('slow-activation', {
      kind: 'root-click',
    });
    await Promise.resolve();

    const saving = fixtureValue.editor.save(new AbortController().signal);
    await Promise.resolve();

    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
    resolver.resolve(createdAnnotation('', { id: 'slow-activation' }));
    await expect(focusing).resolves.toBe('editable');
    await expect(saving).resolves.toEqual(new Uint8Array([37, 80, 68, 70, 45]));
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
  });

  it('queues a selection commit behind byte capture and marks the created highlight dirty', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const uiManager = manager();
    const dirty = vi.fn();
    uiManager.highlightSelection.mockImplementation(() => {
      fixtureValue.annotationStorage.addEditor(9);
    });
    fixtureValue.editor.onDirty(dirty);
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });

    const committing = fixtureValue.editor.commitSelection('current', {
      kind: 'highlight',
      color: '#ffd400',
    });
    await Promise.resolve();
    expect(uiManager.highlightSelection).not.toHaveBeenCalled();

    pending.resolve(new Uint8Array(new ArrayBuffer(3)));
    await expect(saving).resolves.toHaveLength(3);
    await expect(committing).resolves.toMatchObject({
      identity: { id: 'created-native', kind: 'stable' },
    });

    expect(dirty).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('cancels queued activation and selection work when the view suspends during a save', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const projected = createdAnnotation('', { id: 'closing-freetext', type: 'free-text' });
    const uiManager = manager(selectedEditor('closing-freetext', 3));
    fixtureValue.editor.setAnnotationProjection([
      { annotation: projected, stableId: 'closing-freetext' },
    ]);
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });

    const focusing = fixtureValue.editor.focusAnnotation('closing-freetext', {
      kind: 'root-click',
    });
    const committing = fixtureValue.editor.commitSelection('current', {
      kind: 'highlight',
      color: '#ffd400',
    });
    await fixtureValue.editor.suspendInteractions();
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).resolves.toHaveLength(3);
    await expect(focusing).resolves.toBe('cancelled');
    await expect(committing).resolves.toBe('dismissed');
    expect(fixtureValue.commentBridge.focusAnnotation).not.toHaveBeenCalled();
    expect(uiManager.highlightSelection).not.toHaveBeenCalled();
  });

  it('rolls back interaction suspension when native neutralization fails', async () => {
    const fixtureValue = fixture();
    const failure = new Error('neutralization failed');
    vi.spyOn(fixtureValue.editor, 'abortInteraction').mockRejectedValue(failure);

    await expect(fixtureValue.editor.suspendInteractions()).rejects.toBe(failure);

    expect(Reflect.get(fixtureValue.editor, 'interactionsSuspended') as boolean).toBe(false);
  });

  it('rejects toolbar and contextual edit intents after interaction suspension', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await fixtureValue.editor.suspendInteractions();
    await fixtureValue.editor.setTool('highlight');
    await fixtureValue.editor.editAnnotation({
      editComment: false,
      id: 'closing-highlight',
      kind: 'highlight',
    });

    expect(fixtureValue.modeRequests).toEqual([]);
    expect(uiManager.updateParams).not.toHaveBeenCalled();
  });

  it('cancels a save-queued activation promptly when its external signal aborts', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const abort = new AbortController();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });

    const focusing = fixtureValue.editor.focusAnnotation('queued-abort', {
      kind: 'sidebar',
      signal: abort.signal,
    });
    abort.abort();

    await expect(focusing).resolves.toBe('cancelled');
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));
    await expect(saving).resolves.toHaveLength(3);
  });

  it('queues direct contextual editing behind byte capture', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const uiManager = manager(selectedEditor('queued-direct-edit', 9));
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });

    const editing = fixtureValue.editor.editAnnotation({
      editComment: false,
      id: 'queued-direct-edit',
      kind: 'highlight',
    });
    await Promise.resolve();
    expect(fixtureValue.modeRequests).toEqual([]);
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).resolves.toHaveLength(3);
    await expect(editing).resolves.toBeUndefined();
    expect(fixtureValue.modeRequests).toEqual([
      { editComment: false, editId: 'queued-direct-edit', mode: 9 },
    ]);
  });

  it('rejects a deferred mutation instead of replaying it into a replacement manager', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const originalManager = manager();
    const replacementManager = manager();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: originalManager,
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });
    const mutation = fixtureValue.editor.undo();
    const rejectedMutation = expect(mutation).rejects.toMatchObject({ name: 'AbortError' });

    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: replacementManager,
    });
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await rejectedMutation;
    await expect(saving).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(originalManager.undo).not.toHaveBeenCalled();
    expect(replacementManager.undo).not.toHaveBeenCalled();
  });

  it('queues the latest tool intent while native bytes are being captured', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    await fixtureValue.editor.setTool('highlight');
    fixtureValue.modeRequests.splice(0);

    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });
    const toolChange = fixtureValue.editor.setTool('freetext');
    const toolOutcome = toolChange.then(
      () => 'resolved',
      (cause: unknown) => cause,
    );
    expect(fixtureValue.viewer.annotationEditorMode).toBe(0);
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).resolves.toHaveLength(3);
    await expect(toolOutcome).resolves.toBe('resolved');
    expect(fixtureValue.viewer.annotationEditorMode).toBe(3);
    expect(fixtureValue.modeRequests).toEqual([{ mode: 0 }, { mode: 3 }]);
  });

  it('returns captured bytes while rejecting a queued tool whose restore fails', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    const descriptor = Object.getOwnPropertyDescriptor(fixtureValue.viewer, 'annotationEditorMode');
    if (descriptor?.get === undefined || descriptor.set === undefined)
      throw new Error('Expected the fixture viewer mode accessor.');
    const restoreFailure = new Error('queued tool restore failed');
    const getMode = descriptor.get.bind(fixtureValue.viewer);
    const setMode = descriptor.set.bind(fixtureValue.viewer);
    Object.defineProperty(fixtureValue.viewer, 'annotationEditorMode', {
      configurable: true,
      get: getMode,
      set(value: { readonly mode: number }) {
        if (value.mode === 3) throw restoreFailure;
        setMode(value);
      },
    });

    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });
    const queuedTool = fixtureValue.editor.setTool('freetext');
    const queuedToolOutcome = expect(queuedTool).rejects.toBe(restoreFailure);
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).resolves.toHaveLength(3);
    await queuedToolOutcome;
    expect(fixtureValue.viewer.annotationEditorMode).toBe(0);
  });

  it('returns captured bytes without warning when a queued tool restore is aborted', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    const descriptor = Object.getOwnPropertyDescriptor(fixtureValue.viewer, 'annotationEditorMode');
    if (descriptor?.get === undefined || descriptor.set === undefined)
      throw new Error('Expected the fixture viewer mode accessor.');
    const restoreFailure = new DOMException('queued tool was cancelled', 'AbortError');
    const getMode = descriptor.get.bind(fixtureValue.viewer);
    const setMode = descriptor.set.bind(fixtureValue.viewer);
    Object.defineProperty(fixtureValue.viewer, 'annotationEditorMode', {
      configurable: true,
      get: getMode,
      set(value: { readonly mode: number }) {
        if (value.mode === 3) throw restoreFailure;
        setMode(value);
      },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });
    const queuedTool = fixtureValue.editor.setTool('freetext');
    const queuedOutcome = expect(queuedTool).rejects.toBe(restoreFailure);
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).resolves.toHaveLength(3);
    await queuedOutcome;
    expect(warning).not.toHaveBeenCalled();
  });

  it('drains and coalesces tool intents that arrive while the save tool is restoring', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    fixtureValue.viewer.currentMode = 9;

    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests).toEqual([{ mode: 0 }]);
    });
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });
    const firstTool = fixtureValue.editor.setTool('freetext');
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));
    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests[fixtureValue.modeRequests.length - 1]).toEqual({ mode: 3 });
    });
    const latestTool = fixtureValue.editor.setTool('ink');
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 3,
    });

    await vi.waitFor(() => {
      expect(fixtureValue.modeRequests[fixtureValue.modeRequests.length - 1]).toEqual({ mode: 15 });
    });
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 15,
    });
    await expect(saving).resolves.toHaveLength(3);
    await expect(firstTool).resolves.toBeUndefined();
    await expect(latestTool).resolves.toBeUndefined();
    expect(fixtureValue.viewer.annotationEditorMode).toBe(15);
  });

  it('pauses the selected native tool only while PDF.js captures bytes and restores it afterward', async () => {
    const fixtureValue = fixture();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    await fixtureValue.editor.setTool('ink');
    fixtureValue.modeRequests.splice(0);
    fixtureValue.saveDocument.mockImplementation(async () => {
      expect(fixtureValue.viewer.annotationEditorMode).toBe(0);
      return new Uint8Array([37, 80, 68, 70]);
    });

    await fixtureValue.editor.save(new AbortController().signal);

    expect(fixtureValue.viewer.annotationEditorMode).toBe(15);
    expect(fixtureValue.modeRequests).toEqual([{ mode: 0 }, { mode: 15 }]);
  });

  it.each([
    ['an Error', new Error('worker rejected save')],
    ['a non-Error reason', 'worker rejected save'],
  ])(
    'restores the selected tool when PDF.js serialization fails with %s',
    async (_kind, failure) => {
      const fixtureValue = fixture();
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager: manager(),
      });
      await fixtureValue.editor.setTool('highlight');
      fixtureValue.saveDocument.mockRejectedValue(failure);

      await expect(fixtureValue.editor.save(new AbortController().signal)).rejects.toThrow(
        'worker rejected save',
      );

      expect(fixtureValue.viewer.annotationEditorMode).toBe(9);
    },
  );

  it('ends the current edit and takes ownership of the full-span PDF.js bytes without copying', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    const upstream = new Uint8Array([37, 80, 68, 70, 45, 49]);
    fixtureValue.saveDocument.mockResolvedValue(upstream);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    const saved = await fixtureValue.editor.save(new AbortController().signal);

    expect(uiManager.endCurrentEditing).toHaveBeenCalledOnce();
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    expect(saved).toEqual(upstream);
    expect(saved).toBe(upstream);
  });

  it('copies a byte window returned by PDF.js before its backing buffer can change', async () => {
    const fixtureValue = fixture();
    const backing = new Uint8Array([0, 37, 80, 68, 70, 0]);
    const windowed = backing.subarray(1, 5);
    fixtureValue.saveDocument.mockResolvedValue(windowed);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });

    const saved = await fixtureValue.editor.save(new AbortController().signal);
    backing[1] = 0;

    expect(saved).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(saved).not.toBe(windowed);
    expect(saved.buffer).not.toBe(backing.buffer);
  });

  it('forwards the PDF.js modified reset before resolving saved bytes', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    const dirty = vi.fn();
    fixtureValue.editor.onDirty(dirty);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });
    fixtureValue.saveDocument.mockImplementation(async () => {
      const onResetModified = fixtureValue.annotationStorage.onResetModified;
      if (onResetModified === null)
        throw new Error('Expected the editor to own the reset callback.');
      onResetModified();
      return new Uint8Array([37, 80, 68, 70]);
    });

    await fixtureValue.editor.save(new AbortController().signal);

    expect(dirty).toHaveBeenCalledWith(false);
  });

  it('does not turn save-time storage callbacks into a new revision but keeps queued mutations dirty', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    const dirty = vi.fn();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    fixtureValue.editor.onDirty(dirty);
    uiManager.updateParams.mockImplementation(() => {
      fixtureValue.annotationStorage.onSetModified?.();
    });
    fixtureValue.saveDocument.mockImplementation(() => {
      fixtureValue.annotationStorage.onSetModified?.();
      return pending.promise;
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });
    expect(dirty).not.toHaveBeenCalled();

    const queuedMutation = fixtureValue.editor.setParameter('highlight-color', '#ffee00');
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));
    await Promise.all([saving, queuedMutation]);

    expect(uiManager.updateParams).toHaveBeenCalledExactlyOnceWith(31, '#ffee00');
    expect(dirty).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('rejects owned cancellation before touching the PDF.js save boundary', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await expect(fixtureValue.editor.save(AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(uiManager.endCurrentEditing).not.toHaveBeenCalled();
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
  });

  it('rejects a save whose manager is rebound while saveDocument is pending', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });

    const saving = fixtureValue.editor.save(new AbortController().signal);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
  });

  it('rejects a replacement-manager tool queued behind a retired-manager save', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const initialManager = manager();
    const replacementManager = manager();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: initialManager,
    });
    const saving = fixtureValue.editor.save(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    });

    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: replacementManager,
    });
    const queuedTool = fixtureValue.editor.setTool('ink');
    const queuedOutcome = expect(queuedTool).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).rejects.toMatchObject({ name: 'InvalidStateError' });
    await queuedOutcome;
    expect(replacementManager.updateParams).not.toHaveBeenCalled();
    expect(fixtureValue.modeRequests).not.toContainEqual({ mode: 15 });
  });

  it('rejects a concurrent save while preserving the active save', async () => {
    beginPluginActivation();
    endPluginActivation();
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });

    const firstSave = fixtureValue.editor.save(new AbortController().signal);
    await expect(fixtureValue.editor.save(new AbortController().signal)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(firstSave).resolves.toHaveLength(3);
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
    expect(readerPerformanceSnapshot().counters.maxConcurrentSerializations).toBe(1);
  });

  it('rejects cancellation that occurs while saveDocument is pending', async () => {
    const fixtureValue = fixture();
    const pending = deferred<Uint8Array<ArrayBuffer>>();
    const controller = new AbortController();
    fixtureValue.saveDocument.mockReturnValue(pending.promise);
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });

    const saving = fixtureValue.editor.save(controller.signal);
    controller.abort('cancelled by owner');
    pending.resolve(new Uint8Array(new ArrayBuffer(3)));

    await expect(saving).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
  });

  it('rejects a synchronous manager rebind before calling saveDocument', async () => {
    const fixtureValue = fixture();
    const initialManager = manager();
    initialManager.endCurrentEditing.mockImplementation(() => {
      fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
        source: fixtureValue.viewer,
        uiManager: manager(),
      });
    });
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: initialManager,
    });

    await expect(fixtureValue.editor.save(new AbortController().signal)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
  });

  it('rejects a destroyed editor without calling saveDocument', async () => {
    const fixtureValue = fixture();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    fixtureValue.editor.destroy();

    await expect(fixtureValue.editor.save(new AbortController().signal)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
  });
});
