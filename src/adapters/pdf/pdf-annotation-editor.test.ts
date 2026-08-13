import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { PdfAnnotationEditor, type PdfAnnotationToolOptions } from './pdf-annotation-editor.js';

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
  onResetModified: (() => void) | null;
  onSetModified: (() => void) | null;
  resetModified: ReturnType<typeof vi.fn<() => void>>;
  readonly serializable?: never;
}

function storage(): MutableAnnotationStorage {
  const value: MutableAnnotationStorage = {
    onResetModified: null,
    onSetModified: null,
    resetModified: vi.fn(),
  };
  Object.defineProperty(value, 'serializable', {
    configurable: false,
    get: () => {
      throw new Error('AnnotationStorage.serializable must stay private to PDF.js.');
    },
  });
  return value;
}

function manager() {
  return {
    delete: vi.fn(),
    endCurrentEditing: vi.fn(),
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
    annotationEditorType: { FREETEXT: 3, HIGHLIGHT: 9, INK: 15, NONE: 0 },
    eventBus,
    pdf,
    viewer,
  });
  return {
    annotationStorage,
    changedModes,
    editor,
    eventBus,
    modeRequests,
    pdf,
    saveDocument,
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
  it('signals a successful native comment mutation without writing parallel annotation state', () => {
    const { annotationStorage, editor, eventBus, viewer } = fixture();
    const dirty = vi.fn();
    editor.onDirty(dirty);
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });

    (editor as PdfAnnotationEditor & { notifyNativeMutation(): void }).notifyNativeMutation();

    expect(dirty).toHaveBeenCalledWith(true);
    expect(annotationStorage.resetModified).not.toHaveBeenCalled();
  });
  it('does not expose target-edit options in the public tool contract', () => {
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('editId');
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('editComment');
    expectTypeOf<PdfAnnotationToolOptions>().not.toHaveProperty('mustEnterInEditMode');
    expectTypeOf<PdfAnnotationToolOptions>().toHaveProperty('isFromKeyboard');
  });

  it.each([
    ['Underline', 'readonly-underline'],
    ['Text Note', 'readonly-text-note'],
  ])('does not forward an untyped %s target through setTool', async (_type, editId) => {
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
    for (const [parameter, value] of parameters) editor.setParameter(parameter, value);
    editor.undo();
    editor.redo();
    editor.deleteSelection();

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
    expect(eventBus.listeners.get('annotationeditormodechanged')).toBeUndefined();
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
    expect(eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(0);
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
    expect(eventBus.listeners.get('annotationeditormodechanged')).toHaveLength(0);
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
    const previousSet = vi.fn();
    const previousReset = vi.fn();
    annotationStorage.onSetModified = previousSet;
    annotationStorage.onResetModified = previousReset;
    const dirty = vi.fn();
    const unsubscribe = editor.onDirty(dirty);

    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    annotationStorage.onSetModified();
    annotationStorage.onResetModified();
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager() });
    annotationStorage.onSetModified();
    editor.destroy();

    expect(previousSet).toHaveBeenCalledTimes(2);
    expect(previousReset).toHaveBeenCalledOnce();
    expect(dirty.mock.calls).toEqual([[true], [false], [true]]);
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

  it('ends the current edit, calls saveDocument once, and copies returned bytes', async () => {
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
    expect(saved).not.toBe(upstream);
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
