import { describe, expect, it, vi } from 'vitest';
import { PdfCommentBridge, type PdfCommentEditor } from './pdf-comment-bridge.js';

function editor(
  comment = '',
  options: {
    readonly annotationType?: number;
    readonly color?: readonly number[] | undefined;
  } = {},
): PdfCommentEditor & { comment: unknown } {
  let value: unknown = comment;
  const annotationType = options.annotationType ?? 9;
  let editorType = 'highlight';
  if (annotationType === 3) editorType = 'freetext';
  else if (annotationType === 15) editorType = 'ink';
  return {
    get comment() {
      return value;
    },
    set comment(next: unknown) {
      value = next;
    },
    focusCommentButton: vi.fn(),
    editorType,
    getData: () => ({
      annotationType: options.annotationType ?? 9,
      color: 'color' in options ? options.color : [255, 212, 0],
      contentsObj: { str: typeof value === 'string' ? value : '' },
      opacity: 1,
    }),
    mode: annotationType,
    propertiesToUpdate: [],
    select: vi.fn(),
    uid: 'editor-1',
  };
}

function uiManager(selected: PdfCommentEditor | null = null) {
  return {
    delete: vi.fn(),
    deleteComment: vi.fn(),
    firstSelectedEditor: selected,
    setSelected: vi.fn(),
    updateParams: vi.fn(),
  };
}

describe('PdfCommentBridge exact PDF.js 6.2.108 seam', () => {
  it('routes native comment Link Tag color and trash mutations', async () => {
    const host = document.body.createDiv();
    const onNativeMutation = vi.fn();
    const bridge = new PdfCommentBridge(host, { onNativeMutation });
    const native = editor('Existing');
    const manager = uiManager(native);
    await bridge.showDialog(manager, native, 20, 30);

    host.querySelector<HTMLButtonElement>('[data-action="insert-link"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="insert-tag"]')?.click();
    const color = host.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
    if (color === null) throw new Error('Expected native annotation color control.');
    color.value = '#123456';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();

    expect(native.comment).toBe('Existing [[Link]] #tag');
    expect(manager.updateParams).toHaveBeenCalledWith(31, '#123456');
    expect(manager.delete).toHaveBeenCalledOnce();
    expect(onNativeMutation).toHaveBeenCalledTimes(4);
    bridge.dispose();
    host.remove();
  });

  it('keeps the edit dialog open when a color mutation synchronously tears down native popups', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Existing');
    const manager = uiManager(native);
    manager.updateParams.mockImplementation(() => {
      bridge.destroyPopup();
    });
    await bridge.showDialog(manager, native, 20, 30);
    const color = host.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
    if (color === null) throw new Error('Expected native annotation color control.');

    color.value = '#5fb236';
    color.dispatchEvent(new Event('input', { bubbles: true }));

    expect(bridge.dialogElement.hidden).toBe(false);
    bridge.dispose();
    host.remove();
  });

  it('reserves and seeds the next comment dialog', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor();
    const manager = uiManager(native);
    const reservation = (
      bridge as PdfCommentBridge & {
        reserveNextDialog(seed: '[['): {
          readonly closed: Promise<string>;
          readonly opened: Promise<void>;
        };
      }
    ).reserveNextDialog('[[');

    await bridge.showDialog(manager, native, 20, 30);
    await reservation.opened;

    expect(native.comment).toBe('');
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('[[');
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected seeded comment input.');
    input.value = '[[Linked note]]';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(native.comment).toBe('[[Linked note]]');
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await expect(reservation.closed).resolves.toBe('escape');
    bridge.dispose();
    host.remove();
  });

  it('does not commit a seed until the interactive dialog changes', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor();
    const nativeCommits: unknown[] = [];
    Object.defineProperty(native, 'comment', {
      configurable: true,
      get: () => '',
      set: (value: unknown) => {
        nativeCommits.push(value);
      },
    });
    const reservation = bridge.reserveNextDialog('[[');

    await bridge.showDialog(uiManager(native), native, 20, 30);

    expect(bridge.dialogElement.hidden).toBe(false);
    expect(nativeCommits).toEqual([]);
    bridge.dispose();
    await expect(reservation.closed).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeCommits).toEqual([]);
    host.remove();
  });

  it('keeps a reserved seeded dialog through a repeated PDF.js showDialog callback', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor();
    const manager = uiManager(native);
    const reservation = bridge.reserveNextDialog('[[');

    await bridge.showDialog(manager, native, 20, 30);
    await reservation.opened;
    const repeated = editor();
    await bridge.showDialog(manager, repeated, 20, 30);

    expect(bridge.dialogElement.hidden).toBe(false);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('[[');
    host
      .querySelector<HTMLTextAreaElement>('textarea')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await expect(reservation.closed).resolves.toBe('escape');
    bridge.dispose();
    host.remove();
  });

  it('keeps a reserved dialog open through native popup teardown callbacks', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor();
    const reservation = bridge.reserveNextDialog('#');
    await bridge.showDialog(uiManager(native), native, 20, 30);
    await reservation.opened;

    bridge.destroyPopup();
    bridge.toggleCommentPopup(null);

    expect(bridge.dialogElement.hidden).toBe(false);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('#');
    host
      .querySelector<HTMLTextAreaElement>('textarea')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await expect(reservation.closed).resolves.toBe('escape');
    bridge.dispose();
    host.remove();
  });

  it('focuses a reserved dialog after native creation finishes moving focus', async () => {
    const host = document.body.createDiv();
    const nativeFocus = host.createEl('button');
    const bridge = new PdfCommentBridge(host);
    const reservation = bridge.reserveNextDialog('[[');
    await bridge.showDialog(uiManager(), editor(), 20, 30);
    await reservation.opened;
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
    nativeFocus.focus();
    expect(bridge.dialogElement.hidden).toBe(false);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });

    expect(host.querySelector<HTMLTextAreaElement>('textarea')).toBe(document.activeElement);
    host
      .querySelector<HTMLTextAreaElement>('textarea')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await expect(reservation.closed).resolves.toBe('escape');
    bridge.dispose();
    host.remove();
  });

  it('clears an unopened comment reservation on abort', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const abortController = new AbortController();
    const reservation = bridge.reserveNextDialog('#', abortController.signal);
    let opened: unknown = 'pending';
    let closed: unknown = 'pending';
    void reservation.opened.catch((cause: unknown) => {
      opened = cause;
    });
    void reservation.closed.catch((cause: unknown) => {
      closed = cause;
    });

    abortController.abort(new DOMException('cancelled', 'AbortError'));
    await Promise.resolve();

    expect(opened).toMatchObject({ name: 'AbortError' });
    expect(closed).toMatchObject({ name: 'AbortError' });
    const native = editor('Existing');
    await bridge.showDialog(uiManager(native), native, 0, 0);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Existing');
    bridge.dispose();
    host.remove();
  });

  it('clears an unopened comment reservation on timeout', async () => {
    vi.useFakeTimers();
    try {
      const host = document.body.createDiv();
      const bridge = new PdfCommentBridge(host);
      const reservation = bridge.reserveNextDialog('[[');
      let opened: unknown = 'pending';
      let closed: unknown = 'pending';
      void reservation.opened.catch((cause: unknown) => {
        opened = cause;
      });
      void reservation.closed.catch((cause: unknown) => {
        closed = cause;
      });

      await vi.advanceTimersByTimeAsync(2_000);

      expect(opened).toMatchObject({ name: 'TimeoutError' });
      expect(closed).toMatchObject({ name: 'TimeoutError' });
      const native = editor('Existing');
      await bridge.showDialog(uiManager(native), native, 0, 0);
      expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Existing');
      bridge.dispose();
      host.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains a native seed commit failure after keeping the dialog interactive', async () => {
    const host = document.body.createDiv();
    const onFailure = vi.fn();
    const bridge = new PdfCommentBridge(host, { onFailure });
    const cause = new Error('seed assignment failed');
    const native = editor('Existing');
    Object.defineProperty(native, 'comment', {
      configurable: true,
      get: () => 'Existing',
      set: () => {
        throw cause;
      },
    });
    const reservation = bridge.reserveNextDialog('#');

    const opening = bridge.showDialog(uiManager(native), native, 0, 0);
    await expect(opening).resolves.toBeUndefined();
    await expect(reservation.opened).resolves.toBeUndefined();
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected seeded comment input.');
    expect(input.value).toBe('#');
    input.value = '#review';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(bridge.dialogElement.hidden).toBe(false);
    expect(onFailure).toHaveBeenCalledWith({
      action: 'save-comment',
      cause,
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await expect(reservation.closed).resolves.toBe('escape');
    bridge.dispose();
    host.remove();
  });

  it('persists comment changes live without Save or Cancel', async () => {
    const host = document.body.createDiv();
    const onNativeMutation = vi.fn();
    const bridge = new PdfCommentBridge(host, { onNativeMutation });
    const native = editor('Draft');
    const manager = uiManager(native);

    await bridge.showDialog(manager, native, 20, 30);
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected native comment input.');
    input.value = 'Draft updated';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(native.comment).toBe('Draft updated');
    expect(onNativeMutation).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-action="save-comment"]')).toBeNull();
    expect(host.querySelector('[data-action="cancel-comment"]')).toBeNull();
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(native.comment).toBe('Draft updated');
    bridge.dispose();
    host.remove();
  });

  it('implements only the runtime manager surface and commits ordinary text to the native editor', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor();
    const manager = uiManager(native);
    const focusCommentButton = vi.spyOn(native, 'focusCommentButton');

    await bridge.showDialog(manager, native, 20, 30);
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected native comment input.');
    input.value = 'Key idea [[Gradient descent]] #important';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(native.comment).toBe('Key idea [[Gradient descent]] #important');
    expect(focusCommentButton).not.toHaveBeenCalled();
    expect(bridge.dialogElement.ownerDocument).toBe(host.ownerDocument);
    expect(() => {
      bridge.setSidebarUiManager({});
      bridge.showSidebar([
        { contentsObj: { str: 'Sidebar comment' }, id: 'side-1', popupRef: true },
      ]);
      expect(bridge.dialogElement.dataset['commentCount']).toBe('1');
      expect(bridge.dialogElement.dataset['sidebarVisible']).toBe('true');
      bridge.selectComment('side-1');
      expect(bridge.dialogElement.dataset['selectedCommentId']).toBe('side-1');
      bridge.updateComment({ contentsObj: { str: 'Updated' }, id: 'side-1', popupRef: true });
      bridge.removeComments(['side-1']);
      expect(bridge.dialogElement.dataset['commentCount']).toBe('0');
      bridge.hideSidebar();
      expect(bridge.dialogElement.dataset['sidebarVisible']).toBe('false');
      bridge.addComment({ contentsObj: { str: 'Added' }, id: 'editor-1', popupRef: true });
      bridge.toggleCommentPopup(native, true, true);
      bridge.updatePopupColor(native);
      bridge.destroyPopup();
      bridge.makeCommentColor([255, 212, 0], 1);
    }).not.toThrow();
    bridge.dispose();
    expect(host.childElementCount).toBe(0);
    host.remove();
  });

  it('treats the null popup source used by PDF.js mode teardown as an idempotent clear', () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Selected');
    const states = vi.fn();
    native.setCommentButtonStates = states;
    bridge.toggleCommentPopup(native, true, true);
    bridge.destroyPopup();

    expect(() => {
      bridge.toggleCommentPopup(null);
    }).not.toThrow();
    expect(bridge.dialogElement.hidden).toBe(true);
    expect(states).toHaveBeenLastCalledWith({ hasPopup: false, selected: false });
    bridge.dispose();
    host.remove();
  });

  it('keeps live editor changes on blur and deletes through native PDF.js comment history', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Existing #tag');
    const liveManager = uiManager(native);

    await bridge.showDialog(liveManager, native, 0, 0);
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected native comment input.');
    input.value = 'Changed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(native.comment).toBe('Changed');

    const savedData = { text: 'Existing #tag' };
    native.comment = savedData;
    const historyManager = {
      delete: vi.fn(),
      deleteComment: vi.fn(),
      firstSelectedEditor: native,
      setSelected: vi.fn(),
      updateParams: vi.fn(),
    };
    await bridge.showDialog(historyManager, native, 0, 0);
    host.querySelector<HTMLButtonElement>('[data-action="delete-comment"]')?.click();
    expect(historyManager.deleteComment).toHaveBeenCalledWith(native, savedData);
    bridge.dispose();
    host.remove();
  });

  it.each(['delete-comment', 'delete-annotation'] as const)(
    'settles %s before synchronous native popup teardown',
    async (action) => {
      const host = document.body.createDiv();
      const bridge = new PdfCommentBridge(host);
      const native = editor('Existing');
      const manager = uiManager(native);
      if (action === 'delete-comment') {
        manager.deleteComment.mockImplementation(() => {
          bridge.destroyPopup();
        });
      } else {
        manager.setSelected.mockImplementation(() => {
          bridge.destroyPopup();
        });
      }
      const reservation = bridge.reserveNextDialog('');
      await bridge.showDialog(manager, native, 0, 0);
      await reservation.opened;

      host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click();

      await expect(reservation.closed).resolves.toBe(action);
      bridge.dispose();
      host.remove();
    },
  );

  it.each([
    ['underlineAnnotation', 'Underline annotations'],
    ['textAnnotation', 'Text Note annotations'],
  ])(
    'forces existing %s comments read-only from the actual annotation subtype',
    (className, reason) => {
      const host = document.body.createDiv();
      const bridge = new PdfCommentBridge(host);
      const annotationElement = host.createDiv({ cls: className });
      const commentButton = host.createEl('button');
      annotationElement.after(commentButton);
      const setCommentButtonStates = vi.fn();
      const setComment = vi.fn();
      const source = {
        elementBeforePopup: commentButton,
        getData: () => ({ contentsObj: { str: 'Imported comment' } }),
        set comment(value: unknown) {
          setComment(value);
        },
        setCommentButtonStates,
      };

      bridge.toggleCommentPopup(source, true, true, true);

      expect(
        host.querySelector('[data-region="annotation-read-only-reason"]')?.textContent,
      ).toContain(reason);
      expect(host.querySelector('[data-action="save-comment"]')).toBeNull();
      expect(host.querySelector('[data-action="delete-annotation"]')).toBeNull();
      expect(setCommentButtonStates).toHaveBeenCalledWith({ hasPopup: true, selected: true });
      expect(setComment).not.toHaveBeenCalled();
      bridge.destroyPopup();
      expect(setCommentButtonStates).toHaveBeenLastCalledWith({ hasPopup: false, selected: false });
      bridge.dispose();
      host.remove();
    },
  );

  it('changes color and deletes the supported selected annotation through the native UI manager', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Supported');
    const manager = uiManager(native);
    await bridge.showDialog(manager, native, 0, 0);

    const color = host.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
    if (color === null) throw new Error('Expected annotation color control.');
    color.value = '#112233';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    expect(manager.setSelected).toHaveBeenCalledWith(native);
    expect(manager.updateParams).toHaveBeenCalledWith(31, '#112233');

    host.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(manager.delete).toHaveBeenCalledOnce();
    bridge.dispose();
    host.remove();
  });

  it.each([
    [15, 21],
    [3, 12],
  ])(
    'routes native annotation type %i through PDF.js parameter %i',
    async (annotationType, parameter) => {
      const host = document.body.createDiv();
      const bridge = new PdfCommentBridge(host);
      const native = editor('', { annotationType, color: undefined });
      const manager = uiManager(native);

      await bridge.showDialog(manager, native, 0, 0);
      const color = host.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
      expect(color?.value).toBe('#000000');
      if (color === null) throw new Error('Expected annotation color.');
      color.value = '#445566';
      color.dispatchEvent(new Event('input', { bubbles: true }));

      expect(manager.updateParams).toHaveBeenCalledWith(parameter, '#445566');
      bridge.dispose();
      host.remove();
    },
  );

  it.each([
    [3, 'freetext', 12],
    [9, 'highlight', 31],
    [15, 'ink', 21],
  ])(
    'uses native editor mode %i rather than serialized annotation data for %s color',
    async (mode, editorType, parameter) => {
      const host = document.body.createDiv();
      const bridge = new PdfCommentBridge(host);
      const native = editor('Native');
      Object.assign(native, { editorType, mode });
      const getData = vi.spyOn(native, 'getData').mockReturnValue({
        annotationType: 1,
        color: [10, 20, 30],
        contentsObj: { str: 'Native' },
      });
      const manager = uiManager(native);

      await bridge.showDialog(manager, native, 0, 0);
      const color = host.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
      if (color === null) throw new Error('Expected native annotation color control.');
      color.value = '#123456';
      color.dispatchEvent(new Event('input', { bubbles: true }));

      expect(getData).toHaveBeenCalled();
      expect(manager.updateParams).toHaveBeenCalledWith(parameter, '#123456');
      bridge.dispose();
      host.remove();
    },
  );

  it('renders annotation-layer PopupElement hover as passive content without focus or mutation tools', () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const before = host.createEl('button');
    before.focus();
    const setComment = vi.fn();
    const popupElement: PdfCommentEditor = {
      elementBeforePopup: host.createEl('button'),
      getData: () => ({ contentsObj: { str: 'Imported popup comment' } }),
      get comment() {
        return 'Imported popup comment';
      },
      set comment(value: unknown) {
        setComment(value);
      },
      setCommentButtonStates: vi.fn(),
    };

    bridge.toggleCommentPopup(popupElement, false, true, true);

    expect(host.querySelector('[data-region="annotation-comment-popup"]')?.textContent).toBe(
      'Imported popup comment',
    );
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.hidden).toBe(true);
    expect(host.querySelector('[data-action="annotation-color"]')).toBeNull();
    expect(host.querySelector('[data-action="delete-annotation"]')).toBeNull();
    expect(host.ownerDocument.activeElement).toBe(before);
    expect(setComment).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it('keeps toggleCommentPopup passive for native editors and reserves editing for showDialog', async () => {
    const host = document.body.createDiv();
    const native = editor('Native popup');
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);

    bridge.toggleCommentPopup(native, true, true, true);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.hidden).toBe(true);
    expect(host.querySelector('[data-region="annotation-comment-popup"]')?.textContent).toBe(
      'Native popup',
    );

    await bridge.showDialog(manager, native, 0, 0);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Native popup');
    bridge.dispose();
    host.remove();
  });

  it('offers Edit only for a selected supported native editor and routes it to the edit dialog', () => {
    const host = document.body.createDiv();
    const native = editor('Selected native comment');
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);
    const editComment = vi.fn(() => bridge.showDialog(manager, native, 10, 20));
    native.editComment = editComment;

    bridge.toggleCommentPopup(native, true, true, true);
    const edit = host.querySelector<HTMLButtonElement>('[data-action="edit-comment"]');
    expect(edit).not.toBeNull();
    expect(host.ownerDocument.activeElement).toBe(edit);
    edit?.click();

    expect(editComment).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'Selected native comment',
    );
    bridge.dispose();
    host.remove();
  });

  it('never offers Edit or moves focus for hover, PopupElement, or unsupported selected sources', () => {
    const host = document.body.createDiv();
    const invoker = host.createEl('button');
    invoker.focus();
    const native = editor('Hover native');
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);
    bridge.setSidebarUiManager(manager);
    native.editComment = vi.fn();

    bridge.toggleCommentPopup(native, false, true, true);
    expect(host.querySelector('[data-action="edit-comment"]')).toBeNull();
    expect(host.ownerDocument.activeElement).toBe(invoker);
    bridge.destroyPopup();

    const popupEdit = vi.fn();
    const popupElement: PdfCommentEditor = {
      comment: 'Imported',
      editComment: popupEdit,
      getData: () => ({ contentsObj: { str: 'Imported' } }),
    };
    bridge.toggleCommentPopup(popupElement, true, true, true);
    expect(host.querySelector('[data-action="edit-comment"]')).toBeNull();
    expect(host.querySelector('[data-action="cancel-comment"]')).not.toBeNull();
    expect(popupEdit).not.toHaveBeenCalled();
    bridge.dispose();
    host.remove();
  });

  it.each(['blur', 'Escape'] as const)(
    'clears selected passive state through %s so one standalone toggle reopens preview',
    async (action) => {
      const host = document.body.createDiv();
      const native = editor('Lifecycle comment');
      const manager = uiManager(native);
      const states = vi.fn();
      native.setCommentButtonStates = states;
      const bridge = new PdfCommentBridge(host);
      bridge.setSidebarUiManager(manager);
      native.editComment = () => bridge.showDialog(manager, native, 10, 20);

      bridge.toggleCommentPopup(native, true, true, true);
      host.querySelector<HTMLButtonElement>('[data-action="edit-comment"]')?.click();

      expect(states).toHaveBeenLastCalledWith({ hasPopup: false, selected: false });
      expect(host.querySelector<HTMLTextAreaElement>('textarea')?.hidden).toBe(false);
      if (action === 'blur') {
        host
          .querySelector<HTMLTextAreaElement>('textarea')
          ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      } else {
        host
          .querySelector<HTMLTextAreaElement>('textarea')
          ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      }
      expect(bridge.dialogElement.hidden).toBe(true);

      bridge.toggleCommentPopup(native, true, undefined, true);

      expect(bridge.dialogElement.hidden).toBe(false);
      expect(host.querySelector<HTMLTextAreaElement>('textarea')?.hidden).toBe(true);
      expect(host.querySelector('[data-region="annotation-comment-popup"]')).not.toBeNull();
      expect(states).toHaveBeenLastCalledWith({ hasPopup: true, selected: true });
      bridge.dispose();
      host.remove();
    },
  );

  it.each(['Escape'] as const)(
    'restores the standalone comment invoker after Edit and %s',
    (action) => {
      const host = document.body.createDiv();
      const invoker = host.createEl('button');
      invoker.textContent = 'Standalone comment';
      invoker.focus();
      const native = editor('Focus lifecycle comment');
      const manager = uiManager(native);
      const bridge = new PdfCommentBridge(host);
      bridge.setSidebarUiManager(manager);
      native.editComment = () => bridge.showDialog(manager, native, 10, 20);

      bridge.toggleCommentPopup(native, true, true, true);
      host.querySelector<HTMLButtonElement>('[data-action="edit-comment"]')?.click();
      expect(host.ownerDocument.activeElement).toBe(
        host.querySelector<HTMLTextAreaElement>('textarea'),
      );

      host
        .querySelector<HTMLTextAreaElement>('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: action }));

      expect(bridge.dialogElement.hidden).toBe(true);
      expect(host.ownerDocument.activeElement).toBe(invoker);
      bridge.dispose();
      host.remove();
    },
  );

  it('treats every unknown or structurally incomplete source as read-only', async () => {
    const host = document.body.createDiv();
    const annotation = host.createDiv({ cls: 'foo highlightAnnotation extra' });
    const anchor = host.createEl('button');
    annotation.append(anchor);
    const incomplete: PdfCommentEditor = {
      comment: 'Unknown',
      editorType: 'highlight',
      elementBeforePopup: anchor,
      getData: () => ({ contentsObj: { str: 'Unknown' } }),
      mode: 9,
      uid: 'not-a-native-editor',
    };
    const bridge = new PdfCommentBridge(host);

    await bridge.showDialog(uiManager(incomplete), incomplete, 0, 0);

    expect(
      host.querySelector('[data-region="annotation-read-only-reason"]')?.textContent,
    ).toContain('read-only');
    expect(host.querySelector('[data-action="save-comment"]')).toBeNull();
    expect(host.querySelector('[data-action="delete-annotation"]')).toBeNull();
    bridge.dispose();
    host.remove();
  });

  it('uses native comment history for both string and object saved comments', async () => {
    const host = document.body.createDiv();
    const native = editor('Plain comment');
    const manager = uiManager(native);
    const bridge = new PdfCommentBridge(host);

    await bridge.showDialog(manager, native, 0, 0);
    host.querySelector<HTMLButtonElement>('[data-action="delete-comment"]')?.click();

    expect(manager.deleteComment).toHaveBeenCalledWith(native, 'Plain comment');
    expect(native.comment).toBe('Plain comment');
    bridge.dispose();
    host.remove();
  });

  it.each([
    ['change comment', 'change-comment'],
    ['delete comment', 'delete-comment'],
    ['delete annotation', 'delete-annotation'],
  ])('reports a failed %s once and keeps the editor open', async (_label, action) => {
    const host = document.body.createDiv();
    const native = editor('Original');
    const manager = uiManager(native);
    const cause = new Error('native mutation failed');
    if (action === 'change-comment') {
      Object.defineProperty(native, 'comment', {
        configurable: true,
        get: () => 'Original',
        set: () => {
          throw cause;
        },
      });
    } else if (action === 'delete-comment') {
      manager.deleteComment.mockImplementation(() => {
        throw cause;
      });
    } else {
      manager.delete.mockImplementation(() => {
        throw cause;
      });
    }
    const onFailure = vi.fn();
    const bridge = new PdfCommentBridge(host, { onFailure });
    await bridge.showDialog(manager, native, 0, 0);

    if (action === 'change-comment') {
      const input = host.querySelector<HTMLTextAreaElement>('textarea');
      if (input === null) throw new Error('Expected native comment input.');
      input.value = 'Rejected';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ cause });
    expect(bridge.dialogElement.hidden).toBe(false);
    bridge.dispose();
    host.remove();
  });

  it.each(['delete-comment', 'delete-annotation'] as const)(
    'keeps a reserved %s transaction pending when the native mutation fails',
    async (action) => {
      const host = document.body.createDiv();
      const native = editor('Original');
      const manager = uiManager(native);
      const cause = new Error('native deletion failed');
      if (action === 'delete-comment') {
        manager.deleteComment.mockImplementation(() => {
          throw cause;
        });
      } else {
        manager.delete.mockImplementation(() => {
          throw cause;
        });
      }
      const bridge = new PdfCommentBridge(host, { onFailure: vi.fn() });
      const reservation = bridge.reserveNextDialog('');
      let closeOutcome: string = 'pending';
      void reservation.closed.then(
        (reason) => {
          closeOutcome = reason;
        },
        () => {
          closeOutcome = 'rejected';
        },
      );
      await bridge.showDialog(manager, native, 0, 0);
      await reservation.opened;

      host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click();
      await Promise.resolve();

      expect(closeOutcome).toBe('pending');
      expect(bridge.dialogElement.hidden).toBe(false);
      host
        .querySelector<HTMLTextAreaElement>('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      await expect(reservation.closed).resolves.toBe('escape');
      bridge.dispose();
      host.remove();
    },
  );

  it('keeps unsupported comment sources editable without exposing annotation mutation', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('', { annotationType: 99 });

    await bridge.showDialog({}, native, 0, 0);
    expect(host.querySelector('[data-action="annotation-color"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(native.comment).toBe('');
    bridge.dispose();
    host.remove();
  });

  it('honors PDF.js selected, hover, and explicit popup visibility semantics', () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const first = editor('First');
    const second = editor('Second');

    bridge.toggleCommentPopup(first, false, true, false);
    expect(bridge.dialogElement.hidden).toBe(false);
    bridge.toggleCommentPopup(first, false, false, false);
    expect(bridge.dialogElement.hidden).toBe(true);
    bridge.toggleCommentPopup(first, true, undefined, false);
    expect(bridge.dialogElement.hidden).toBe(false);
    bridge.toggleCommentPopup(first, false, undefined, false);
    expect(bridge.dialogElement.hidden).toBe(false);
    bridge.toggleCommentPopup(first, true, undefined, false);
    expect(bridge.dialogElement.hidden).toBe(true);
    bridge.toggleCommentPopup(second, true, undefined, false);
    expect(bridge.dialogElement.hidden).toBe(false);
    bridge.dispose();
    host.remove();
  });

  it('contains read-only popup disposal and invokes inert read-only actions without mutation', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('');
    bridge.toggleCommentPopup(native, true, true, false);
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    host.querySelector<HTMLButtonElement>('[data-action="cancel-comment"]')?.click();

    bridge.dispose();
    bridge.toggleCommentPopup(native, true, true, false);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-annotation-popover]')).toBeNull();
    });
    host.remove();
  });

  it('rejects malformed managers and comments, clears selected removals, and updates active colors only', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('', { color: [1, 2, 3] });
    bridge.setSidebarUiManager({ delete: vi.fn() });
    bridge.addComment(null);
    bridge.addComment({ id: 'empty', popupRef: false });
    bridge.showSidebar([{ contentsObj: { str: 'Text' }, id: 'selected' }]);
    bridge.selectComment('selected');
    bridge.removeComments(['selected']);
    expect(bridge.dialogElement.dataset['selectedCommentId']).toBeUndefined();

    await bridge.showDialog(null, native, 0, 0);
    bridge.updatePopupColor(editor('other'));
    bridge.updatePopupColor(native);
    expect(host.querySelector<HTMLInputElement>('[data-action="annotation-color"]')).toBeNull();
    bridge.dispose();
    host.remove();
  });

  it('survives the runtime destroy call used during PDFViewer document rebind', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor('Before');

    bridge.destroy();
    await bridge.showDialog(null, native, 0, 0);

    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Before');
    bridge.dispose();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(bridge.showDialog(null, native, 0, 0)).resolves.toBeUndefined();
    expect(error.mock.calls[0]?.[0]).toBe(
      '[abyss-documents] Failed to open PDF annotation comment',
    );
    const details: unknown = error.mock.calls[0]?.[1];
    expect(details).toMatchObject({ cause: { name: 'InvalidStateError' } });
    error.mockRestore();
    host.remove();
  });

  it('covers popup visibility, sizing, colors, and contained async failures', async () => {
    const host = document.body.createDiv();
    const bridge = new PdfCommentBridge(host);
    const native = editor();

    await bridge.showDialog(null, native, -10, -20, { height: 72 });
    expect(bridge.dialogElement.style.getPropertyValue('--abyss-comment-height')).toBe('72px');
    bridge.toggleCommentPopup(native, false);
    bridge.toggleCommentPopup(native, true, true, false);
    bridge.toggleCommentPopup(native, true, false);
    expect(bridge.makeCommentColor(null)).toBeNull();
    expect(bridge.makeCommentColor([1, 2])).toBeNull();
    expect(bridge.makeCommentColor([-1, 300, 12.4], 2)).toBe('rgb(0 255 12 / 1)');
    expect(bridge.makeCommentColor([1, 2, 3], -1)).toBe('rgb(1 2 3 / 0)');

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge.dispose();
    bridge.dispose();
    bridge.destroy();
    bridge.toggleCommentPopup(native, true);
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalled();
    });
    expect(String(error.mock.calls[0]?.[0])).toBe(
      '[abyss-documents] Failed to open PDF annotation comment',
    );
    const context: unknown = error.mock.calls[0]?.[1];
    expect((context as { cause?: unknown } | undefined)?.cause).toBeInstanceOf(DOMException);
    host.remove();
  });
});
