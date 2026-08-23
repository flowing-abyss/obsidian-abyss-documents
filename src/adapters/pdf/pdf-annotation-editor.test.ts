import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../../reader-performance.js';
import { PdfAnnotationEditor, type PdfAnnotationToolOptions } from './pdf-annotation-editor.js';
import type { PdfCommentDialogReservation } from './pdf-comment-bridge.js';

type Listener = (event: unknown) => void;

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
  addEditor: ReturnType<typeof vi.fn<(type: number) => void>>;
  onAnnotationEditor: ((type: number | null) => void) | null;
  onResetModified: (() => void) | null;
  onSetModified: (() => void) | null;
  resetModified: ReturnType<typeof vi.fn<() => void>>;
  readonly serializable?: never;
}

function storage(): MutableAnnotationStorage {
  let modified = false;
  const value: MutableAnnotationStorage = {
    addEditor: vi.fn((type: number) => {
      if (!modified) {
        modified = true;
        value.onSetModified?.();
      }
      value.onAnnotationEditor?.(type);
    }),
    onAnnotationEditor: null,
    onResetModified: null,
    onSetModified: null,
    resetModified: vi.fn(() => {
      if (!modified) return;
      modified = false;
      value.onResetModified?.();
    }),
  };
  Object.defineProperty(value, 'serializable', {
    configurable: false,
    get: () => {
      throw new Error('AnnotationStorage.serializable must stay private to PDF.js.');
    },
  });
  return value;
}

function selectedEditor(uid: string, mode: number) {
  let editorType = 'ink';
  if (mode === 3) editorType = 'freetext';
  else if (mode === 9) editorType = 'highlight';
  return {
    editorType,
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
    getLayer: vi.fn((pageIndex: number) => layers[pageIndex]),
    highlightSelection: vi.fn(),
    layers,
    redo: vi.fn(),
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
  const commentBridge = {
    reserveNextDialog: vi.fn<
      (seed: '' | '[[' | '#', signal?: AbortSignal) => PdfCommentDialogReservation
    >(() => ({
      closed: Promise.resolve('external' as const),
      opened: Promise.resolve(),
    })),
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
    eventBus,
    modeRequests,
    pdf,
    saveDocument,
    selectionObserver,
    viewer,
  };
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
      const editor = fixtureValue.editor as PdfAnnotationEditor & {
        commitSelection(
          token: string,
          action:
            | { readonly kind: 'highlight'; readonly color: string }
            | {
                readonly kind: 'comment';
                readonly color: string;
                readonly seed: '' | '[[' | '#';
              },
        ): Promise<'created' | 'dismissed'>;
      };

      await expect(
        editor.commitSelection(
          'current',
          kind === 'highlight' ? { kind, color: '#ffd400' } : { kind, color: '#ffd400', seed: '' },
        ),
      ).resolves.toBe('created');

      expect(calls).toEqual(['color', kind]);
    }
  });

  it('resolves highlight after dirty and NONE', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
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

    await expect(committing).resolves.toBe('created');
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
    ).resolves.toBe('created');

    expect(fixtureValue.annotationStorage.addEditor).toHaveBeenCalledTimes(2);
  });

  it('suppresses transient native highlight mode', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
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

  it('does not double-create while quick highlight is armed', async () => {
    const fixtureValue = fixture();
    const uiManager = manager();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager,
    });

    await fixtureValue.editor.setQuickHighlight({ enabled: true, color: '#5fb236' });
    await expect(
      fixtureValue.editor.commitSelection('current', {
        kind: 'highlight',
        color: '#5fb236',
      }),
    ).resolves.toBe('dismissed');

    expect(uiManager.updateParams).toHaveBeenCalledExactlyOnceWith(31, '#5fb236');
    expect(uiManager.highlightSelection).not.toHaveBeenCalled();
    expect(fixtureValue.viewer.annotationEditorMode).toBe(9);
  });

  it('resolves comment after bridge open close and NONE', async () => {
    const fixtureValue = fixture();
    const opened = deferred<void>();
    const closed = deferred<'escape'>();
    fixtureValue.commentBridge.reserveNextDialog.mockReturnValue({
      opened: opened.promise,
      closed: closed.promise,
    });
    const uiManager = manager();
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
    opened.resolve(undefined);
    await Promise.resolve();
    expect(settled).toBe(false);
    closed.resolve('escape');

    await expect(committing).resolves.toBe('created');
    expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
  });

  it('does not time out while an open comment waits for the user', async () => {
    vi.useFakeTimers();
    try {
      const fixtureValue = fixture();
      const closed = deferred<'escape'>();
      fixtureValue.commentBridge.reserveNextDialog.mockReturnValue({
        opened: Promise.resolve(),
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
      expect(outcome).toBe('created');
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
        opened: Promise.resolve(),
        closed: closed.promise,
      });
      const uiManager = manager();
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
    for (const lifecycle of ['detach', 'destroy', 'save'] as const) {
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

      let saving: Promise<Uint8Array> | null = null;
      if (lifecycle === 'detach') fixtureValue.editor.detachFromDocument();
      else if (lifecycle === 'destroy') fixtureValue.editor.destroy();
      else saving = fixtureValue.editor.save(new AbortController().signal);

      await vi.waitFor(() => {
        expect(outcome).not.toBe('pending');
      });
      expect(outcome).toMatchObject({ name: 'AbortError' });
      expect(fixtureValue.viewer.annotationEditorMode).toBe(0);
      if (saving !== null)
        await expect(saving).resolves.toEqual(new Uint8Array([37, 80, 68, 70, 45]));
    }
  });

  it('waits for source-confirmed NONE before an aborted interaction settles', async () => {
    const fixtureValue = fixture({ dispatchModeChanges: false });
    const uiManager = manager();
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
          opened: new Promise<void>(() => undefined),
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
    const dirty = vi.fn();
    editor.onDirty(dirty);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });

    (editor as PdfAnnotationEditor & { notifyNativeMutation(): void }).notifyNativeMutation();

    expect(dirty).toHaveBeenCalledWith(true);
    expect(annotationStorage.resetModified).not.toHaveBeenCalled();
  });
  it('does not widen generic setTool edit options', () => {
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('editId');
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('editComment');
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('mustEnterInEditMode');
    expectTypeOf<PdfAnnotationToolOptions>().toHaveProperty('isFromKeyboard');
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

  it('does not re-arm a contextual annotation tool after autosave', async () => {
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

    expect(viewer.annotationEditorMode).toBe(0);
    expect(modeRequests).toEqual([
      { editComment: false, editId: 'highlight-1', mode: 9 },
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
  it('waits for source-confirmed NONE before saving an aborted interaction', async () => {
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
    await Promise.resolve();

    expect(fixtureValue.modeRequests).toEqual([{ mode: 9 }, { mode: 0 }]);
    expect(uiManager.endCurrentEditing).not.toHaveBeenCalled();
    expect(fixtureValue.saveDocument).not.toHaveBeenCalled();
    fixtureValue.eventBus.dispatch('annotationeditormodechanged', {
      source: fixtureValue.viewer,
      mode: 0,
    });

    await expect(saving).resolves.toEqual(new Uint8Array([37, 80, 68, 70, 45]));
    await expect(committing).resolves.toMatchObject({ name: 'AbortError' });
    expect(uiManager.endCurrentEditing).toHaveBeenCalledOnce();
    expect(fixtureValue.saveDocument).toHaveBeenCalledOnce();
  });

  it('propagates neutral mode failure before entering the save boundary', async () => {
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
    expect(uiManager.endCurrentEditing).not.toHaveBeenCalled();
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

  it('restores the selected tool when PDF.js serialization fails', async () => {
    const fixtureValue = fixture();
    fixtureValue.eventBus.dispatch('annotationeditoruimanager', {
      source: fixtureValue.viewer,
      uiManager: manager(),
    });
    await fixtureValue.editor.setTool('highlight');
    fixtureValue.saveDocument.mockRejectedValue(new Error('worker rejected save'));

    await expect(fixtureValue.editor.save(new AbortController().signal)).rejects.toThrow(
      'worker rejected save',
    );

    expect(fixtureValue.viewer.annotationEditorMode).toBe(9);
  });

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
