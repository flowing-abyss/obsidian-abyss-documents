import { describe, expect, it, vi } from 'vitest';
import {
  PdfCommentBridge,
  type PdfAnnotationFocus,
  type PdfCommentEditor,
  type PdfCommentMutationFailure,
} from './pdf-comment-bridge.js';

function editor(
  comment = '',
  options: {
    readonly anchor?: Element | null;
    readonly color?: readonly number[] | undefined;
    readonly mode?: 3 | 9 | 15;
    readonly uid?: string;
  } = {},
): PdfCommentEditor & { comment: unknown } {
  let value: unknown = comment;
  const mode = options.mode ?? 9;
  let editorType = 'highlight';
  if (mode === 3) editorType = 'freetext';
  else if (mode === 15) editorType = 'ink';
  return {
    get comment() {
      return value;
    },
    set comment(next: unknown) {
      value = next;
    },
    editorType,
    elementBeforePopup: options.anchor,
    focusCommentButton: vi.fn(),
    getData: () => ({
      annotationType: mode,
      color: 'color' in options ? options.color : [255, 212, 0],
      contentsObj: { str: typeof value === 'string' ? value : '' },
      opacity: 1,
    }),
    mode,
    propertiesToUpdate: [],
    select: vi.fn(),
    setCommentButtonStates: vi.fn(),
    uid: options.uid ?? 'editor-1',
  };
}

function uiManager(selected: PdfCommentEditor | null = null) {
  return {
    delete: vi.fn<() => void>(),
    firstSelectedEditor: selected ?? undefined,
    getEditor: vi.fn<(id: string) => PdfCommentEditor | undefined>(),
    setSelected: vi.fn<(editor: PdfCommentEditor) => void>(),
    updateParams: vi.fn<(type: number, value: unknown) => void>(),
  };
}

describe('PdfCommentBridge exact PDF.js comment-manager seam', () => {
  it('normalizes a reserved native creation without owning an annotation popover', async () => {
    const host = document.body.createDiv();
    const native = editor('Seed', { uid: 'native-highlight' });
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    const reservation = bridge.reserveNextDialog('Draft');

    await bridge.showDialog(manager, native, 20, 30);

    await expect(reservation.opened).resolves.toMatchObject({
      comment: 'Draft',
      identity: { id: 'native-highlight', kind: 'stable' },
      type: 'highlight',
    });
    await expect(reservation.closed).resolves.toBe('external');
    expect(native.comment).toBe('Draft');
    expect(host.querySelector('[data-annotation-editor-popover]')).toBeNull();
    bridge.dispose();
    host.remove();
  });

  it('emits normalized existing focus without mutating the native editor', () => {
    const host = document.body.createDiv();
    const native = editor('Inspect without mutation', { uid: 'inspect' });
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    const focused: Array<PdfAnnotationFocus | null> = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => focused.push(focus));

    bridge.toggleCommentPopup(native, true, true, true);

    expect(focused[0]).toMatchObject({
      annotations: [{ comment: 'Inspect without mutation', identity: { id: 'inspect' } }],
      editable: true,
    });
    expect(manager.setSelected).not.toHaveBeenCalled();
    expect(manager.updateParams).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('resolves public selected DOM ids and preserves batch update/delete order', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'second';
    const first = editor('First', { anchor: firstNode, uid: 'first' });
    const second = editor('Second', { anchor: secondNode, uid: 'second' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'first') return first;
      if (id === 'second') return second;
      return undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    bridge.focusFromPointer(secondNode);

    const focus = focused[0];
    expect(focus).toMatchObject({
      annotations: [
        { identity: { id: 'first', kind: 'stable' } },
        { identity: { id: 'second', kind: 'stable' } },
      ],
      editable: true,
    });
    if (focus === undefined) throw new Error('Expected a normalized multi focus.');
    expect(bridge.updateAnnotations({ annotations: focus.annotations, color: '#5fb236' })).toBe(
      true,
    );
    expect(manager.updateParams.mock.calls).toEqual([
      [31, '#5fb236'],
      [31, '#5fb236'],
    ]);
    expect(bridge.deleteAnnotations(focus.annotations)).toBe(true);
    expect(manager.setSelected.mock.calls.map(([source]) => source)).toEqual([
      first,
      second,
      first,
      second,
    ]);
    expect(manager.delete).toHaveBeenCalledTimes(2);
    bridge.dispose();
    host.remove();
  });

  it('focuses one exact native editor even when overlapping editors are already selected', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'overlap-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'overlap-second';
    const first = editor('First', { anchor: firstNode, uid: 'overlap-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'overlap-second' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'overlap-first') return first;
      return id === 'overlap-second' ? second : undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(bridge.focusAnnotation('overlap-second')).resolves.toBe(true);

    expect(manager.setSelected).toHaveBeenCalledOnce();
    expect(manager.setSelected).toHaveBeenCalledWith(second);
    expect(focused).toHaveLength(1);
    expect(focused[0]?.annotations).toHaveLength(1);
    expect(focused[0]?.annotations[0]?.identity).toEqual({
      id: 'overlap-second',
      kind: 'stable',
    });
    const missing = new AbortController();
    const missingFocus = bridge.focusAnnotation('missing', missing.signal);
    missing.abort();
    await expect(missingFocus).resolves.toBe(false);
    bridge.dispose();
    host.remove();
  });

  it('focuses one exact imported annotation through its public annotation-layer id', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationLayer' });
    const first = layer.createDiv({ cls: 'highlightAnnotation' });
    first.dataset['annotationId'] = 'imported-first';
    const second = layer.createDiv({ cls: 'highlightAnnotation' });
    second.dataset['annotationId'] = 'imported-second';
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(bridge.focusAnnotation('imported-second')).resolves.toBe(true);

    expect(focused).toHaveLength(1);
    expect(focused[0]).toMatchObject({
      annotations: [{ identity: { id: 'imported-second', kind: 'stable' } }],
      editable: false,
    });
    bridge.dispose();
    host.remove();
  });

  it('waits for far-page writable and imported layers and cancels stale focus', async () => {
    const host = document.body.createDiv();
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const annotationLayer = host.createDiv({ cls: 'annotationLayer' });
    const writableNode = createDiv();
    writableNode.className = 'highlightEditor';
    writableNode.id = 'far-writable';
    const writable = editor('Far writable', { anchor: writableNode, uid: 'far-writable' });
    const manager = uiManager(writable);
    manager.getEditor.mockImplementation((id) => (id === 'far-writable' ? writable : undefined));
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    const writableFocus = bridge.focusAnnotation('far-writable');
    editorLayer.append(writableNode);
    await Promise.resolve();
    bridge.setSidebarUiManager(manager);
    await expect(writableFocus).resolves.toBe(true);
    expect(focused[focused.length - 1]?.annotations[0]?.identity).toEqual({
      id: 'far-writable',
      kind: 'stable',
    });

    const importedFocus = bridge.focusAnnotation('far-imported');
    const imported = annotationLayer.createDiv({ cls: 'highlightAnnotation' });
    imported.dataset['annotationId'] = 'far-imported';
    await expect(importedFocus).resolves.toBe(true);
    expect(focused[focused.length - 1]?.annotations[0]?.identity).toEqual({
      id: 'far-imported',
      kind: 'stable',
    });

    const stale = new AbortController();
    const staleFocus = bridge.focusAnnotation('stale-imported', stale.signal);
    stale.abort();
    const staleImported = annotationLayer.createDiv({ cls: 'highlightAnnotation' });
    staleImported.dataset['annotationId'] = 'stale-imported';
    await expect(staleFocus).resolves.toBe(false);
    expect(focused[focused.length - 1]?.annotations[0]?.identity).not.toEqual({
      id: 'stale-imported',
      kind: 'stable',
    });
    bridge.dispose();
    host.remove();
  });

  it('degrades mixed or unsupported selections to read-only operations', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const writableNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    writableNode.id = 'writable';
    const unsupportedNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    unsupportedNode.id = 'unsupported';
    const writable = editor('Writable', { anchor: writableNode, uid: 'writable' });
    const unsupported: PdfCommentEditor = {
      comment: 'Imported',
      elementBeforePopup: unsupportedNode,
      getData: () => ({ contentsObj: { str: 'Imported' } }),
      uid: 'unsupported',
    };
    const manager = uiManager(writable);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'writable') return writable;
      return id === 'unsupported' ? unsupported : undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    bridge.focusFromPointer(writableNode);

    const focus = focused[0];
    expect(focus).toMatchObject({ editable: false });
    if (focus === undefined) throw new Error('Expected read-only focus.');
    expect(bridge.updateAnnotations({ annotations: focus.annotations, comment: 'Rejected' })).toBe(
      false,
    );
    expect(bridge.deleteAnnotations(focus.annotations)).toBe(false);
    expect(manager.setSelected).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('reports rejected native changes and retains retryable bindings', () => {
    const host = document.body.createDiv();
    const native = editor('Before', { uid: 'retry' });
    const manager = uiManager(native);
    const failures: PdfCommentMutationFailure[] = [];
    const bridge = new PdfCommentBridge(host, { onFailure: (failure) => failures.push(failure) });
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });
    bridge.toggleCommentPopup(native, true, true, true);
    const focus = focused[0];
    if (focus === undefined) throw new Error('Expected writable focus.');
    Object.defineProperty(native, 'comment', {
      configurable: true,
      get: () => 'Before',
      set: () => {
        throw new Error('setter rejected');
      },
    });

    expect(bridge.updateAnnotations({ annotations: focus.annotations, comment: 'After' })).toBe(
      false,
    );
    expect(failures[0]?.action).toBe('save-comment');
    expect(failures[0]?.cause).toMatchObject({ message: 'setter rejected' });
    bridge.dispose();
    host.remove();
  });

  it('implements the remaining PDF.js manager lifecycle idempotently', () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Existing');

    expect(bridge.makeCommentColor([255, 212, 0], 0.5)).toBe('rgb(255 212 0 / 0.5)');
    expect(() => {
      bridge.showSidebar([{ contentsObj: { str: 'Sidebar' }, id: 'side', popupRef: true }]);
      bridge.selectComment('side');
      bridge.updateComment({ contentsObj: { str: 'Updated' }, id: 'side', popupRef: true });
      bridge.removeComments(['side']);
      bridge.hideSidebar();
      bridge.addComment({ contentsObj: { str: 'Added' }, id: 'native', popupRef: true });
      bridge.toggleCommentPopup(native, false, true, false);
      bridge.updatePopupColor(native);
      bridge.destroyPopup();
      bridge.toggleCommentPopup(null);
      bridge.destroy();
    }).not.toThrow();

    bridge.dispose();
    expect(host.querySelector('[data-pdf-comment-bridge]')).toBeNull();
    host.remove();
  });
});
