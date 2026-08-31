import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asAnnotationId, type DocumentAnnotation } from '../../document-core/annotations.js';
import {
  PdfCommentBridge,
  type PdfAnnotationFocus,
  type PdfCommentEditor,
  type PdfCommentMutationFailure,
} from './pdf-comment-bridge.js';
import { PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE } from './pdf-runtime.js';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ height: 20, width: 100, x: 10, y: 20 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function editor(
  comment = '',
  options: {
    readonly annotationElementId?: string | null;
    readonly anchor?: Element | null;
    readonly color?: readonly number[] | undefined;
    readonly dataId?: string | undefined;
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
    annotationElementId: options.annotationElementId ?? null,
    color: '#ffd400',
    get comment() {
      return value;
    },
    set comment(next: unknown) {
      value = next;
    },
    editorType,
    elementBeforePopup: options.anchor === undefined ? document.body : options.anchor,
    focusCommentButton: vi.fn(),
    getData: () => ({
      annotationType: mode,
      color: 'color' in options ? options.color : [255, 212, 0],
      contentsObj: { str: typeof value === 'string' ? value : '' },
      ...('dataId' in options ? { id: options.dataId } : {}),
      opacity: 1,
    }),
    getNonHCMColor: () => [255, 212, 0],
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
    toggleSelected: vi.fn<(editor: PdfCommentEditor) => void>(),
    updateParams: vi.fn<(type: number, value: unknown) => void>(),
  };
}

function annotation(id: string, writable = true): DocumentAnnotation {
  const unavailable = {
    available: false as const,
    reason: { code: 'document-read-only' as const, message: 'Locked.' },
  };
  const capability = writable ? ({ available: true } as const) : unavailable;
  return {
    anchor: {
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 0, y: 0 } },
      kind: 'fixed-page',
      pageIndex: 0,
    },
    author: '',
    capabilities: {
      color: capability,
      comment: capability,
      conversions: { highlight: capability, underline: capability },
      deletion: capability,
      geometry: capability,
      metadata: capability,
    },
    color: '#ffd400',
    comment: '',
    createdAt: null,
    identity: { id: asAnnotationId(id), kind: 'stable' },
    links: [],
    modifiedAt: null,
    selectedText: null,
    tags: [],
    type: 'highlight',
  };
}

describe('PdfCommentBridge exact PDF.js comment-manager seam', () => {
  it('uses the native annotation color instead of popup color in forced colors mode', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor' });
    node.id = 'forced-colors-editor';
    const native = {
      annotationElementId: '363R',
      color: '#ffffff',
      comment: null,
      editorType: 'highlight',
      getData: () => ({
        color: [1, 2, 3],
        contentsObj: { str: '' },
        id: '363R',
      }),
      getNonHCMColor: () => [255, 212, 0] as const,
      mode: 9,
      propertiesToUpdate: [],
      select: vi.fn(),
      uid: 'forced-colors-editor',
    } satisfies PdfCommentEditor;
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);

    expect(bridge.normalizeCreatedAnnotation(manager)).toMatchObject({
      color: '#ffd400',
      comment: '',
      identity: { id: '363R', kind: 'stable' },
    });

    bridge.dispose();
    host.remove();
  });

  it('adopts the new highlight with a null comment without reading incomplete PDF.js data', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor' });
    node.id = 'pdfjs_internal_editor_3';
    const getData = vi.fn(() => {
      throw new TypeError("Cannot destructure property 'text' of 'this.comment' as it is null.");
    });
    const native = {
      annotationElementId: null,
      color: '#ffd400',
      comment: null,
      editorType: 'highlight',
      getData,
      getNonHCMColor: vi.fn(() => [255, 212, 0] as const),
      mode: 9,
      propertiesToUpdate: [],
      select: vi.fn(),
      uid: 'pdfjs_internal_editor_3',
    } satisfies PdfCommentEditor & {
      readonly color: string;
      getNonHCMColor(): readonly number[];
    };
    const manager = uiManager();
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);

    const result = bridge.normalizeSelectionHighlight(manager, new Set());

    expect(getData).not.toHaveBeenCalled();
    expect(manager.setSelected).toHaveBeenCalledExactlyOnceWith(native);
    expect(result).toMatchObject({
      color: '#ffd400',
      capabilities: { deletion: { available: true } },
      comment: '',
      identity: { id: 'pdfjs_internal_editor_3', kind: 'stable' },
    });
    bridge.dispose();
    host.remove();
  });

  it.each([
    ['#5FB236', '#5fb236'],
    ['yellow', null],
  ] as const)(
    'falls back to the public editor color %s when PDF.js exposes no non-HCM accessor',
    (publicColor, expectedColor) => {
      const host = document.body.createDiv();
      const layer = host.createDiv({ cls: 'annotationEditorLayer' });
      const node = layer.createDiv({ cls: 'highlightEditor' });
      node.id = 'public-color-editor';
      const getData = vi.fn(() => {
        throw new Error('Incomplete selection data must not be read.');
      });
      const native = {
        annotationElementId: null,
        color: publicColor,
        comment: { text: 'Public comment' },
        editorType: 'highlight',
        getData,
        mode: 9,
        propertiesToUpdate: [],
        select: vi.fn(),
        uid: 'public-color-editor',
      } satisfies PdfCommentEditor;
      const manager = uiManager();
      manager.getEditor.mockReturnValue(native);
      const bridge = new PdfCommentBridge(host);

      const result = bridge.normalizeSelectionHighlight(manager, new Set());

      expect(getData).not.toHaveBeenCalled();
      if (expectedColor === null) {
        expect(result).toBeNull();
        expect(manager.setSelected).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ color: expectedColor, comment: 'Public comment' });
        expect(manager.setSelected).toHaveBeenCalledExactlyOnceWith(native);
      }
      bridge.dispose();
      host.remove();
    },
  );

  it('ignores a persisted highlight mounted during repeated selection before adopting the new one', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const persistedNode = layer.createDiv({ cls: 'highlightEditor' });
    persistedNode.id = 'pdfjs_internal_editor_0';
    const persisted = editor('', {
      annotationElementId: '7R',
      uid: '7R',
    });
    const created = editor('', { uid: 'pdfjs_internal_editor_1' });
    const manager = uiManager();
    manager.getEditor.mockImplementation((id) => {
      if (id === 'pdfjs_internal_editor_0') return persisted;
      return id === 'pdfjs_internal_editor_1' ? created : undefined;
    });
    const bridge = new PdfCommentBridge(host);

    expect(bridge.normalizeSelectionHighlight(manager, new Set())).toBeNull();

    const createdNode = layer.createDiv({ cls: 'highlightEditor' });
    createdNode.id = 'pdfjs_internal_editor_1';
    expect(bridge.normalizeSelectionHighlight(manager, new Set())).toMatchObject({
      identity: { id: 'pdfjs_internal_editor_1', kind: 'stable' },
      type: 'highlight',
    });
    expect(manager.setSelected).toHaveBeenCalledExactlyOnceWith(created);
    bridge.dispose();
    host.remove();
  });

  it('normalizes the new unselected native editor without adopting an older highlight', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const oldNode = layer.createDiv({ cls: 'highlightEditor' });
    oldNode.id = 'pdfjs_internal_editor_old';
    const oldEditor = editor('Old', { uid: 'old-highlight' });
    const manager = uiManager(oldEditor);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'pdfjs_internal_editor_old') return oldEditor;
      return id === 'new-highlight' ? newEditor : undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const existingIds = bridge.nativeEditorIds(manager);
    const newNode = layer.createDiv({ cls: 'highlightEditor' });
    newNode.id = 'new-highlight';
    const newEditor = editor('New', { uid: 'new-highlight' });

    expect(bridge.normalizeSelectionHighlight(manager, existingIds)).toMatchObject({
      comment: 'New',
      identity: { id: 'new-highlight', kind: 'stable' },
    });

    bridge.dispose();
    host.remove();
  });

  it('excludes an unmounted previously selected editor from a new selection highlight', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const oldEditor = editor('Old', { uid: 'old-unmounted-highlight' });
    const newEditor = editor('New', { uid: 'new-mounted-highlight' });
    const manager = uiManager(oldEditor);
    manager.getEditor.mockImplementation((id) =>
      id === 'new-mounted-highlight' ? newEditor : undefined,
    );
    const bridge = new PdfCommentBridge(host);
    const existingIds = bridge.nativeEditorIds(manager);
    const newNode = layer.createDiv({ cls: 'highlightEditor' });
    newNode.id = 'new-mounted-highlight';

    expect(existingIds).toContain('old-unmounted-highlight');
    expect(bridge.normalizeSelectionHighlight(manager, existingIds)).toMatchObject({
      comment: 'New',
      identity: { id: 'new-mounted-highlight', kind: 'stable' },
    });

    bridge.dispose();
    host.remove();
  });

  it('enumerates selected and mounted PDF.js runtime aliases while ignoring empty DOM ids', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const blank = layer.createDiv({ cls: 'highlightEditor' });
    blank.setAttribute('id', '');
    const mounted = layer.createDiv({ cls: 'highlightEditor' });
    mounted.id = 'pdfjs-dom-id';
    const selected = editor('Selected', { uid: 'selected-runtime' });
    const resolved = editor('Mounted', { uid: 'resolved-runtime' });
    const manager = uiManager(selected);
    manager.getEditor.mockImplementation((id) => (id === 'pdfjs-dom-id' ? resolved : undefined));
    const bridge = new PdfCommentBridge(host);

    expect(bridge.nativeEditorIds(manager)).toEqual(
      new Set(['selected-runtime', 'pdfjs-dom-id', 'resolved-runtime']),
    );

    bridge.dispose();
    host.remove();
  });

  it('waits when more than one new highlight is present after the reservation baseline', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor' });
    firstNode.id = 'new-highlight-1';
    const secondNode = layer.createDiv({ cls: 'highlightEditor' });
    secondNode.id = 'new-highlight-2';
    const first = editor('First', { uid: 'new-highlight-1' });
    const second = editor('Second', { uid: 'new-highlight-2' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'new-highlight-1') return first;
      if (id === 'new-highlight-2') return second;
      return undefined;
    });
    const bridge = new PdfCommentBridge(host);

    expect(bridge.normalizeSelectionHighlight(manager, new Set())).toBeNull();

    bridge.dispose();
    host.remove();
  });

  it('adopts a generic native editor only when the unselected PDF.js candidate is unique', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor' });
    firstNode.id = 'generic-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor' });
    secondNode.id = 'generic-second';
    const first = editor('First generic', { uid: 'generic-first' });
    const second = editor('Second generic', { uid: 'generic-second' });
    const manager = uiManager();
    manager.getEditor.mockImplementation((id) => {
      if (id === 'generic-first') return first;
      return id === 'generic-second' ? second : undefined;
    });
    const bridge = new PdfCommentBridge(host);

    expect(bridge.normalizeCreatedAnnotation(manager)).toBeNull();
    secondNode.remove();
    expect(bridge.normalizeCreatedAnnotation(manager)).toMatchObject({
      comment: 'First generic',
      identity: { id: 'generic-first', kind: 'stable' },
      type: 'highlight',
    });

    bridge.dispose();
    host.remove();
  });

  it('uses the selected highlight fallback when an older PDF.js manager has no editor lookup', () => {
    const host = document.body.createDiv();
    const selected = editor('Selected fallback', { uid: 'selected-fallback' });
    const manager = uiManager(selected);
    Reflect.deleteProperty(manager, 'getEditor');
    const bridge = new PdfCommentBridge(host);

    expect(bridge.normalizeSelectionHighlight(manager)).toMatchObject({
      comment: 'Selected fallback',
      identity: { id: 'selected-fallback', kind: 'stable' },
      type: 'highlight',
    });

    bridge.dispose();
    host.remove();
  });

  it('refuses an unsupported selected editor instead of guessing a mounted writable candidate', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const supportedNode = layer.createDiv({ cls: 'highlightEditor' });
    supportedNode.id = 'mounted-supported';
    const supported = editor('Mounted supported', { uid: 'mounted-supported' });
    const unsupported: PdfCommentEditor = {
      comment: 'Unsupported selected',
      getData: () => ({ contentsObj: { str: 'Unsupported selected' } }),
      uid: 'unsupported-selected',
    };
    const manager = uiManager(unsupported);
    manager.getEditor.mockImplementation((id) =>
      id === 'mounted-supported' ? supported : undefined,
    );
    const bridge = new PdfCommentBridge(host);

    expect(bridge.normalizeCreatedAnnotation(manager)).toBeNull();

    bridge.dispose();
    host.remove();
  });

  it.each([
    ['Ink', 15],
    ['FreeText', 3],
  ] as const)(
    'keeps a new %s editor generic but excludes it from selection highlight adoption',
    (_name, mode) => {
      const host = document.body.createDiv();
      const layer = host.createDiv({ cls: 'annotationEditorLayer' });
      const node = layer.createDiv({ cls: mode === 15 ? 'inkEditor' : 'freeTextEditor' });
      node.id = 'new-non-highlight';
      const native = editor('Different tool', { mode, uid: 'new-non-highlight' });
      const manager = uiManager(native);
      manager.getEditor.mockReturnValue(native);
      const bridge = new PdfCommentBridge(host);

      expect(bridge.normalizeCreatedAnnotation(manager)).toMatchObject({
        identity: { id: 'new-non-highlight', kind: 'stable' },
        type: mode === 15 ? 'ink' : 'free-text',
      });
      expect(bridge.normalizeSelectionHighlight(manager, new Set())).toBeNull();

      bridge.dispose();
      host.remove();
    },
  );

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

  it('supersedes and aborts stale dialog reservations without writing their drafts', async () => {
    const host = document.body.createDiv();
    const native = editor('Original', { uid: 'reserved-highlight' });
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    const superseded = bridge.reserveNextDialog('Superseded draft');
    const active = bridge.reserveNextDialog('Active draft');

    await expect(superseded.opened).rejects.toMatchObject({ name: 'AbortError' });
    await expect(superseded.closed).rejects.toMatchObject({ name: 'AbortError' });
    await bridge.showDialog(manager, native, 20, 30);
    await expect(active.opened).resolves.toMatchObject({ comment: 'Active draft' });
    expect(native.comment).toBe('Active draft');

    const abort = new AbortController();
    const aborted = bridge.reserveNextDialog('Aborted draft', abort.signal);
    abort.abort(new DOMException('Reader closed.', 'AbortError'));
    await expect(aborted.opened).rejects.toMatchObject({ name: 'AbortError' });
    await expect(aborted.closed).rejects.toMatchObject({ name: 'AbortError' });
    await bridge.showDialog(manager, native, 20, 30);
    expect(native.comment).toBe('Active draft');

    bridge.dispose();
    host.remove();
  });

  it('settles an already-aborted dialog reservation without arming a stale timeout', async () => {
    vi.useFakeTimers();
    const host = document.body.createDiv();
    const abort = new AbortController();
    const reason = { message: 'Reader changed selection.', name: 'AbortError' };
    abort.abort(reason);
    const bridge = new PdfCommentBridge(host);
    try {
      const reservation = bridge.reserveNextDialog('Never write this draft', abort.signal);

      await expect(reservation.opened).rejects.toBe(reason);
      await expect(reservation.closed).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      bridge.dispose();
      host.remove();
      vi.useRealTimers();
    }
  });

  it('expires an unclaimed dialog reservation without leaving a pending lifecycle timer', async () => {
    vi.useFakeTimers();
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    try {
      const reservation = bridge.reserveNextDialog('Timed-out draft');
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(reservation.opened).rejects.toMatchObject({ name: 'TimeoutError' });
      await expect(reservation.closed).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      bridge.dispose();
      host.remove();
      vi.useRealTimers();
    }
  });

  it('rejects a reserved draft when PDF.js presents an unsupported native editor', async () => {
    const host = document.body.createDiv();
    const native: PdfCommentEditor & { comment: string } = {
      comment: 'Locked native comment',
      getData: () => ({ contentsObj: { str: 'Locked native comment' } }),
      uid: 'unsupported-reservation',
    };
    const manager = uiManager(native);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bridge = new PdfCommentBridge(host);
    const reservation = bridge.reserveNextDialog('Draft that must not persist');

    await bridge.showDialog(manager, native, 20, 30);

    await expect(reservation.opened).rejects.toThrow('could not be persisted');
    await expect(reservation.closed).rejects.toThrow('could not be persisted');
    expect(native.comment).toBe('Locked native comment');
    log.mockRestore();
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

  it('publishes a native PDF.js dialog without a reservation as an existing editable focus', async () => {
    const host = document.body.createDiv();
    const native = editor('Existing native comment', { uid: 'unreserved-dialog' });
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    const focused: Array<PdfAnnotationFocus | null> = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => focused.push(focus));

    await bridge.showDialog(manager, native, 101, 202);

    expect(focused).toEqual([
      expect.objectContaining({
        annotations: [expect.objectContaining({ comment: 'Existing native comment' })],
        editable: true,
        position: { x: 101, y: 202 },
      }),
    ]);
    expect(native.comment).toBe('Existing native comment');
    expect(manager.setSelected).not.toHaveBeenCalled();

    bridge.dispose();
    host.remove();
  });

  it('retains a selected FreeText binding across PDF.js edit-mode hover hides', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'freeTextEditor selectedEditor' });
    node.id = 'selected-freetext';
    const native = editor('Edit me', { anchor: node, mode: 3, uid: 'selected-freetext' });
    const manager = uiManager(native);
    manager.getEditor.mockImplementation((id) => (id === 'selected-freetext' ? native : undefined));
    const bridge = new PdfCommentBridge(host);
    const focused: Array<PdfAnnotationFocus | null> = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => focused.push(focus));
    bridge.toggleCommentPopup(native, true, true, true);
    const annotation = focused[0]?.annotations[0];
    if (annotation === undefined) throw new Error('Expected selected FreeText focus.');

    for (let index = 0; index < 5; index += 1)
      bridge.toggleCommentPopup(native, false, false, true);
    await Promise.resolve();

    expect(focused).toHaveLength(1);
    expect(bridge.updateAnnotations({ annotations: [annotation], color: '#5fb236' })).toBe(true);
    expect(manager.updateParams).toHaveBeenCalled();
    node.removeClass('selectedEditor');
    bridge.destroyPopup();
    expect(focused).toHaveLength(2);
    expect(focused[1]).toBeNull();
    bridge.dispose();
    host.remove();
  });

  it.each([
    ['Highlight', 9, 'highlight', PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE.HIGHLIGHT_COLOR],
    ['Ink', 15, 'ink', PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE.INK_COLOR],
    ['FreeText', 3, 'freetext', PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE.FREETEXT_COLOR],
  ] as const)(
    'maps the native %s color update to its PDF.js parameter',
    (_label, mode, _type, parameter) => {
      const host = document.body.createDiv();
      const native = editor('Recolor me', { mode, uid: `color-${String(mode)}` });
      const manager = uiManager(native);
      const bridge = new PdfCommentBridge(host);
      const focused: PdfAnnotationFocus[] = [];
      bridge.setSidebarUiManager(manager);
      bridge.onAnnotationFocus((next) => {
        if (next !== null) focused.push(next);
      });
      bridge.toggleCommentPopup(native, true, true, true);
      const annotation = focused[0]?.annotations[0];
      if (annotation === undefined) throw new Error('Expected a writable native focus.');

      expect(bridge.updateAnnotations({ annotations: [annotation], color: '#5fb236' })).toBe(true);
      expect(manager.updateParams).toHaveBeenCalledExactlyOnceWith(parameter, '#5fb236');

      bridge.dispose();
      host.remove();
    },
  );

  it('deletes exactly one bound annotation through the native manager and reports its mutation', () => {
    const host = document.body.createDiv();
    const native = editor('Delete only this', { uid: 'single-delete' });
    const manager = uiManager(native);
    const mutations = vi.fn();
    const bridge = new PdfCommentBridge(host, { onNativeMutation: mutations });
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });
    bridge.toggleCommentPopup(native, true, true, true);
    const annotation = focused[0]?.annotations[0];
    if (annotation === undefined) throw new Error('Expected a bound annotation.');

    expect(bridge.deleteAnnotations([annotation])).toBe(true);
    expect(manager.setSelected).toHaveBeenCalledExactlyOnceWith(native);
    expect(manager.delete).toHaveBeenCalledOnce();
    expect(mutations).toHaveBeenCalledOnce();

    bridge.dispose();
    host.remove();
  });

  it('disables batch recolor before a failure in the second native editor can leave partial state', () => {
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
    let selected: PdfCommentEditor | undefined;
    manager.setSelected.mockImplementation((next) => {
      selected = next;
    });
    manager.updateParams.mockImplementation(() => {
      if (selected === second) throw new Error('second recolor rejected');
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    bridge.focusFromPointer(secondNode, true);

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
      false,
    );
    expect(manager.setSelected).not.toHaveBeenCalled();
    expect(manager.updateParams).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('keeps an ordinary selected-editor focus isolated from stale PDF.js peers', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'preserved-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'preserved-second';
    const first = editor('First', { anchor: firstNode, uid: 'preserved-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'preserved-second' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'preserved-first') return first;
      if (id === 'preserved-second') return second;
      return undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(
      bridge.focusAnnotation('preserved-second', undefined, undefined, {
        editableOnly: true,
        preserveSelection: true,
      }),
    ).resolves.toBe(true);

    expect(focused[0]?.annotations.map((annotation) => annotation.identity)).toEqual([
      { id: 'preserved-second', kind: 'stable' },
    ]);
    expect(manager.setSelected).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('publishes selected peers only for an explicit modified multi-selection', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'explicit-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'explicit-second';
    const first = editor('First', { anchor: firstNode, uid: 'explicit-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'explicit-second' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'explicit-first') return first;
      return id === 'explicit-second' ? second : undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(
      bridge.focusAnnotation('explicit-second', undefined, undefined, {
        editableOnly: true,
        includeSelectedPeers: true,
        preserveSelection: true,
      }),
    ).resolves.toBe(true);

    expect(focused[0]?.annotations.map((annotation) => annotation.identity)).toEqual([
      { id: 'explicit-first', kind: 'stable' },
      { id: 'explicit-second', kind: 'stable' },
    ]);
    bridge.dispose();
    host.remove();
  });

  it('restores the exact selected native batch after persistence neutralizes PDF.js', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'persisted-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'persisted-second';
    const first = editor('First', { anchor: firstNode, uid: 'persisted-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'persisted-second' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'persisted-first') return first;
      if (id === 'persisted-second') return second;
      return undefined;
    });
    manager.setSelected.mockImplementation((selected) => {
      firstNode.toggleClass('selectedEditor', selected === first);
      secondNode.toggleClass('selectedEditor', selected === second);
    });
    manager.toggleSelected.mockImplementation((selected) => {
      selected.elementBeforePopup?.toggleClass('selectedEditor', true);
    });
    const bridge = new PdfCommentBridge(host);
    const focused: Array<PdfAnnotationFocus | null> = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => focused.push(focus));
    await expect(
      bridge.focusAnnotation('persisted-second', undefined, undefined, {
        editableOnly: true,
        includeSelectedPeers: true,
        preserveSelection: true,
      }),
    ).resolves.toBe(true);

    bridge.beginPersistence();
    bridge.beginPersistence();
    firstNode.removeClass('selectedEditor');
    secondNode.removeClass('selectedEditor');
    bridge.destroyPopup();
    bridge.endPersistence();

    expect(manager.setSelected).not.toHaveBeenCalled();
    expect(manager.toggleSelected).not.toHaveBeenCalled();
    bridge.endPersistence();

    expect(manager.setSelected).toHaveBeenCalledOnce();
    expect(manager.setSelected).toHaveBeenCalledWith(first);
    expect(manager.toggleSelected).toHaveBeenCalledOnce();
    expect(manager.toggleSelected).toHaveBeenCalledWith(second);
    expect(firstNode.hasClass('selectedEditor')).toBe(true);
    expect(secondNode.hasClass('selectedEditor')).toBe(true);
    expect(focused).toHaveLength(1);
    expect(focused[0]?.annotations.map((annotation) => annotation.identity)).toEqual([
      { id: 'persisted-first', kind: 'stable' },
      { id: 'persisted-second', kind: 'stable' },
    ]);
    bridge.dispose();
    host.remove();
  });

  it('does not restore only part of a native batch when PDF.js cannot toggle peers', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'incomplete-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'incomplete-second';
    const first = editor('First', { anchor: firstNode, uid: 'incomplete-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'incomplete-second' });
    const manager = uiManager(first);
    Reflect.deleteProperty(manager, 'toggleSelected');
    manager.getEditor.mockImplementation((id) => {
      if (id === 'incomplete-first') return first;
      return id === 'incomplete-second' ? second : undefined;
    });
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);
    await expect(
      bridge.focusAnnotation('incomplete-second', undefined, undefined, {
        editableOnly: true,
        includeSelectedPeers: true,
        preserveSelection: true,
      }),
    ).resolves.toBe(true);

    bridge.beginPersistence();
    firstNode.removeClass('selectedEditor');
    secondNode.removeClass('selectedEditor');
    bridge.destroyPopup();
    bridge.endPersistence();

    expect(manager.setSelected).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();

    bridge.dispose();
    host.remove();
  });

  it('observes PDF.js settled native selection and disconnects the observer on dispose', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'settled-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor' });
    secondNode.id = 'settled-second';
    const first = editor('First', { anchor: firstNode, uid: 'settled-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'settled-second' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'settled-first') return first;
      if (id === 'settled-second') return second;
      return undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });
    bridge.focusFromPointer(firstNode, true);

    secondNode.addClass('selectedEditor');
    await vi.waitFor(() => {
      expect(focused[focused.length - 1]?.annotations).toHaveLength(2);
    });

    expect(focused[focused.length - 1]).toMatchObject({
      annotations: [
        { identity: { id: 'settled-first', kind: 'stable' } },
        { identity: { id: 'settled-second', kind: 'stable' } },
      ],
      editable: true,
    });
    bridge.dispose();
    expect(
      (bridge as unknown as { selectionObserver: MutationObserver | null }).selectionObserver,
    ).toBeNull();
    host.remove();
  });

  it('focuses selected FreeText when PDF.js has no comment data', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'freeTextEditor selectedEditor' });
    node.id = 'pdfjs_internal_editor_0';
    const native: PdfCommentEditor = {
      annotationElementId: '30R',
      comment: 'Persisted FreeText',
      editorType: 'freetext',
      elementBeforePopup: node,
      getData: () => {
        throw new TypeError("Cannot read properties of null (reading 'text')");
      },
      mode: 3,
      propertiesToUpdate: [],
      select: vi.fn(),
      uid: 'pdfjs_internal_editor_0',
    };
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);

    const focused = bridge.focusAnnotation('30R', undefined, undefined, {
      editableOnly: true,
      preserveSelection: true,
    });

    await expect(focused).resolves.toBe(true);
    bridge.dispose();
    host.remove();
  });

  it('focuses a selected runtime editor while publishing its stable projected identity', async () => {
    vi.useFakeTimers();
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    node.id = 'pdfjs_internal_editor_0';
    const native = editor('Persisted comment', {
      anchor: node,
      uid: 'pdfjs_internal_editor_0',
    });
    const manager = uiManager(native);
    manager.getEditor.mockImplementation((id) =>
      id === 'pdfjs_internal_editor_0' ? native : undefined,
    );
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => {
      if (focus !== null) focused.push(focus);
    });

    const result = bridge.focusAnnotation('29R', undefined, annotation('29R'), {
      editableOnly: true,
      preserveSelection: true,
      ...({ editorUid: 'pdfjs_internal_editor_0' } as Record<string, string>),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const value = await result;
    vi.useRealTimers();

    expect(value).toBe(true);
    expect(focused[0]?.annotations[0]?.identity).toEqual({ id: '29R', kind: 'stable' });
    bridge.dispose();
    host.remove();
  });

  it('skips stale selected DOM candidates before preserving the exact ready native selection', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    layer.createDiv({ cls: 'highlightEditor' }).id = 'not-selected';
    const blank = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    blank.setAttribute('id', '');
    const missing = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    missing.id = 'missing-editor';
    const foreignNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    foreignNode.id = 'foreign-editor';
    const targetNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    targetNode.id = 'target-editor';
    const foreign = editor('Foreign', { anchor: foreignNode, uid: 'foreign-editor' });
    const target = editor('Target', { anchor: targetNode, uid: 'target-editor' });
    const manager = uiManager(target);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'foreign-editor') return foreign;
      return id === 'target-editor' ? target : undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(
      bridge.focusAnnotation('target-editor', undefined, undefined, {
        editableOnly: true,
        preserveSelection: true,
      }),
    ).resolves.toBe(true);

    expect(focused[0]?.editable).toBe(true);
    expect(focused[0]?.annotations.map((annotation) => annotation.identity)).toContainEqual({
      id: 'target-editor',
      kind: 'stable',
    });
    expect(manager.setSelected).not.toHaveBeenCalled();

    bridge.dispose();
    host.remove();
  });

  it('rejects an unsupported mounted native editor immediately for editable-only focus', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor' });
    node.id = 'unsupported-native';
    const native: PdfCommentEditor = {
      comment: 'Unsupported native shape',
      getData: () => ({
        id: 'unsupported-native',
        contentsObj: { str: 'Unsupported native shape' },
      }),
      mode: 9,
      uid: 'unsupported-native',
    };
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);

    await expect(
      bridge.focusAnnotation('unsupported-native', undefined, undefined, { editableOnly: true }),
    ).resolves.toBe(false);
    expect(manager.setSelected).not.toHaveBeenCalled();

    bridge.dispose();
    host.remove();
  });

  it('disables batch comment updates before a failure in the second editor can leave partial state', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'comment-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'comment-second';
    const first = editor('First', { anchor: firstNode, uid: 'comment-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'comment-second' });
    Object.defineProperty(second, 'comment', {
      configurable: true,
      get: () => 'Second',
      set: () => {
        throw new Error('second comment rejected');
      },
    });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'comment-first') return first;
      if (id === 'comment-second') return second;
      return undefined;
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    bridge.focusFromPointer(secondNode, true);

    const focus = focused[0];
    if (focus === undefined) throw new Error('Expected a normalized multi focus.');
    expect(bridge.updateAnnotations({ annotations: focus.annotations, comment: 'After' })).toBe(
      false,
    );
    expect(first.comment).toBe('First');
    expect(second.comment).toBe('Second');
    bridge.dispose();
    host.remove();
  });

  it('disables batch deletion before a failure in the second editor can leave partial state', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const firstNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    firstNode.id = 'delete-first';
    const secondNode = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    secondNode.id = 'delete-second';
    const first = editor('First', { anchor: firstNode, uid: 'delete-first' });
    const second = editor('Second', { anchor: secondNode, uid: 'delete-second' });
    const manager = uiManager(first);
    manager.getEditor.mockImplementation((id) => {
      if (id === 'delete-first') return first;
      if (id === 'delete-second') return second;
      return undefined;
    });
    let selected: PdfCommentEditor | undefined;
    const deleted: PdfCommentEditor[] = [];
    manager.setSelected.mockImplementation((next) => {
      selected = next;
    });
    manager.delete.mockImplementation(() => {
      if (selected === second) throw new Error('second deletion rejected');
      if (selected !== undefined) deleted.push(selected);
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    bridge.focusFromPointer(secondNode, true);

    const focus = focused[0];
    if (focus === undefined) throw new Error('Expected a normalized multi focus.');
    expect(bridge.deleteAnnotations(focus.annotations)).toBe(false);
    expect(deleted).toEqual([]);
    expect(manager.setSelected).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
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

    expect(bridge.nativeEditorUidForAnnotation('overlap-second')).toBe('overlap-second');
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

  it('selects a mounted native editor synchronously for contextual activation retries', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor' });
    node.id = 'pdfjs_internal_editor_12';
    const native = editor('Retry target', {
      anchor: node,
      annotationElementId: '412R',
      uid: '412R',
    });
    const manager = uiManager();
    manager.getEditor.mockImplementation((id) => (id === node.id ? native : undefined));
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);

    expect(bridge.selectAnnotation('')).toBe(false);
    expect(bridge.selectAnnotation('412R')).toBe(true);
    expect(manager.setSelected).toHaveBeenCalledExactlyOnceWith(native);

    bridge.dispose();
    expect(bridge.selectAnnotation('412R')).toBe(false);
    host.remove();
  });

  it('re-resolves a replaced native annotation anchor without selecting the PDF.js editor', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const first = layer.createDiv({ cls: 'highlightEditor' });
    first.id = 'pdfjs_internal_editor_12';
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ height: 20, width: 80, x: 100, y: 120 }),
    );
    const native = editor('Anchor', {
      annotationElementId: '412R',
      uid: '412R',
    });
    const manager = uiManager();
    manager.getEditor.mockImplementation((id) => (id === first.id ? native : undefined));
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);

    expect(bridge.resolveAnnotationAnchor('412R', first.id)).toEqual(
      DOMRect.fromRect({ height: 20, width: 80, x: 100, y: 120 }),
    );
    first.remove();
    const replacement = layer.createDiv({ cls: 'highlightEditor' });
    replacement.id = 'pdfjs_internal_editor_12';
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ height: 24, width: 96, x: 180, y: 240 }),
    );

    expect(bridge.resolveAnnotationAnchor('412R', replacement.id)).toEqual(
      DOMRect.fromRect({ height: 24, width: 96, x: 180, y: 240 }),
    );
    expect(bridge.synchronizeAnnotationSelection('412R', replacement.id)).toBe(true);
    expect(replacement.dataset['abyssAnnotationSelected']).toBe('true');
    expect(manager.setSelected).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('uses a fresh sidebar anchor when the writable native anchor is unavailable', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor' });
    node.id = 'sidebar-anchor-fallback';
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect());
    const native = editor('Fallback', { anchor: null, uid: node.id });
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => {
      if (focus !== null) focused.push(focus);
    });

    await expect(
      bridge.focusAnnotation(node.id, undefined, undefined, {
        clientPosition: { x: 72, y: 288 },
      }),
    ).resolves.toBe(true);

    expect(focused).toHaveLength(1);
    expect(focused[0]?.position).toEqual({ x: 72, y: 288 });
    bridge.dispose();
    host.remove();
  });

  it('prefers a connected native anchor over the sidebar anchor', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor' });
    node.id = 'native-anchor-wins';
    const anchor = layer.createDiv();
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ height: 40, width: 120, x: 140, y: 210 }),
    );
    const native = editor('Native', { anchor, uid: node.id });
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => {
      if (focus !== null) focused.push(focus);
    });

    await expect(
      bridge.focusAnnotation(node.id, undefined, undefined, {
        clientPosition: { x: 72, y: 288 },
      }),
    ).resolves.toBe(true);

    expect(focused[0]?.position).toEqual({ x: 140, y: 250 });
    bridge.dispose();
    host.remove();
  });

  it('does not emit a native annotation focus at zero when neither anchor exists', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor' });
    node.id = 'missing-native-anchor';
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect());
    const native = editor('Missing', { anchor: null, uid: node.id });
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => {
      if (focus !== null) focused.push(focus);
    });

    await expect(bridge.focusAnnotation(node.id)).resolves.toBe(false);

    expect(focused).toEqual([]);
    bridge.dispose();
    host.remove();
  });

  it('resolves a writable editor by native uid when its mounted DOM id is internal', async () => {
    const host = document.body.createDiv();
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const nativeNode = editorLayer.createDiv({ cls: 'highlightEditor' });
    nativeNode.id = 'pdfjs_internal_editor_0';
    const annotationLayer = host.createDiv({ cls: 'annotationLayer' });
    const importedNode = annotationLayer.createDiv({ cls: 'highlightAnnotation' });
    importedNode.dataset['annotationId'] = '29R';
    const native = editor('Writable', {
      anchor: nativeNode,
      dataId: '29R',
      uid: 'pdfjs_internal_editor_0',
    });
    const manager = uiManager(native);
    manager.getEditor.mockImplementation((id) =>
      id === 'pdfjs_internal_editor_0' ? native : undefined,
    );
    const stableData = native.getData();
    manager.setSelected.mockImplementation(() => {
      native.getData = () => ({ ...stableData, id: 'pdfjs_internal_editor_0' });
    });
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(bridge.focusAnnotation('29R')).resolves.toBe(true);

    expect(manager.setSelected).toHaveBeenCalledOnce();
    expect(manager.setSelected).toHaveBeenCalledWith(native);
    expect(focused).toHaveLength(1);
    expect(focused[0]).toMatchObject({
      annotations: [{ identity: { id: '29R', kind: 'stable' } }],
      editable: true,
    });
    bridge.toggleCommentPopup(native, true, true, true);
    expect(focused[1]).toMatchObject({
      annotations: [{ identity: { id: '29R', kind: 'stable' } }],
      editable: true,
    });
    const annotation = focused[0]?.annotations[0];
    if (annotation === undefined) throw new Error('Expected one exact writable annotation.');
    expect(bridge.updateAnnotations({ annotations: [annotation], comment: 'Updated' })).toBe(true);
    expect(native.comment).toBe('Updated');
    bridge.dispose();
    host.remove();
  });

  it('forces an authoritative locked projection read-only despite a supported native editor', async () => {
    const host = document.body.createDiv();
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const nativeNode = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
    nativeNode.id = 'pdfjs_internal_locked';
    const native = editor('Native writable shape', {
      anchor: nativeNode,
      dataId: 'locked-highlight',
      uid: 'pdfjs_internal_locked',
    });
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });
    const locked = annotation('locked-highlight', false);
    const options = { forceReadonly: true } as Parameters<
      PdfCommentBridge['focusAnnotation']
    >[3] & { readonly forceReadonly: boolean };

    await expect(
      bridge.focusAnnotation('locked-highlight', undefined, locked, options),
    ).resolves.toBe(true);

    expect(focused).toHaveLength(1);
    expect(focused[0]).toMatchObject({
      annotations: [{ identity: { id: 'locked-highlight', kind: 'stable' } }],
      editable: false,
    });
    expect(manager.setSelected).not.toHaveBeenCalled();
    const normalized = focused[0]?.annotations[0];
    if (normalized === undefined) throw new Error('Expected one locked annotation focus.');
    expect(bridge.updateAnnotations({ annotations: [normalized], color: '#5fb236' })).toBe(false);
    expect(bridge.deleteAnnotations([normalized])).toBe(false);
    bridge.dispose();
    host.remove();
  });

  it.each([
    ['Underline', 'underlineAnnotation', 'underline', 'Underline annotations are read-only.'],
    ['Text Note', 'textAnnotation', 'text-note', 'Text Note annotations are read-only.'],
  ] as const)(
    'keeps a native %s subtype read-only even though its editor implementation is supported',
    async (_label, subtype, type, reason) => {
      const host = document.body.createDiv();
      const layer = host.createDiv({ cls: 'annotationEditorLayer' });
      const node = layer.createDiv({ cls: `highlightEditor selectedEditor ${subtype}` });
      node.id = `locked-${subtype}`;
      const native = editor('Locked native metadata', { anchor: node, uid: node.id });
      const manager = uiManager(native);
      manager.getEditor.mockReturnValue(native);
      const bridge = new PdfCommentBridge(host);
      const focused: PdfAnnotationFocus[] = [];
      bridge.setSidebarUiManager(manager);
      bridge.onAnnotationFocus((focus) => {
        if (focus !== null) focused.push(focus);
      });

      await expect(
        bridge.focusAnnotation(node.id, undefined, undefined, { forceReadonly: true }),
      ).resolves.toBe(true);

      expect(focused[0]).toMatchObject({
        annotations: [
          {
            capabilities: { comment: { available: false, reason: { message: reason } } },
            type,
          },
        ],
        editable: false,
      });
      expect(manager.setSelected).not.toHaveBeenCalled();

      bridge.dispose();
      host.remove();
    },
  );

  it('keeps an already-selected native editor read-only when preserving an authoritative selection', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationEditorLayer' });
    const node = layer.createDiv({ cls: 'highlightEditor selectedEditor' });
    node.id = 'preserved-locked-native';
    const native = editor('Preserved locked', { anchor: node, uid: node.id });
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => {
      if (focus !== null) focused.push(focus);
    });

    await expect(
      bridge.focusAnnotation(node.id, undefined, undefined, {
        forceReadonly: true,
        preserveSelection: true,
      }),
    ).resolves.toBe(true);

    expect(focused[0]).toMatchObject({
      annotations: [{ identity: { id: node.id, kind: 'stable' } }],
      editable: false,
    });
    expect(manager.setSelected).not.toHaveBeenCalled();

    bridge.dispose();
    host.remove();
  });

  it('clears the stable writable binding when readonly focus resolves a replacement editor', async () => {
    const host = document.body.createDiv();
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const oldNode = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
    oldNode.id = 'old-runtime-editor';
    const oldEditor = editor('Old writable editor', {
      anchor: oldNode,
      dataId: 'replacement-highlight',
      uid: 'old-runtime-editor',
    });
    const oldManager = uiManager(oldEditor);
    oldManager.getEditor.mockImplementation((id) =>
      id === 'old-runtime-editor' ? oldEditor : undefined,
    );
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(oldManager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });
    await expect(bridge.focusAnnotation('replacement-highlight')).resolves.toBe(true);
    oldManager.setSelected.mockClear();

    oldNode.remove();
    const replacementNode = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
    replacementNode.id = 'new-runtime-editor';
    const replacementEditor = editor('Replacement editor', {
      anchor: replacementNode,
      dataId: 'replacement-highlight',
      uid: 'new-runtime-editor',
    });
    const replacementManager = uiManager(replacementEditor);
    replacementManager.getEditor.mockImplementation((id) =>
      id === 'new-runtime-editor' ? replacementEditor : undefined,
    );
    bridge.setSidebarUiManager(replacementManager);

    await expect(
      bridge.focusAnnotation(
        'replacement-highlight',
        undefined,
        annotation('replacement-highlight', false),
        { forceReadonly: true },
      ),
    ).resolves.toBe(true);

    const readonly = focused[focused.length - 1]?.annotations[0];
    if (readonly === undefined) throw new Error('Expected replacement read-only focus.');
    expect(bridge.updateAnnotations({ annotations: [readonly], comment: 'Must not write' })).toBe(
      false,
    );
    expect(bridge.deleteAnnotations([readonly])).toBe(false);
    expect(oldEditor.comment).toBe('Old writable editor');
    expect(oldManager.setSelected).not.toHaveBeenCalled();
    expect(oldManager.updateParams).not.toHaveBeenCalled();
    expect(oldManager.delete).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('rebinds a stable annotation to its mounted replacement editor after PDF.js rerenders', async () => {
    const host = document.body.createDiv();
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const oldNode = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
    oldNode.id = 'pdfjs_internal_editor_1';
    const oldEditor = editor('Old editor', {
      anchor: oldNode,
      annotationElementId: '370R',
      uid: oldNode.id,
    });
    const oldManager = uiManager(oldEditor);
    oldManager.getEditor.mockImplementation((id) => (id === oldNode.id ? oldEditor : undefined));
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(oldManager);
    await expect(bridge.focusAnnotation('370R')).resolves.toBe(true);
    expect(bridge.nativeEditorUidForAnnotation('370R')).toBe(oldNode.id);

    oldNode.remove();
    const newNode = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
    newNode.id = 'pdfjs_internal_editor_4';
    const newEditor = editor('New editor', {
      anchor: newNode,
      annotationElementId: '370R',
      uid: newNode.id,
    });
    const newManager = uiManager(newEditor);
    newManager.getEditor.mockImplementation((id) => (id === newNode.id ? newEditor : undefined));
    bridge.setSidebarUiManager(newManager);

    expect(bridge.nativeEditorUidForAnnotation('370R')).toBe(newNode.id);
    expect(bridge.updateAnnotations({ annotations: [annotation('370R')], color: '#5fb236' })).toBe(
      true,
    );
    expect(newManager.setSelected).toHaveBeenCalledExactlyOnceWith(newEditor);
    expect(newManager.updateParams).toHaveBeenCalledExactlyOnceWith(
      PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE.HIGHLIGHT_COLOR,
      '#5fb236',
    );
    expect(oldManager.updateParams).not.toHaveBeenCalled();

    bridge.dispose();
    host.remove();
  });

  it('clears the stable writable binding when authoritative readonly focus is imported', async () => {
    const host = document.body.createDiv();
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const oldNode = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
    oldNode.id = 'old-imported-runtime';
    const oldEditor = editor('Old imported predecessor', {
      anchor: oldNode,
      dataId: 'imported-readonly-highlight',
      uid: 'old-imported-runtime',
    });
    const oldManager = uiManager(oldEditor);
    oldManager.getEditor.mockImplementation((id) =>
      id === 'old-imported-runtime' ? oldEditor : undefined,
    );
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(oldManager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });
    await expect(bridge.focusAnnotation('imported-readonly-highlight')).resolves.toBe(true);
    oldManager.setSelected.mockClear();

    editorLayer.remove();
    const annotationLayer = host.createDiv({ cls: 'annotationLayer' });
    const imported = annotationLayer.createDiv({ cls: 'highlightAnnotation' });
    imported.dataset['annotationId'] = 'imported-readonly-highlight';
    bridge.setSidebarUiManager(uiManager());

    await expect(
      bridge.focusAnnotation(
        'imported-readonly-highlight',
        undefined,
        annotation('imported-readonly-highlight', false),
        { forceReadonly: true },
      ),
    ).resolves.toBe(true);

    const readonly = focused[focused.length - 1]?.annotations[0];
    if (readonly === undefined) throw new Error('Expected imported read-only focus.');
    expect(bridge.updateAnnotations({ annotations: [readonly], comment: 'Must not write' })).toBe(
      false,
    );
    expect(bridge.deleteAnnotations([readonly])).toBe(false);
    expect(oldEditor.comment).toBe('Old imported predecessor');
    expect(oldManager.setSelected).not.toHaveBeenCalled();
    expect(oldManager.updateParams).not.toHaveBeenCalled();
    expect(oldManager.delete).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('clears request-scoped readonly state when the authoritative projection becomes writable', async () => {
    const host = document.body.createDiv();
    const editorLayer = host.createDiv({ cls: 'annotationEditorLayer' });
    const nativeNode = editorLayer.createDiv({ cls: 'highlightEditor selectedEditor' });
    nativeNode.id = 'pdfjs_internal_upgrade';
    const native = editor('Writable after projection refresh', {
      anchor: nativeNode,
      dataId: 'upgraded-highlight',
      uid: 'pdfjs_internal_upgrade',
    });
    const manager = uiManager(native);
    manager.getEditor.mockReturnValue(native);
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(
      bridge.focusAnnotation(
        'upgraded-highlight',
        undefined,
        annotation('upgraded-highlight', false),
        {
          forceReadonly: true,
        },
      ),
    ).resolves.toBe(true);
    await expect(
      bridge.focusAnnotation('upgraded-highlight', undefined, annotation('upgraded-highlight'), {
        editableOnly: true,
        preserveSelection: true,
      }),
    ).resolves.toBe(true);

    const upgraded = focused[focused.length - 1];
    expect(focused.map((focus) => focus.editable)).toEqual([false, true]);
    expect(upgraded).toMatchObject({
      annotations: [{ identity: { id: 'upgraded-highlight', kind: 'stable' } }],
      editable: true,
    });
    const writable = upgraded?.annotations[0];
    if (writable === undefined) throw new Error('Expected one upgraded writable annotation.');
    expect(bridge.updateAnnotations({ annotations: [writable], comment: 'Updated' })).toBe(true);
    expect(native.comment).toBe('Updated');
    expect(bridge.deleteAnnotations([writable])).toBe(true);
    expect(manager.delete).toHaveBeenCalledOnce();
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

  it('refuses an editable-only imported target but opens the same exact target as forced read-only', async () => {
    vi.useFakeTimers();
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationLayer' });
    const imported = layer.createDiv({ cls: 'highlightAnnotation' });
    imported.dataset['annotationId'] = 'locked-import';
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    try {
      const refused = bridge.focusAnnotation('locked-import', undefined, undefined, {
        editableOnly: true,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(refused).resolves.toBe(false);
      await expect(
        bridge.focusAnnotation('locked-import', undefined, undefined, {
          editableOnly: true,
          forceReadonly: true,
        }),
      ).resolves.toBe(true);

      expect(focused).toHaveLength(1);
      expect(focused[0]).toMatchObject({
        annotations: [{ identity: { id: 'locked-import', kind: 'stable' } }],
        editable: false,
      });
    } finally {
      bridge.dispose();
      host.remove();
      vi.useRealTimers();
    }
  });

  it('keeps imported Underline and Text Note focus typed, paged, and read-only', async () => {
    const host = document.body.createDiv();
    const page = host.createDiv();
    page.dataset['pageNumber'] = '6';
    const layer = page.createDiv({ cls: 'annotationLayer' });
    const underline = layer.createDiv({ cls: 'underlineAnnotation', text: 'Underlined phrase' });
    underline.dataset['annotationId'] = 'imported-underline';
    underline.dataset['comment'] = 'Underline comment';
    const textNote = layer.createDiv({ cls: 'textAnnotation', text: 'Text Note marker' });
    textNote.dataset['annotationId'] = 'imported-text-note';
    textNote.dataset['comment'] = 'Text Note comment';
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });
    await expect(bridge.focusAnnotation('imported-underline')).resolves.toBe(true);
    await expect(bridge.focusAnnotation('imported-text-note')).resolves.toBe(true);

    expect(focused.map((focus) => focus.editable)).toEqual([false, false]);
    expect(focused.map((focus) => focus.annotations[0])).toMatchObject([
      {
        anchor: { pageIndex: 5 },
        comment: 'Underline comment',
        identity: { id: 'imported-underline', kind: 'stable' },
        selectedText: 'Underlined phrase',
        type: 'underline',
      },
      {
        anchor: { pageIndex: 5 },
        comment: 'Text Note comment',
        identity: { id: 'imported-text-note', kind: 'stable' },
        selectedText: 'Text Note marker',
        type: 'text-note',
      },
    ]);
    expect(
      focused.every((focus) => focus.annotations[0]?.capabilities.comment.available === false),
    ).toBe(true);

    bridge.dispose();
    host.remove();
  });

  it.each([
    ['Ink', 'inkAnnotation', 'ink'],
    ['FreeText', 'freeTextAnnotation', 'free-text'],
  ] as const)(
    'types imported %s annotations without assigning writable native controls',
    async (_label, cls, type) => {
      const host = document.body.createDiv();
      const layer = host.createDiv({ cls: 'annotationLayer' });
      const imported = layer.createDiv({ cls, text: `${_label} content` });
      imported.dataset['annotationId'] = `imported-${type}`;
      const bridge = new PdfCommentBridge(host);
      const focused: PdfAnnotationFocus[] = [];
      bridge.onAnnotationFocus((focus) => {
        if (focus !== null) focused.push(focus);
      });

      await expect(bridge.focusAnnotation(`imported-${type}`)).resolves.toBe(true);

      expect(focused[0]).toMatchObject({
        annotations: [{ type, capabilities: { color: { available: false } } }],
        editable: false,
      });

      bridge.dispose();
      host.remove();
    },
  );

  it('preserves projected metadata when an unsupported imported annotation has no native values', async () => {
    const host = document.body.createDiv();
    const page = host.createDiv();
    page.dataset['pageNumber'] = 'not-a-page';
    const layer = page.createDiv({ cls: 'annotationLayer' });
    const imported = layer.createDiv({ cls: 'stampAnnotation' });
    imported.dataset['annotationId'] = 'projected-unsupported';
    const projected: DocumentAnnotation = {
      ...annotation('projected-unsupported', false),
      anchor: {
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 42, y: 24 } },
        kind: 'fixed-page',
        pageIndex: 7,
      },
      color: '#5fb236',
      comment: 'Projected comment',
      links: ['Notes/Source.md'],
      selectedText: 'Projected selection',
      tags: ['Projection'],
      type: 'highlight',
    };
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(
      bridge.focusAnnotation('projected-unsupported', undefined, projected),
    ).resolves.toBe(true);

    expect(focused[0]).toMatchObject({
      annotations: [
        {
          anchor: projected.anchor,
          color: '#5fb236',
          comment: 'Projected comment',
          externalType: 'stampAnnotation',
          links: ['Notes/Source.md'],
          selectedText: 'Projected selection',
          tags: ['Projection'],
          type: 'highlight',
        },
      ],
      editable: false,
    });

    bridge.dispose();
    host.remove();
  });

  it('retains extracted metadata when sidebar focus resolves an imported annotation layer', async () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationLayer' });
    const imported = layer.createDiv({ cls: 'highlightAnnotation' });
    imported.id = 'pdfjs_internal_id_imported-metadata';
    imported.dataset['annotationId'] = 'imported-metadata';
    const unavailable = {
      available: false as const,
      reason: { code: 'unsupported-annotation' as const, message: 'Read-only' },
    };
    const projected = {
      anchor: {
        coordinateSpace: 'page-points-top-left' as const,
        geometry: { kind: 'point' as const, point: { x: 12, y: 24 } },
        kind: 'fixed-page' as const,
        pageIndex: 0,
      },
      author: 'Fixture author',
      capabilities: {
        color: unavailable,
        comment: unavailable,
        conversions: { highlight: unavailable, underline: unavailable },
        deletion: unavailable,
        geometry: unavailable,
        metadata: unavailable,
      },
      color: '#ffd400',
      comment: 'Annotation 00001',
      createdAt: null,
      identity: { id: asAnnotationId('imported-metadata'), kind: 'stable' as const },
      links: ['Topic 1'],
      modifiedAt: null,
      selectedText: 'Selected fixture text',
      tags: ['topic-1'],
      type: 'highlight' as const,
    } satisfies DocumentAnnotation;
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    await expect(bridge.focusAnnotation('imported-metadata', undefined, projected)).resolves.toBe(
      true,
    );

    expect(focused).toHaveLength(1);
    expect(focused[0]).toMatchObject({
      annotations: [
        {
          author: 'Fixture author',
          comment: 'Annotation 00001',
          identity: { id: 'imported-metadata', kind: 'stable' },
          links: ['Topic 1'],
          selectedText: 'Selected fixture text',
          tags: ['topic-1'],
        },
      ],
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

  it('bounds missing-editor readiness scans and cleans observation on abort', async () => {
    vi.useFakeTimers();
    const host = document.body.createDiv();
    const query = vi.spyOn(host, 'querySelectorAll');
    const bridge = new PdfCommentBridge(host);
    const abort = new AbortController();
    try {
      const focus = bridge.focusAnnotation('never-mounted', abort.signal);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(query.mock.calls.length).toBeLessThanOrEqual(2);
      abort.abort(new DOMException('Superseded readiness.', 'AbortError'));
      await expect(focus).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      const callsAfterAbort = query.mock.calls.length;
      host.createDiv({ cls: 'annotationEditorLayer' });
      await Promise.resolve();
      expect(query).toHaveBeenCalledTimes(callsAfterAbort);
    } finally {
      bridge.dispose();
      host.remove();
      vi.useRealTimers();
    }
  });

  it('rejects blank, aborted, and disposed focus requests before scanning PDF.js DOM', async () => {
    const host = document.body.createDiv();
    const query = vi.spyOn(host, 'querySelectorAll');
    const abort = new AbortController();
    abort.abort(new DOMException('Superseded request.', 'AbortError'));
    const bridge = new PdfCommentBridge(host);

    await expect(bridge.focusAnnotation('   ')).resolves.toBe(false);
    await expect(bridge.focusAnnotation('ignored-after-abort', abort.signal)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();

    bridge.dispose();
    await expect(bridge.focusAnnotation('ignored-after-dispose')).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
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

    bridge.focusFromPointer(writableNode, true);

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

  it('ignores interactive and detached pointer targets while keeping imported annotation clicks read-only', () => {
    const host = document.body.createDiv();
    const layer = host.createDiv({ cls: 'annotationLayer' });
    const imported = layer.createDiv({ cls: 'highlightAnnotation', text: 'Imported passage' });
    imported.dataset['annotationId'] = 'pointer-imported';
    const link = imported.createEl('a', { text: 'Open linked note' });
    const detached = host.createDiv({ cls: 'highlightEditor' });
    detached.id = 'not-in-pdfjs-layer';
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.onAnnotationFocus((next) => {
      if (next !== null) focused.push(next);
    });

    bridge.focusFromPointer(link);
    bridge.focusFromPointer(detached);
    expect(focused).toEqual([]);

    bridge.focusFromPointer(imported);
    expect(focused).toEqual([
      expect.objectContaining({
        annotations: [
          expect.objectContaining({ identity: { id: 'pointer-imported', kind: 'stable' } }),
        ],
        editable: false,
      }),
    ]);

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

  it('does not clear focused state while a native mutation is notifying the reader', () => {
    const host = document.body.createDiv();
    const native = editor('Before native mutation', { uid: 'mutation-guard' });
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host, {
      onNativeMutation: () => {
        bridge.destroyPopup();
      },
    });
    const focused: Array<PdfAnnotationFocus | null> = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => focused.push(focus));
    bridge.toggleCommentPopup(native, true, true, true);
    const annotation = focused[0]?.annotations[0];
    if (annotation === undefined) throw new Error('Expected focused native annotation.');

    expect(bridge.updateAnnotations({ annotations: [annotation], comment: 'Saved mutation' })).toBe(
      true,
    );
    expect(native.comment).toBe('Saved mutation');
    expect(focused).toHaveLength(1);
    expect(focused[0]).not.toBeNull();

    bridge.dispose();
    host.remove();
  });

  it('refreshes only the current native popup after PDF.js changes its displayed state', () => {
    const host = document.body.createDiv();
    const native = editor('Original popup', { uid: 'current-popup' });
    const other = editor('Other popup', { uid: 'other-popup' });
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    const focused: PdfAnnotationFocus[] = [];
    bridge.setSidebarUiManager(manager);
    bridge.onAnnotationFocus((focus) => {
      if (focus !== null) focused.push(focus);
    });
    bridge.toggleCommentPopup(native, true, true, true);

    native.comment = 'Updated by PDF.js';
    bridge.updatePopupColor(other);
    expect(focused).toHaveLength(1);
    bridge.updatePopupColor(native);

    expect(focused).toHaveLength(2);
    expect(focused[1]?.annotations[0]?.comment).toBe('Updated by PDF.js');

    bridge.dispose();
    host.remove();
  });

  it('implements the remaining PDF.js manager lifecycle idempotently', () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Existing');

    expect(bridge.makeCommentColor([255, 212, 0], 0.5)).toBe('rgb(255 212 0 / 0.5)');
    expect(bridge.makeCommentColor(null)).toBeNull();
    expect(bridge.makeCommentColor([255, 212])).toBeNull();
    expect(bridge.makeCommentColor([-2, 256, 3.6], 2)).toBe('rgb(0 255 4 / 1)');
    expect(bridge.makeCommentColor([10, 20, 30], -0.5)).toBe('rgb(10 20 30 / 0)');
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

    expect(bridge.dispose()).toBe(true);
    expect(bridge.dispose()).toBe(true);
    expect(host.querySelector('[data-pdf-comment-bridge]')).toBeNull();
    host.remove();
  });

  it('ignores every passive hover popup while retaining explicit selected focus', () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Passive read-only');
    const focused: Array<PdfAnnotationFocus | null> = [];
    bridge.onAnnotationFocus((focus) => focused.push(focus));

    bridge.toggleCommentPopup(native, false, true, false);
    bridge.toggleCommentPopup(native, false, true, true);
    expect(focused).toEqual([]);

    bridge.toggleCommentPopup(editor('Missing anchor', { anchor: null }));
    expect(focused).toEqual([]);

    const missingRgb = editor('Missing RGB', { color: undefined });
    missingRgb.getNonHCMColor = () => [undefined, undefined, undefined] as unknown as number[];
    bridge.toggleCommentPopup(missingRgb, true, true);
    expect(focused[focused.length - 1]?.annotations[0]?.color).toBe('#000000');

    const page = document.body.createDiv();
    page.dataset['pageNumber'] = '0';
    const pageAnchor = page.createDiv();
    bridge.toggleCommentPopup(editor('Invalid page', { anchor: pageAnchor }), true, true);
    expect(focused[focused.length - 1]?.annotations[0]?.anchor).toMatchObject({
      kind: 'fixed-page',
      pageIndex: 0,
    });
    page.dataset['pageNumber'] = '2';
    bridge.toggleCommentPopup(editor('Valid page', { anchor: pageAnchor }), true, true);
    expect(focused[focused.length - 1]?.annotations[0]?.anchor).toMatchObject({
      kind: 'fixed-page',
      pageIndex: 1,
    });
    page.remove();

    bridge.toggleCommentPopup(native);
    expect(focused).toHaveLength(4);

    bridge.toggleCommentPopup(native, true, true, false);
    bridge.toggleCommentPopup(native, true, true, true);
    expect(focused).toHaveLength(6);

    bridge.dispose();
    host.remove();
  });

  it('keeps the compatibility sidebar count and selected comment in sync with valid PDF.js data', () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);

    bridge.showSidebar([
      { contentsObj: { str: 'Visible comment' }, id: 'visible', popupRef: true },
      { contentsObj: { str: '' }, id: 'empty', popupRef: true },
      { contentsObj: { str: 'Detached' }, id: 'detached', popupRef: false },
      { contentsObj: { str: 'Missing id' } },
    ]);
    bridge.selectComment('visible');
    expect(bridge.dialogElement.dataset).toMatchObject({
      commentCount: '1',
      selectedCommentId: 'visible',
      sidebarVisible: 'true',
    });

    bridge.updateComment({
      contentsObj: { str: 'Updated comment' },
      id: 'visible',
      popupRef: true,
    });
    bridge.addComment({ contentsObj: { str: 'Second comment' }, id: 'second', popupRef: true });
    expect(bridge.dialogElement.dataset['commentCount']).toBe('2');
    bridge.removeComments(['visible']);
    expect(bridge.dialogElement.dataset).toMatchObject({ commentCount: '1' });
    expect(bridge.dialogElement.dataset['selectedCommentId']).toBeUndefined();
    bridge.hideSidebar();
    expect(bridge.dialogElement.dataset['sidebarVisible']).toBe('false');

    bridge.dispose();
    host.remove();
  });

  it('survives an upstream manager destroy so a replacement manager can commit comments', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Replacement', { uid: 'replacement-highlight' });
    const manager = uiManager(native);

    bridge.setSidebarUiManager(uiManager(editor('Retired')));
    bridge.destroy();
    bridge.setSidebarUiManager(manager);
    const reservation = bridge.reserveNextDialog('Draft after rebind');
    await bridge.showDialog(manager, native, 20, 30);

    await expect(reservation.opened).resolves.toMatchObject({
      comment: 'Draft after rebind',
      identity: { id: 'replacement-highlight', kind: 'stable' },
    });
    expect(host.querySelector('[data-pdf-comment-bridge]')).toBe(bridge.dialogElement);

    bridge.dispose();
    expect(() => bridge.reserveNextDialog('Disposed')).toThrow('disposed');
    host.remove();
  });
});
