import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { AutosaveScheduler } from '../../autosave-scheduler.js';
import { asAnnotationId, type DocumentAnnotation } from '../../document-core/annotations.js';
import type { AnnotationEditorPopoverRequest } from '../../reader/annotation-editor-popover.js';
import { AnnotationInteractionController } from '../../reader/annotation-interaction-controller.js';
import { ReaderShell } from '../../reader/reader-shell.js';
import { PdfAnnotationEditor } from './pdf-annotation-editor.js';
import { PdfCommentBridge, type PdfCommentEditor } from './pdf-comment-bridge.js';
import type { PdfTextSelection } from './pdf-selection-observer.js';

const palette = [
  { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
  { color: '#5fb236', meaning: 'Definition', name: 'Green' },
] as const;

function textSelection(token: string): PdfTextSelection {
  return {
    clientRect: { bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 },
    clientRects: [{ bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 }],
    input: 'pointer',
    pageIndex: 0,
    text: 'Selected text',
    token,
  };
}

function nativeAnnotation(comment = '', id = 'created-native'): DocumentAnnotation {
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
    identity: { id: asAnnotationId(id), kind: 'stable' },
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

function oneShotFixture() {
  const eventBus = new IntegrationEventBus();
  const selectionListeners = new Set<(selection: PdfTextSelection | null) => void>();
  let materialized = false;
  let selectionLive = true;
  let viewHidden = false;
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
      if (!selectionLive) return;
      const capturedBeforeNavigation = !viewHidden;
      selectionLive = false;
      viewer.annotationEditorMode = { mode: 9 } as never;
      queueMicrotask(() => {
        if (!capturedBeforeNavigation) return;
        materialized = true;
        annotationStorage.onAnnotationEditor?.(9);
        annotationStorage.onSetModified?.();
      });
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
      nativeEditorIds: () => new Set<string>(),
      normalizeCreatedAnnotation: () => nativeAnnotation(),
      normalizeSelectionHighlight: () => (materialized ? nativeAnnotation() : null),
      onAnnotationFocus: () => () => undefined,
      reserveNextDialog: () => ({
        closed: Promise.resolve('external'),
        opened: Promise.resolve(nativeAnnotation()),
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
      validate: () => (selectionLive ? 'current' : 'stale'),
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
      flushAnnotationEditor: async () => true,
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
      selectionLive = selection !== null;
      for (const listener of selectionListeners) listener(selection);
    },
    hideViewAndInvalidateSelection() {
      viewHidden = true;
      selectionLive = false;
    },
    manager,
    opened,
  };
}

describe('PDF annotation interaction integration', () => {
  it('keeps the selection editor open through its real one-shot native mode transaction', async () => {
    const test = oneShotFixture();
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

  it('captures selection geometry before immediate navigation hides the PDF view', async () => {
    const test = oneShotFixture();
    const selection = textSelection('immediate-navigation');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    const creating = request.onCreate({ color: '#ffd400', comment: '', selection });
    const capturedInCreationStack = test.manager.highlightSelection.mock.calls.length === 1;
    test.hideViewAndInvalidateSelection();

    await expect(creating).resolves.toMatchObject({
      identity: { id: 'created-native', kind: 'stable' },
    });
    expect(capturedInCreationStack).toBe(true);
    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('publishes only editable focus while PDF.js materializes a persisted highlight', async () => {
    const host = document.body.createDiv();
    const annotationLayer = host.createDiv({ cls: 'annotationLayer' });
    const imported = annotationLayer.createDiv({ cls: 'highlightAnnotation' });
    imported.dataset['annotationId'] = 'persisted-highlight';
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const eventBus = new IntegrationEventBus();
    const annotationStorage = {
      onAnnotationEditor: null as ((type: number | null) => void) | null,
      onResetModified: null as (() => void) | null,
      onSetModified: null as (() => void) | null,
    };
    const manager = {
      commentSelection: vi.fn(),
      delete: vi.fn(),
      disableUserSelect: vi.fn(),
      endCurrentEditing: vi.fn(),
      firstSelectedEditor: undefined as PdfCommentEditor | undefined,
      getEditor: vi.fn<(id: string) => PdfCommentEditor | undefined>(),
      getLayer: vi.fn(),
      highlightSelection: vi.fn(),
      redo: vi.fn(),
      setSelected: vi.fn(),
      undo: vi.fn(),
      updateParams: vi.fn(),
    };
    const activationOrder: string[] = [];
    const viewer = { currentMode: 0, annotationEditorMode: 0 };
    const bridge = new PdfCommentBridge(host);
    Object.defineProperty(viewer, 'annotationEditorMode', {
      configurable: true,
      get: () => viewer.currentMode,
      set: (request: { readonly editId?: string; readonly mode: number }) => {
        viewer.currentMode = request.mode;
        if (request.editId === 'persisted-highlight') {
          const node = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
          node.id = 'runtime-highlight';
          vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(
            DOMRect.fromRect({ height: 28, width: 160, x: 80, y: 120 }),
          );
          const native: PdfCommentEditor = {
            comment: '',
            editorType: 'highlight',
            elementBeforePopup: node,
            getData: () => ({ id: 'persisted-highlight' }),
            mode: 9,
            propertiesToUpdate: [],
            select: vi.fn(),
            uid: 'persisted-highlight',
          };
          manager.firstSelectedEditor = native;
          manager.getEditor.mockImplementation((id) =>
            id === 'runtime-highlight' ? native : undefined,
          );
          bridge.toggleCommentPopup(native, true, true, false);
          window.setTimeout(() => {
            activationOrder.push('pdfjs-focus');
          }, 0);
        }
        queueMicrotask(() => {
          eventBus.dispatch('annotationeditormodechanged', { mode: request.mode, source: viewer });
          eventBus.dispatch('editingstateschanged', {
            details: { hasSelectedEditor: manager.firstSelectedEditor !== undefined },
            source: manager,
          });
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
      annotationEditorType: { DISABLE: -1, FREETEXT: 3, HIGHLIGHT: 9, INK: 15, NONE: 0 },
      commentBridge: bridge,
      eventBus,
      pdf: { annotationStorage, numPages: 1 } as unknown as PDFDocumentProxy,
      selectionObserver: {
        invalidate: vi.fn(),
        onSelection: () => () => undefined,
        validate: () => 'current',
      },
      viewer,
    });
    eventBus.dispatch('annotationeditoruimanager', { source: viewer, uiManager: manager });
    const annotation = nativeAnnotation('', 'persisted-highlight');
    editor.setAnnotationProjection([{ annotation, stableId: 'persisted-highlight' }]);
    const focusKinds: boolean[] = [];
    editor.onAnnotationFocus((focus) => {
      if (focus !== null) {
        activationOrder.push('bridge-focus');
        focusKinds.push(focus.editable);
      }
    });

    await expect(
      editor.focusAnnotation('persisted-highlight', { kind: 'root-click' }),
    ).resolves.toBe('editable');

    expect(focusKinds).toEqual([true]);
    expect(activationOrder).toEqual(['pdfjs-focus', 'bridge-focus']);
    expect(manager.setSelected).not.toHaveBeenCalled();
    expect(imported.isConnected).toBe(true);
    editor.destroy();
    bridge.dispose();
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
    vi.spyOn(nativeNode, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ height: 28, width: 160, x: 80, y: 120 }),
    );
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
    await editor.editAnnotation({
      editComment: false,
      id: 'autosave-target',
      kind: 'highlight',
    });
    expect(editor.hasContextualEdit).toBe(true);
    let revision = 0;
    const scheduler = new AutosaveScheduler(async () => {
      await editor.save(new AbortController().signal);
    });
    const stopDirty = editor.onDirty((dirty) => {
      if (dirty) scheduler.markDirty(++revision);
    });
    bridge.focusFromPointer(nativeNode);
    await vi.advanceTimersByTimeAsync(0);
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
    expect(editor.hasContextualEdit).toBe(true);
    expect(manager.setSelected).toHaveBeenCalledWith(native);
    expect(host.querySelector('[data-annotation-editor-popover]')).toBe(element);
    expect(element.isConnected).toBe(true);
    expect(element.hidden).toBe(false);
    expect(comment.value).toBe('Still focused after autosave');
    expect(focusedAnnotationId).toBe('autosave-target');
    expect(setCommentButtonStates).toHaveBeenLastCalledWith({ hasPopup: true, selected: true });
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
});
