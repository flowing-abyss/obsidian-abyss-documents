import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import type {
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfSelectionAction,
} from '../adapters/pdf/pdf-annotation-editor.js';
import { PdfAnnotationEditor } from '../adapters/pdf/pdf-annotation-editor.js';
import {
  PdfCommentBridge,
  type PdfAnnotationFocus,
  type PdfCommentEditor,
} from '../adapters/pdf/pdf-comment-bridge.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import { AutosaveScheduler } from '../autosave-scheduler.js';
import { asAnnotationId, type DocumentAnnotation } from '../document-core/annotations.js';
import type { AnnotationEditorPopoverRequest } from './annotation-editor-popover.js';
import {
  AnnotationInteractionController,
  type AnnotationInteractionHost,
  type QuickHighlightState,
} from './annotation-interaction-controller.js';
import { ReaderShell } from './reader-shell.js';

const palette = [
  { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
  { color: '#5fb236', meaning: 'Definition', name: 'Green' },
] as const;

function textSelection(token = 'selection-1'): PdfTextSelection {
  return {
    clientRect: { bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 },
    clientRects: [{ bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 }],
    input: 'pointer',
    pageIndex: 0,
    text: 'Selected text',
    token,
  };
}

function nativeAnnotation(comment = 'F'): DocumentAnnotation {
  const available = { available: true } as const;
  return {
    anchor: {
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 10, y: 20 } },
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
    identity: { id: asAnnotationId('created-native'), kind: 'stable' },
    links: [],
    modifiedAt: null,
    selectedText: 'Selected text',
    tags: [],
    type: 'highlight',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class IntegrationEventBus {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  on(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  off(name: string, listener: (event: unknown) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }
}

function realInteractionFixture() {
  const eventBus = new IntegrationEventBus();
  const selectionListeners = new Set<(selection: PdfTextSelection | null) => void>();
  const annotationStorage = {
    onAnnotationEditor: null as ((type: number | null) => void) | null,
    onResetModified: null as (() => void) | null,
    onSetModified: null as (() => void) | null,
  };
  const viewer = { currentMode: 0, annotationEditorMode: 0 };
  Object.defineProperty(viewer, 'annotationEditorMode', {
    configurable: true,
    get: () => viewer.currentMode,
    set: (request: { readonly mode: number }) => {
      viewer.currentMode = request.mode;
      queueMicrotask(() => {
        eventBus.dispatch('annotationeditormodechanged', { mode: request.mode, source: viewer });
      });
    },
  });
  const manager = {
    commentSelection: vi.fn(),
    delete: vi.fn(),
    disableUserSelect: vi.fn(),
    endCurrentEditing: vi.fn(),
    firstSelectedEditor: undefined,
    getEditor: vi.fn(),
    getLayer: vi.fn(),
    highlightSelection: vi.fn(() => {
      annotationStorage.onAnnotationEditor?.(9);
    }),
    redo: vi.fn(),
    undo: vi.fn(),
    updateParams: vi.fn(),
  };
  const interaction = new PdfAnnotationEditor({
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
    commentBridge: {
      beginPersistence: () => undefined,
      deleteAnnotations: () => true,
      endPersistence: () => undefined,
      focusAnnotation: async () => true,
      normalizeCreatedAnnotation: () => nativeAnnotation(''),
      onAnnotationFocus: () => () => undefined,
      reserveNextDialog: () => ({
        closed: Promise.resolve('external'),
        opened: Promise.resolve(nativeAnnotation('')),
      }),
      updateAnnotations: () => true,
    },
    eventBus,
    pdf: { annotationStorage } as unknown as PDFDocumentProxy,
    selectionObserver: {
      invalidate: vi.fn(),
      onSelection(listener: (selection: PdfTextSelection | null) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
      validate: () => 'current',
    },
    viewer,
  });
  eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager });
  const opened: AnnotationEditorPopoverRequest[] = [];
  const closeAnnotationEditor = vi.fn(() => true);
  const controller = new AnnotationInteractionController(
    interaction,
    {
      closeAnnotationEditor,
      openAnnotationEditor(request) {
        opened.push(request);
        return true;
      },
      setQuickHighlightState: vi.fn(),
    },
    palette,
  );
  return {
    closeAnnotationEditor,
    controller,
    emitSelection(selection: PdfTextSelection | null) {
      for (const listener of selectionListeners) listener(selection);
    },
    opened,
  };
}

function fixture(initialMode: PdfAnnotationLogicalMode = 'neutral') {
  const annotationFocusListeners = new Set<(value: PdfAnnotationFocus | null) => void>();
  const colorListeners = new Set<(value: string) => void>();
  let mode = initialMode;
  const modeListeners = new Set<(value: PdfAnnotationLogicalMode) => void>();
  const selectionListeners = new Set<(value: PdfTextSelection | null) => void>();
  const commitSelection = vi.fn(
    async (
      _token: string,
      _action: PdfSelectionAction,
      _signal?: AbortSignal,
    ): Promise<DocumentAnnotation | 'dismissed'> => nativeAnnotation(''),
  );
  const setQuickHighlight = vi.fn(
    async (state: { readonly enabled: boolean; readonly color: string }): Promise<void> => {
      mode = state.enabled ? 'quick-highlight' : 'neutral';
      for (const listener of modeListeners) listener(mode);
    },
  );
  const interaction: PdfAnnotationInteraction = {
    commitSelection,
    deleteAnnotations: () => true,
    focusAnnotation: vi.fn(async () => true),
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
    updateAnnotations: () => true,
  };
  const opened: AnnotationEditorPopoverRequest[] = [];
  const states: QuickHighlightState[] = [];
  const closeAnnotationEditor = vi.fn(() => true);
  const host: AnnotationInteractionHost = {
    closeAnnotationEditor,
    openAnnotationEditor: (request) => {
      opened.push(request);
      return true;
    },
    setQuickHighlightState: (state) => states.push(state),
  };
  const failures: Array<{ action: string; cause: unknown }> = [];
  const observedColors: string[] = [];
  const observedModes: PdfAnnotationLogicalMode[] = [];
  const controller = new AnnotationInteractionController(interaction, host, palette, {
    onColorChange: (color) => observedColors.push(color),
    onFailure: (action, cause) => failures.push({ action, cause }),
    onModeChange: (nextMode) => observedModes.push(nextMode),
  });
  return {
    closeAnnotationEditor,
    commitSelection,
    controller,
    emitColor(color: string) {
      for (const listener of colorListeners) listener(color);
    },
    emitAnnotationFocus(focus: PdfAnnotationFocus | null) {
      for (const listener of annotationFocusListeners) listener(focus);
    },
    emitMode(next: PdfAnnotationLogicalMode) {
      mode = next;
      for (const listener of modeListeners) listener(next);
    },
    emitSelection(selection: PdfTextSelection | null) {
      for (const listener of selectionListeners) listener(selection);
    },
    failures,
    modeListenerCount: () => modeListeners.size,
    observedColors,
    observedModes,
    opened,
    selectionListenerCount: () => selectionListeners.size,
    setQuickHighlight,
    states,
  };
}

describe('AnnotationInteractionController', () => {
  it('routes normalized native single and multi focus into the unified editor', () => {
    const test = fixture();
    const first = nativeAnnotation('First');
    const second = {
      ...nativeAnnotation('Second'),
      identity: { id: asAnnotationId('created-native-2'), kind: 'stable' as const },
    };

    test.emitAnnotationFocus({
      annotations: [first],
      editable: true,
      position: { x: 12, y: 34 },
    });
    test.emitAnnotationFocus({
      annotations: [first, second],
      editable: true,
      position: { x: 56, y: 78 },
    });

    expect(test.opened).toEqual([
      expect.objectContaining({
        position: { x: 12, y: 34 },
        target: { annotation: first, kind: 'annotation' },
      }),
      expect.objectContaining({
        position: { x: 56, y: 78 },
        target: { annotations: [first, second], kind: 'multiple' },
      }),
    ]);
    expect(test.commitSelection).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('returns a dismissed native creation outcome without closing the unified draft', async () => {
    const test = fixture();
    test.commitSelection.mockResolvedValueOnce('dismissed');
    test.emitSelection(textSelection('dismissed-selection'));
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await expect(
      request.onCreate({
        color: '#5fb236',
        comment: '',
        selection: textSelection('dismissed-selection'),
      }),
    ).resolves.toBe('dismissed');

    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    expect(test.commitSelection).toHaveBeenCalledExactlyOnceWith(
      'dismissed-selection',
      { color: '#5fb236', kind: 'highlight' },
      expect.any(AbortSignal),
    );
    test.controller.destroy();
  });

  it('passes the complete unified metadata draft to native comment creation', async () => {
    const test = fixture();
    const selection = textSelection('comment-selection');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await request.onCreate({
      color: '#5fb236',
      comment: 'Review [[Source]] #later',
      selection,
    });

    expect(test.commitSelection).toHaveBeenCalledExactlyOnceWith(
      'comment-selection',
      { color: '#5fb236', kind: 'comment', seed: 'Review [[Source]] #later' },
      expect.any(AbortSignal),
    );
    expect(test.observedColors).toEqual(['#5fb236']);
    test.controller.destroy();
  });

  it('keeps the selection editor open through its real one-shot native mode transaction', async () => {
    const test = realInteractionFixture();
    const selection = textSelection('real-one-shot');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await expect(
      request.onCreate({ color: '#ffd400', comment: '', selection }),
    ).resolves.toMatchObject({ identity: { id: 'created-native', kind: 'stable' } });

    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('hands the created native identity into the same shell editor and persists the latest draft', async () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const selectionListeners = new Set<(selection: PdfTextSelection | null) => void>();
    const modeListeners = new Set<(mode: PdfAnnotationLogicalMode) => void>();
    const created = deferred<DocumentAnnotation>();
    const updateAnnotations = vi.fn(() => true);
    const deleteAnnotations = vi.fn(() => true);
    const interaction = {
      commitSelection: () => created.promise,
      deleteAnnotations,
      onColor: () => () => undefined,
      onAnnotationFocus: () => () => undefined,
      onMode(listener: (mode: PdfAnnotationLogicalMode) => void) {
        modeListeners.add(listener);
        listener('neutral');
        return () => modeListeners.delete(listener);
      },
      onSelection(listener: (selection: PdfTextSelection | null) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
      setQuickHighlight: vi.fn(),
      updateAnnotations,
    } as unknown as PdfAnnotationInteraction;
    const controller = new AnnotationInteractionController(interaction, shell, palette);
    const selection = textSelection('created-handoff');
    for (const listener of selectionListeners) listener(selection);
    const element = host.querySelector<HTMLElement>('[data-annotation-editor-popover]');
    if (element === null) throw new Error('Expected the shell-owned selection editor.');
    const comment = element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    const tags = element.querySelector<HTMLInputElement>('[aria-label="Tags"]');
    const links = element.querySelector<HTMLInputElement>('[aria-label="Links"]');
    if (comment === null || tags === null || links === null)
      throw new Error('Expected the shell-owned selection editor.');

    comment.value = 'F';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    comment.value = 'Final draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    tags.value = '#review';
    tags.dispatchEvent(new Event('input', { bubbles: true }));
    links.value = '[[Source]]';
    links.dispatchEvent(new Event('input', { bubbles: true }));
    const annotation = nativeAnnotation();
    created.resolve(annotation);

    await vi.waitFor(() => {
      expect(element.querySelector('[data-action="delete-annotation"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-annotation-editor-popover]')).toBe(element);
    expect(element.isConnected).toBe(true);
    expect(element.hidden).toBe(false);
    expect(comment.value).toBe('Final draft');
    expect(tags.value).toBe('#review');
    expect(links.value).toBe('[[Source]]');
    expect(updateAnnotations).toHaveBeenCalledWith({
      annotations: [annotation],
      comment: 'Final draft #review [[Source]]',
    });

    element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(deleteAnnotations).toHaveBeenCalledWith([annotation]);
    controller.destroy();
    shell.destroy();
    host.remove();
  });

  it('keeps one shell editor and its native target open through autosave teardown', async () => {
    vi.useFakeTimers();
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const eventBus = new IntegrationEventBus();
    const saveGate = deferred<Uint8Array>();
    const saveDocument = vi.fn(() => saveGate.promise);
    const annotationStorage = {
      onAnnotationEditor: null as ((type: number | null) => void) | null,
      onResetModified: null as (() => void) | null,
      onSetModified: null as (() => void) | null,
    };
    const nativeModeRequests: number[] = [];
    const viewer = { currentMode: 9, annotationEditorMode: 9 };
    Object.defineProperty(viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => viewer.currentMode,
      set: (request: { readonly mode: number }) => {
        nativeModeRequests.push(request.mode);
        viewer.currentMode = request.mode;
        eventBus.dispatch('annotationeditormodechanged', { mode: request.mode, source: viewer });
      },
    });
    let commentValue = 'Before autosave';
    const setCommentButtonStates = vi.fn();
    const nativeNode = shell.documentHost
      .createDiv({ cls: 'annotationEditorLayer' })
      .createDiv({ cls: 'highlightEditor selectedEditor' });
    nativeNode.id = 'autosave-target';
    const native: PdfCommentEditor = {
      get comment() {
        return commentValue;
      },
      set comment(value: unknown) {
        commentValue = typeof value === 'string' ? value : '';
      },
      editorType: 'highlight',
      elementBeforePopup: nativeNode,
      getData: () => ({ color: [255, 212, 0], contentsObj: { str: commentValue } }),
      mode: 9,
      propertiesToUpdate: [],
      select: vi.fn(),
      setCommentButtonStates,
      uid: 'autosave-target',
    };
    const manager = {
      commentSelection: vi.fn(),
      delete: vi.fn(),
      disableUserSelect: vi.fn(),
      endCurrentEditing: vi.fn(),
      firstSelectedEditor: native,
      getEditor: vi.fn((id: string) => (id === 'autosave-target' ? native : undefined)),
      getLayer: vi.fn(),
      highlightSelection: vi.fn(),
      redo: vi.fn(),
      setSelected: vi.fn(),
      undo: vi.fn(),
      updateParams: vi.fn(),
    };
    let notifyNativeMutation = (): void => undefined;
    const bridge = new PdfCommentBridge(shell.documentHost, {
      onNativeMutation: () => {
        notifyNativeMutation();
      },
    });
    let focusedAnnotationId: string | null = null;
    const stopFocus = bridge.onAnnotationFocus((focus) => {
      const annotation = focus?.annotations[0];
      focusedAnnotationId = annotation?.identity.kind === 'stable' ? annotation.identity.id : null;
    });
    manager.endCurrentEditing.mockImplementation(() => {
      bridge.destroyPopup();
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
      annotationEditorType: { DISABLE: -1, FREETEXT: 3, HIGHLIGHT: 9, INK: 15, NONE: 0 },
      commentBridge: bridge,
      eventBus,
      pdf: { annotationStorage, saveDocument } as unknown as PDFDocumentProxy,
      selectionObserver: {
        invalidate: vi.fn(),
        onSelection: () => () => undefined,
        validate: () => 'current',
      },
      viewer,
    });
    notifyNativeMutation = () => {
      editor.notifyNativeMutation();
    };
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager });
    const controller = new AnnotationInteractionController(editor, shell, palette);
    eventBus.dispatch('annotationeditormodechanged', { mode: 9, source: viewer });
    let revision = 0;
    const scheduler = new AutosaveScheduler(async () => {
      await editor.save(new AbortController().signal);
    });
    const stopDirty = editor.onDirty((dirty) => {
      if (dirty) scheduler.markDirty(++revision);
    });
    bridge.focusFromPointer(nativeNode);
    const element = host.querySelector<HTMLElement>('[data-annotation-editor-popover]');
    if (element === null) throw new Error('Expected the shell-owned native editor.');
    const comment = element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected the shell-owned comment field.');
    comment.value = 'Still focused after autosave';
    comment.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(1_050);

    expect(saveDocument).toHaveBeenCalledOnce();
    expect(manager.endCurrentEditing).toHaveBeenCalledOnce();
    expect(nativeModeRequests).toEqual([0]);
    expect(viewer.currentMode).toBe(0);
    expect(host.querySelector('[data-annotation-editor-popover]')).toBe(element);
    expect(element.isConnected).toBe(true);
    expect(element.hidden).toBe(false);
    expect(comment.value).toBe('Still focused after autosave');
    expect(focusedAnnotationId).toBe('autosave-target');
    saveGate.resolve(new Uint8Array([37, 80, 68, 70]));
    await scheduler.flush();
    expect(nativeModeRequests).toEqual([0, 9]);
    expect(viewer.currentMode).toBe(9);
    expect(manager.setSelected).toHaveBeenCalledWith(native);
    expect(host.querySelector('[data-annotation-editor-popover]')).toBe(element);
    expect(element.isConnected).toBe(true);
    expect(element.hidden).toBe(false);
    expect(comment.value).toBe('Still focused after autosave');
    expect(focusedAnnotationId).toBe('autosave-target');
    expect(setCommentButtonStates).toHaveBeenLastCalledWith({
      hasPopup: true,
      selected: true,
    });
    expect(setCommentButtonStates).toHaveBeenCalledTimes(2);
    element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(manager.delete).toHaveBeenCalledOnce();

    stopFocus();
    stopDirty();
    scheduler.destroy();
    controller.destroy();
    editor.destroy();
    bridge.dispose();
    shell.destroy();
    host.remove();
    vi.useRealTimers();
  });

  it('opens selection UI only in neutral mode and closes it on true invalidation', () => {
    const test = fixture();
    test.emitSelection(textSelection('neutral'));
    test.emitMode('quick-highlight');
    test.emitSelection(textSelection('quick'));
    for (const reason of ['zoom', 'layout', 'navigation', 'session'] as const) {
      test.emitMode('neutral');
      test.emitSelection(textSelection(reason));
      test.controller.invalidate(reason);
    }

    expect(test.opened).toHaveLength(5);
    expect(test.closeAnnotationEditor).toHaveBeenCalled();
    test.controller.destroy();
  });

  it('arms, recolors, and disarms Quick Highlight through the native logical mode', async () => {
    const test = fixture();

    expect(test.controller.requestTool('highlight')).toBe(true);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#ffd400',
        enabled: true,
      });
    });
    expect(test.controller.selectColor('#5fb236')).toBe(true);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#5fb236',
        enabled: true,
      });
    });
    expect(test.controller.requestTool('select')).toBe(true);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#5fb236',
        enabled: false,
      });
    });

    expect(test.controller.quickHighlightArmed).toBe(false);
    test.controller.destroy();
  });

  it('keeps Ink FreeText and disabled modes owned by PDF.js', () => {
    for (const mode of ['ink', 'freetext', 'disabled'] as const) {
      const test = fixture(mode);
      test.emitSelection(textSelection(mode));
      expect(test.opened).toHaveLength(0);
      expect(test.controller.selectColor('#5fb236')).toBe(false);
      expect(test.setQuickHighlight).not.toHaveBeenCalled();
      test.controller.destroy();
    }
  });

  it('contains native creation failures while retaining the unified editor for retry', async () => {
    const test = fixture();
    const cause = new Error('native creation failed');
    test.commitSelection.mockRejectedValueOnce(cause);
    const selection = textSelection('failed-selection');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await expect(request.onCreate({ color: '#ffd400', comment: '', selection })).rejects.toBe(
      cause,
    );

    expect(test.failures).toEqual([{ action: 'create selection annotation', cause }]);
    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('synchronizes native colors and palette changes without stale snap-back', async () => {
    const test = fixture('quick-highlight');
    test.emitColor('#ff6666');
    test.controller.updatePalette([{ color: '#e56eee', meaning: 'Question', name: 'Magenta' }]);

    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#ff6666',
        enabled: true,
      });
    });
    expect(test.controller.color).toBe('#ff6666');
    expect(test.observedColors).toEqual(['#ff6666']);
    test.controller.destroy();
  });

  it('releases native listeners once and rejects closed requests', () => {
    const test = fixture();
    expect(test.modeListenerCount()).toBe(1);
    expect(test.selectionListenerCount()).toBe(1);

    test.controller.destroy();
    test.controller.destroy();

    expect(test.controller.requestTool('highlight')).toBe(false);
    expect(test.controller.selectColor('#5fb236')).toBe(false);
    expect(test.modeListenerCount()).toBe(0);
    expect(test.selectionListenerCount()).toBe(0);
  });
});
