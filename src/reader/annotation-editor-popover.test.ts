import type * as ObsidianModule from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import { asAnnotationId } from '../document-core/annotations.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import { AnnotationEditorPopover } from './annotation-editor-popover.js';

const iconMocks = vi.hoisted(() => ({ setIcon: vi.fn(), setTooltip: vi.fn() }));

vi.mock('obsidian', async (importOriginal) => {
  const original: typeof ObsidianModule = await importOriginal();
  return { ...original, setIcon: iconMocks.setIcon, setTooltip: iconMocks.setTooltip };
});

const palette: readonly AnnotationPaletteEntry[] = [
  { color: '#ffd400', meaning: 'Important', name: 'Yellow' },
  { color: '#5fb236', meaning: 'Question', name: 'Green' },
];

function editableAnnotation(overrides: Partial<DocumentAnnotation> = {}): DocumentAnnotation {
  const available = { available: true } as const;
  return {
    anchor: {
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 20, y: 30 } },
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
    comment: 'Reader prose #Important [[Concept]]',
    createdAt: null,
    identity: { id: asAnnotationId('annotation-1'), kind: 'stable' },
    links: ['Concept'],
    modifiedAt: null,
    selectedText: 'Selected passage',
    tags: ['Important'],
    type: 'highlight',
    ...overrides,
  };
}

function editorRequest(target: Parameters<AnnotationEditorPopover['open']>[0]['target']) {
  return {
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onUpdate: vi.fn(),
    palette,
    position: { x: 40, y: 60 },
    target,
  };
}

function selection(): PdfTextSelection {
  const rect = { bottom: 36, height: 16, left: 10, right: 70, top: 20, width: 60 };
  return {
    clientRect: rect,
    clientRects: [rect],
    input: 'pointer',
    pageIndex: 0,
    text: 'Selected passage',
    token: 'selection-1',
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next, fail) => {
    reject = fail;
    resolve = next;
  });
  return { promise, reject, resolve };
}

function editComment(popover: AnnotationEditorPopover, value: string): void {
  const input = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
  if (input === null) throw new Error('Expected comment field.');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AnnotationEditorPopover', () => {
  it('isolates comment editing from PDF.js global Backspace and clipboard handlers', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    const annotationState = { color: '#ffd400', count: 1 };
    const documentMutation = vi.fn(() => {
      annotationState.count = 0;
      annotationState.color = '#ff0000';
    });
    const windowMutation = vi.fn(() => {
      annotationState.count = 0;
      annotationState.color = '#ff0000';
    });
    const owner = host.win as Window & { Event: typeof Event; KeyboardEvent: typeof KeyboardEvent };
    const keyEvents: KeyboardEventInit[] = [
      { key: 'Backspace' },
      { key: 'Delete' },
      { ctrlKey: true, key: 'a' },
      { metaKey: true, key: 'a' },
      { ctrlKey: true, key: 'z' },
      { metaKey: true, key: 'z' },
      { ctrlKey: true, key: 'y' },
      { metaKey: true, key: 'y' },
      { ctrlKey: true, key: 'Z', shiftKey: true },
      { metaKey: true, key: 'Z', shiftKey: true },
      { key: 'Enter' },
      { key: ' ' },
      { key: 'ArrowDown' },
      { key: 'ArrowLeft' },
      { key: 'ArrowRight' },
      { key: 'ArrowUp' },
    ];
    const events: Event[] = [];
    document.addEventListener('keydown', documentMutation);
    document.addEventListener('copy', documentMutation);
    document.addEventListener('cut', documentMutation);
    document.addEventListener('paste', documentMutation);
    owner.addEventListener('keydown', windowMutation);
    owner.addEventListener('copy', windowMutation);
    owner.addEventListener('cut', windowMutation);
    owner.addEventListener('paste', windowMutation);

    try {
      comment.value = 'Keep this comment intact';
      for (const init of keyEvents) {
        const event = new owner.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        comment.dispatchEvent(event);
        events.push(event);
      }
      for (const type of ['copy', 'cut', 'paste'] as const) {
        const event = new owner.Event(type, { bubbles: true, cancelable: true });
        comment.dispatchEvent(event);
        events.push(event);
      }

      expect({
        annotation: annotationState,
        defaultPrevented: events.map((event) => event.defaultPrevented),
        documentMutations: documentMutation.mock.calls.length,
        value: comment.value,
        windowMutations: windowMutation.mock.calls.length,
      }).toEqual({
        annotation: { color: '#ffd400', count: 1 },
        defaultPrevented: Array.from({ length: 19 }, () => false),
        documentMutations: 0,
        value: 'Keep this comment intact',
        windowMutations: 0,
      });
    } finally {
      document.removeEventListener('keydown', documentMutation);
      document.removeEventListener('copy', documentMutation);
      document.removeEventListener('cut', documentMutation);
      document.removeEventListener('paste', documentMutation);
      owner.removeEventListener('keydown', windowMutation);
      owner.removeEventListener('copy', windowMutation);
      owner.removeEventListener('cut', windowMutation);
      owner.removeEventListener('paste', windowMutation);
      popover.destroy();
      host.remove();
    }
  });

  it('leaves IME composition and its following input native', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    popover.open(editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }));
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    const owner = host.win as Window & { Event: typeof Event };
    const observed: string[] = [];
    const documentObserver = (event: Event): void => {
      observed.push(`document:${event.type}`);
    };
    const windowObserver = (event: Event): void => {
      observed.push(`window:${event.type}`);
    };
    for (const type of [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'input',
    ] as const) {
      document.addEventListener(type, documentObserver);
      owner.addEventListener(type, windowObserver);
    }

    try {
      const events = [
        new owner.Event('compositionstart', { bubbles: true, cancelable: true }),
        new owner.Event('compositionupdate', { bubbles: true, cancelable: true }),
        new owner.Event('compositionend', { bubbles: true, cancelable: true }),
      ];
      for (const event of events) comment.dispatchEvent(event);
      comment.value = '入力';
      const input = new owner.Event('input', { bubbles: true, cancelable: true });
      comment.dispatchEvent(input);

      expect({
        defaultPrevented: [...events, input].map((event) => event.defaultPrevented),
        observed,
        value: comment.value,
      }).toEqual({
        defaultPrevented: [false, false, false, false],
        observed: [
          'document:compositionstart',
          'window:compositionstart',
          'document:compositionupdate',
          'window:compositionupdate',
          'document:compositionend',
          'window:compositionend',
          'document:input',
          'window:input',
        ],
        value: '入力',
      });
    } finally {
      for (const type of [
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'input',
      ] as const) {
        document.removeEventListener(type, documentObserver);
        owner.removeEventListener(type, windowObserver);
      }
      popover.destroy();
      host.remove();
    }
  });

  it('auto-grows the two-row comment field without a resize handle', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    popover.open(editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }));
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected the comment textarea.');
    Object.defineProperty(comment, 'scrollHeight', { configurable: true, value: 96 });

    comment.value += '\nA longer line';
    comment.dispatchEvent(new Event('input', { bubbles: true }));

    expect(comment.rows).toBe(2);
    expect(comment.style.getPropertyValue('--abyss-annotation-comment-height')).toBe('96px');
    popover.destroy();
    host.remove();
  });

  it('measures a long existing comment only after viewport constraints make it visible', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected the comment textarea.');
    const measurements: Array<{ hidden: boolean; maxWidth: string }> = [];
    Object.defineProperty(comment, 'scrollHeight', {
      configurable: true,
      get: () => {
        measurements.push({
          hidden: popover.element.hidden,
          maxWidth: popover.element.style.maxWidth,
        });
        return 220;
      },
    });
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        measurements.push({
          hidden: popover.element.hidden,
          maxWidth: popover.element.style.maxWidth,
        });
        return new DOMRect(0, 0, 244, 120);
      },
    });
    Object.defineProperty(host.win, 'visualViewport', {
      configurable: true,
      value: { height: 160, offsetLeft: 0, offsetTop: 0, width: 260 },
    });

    popover.open({
      ...editorRequest({
        annotation: editableAnnotation({ comment: 'One\nTwo\nThree\nFour\nFive\nSix' }),
        kind: 'annotation',
      }),
      position: { x: 20, y: 140 },
    });

    expect(measurements.length).toBeGreaterThan(0);
    expect(measurements.every(({ hidden, maxWidth }) => !hidden && maxWidth === '244px')).toBe(
      true,
    );
    expect(comment.style.getPropertyValue('--abyss-annotation-comment-height')).toBe('220px');
    expect(popover.element.style.top).toBe('14px');
    Reflect.deleteProperty(host.win, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('re-places a bottom-edge draft after textarea growth and viewport resize', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected the comment textarea.');
    let scrollHeight = 36;
    let viewportHeight = 200;
    Object.defineProperty(comment, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const measured = Number.parseFloat(
          comment.style.getPropertyValue('--abyss-annotation-comment-height'),
        );
        const height = Number.isFinite(measured) && measured > 0 ? measured : 36;
        return new DOMRect(0, 0, 244, Math.min(height, 112) + 24);
      },
    });
    Object.defineProperty(host.win, 'visualViewport', {
      configurable: true,
      get: () => ({ height: viewportHeight, offsetLeft: 0, offsetTop: 0, width: 260 }),
    });
    const selected = selection();
    const edgeSelection: PdfTextSelection = {
      ...selected,
      clientRect: { ...selected.clientRect, bottom: 186, top: 170 },
      clientRects: [{ ...selected.clientRect, bottom: 186, top: 170 }],
    };
    popover.open({
      ...editorRequest({ kind: 'selection', selection: edgeSelection }),
      position: undefined,
    });
    expect(popover.element.style.top).toBe('104px');

    scrollHeight = 200;
    comment.value = 'One\nTwo\nThree\nFour\nFive\nSix';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    expect(popover.element.style.top).toBe('28px');

    viewportHeight = 120;
    host.win.dispatchEvent(new Event('resize'));
    expect({ maxHeight: popover.element.style.maxHeight, top: popover.element.style.top }).toEqual({
      maxHeight: '104px',
      top: '8px',
    });
    Reflect.deleteProperty(host.win, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('uses semantic Obsidian tooltips for every palette swatch', () => {
    iconMocks.setTooltip.mockClear();
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    popover.open(editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }));
    const swatches = Array.from(
      popover.element.querySelectorAll<HTMLButtonElement>('[data-editor-color]'),
    );

    expect(iconMocks.setTooltip).toHaveBeenCalledWith(swatches[0], 'Important', { delay: 250 });
    expect(iconMocks.setTooltip).toHaveBeenCalledWith(swatches[1], 'Question', { delay: 250 });
    popover.destroy();
    host.remove();
  });

  it('renders exactly one raw comment textarea with palette and contextual trash only', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    popover.open(editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }));

    expect(popover.element.isConnected).toBe(true);
    expect(popover.element.hidden).toBe(false);
    expect(popover.element.getAttribute('role')).toBe('dialog');
    expect(popover.element.getAttribute('aria-label')).toBe('Edit annotation');
    expect(
      Array.from(popover.element.querySelectorAll<HTMLButtonElement>('[data-editor-color]')).map(
        (button) => [
          button.dataset['shape'],
          button.getAttribute('aria-label'),
          button.getAttribute('aria-pressed'),
        ],
      ),
    ).toEqual([
      ['square', 'Important', 'true'],
      ['square', 'Question', 'false'],
    ]);
    expect(popover.element.querySelectorAll('textarea')).toHaveLength(1);
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Reader prose #Important [[Concept]]');
    expect(
      popover.element.querySelector(
        '.abyss-annotation-editor-tags, .abyss-annotation-editor-links, [aria-label="Tags"], [aria-label="Links"]',
      ),
    ).toBeNull();
    expect(
      Array.from(popover.element.querySelectorAll('button[data-action]'), (button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Delete annotation']);
    expect(popover.element.textContent).not.toMatch(
      /Save|Cancel|Add Text|Link|Tag|Document tags|Settings/u,
    );

    popover.destroy();
    host.remove();
  });

  it('keeps raw comment bytes exact on open close and ordinary prose edits', () => {
    vi.useFakeTimers();
    try {
      const host = document.body.createDiv();
      const source = '  Привет\n\t#タグ [[Note|Alias]] [[Note#Heading]]  ';
      const annotation = editableAnnotation({ comment: source });
      const onCreate = vi.fn();
      const onDelete = vi.fn();
      const onUpdate = vi.fn();
      const popover = new AnnotationEditorPopover(host);
      const request = {
        ...editorRequest({ annotation, kind: 'annotation' as const }),
        onCreate,
        onDelete,
        onUpdate,
      };

      popover.open(request);
      const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
      if (comment === null) throw new Error('Expected one comment textarea.');
      expect(comment.value).toBe(source);
      expect(popover.close('external')).toBe(true);
      expect({
        creates: onCreate.mock.calls,
        deletes: onDelete.mock.calls,
        updates: onUpdate.mock.calls,
      }).toEqual({ creates: [], deletes: [], updates: [] });

      popover.open(request);
      const edited = '  Revised Привет\n\t#タグ [[Note|Alias]] [[Note#Heading]]  ';
      comment.value = edited;
      comment.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(300);

      expect(onUpdate).toHaveBeenCalledOnce();
      expect(onUpdate).toHaveBeenLastCalledWith({ annotations: [annotation], comment: edited });
      popover.destroy();
      host.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses a fresh selection with X without creating or deleting an annotation', () => {
    const host = document.body.createDiv();
    const quote = host.createSpan({ text: 'Selected passage' });
    const range = document.createRange();
    range.selectNodeContents(quote);
    document.getSelection()?.addRange(range);
    const onClose = vi.fn();
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onClose,
      onCreate,
      onDelete,
    });

    const dismiss = popover.element.querySelector<HTMLButtonElement>(
      '[data-action="dismiss-selection"]',
    );
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss selection');
    expect(document.getSelection()?.rangeCount).toBe(1);
    expect(popover.element.querySelector('[data-action="delete-annotation"]')).toBeNull();
    dismiss?.click();

    expect({ creates: onCreate.mock.calls, deletes: onDelete.mock.calls }).toEqual({
      creates: [],
      deletes: [],
    });
    expect(onClose).toHaveBeenCalledWith('external');
    expect(popover.element.hidden).toBe(true);
    expect(document.getSelection()?.rangeCount).toBe(0);
    popover.destroy();
    host.remove();
  });

  it('lets X cancel pending creation and ignores its late resolution', async () => {
    const host = document.body.createDiv();
    const quote = host.createSpan({ text: 'Selected passage' });
    const range = document.createRange();
    range.selectNodeContents(quote);
    document.getSelection()?.addRange(range);
    const creation = deferred<DocumentAnnotation>();
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onClose,
      onCreate: () => creation.promise,
      onUpdate,
    });
    editComment(popover, 'Pending draft');

    popover.element.querySelector<HTMLButtonElement>('[data-action="dismiss-selection"]')?.click();
    expect(popover.element.hidden).toBe(true);
    expect(document.getSelection()?.rangeCount).toBe(0);
    expect(onClose).toHaveBeenCalledWith('external');

    creation.resolve(editableAnnotation({ comment: 'Pending draft' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.element.hidden).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
    popover.destroy();
    host.remove();
  });

  it('handles a late rejection after X cancels pending creation', async () => {
    const host = document.body.createDiv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const creation = deferred<DocumentAnnotation>();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate: () => creation.promise,
    });
    editComment(popover, 'Pending draft');
    popover.element.querySelector<HTMLButtonElement>('[data-action="dismiss-selection"]')?.click();

    creation.reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.element.hidden).toBe(true);
    expect(log).not.toHaveBeenCalled();
    popover.destroy();
    host.remove();
  });

  it('returns a dismissed selection creation to its editable draft state', async () => {
    const host = document.body.createDiv();
    const onCreate = vi
      .fn()
      .mockReturnValueOnce('dismissed' as const)
      .mockReturnValueOnce('created' as const);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate,
    });

    editComment(popover, 'First draft');
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(popover.element.querySelector('[data-action="dismiss-selection"]')).not.toBeNull();
    expect(popover.element.querySelector('[data-action="delete-annotation"]')).toBeNull();

    editComment(popover, 'Retry draft');
    expect(onCreate).toHaveBeenCalledTimes(2);

    popover.destroy();
    host.remove();
  });

  it('uses contained fixed origins and scrollable visual-viewport bounds', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 0, 120, 80),
    });
    Object.defineProperty(host, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(100, 50, 400, 400),
    });
    Object.defineProperty(popover.element, 'offsetParent', {
      configurable: true,
      value: host,
    });
    Object.defineProperty(host.win, 'visualViewport', {
      configurable: true,
      value: { height: 400, offsetLeft: 40, offsetTop: 20, width: 500 },
    });
    popover.open({
      ...editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }),
      position: { x: 490, y: 400 },
    });
    expect({
      left: popover.element.style.left,
      maxHeight: popover.element.style.maxHeight,
      maxWidth: popover.element.style.maxWidth,
      overflow: popover.element.dataset['overflow'],
      top: popover.element.style.top,
    }).toEqual({
      left: '272px',
      maxHeight: '354px',
      maxWidth: '304px',
      overflow: 'scroll',
      top: '264px',
    });

    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 0, 176, 200),
    });
    Object.defineProperty(popover.element, 'offsetParent', { configurable: true, value: null });
    Object.defineProperty(host.win, 'visualViewport', {
      configurable: true,
      value: { height: 120, offsetLeft: 40, offsetTop: 20, width: 180 },
    });
    popover.open({
      ...editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }),
      position: { x: 100, y: 60 },
    });
    expect({
      left: popover.element.style.left,
      maxHeight: popover.element.style.maxHeight,
      maxWidth: popover.element.style.maxWidth,
      top: popover.element.style.top,
    }).toEqual({ left: '48px', maxHeight: '104px', maxWidth: '164px', top: '28px' });

    Reflect.deleteProperty(host.win, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('keeps an eight-pixel inset and flips a selection popover above the viewport edge', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 0, 250, 80),
    });
    Object.defineProperty(popover.element, 'offsetParent', { configurable: true, value: null });
    Object.defineProperty(host.win, 'visualViewport', {
      configurable: true,
      value: { height: 200, offsetLeft: 0, offsetTop: 0, width: 260 },
    });
    const selected = selection();
    const edgeSelection: PdfTextSelection = {
      ...selected,
      clientRect: { ...selected.clientRect, bottom: 186, left: 0, top: 170 },
      clientRects: [{ ...selected.clientRect, bottom: 186, left: 0, top: 170 }],
    };

    popover.open({
      ...editorRequest({ kind: 'selection', selection: edgeSelection }),
      position: undefined,
    });

    expect({ left: popover.element.style.left, top: popover.element.style.top }).toEqual({
      left: '8px',
      top: '84px',
    });
    Reflect.deleteProperty(host.win, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('creates lazily on first non-empty comment and keeps one creation through a later swatch', async () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    const chosenSelection = selection();
    const immediateCreate = vi.fn(() => editableAnnotation({ color: '#5fb236' }));
    popover.open({
      ...editorRequest({ kind: 'selection', selection: chosenSelection }),
      onCreate: immediateCreate,
    });

    expect(immediateCreate).not.toHaveBeenCalled();
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    await Promise.resolve();
    expect(immediateCreate).toHaveBeenCalledWith({
      color: '#5fb236',
      comment: '',
      selection: chosenSelection,
    });
    expect(popover.element.hidden).toBe(false);

    const lazyResult = deferred<DocumentAnnotation>();
    const lazyCreate = vi.fn(() => lazyResult.promise);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: chosenSelection }),
      onCreate: lazyCreate,
    });
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    expect(lazyCreate).not.toHaveBeenCalled();
    comment.value = 'Draft thought';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    expect(lazyCreate).toHaveBeenCalledOnce();
    expect(lazyCreate).toHaveBeenCalledWith({
      color: '#ffd400',
      comment: 'Draft thought',
      selection: chosenSelection,
    });
    comment.value = 'Draft thought #review [[Source]]';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#ffd400"]')?.click();
    expect(lazyCreate).toHaveBeenCalledOnce();
    lazyResult.resolve(editableAnnotation());
    await Promise.resolve();
    expect(popover.element.hidden).toBe(false);

    popover.destroy();
    host.remove();
  });

  it('uses the built-in yellow when a selection has neither a palette nor an explicit color', async () => {
    const host = document.body.createDiv();
    const selected = selection();
    const onCreate = vi.fn(() => 'created' as const);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selected }),
      onCreate,
      palette: [],
    });

    editComment(popover, 'Default color draft');
    await Promise.resolve();
    await Promise.resolve();

    expect(onCreate).toHaveBeenCalledWith({
      color: '#ffd400',
      comment: 'Default color draft',
      selection: selected,
    });
    popover.destroy();
    host.remove();
  });

  it('does not write a second update when native selection creation already contains the draft', async () => {
    const host = document.body.createDiv();
    const selected = selection();
    const exact = editableAnnotation({ comment: 'Native already has this draft' });
    const onCreate = vi.fn(() => exact);
    const onUpdate = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selected }),
      onCreate,
      onUpdate,
    });

    editComment(popover, exact.comment);
    await Promise.resolve();
    await Promise.resolve();

    expect(onCreate).toHaveBeenCalledWith({
      color: '#ffd400',
      comment: exact.comment,
      selection: selected,
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(popover.hasPendingChanges).toBe(false);
    expect(popover.element.querySelector('[data-action="delete-annotation"]')).not.toBeNull();

    popover.destroy();
    host.remove();
  });

  it('applies the latest draft after deferred creation on the same open generation', async () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    const creation = deferred<DocumentAnnotation>();
    const onCreate = vi.fn(() => creation.promise);
    const onSelectionPreview = vi.fn();
    const onUpdate = vi.fn();
    const selected = selection();
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selected }),
      onCreate,
      onSelectionPreview,
      onUpdate,
    });
    const sameNode = popover.element;
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');

    comment.value = 'Initial draft #Fresh [[New note]]';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    expect(onCreate).toHaveBeenCalledOnce();
    comment.value = 'Latest draft #Fresh [[New note]]';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onSelectionPreview).toHaveBeenLastCalledWith({
      color: '#5fb236',
      comment: 'Latest draft #Fresh [[New note]]',
      selection: selected,
    });

    const created = editableAnnotation({
      color: '#5fb236',
      comment: 'Initial draft #Fresh [[New note]]',
    });
    creation.resolve(created);
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.element).toBe(sameNode);
    expect(comment.value).toBe('Latest draft #Fresh [[New note]]');
    expect(
      popover.element.querySelector('[data-editor-color="#5fb236"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(onUpdate).toHaveBeenLastCalledWith({
      annotations: [created],
      comment: 'Latest draft #Fresh [[New note]]',
    });

    popover.destroy();
    host.remove();
  });

  it('adopts a natively materialized selection draft without creating it twice', () => {
    const host = document.body.createDiv();
    const materialized = editableAnnotation({ color: '#5fb236', comment: 'Original native value' });
    const onCreate = vi.fn();
    const onUpdate = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate,
      onUpdate,
    });
    editComment(popover, 'Draft retained after materialization');

    expect(popover.updateTarget({ annotation: materialized, kind: 'annotation' })).toBe(true);
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith({
      annotations: [materialized],
      color: '#ffd400',
      comment: 'Draft retained after materialization',
    });
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Draft retained after materialization');
    expect(
      popover.element.querySelector('[data-editor-color="#ffd400"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(popover.element.querySelector('[data-action="delete-annotation"]')).not.toBeNull();

    popover.destroy();
    host.remove();
  });

  it('does not resurrect a closed selection when native materialization arrives late', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    popover.open(editorRequest({ kind: 'selection', selection: selection() }));

    expect(popover.close('external')).toBe(true);
    expect(popover.updateTarget({ annotation: editableAnnotation(), kind: 'annotation' })).toBe(
      false,
    );
    expect(popover.isOpen).toBe(false);
    expect(popover.element.hidden).toBe(true);

    popover.destroy();
    host.remove();
  });

  it('returns a refreshed target to selection lifecycle without retaining annotation actions', () => {
    const host = document.body.createDiv();
    const selected = selection();
    const onCreate = vi.fn(() => 'created' as const);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }),
      onCreate,
    });

    expect(popover.updateTarget({ kind: 'selection', selection: selected })).toBe(true);
    expect(popover.element.querySelector('[data-action="delete-annotation"]')).toBeNull();
    expect(popover.element.querySelector('[data-action="dismiss-selection"]')).not.toBeNull();

    editComment(popover, 'Replacement selection draft');
    expect(onCreate).toHaveBeenCalledWith({
      color: '#ffd400',
      comment: 'Replacement selection draft',
      selection: selected,
    });

    popover.destroy();
    host.remove();
  });

  it('keeps a failed creation draft connected and retryable', async () => {
    const host = document.body.createDiv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('creation failed');
    const created = editableAnnotation({ comment: 'Retry me' });
    const onCreate = vi
      .fn<Parameters<AnnotationEditorPopover['open']>[0]['onCreate']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(created);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate,
    });
    const sameNode = popover.element;
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.value = 'Retry me';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(popover.element).toBe(sameNode);
    expect(popover.element.isConnected).toBe(true);
    expect(popover.element.hidden).toBe(false);
    expect(comment.value).toBe('Retry me');
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(popover.element.querySelector('[data-action="delete-annotation"]')).not.toBeNull();
    expect(log).toHaveBeenCalledWith('[abyss-documents] Could not create selection annotation', {
      cause: failure,
    });

    popover.destroy();
    host.remove();
  });

  it('ignores native focus transfer while a selection creation is still committing', async () => {
    const host = document.body.createDiv();
    const nativeLayer = document.body.createDiv({ cls: 'annotationEditorLayer' });
    const nativeEditor = nativeLayer.createEl('button', { cls: 'highlightEditor' });
    const creation = deferred<DocumentAnnotation>();
    const request = {
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate: () => creation.promise,
    };
    const popover = new AnnotationEditorPopover(host);
    popover.open(request);
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#ffd400"]')?.click();

    nativeEditor.focus();

    expect(popover.element.hidden).toBe(false);
    expect(request.onClose).not.toHaveBeenCalled();
    creation.resolve(editableAnnotation());
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.element.hidden).toBe(false);
    popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.focus();
    nativeEditor.focus();
    expect(popover.element.hidden).toBe(false);
    nativeEditor.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(popover.element.hidden).toBe(false);

    popover.destroy();
    nativeLayer.remove();
    host.remove();
  });

  it.each([
    {
      dismiss: () =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
        ),
      label: 'Escape',
      reason: 'escape',
    },
    {
      dismiss: () =>
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })),
      label: 'click-away',
      reason: 'click-away',
    },
  ] as const)(
    'cancels pending creation on $label and ignores its late resolution',
    async ({ dismiss, reason }) => {
      const host = document.body.createDiv();
      const quote = host.createSpan({ text: 'Selected passage' });
      const range = document.createRange();
      range.selectNodeContents(quote);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      const creation = deferred<DocumentAnnotation>();
      const onClose = vi.fn();
      const onUpdate = vi.fn();
      const popover = new AnnotationEditorPopover(host);
      popover.open({
        ...editorRequest({ kind: 'selection', selection: selection() }),
        onClose,
        onCreate: () => creation.promise,
        onUpdate,
      });
      editComment(popover, 'Initial draft #Fresh [[Closed note]]');
      editComment(popover, 'Latest draft #Fresh [[Closed note]]');

      dismiss();
      expect(popover.element.hidden).toBe(true);
      expect(document.getSelection()?.rangeCount).toBe(0);
      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledWith(reason);

      creation.resolve(editableAnnotation({ comment: 'Initial draft #Fresh [[Closed note]]' }));
      await Promise.resolve();
      await Promise.resolve();
      expect(popover.element.hidden).toBe(true);
      expect(onUpdate).not.toHaveBeenCalled();
      popover.destroy();
      host.remove();
    },
  );

  it.each([
    {
      dismiss: () =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
        ),
      label: 'Escape',
      reason: 'escape',
    },
    {
      dismiss: () =>
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })),
      label: 'click-away',
      reason: 'click-away',
    },
  ] as const)(
    'cancels pending creation on $label and handles its late rejection',
    async ({ dismiss, reason }) => {
      const host = document.body.createDiv();
      const quote = host.createSpan({ text: 'Selected passage' });
      const range = document.createRange();
      range.selectNodeContents(quote);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const creation = deferred<DocumentAnnotation>();
      const onClose = vi.fn();
      const onUpdate = vi.fn();
      const popover = new AnnotationEditorPopover(host);
      popover.open({
        ...editorRequest({ kind: 'selection', selection: selection() }),
        onClose,
        onCreate: () => creation.promise,
        onUpdate,
      });
      editComment(popover, 'Pending draft');

      dismiss();
      expect(popover.element.hidden).toBe(true);
      expect(document.getSelection()?.rangeCount).toBe(0);
      expect(onClose).toHaveBeenCalledWith(reason);

      creation.reject(new Error('late failure'));
      await Promise.resolve();
      await Promise.resolve();
      expect(popover.element.hidden).toBe(true);
      expect(onUpdate).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      popover.destroy();
      host.remove();
    },
  );

  it('persists a replaced pending creation draft without disturbing the replacement UI', async () => {
    const host = document.body.createDiv();
    const creation = deferred<DocumentAnnotation>();
    const onUpdate = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate: () => creation.promise,
      onUpdate,
    });
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.value = 'Initial draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    comment.value = 'Replacement draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));

    const replacement = editableAnnotation({ comment: 'Replacement target' });
    popover.open({ ...editorRequest({ annotation: replacement, kind: 'annotation' }), onUpdate });
    const created = editableAnnotation({ color: '#5fb236', comment: 'Initial draft' });
    creation.resolve(created);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Replacement target');
    expect(onUpdate).toHaveBeenCalledWith({
      annotations: [created],
      comment: 'Replacement draft',
    });

    popover.destroy();
    host.remove();
  });

  it('completes tag and link caret tokens in the same comment by keyboard and pointer', () => {
    vi.useFakeTimers();
    try {
      const host = document.body.createDiv();
      const suggest = vi.fn((kind: 'link' | 'tag', query: string, sourcePath: string) => {
        if (sourcePath !== 'Books/Book.pdf') return [];
        if (kind === 'tag' && query === 'to') return [{ display: '#topic', insertion: '#topic' }];
        if (kind === 'link' && query === 'No')
          return [{ display: 'Note', insertion: '[[Note|Alias]]', path: 'Notes/Note.md' }];
        return [];
      });
      const popover = new AnnotationEditorPopover(host, { suggest }, 'Books/Book.pdf');
      const onUpdate = vi.fn();
      const onPreviewUpdate = vi.fn();
      const annotation = editableAnnotation({ comment: 'Review #to … see [[No after' });
      popover.open({
        ...editorRequest({ annotation, kind: 'annotation' }),
        onPreviewUpdate,
        onUpdate,
      });

      popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
      expect(onUpdate).toHaveBeenLastCalledWith({ annotations: [annotation], color: '#5fb236' });

      const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
      if (comment === null) throw new Error('Expected the comment textarea.');
      comment.setSelectionRange(10, 10);
      comment.dispatchEvent(new Event('select', { bubbles: true }));
      expect(popover.element.querySelector('[role="listbox"]')?.textContent).toBe('#topic');
      expect(comment.getAttribute('aria-activedescendant')).toBe(
        popover.element.querySelector('[role="option"][aria-selected="true"]')?.id,
      );
      comment.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      expect(comment.value).toBe('Review #topic … see [[No after');

      const linkCursor = comment.value.indexOf('No') + 2;
      comment.setSelectionRange(linkCursor, linkCursor);
      comment.dispatchEvent(new Event('select', { bubbles: true }));
      popover.element
        .querySelector<HTMLElement>('[role="option"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(comment.value).toBe('Review #topic … see [[Note|Alias]] after');
      expect(suggest).toHaveBeenCalledWith('tag', 'to', 'Books/Book.pdf');
      expect(suggest).toHaveBeenCalledWith('link', 'No', 'Books/Book.pdf');
      expect(onPreviewUpdate).toHaveBeenLastCalledWith({
        annotations: [annotation],
        comment: 'Review #topic … see [[Note|Alias]] after',
      });

      vi.advanceTimersByTime(299);
      expect(onUpdate).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(onUpdate).toHaveBeenLastCalledWith({
        annotations: [annotation],
        comment: 'Review #topic … see [[Note|Alias]] after',
      });

      popover.destroy();
      host.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps keyboard autocomplete focus and applies only the active suggestion', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(
      host,
      {
        suggest: () => [
          { display: '#todo', insertion: '#todo' },
          { display: '#topic', insertion: '#topic' },
        ],
      },
      'Books/Book.pdf',
    );
    const annotation = editableAnnotation({ comment: 'Review #to' });
    popover.open(editorRequest({ annotation, kind: 'annotation' }));
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.setSelectionRange(comment.value.length, comment.value.length);
    comment.dispatchEvent(new Event('select', { bubbles: true }));

    const first = popover.element.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    expect(first?.textContent).toBe('#todo');

    const up = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowUp' });
    comment.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    expect(comment.value).toBe('Review #to');
    expect(
      popover.element.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
        ?.textContent,
    ).toBe('#topic');

    const down = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowDown',
    });
    comment.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(
      popover.element.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
        ?.textContent,
    ).toBe('#todo');

    comment.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowUp' }),
    );
    comment.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }),
    );
    expect(comment.value).toBe('Review #topic');
    expect(popover.element.querySelector('[role="listbox"]')?.hasAttribute('hidden')).toBe(true);

    popover.destroy();
    host.remove();
  });

  it('dismisses stale autocomplete choices instead of replacing changed or selected text', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(
      host,
      { suggest: () => [{ display: '#topic', insertion: '#topic' }] },
      'Books/Book.pdf',
    );
    popover.open(
      editorRequest({ annotation: editableAnnotation({ comment: '#to' }), kind: 'annotation' }),
    );
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');

    comment.setSelectionRange(3, 3);
    comment.dispatchEvent(new Event('select', { bubbles: true }));
    comment.value = '#different';
    comment.setSelectionRange(comment.value.length, comment.value.length);
    comment.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }),
    );
    expect(comment.value).toBe('#different');
    expect(popover.element.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);

    comment.value = '#to';
    comment.setSelectionRange(3, 3);
    comment.dispatchEvent(new Event('select', { bubbles: true }));
    comment.setSelectionRange(0, 3);
    comment.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }),
    );
    expect(comment.value).toBe('#to');
    expect(popover.element.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);

    popover.destroy();
    host.remove();
  });

  it('accepts a draft suggestion with Enter without creating a second annotation', () => {
    const host = document.body.createDiv();
    const suggest = vi.fn(() => [{ display: '#topic', insertion: '#topic' }]);
    const onCreate = vi.fn(() => 'created' as const);
    const popover = new AnnotationEditorPopover(host, { suggest }, 'Books/Book.pdf');
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate,
    });
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.value = '#to';
    comment.setSelectionRange(3, 3);
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    comment.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));

    expect(comment.value).toBe('#topic');
    expect(onCreate).toHaveBeenCalledOnce();
    popover.destroy();
    host.remove();
  });

  it('closes suggestions on first Escape and the popover on second Escape', () => {
    const host = document.body.createDiv();
    const onClose = vi.fn();
    const popover = new AnnotationEditorPopover(
      host,
      { suggest: () => [{ display: '#topic', insertion: '#topic' }] },
      'Books/Book.pdf',
    );
    popover.open({
      ...editorRequest({ annotation: editableAnnotation({ comment: '#to' }), kind: 'annotation' }),
      onClose,
    });
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.setSelectionRange(3, 3);
    comment.dispatchEvent(new Event('select', { bubbles: true }));
    comment.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );

    expect(popover.isOpen).toBe(true);
    expect(popover.element.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);
    comment.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(popover.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledWith('escape');
    popover.destroy();
    host.remove();
  });

  it('reverts the pressed color when its immediate update is rejected', () => {
    const host = document.body.createDiv();
    const annotation = editableAnnotation();
    const onUpdate = vi.fn(() => false);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation, kind: 'annotation' }),
      onUpdate,
    });

    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    expect(annotation.color).toBe('#ffd400');
    expect(
      popover.element.querySelector('[data-editor-color="#ffd400"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      popover.element.querySelector('[data-editor-color="#5fb236"]')?.getAttribute('aria-pressed'),
    ).toBe('false');

    onUpdate.mockReturnValue(true);
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    expect(
      popover.element.querySelector('[data-editor-color="#5fb236"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    popover.destroy();
    host.remove();
  });

  it.each([
    ['rejects', (): boolean => false],
    [
      'throws',
      (): boolean => {
        throw new Error('metadata write failed');
      },
    ],
  ] as const)(
    'reverts an optimistic metadata preview when native persistence %s',
    (_label, persist) => {
      const host = document.body.createDiv();
      const annotation = editableAnnotation({ comment: 'Persisted #Original' });
      const onPreviewUpdate = vi.fn();
      const onPreviewRevert = vi.fn();
      const onUpdate = vi.fn(persist);
      const popover = new AnnotationEditorPopover(host);
      popover.open({
        ...editorRequest({ annotation, kind: 'annotation' }),
        onPreviewRevert,
        onPreviewUpdate,
        onUpdate,
      });

      editComment(popover, 'Unsaved');
      expect(onPreviewUpdate).toHaveBeenLastCalledWith({
        annotations: [annotation],
        comment: 'Unsaved',
      });
      if (_label === 'throws') expect(() => popover.flushPendingChanges()).toThrow('failed');
      else expect(popover.flushPendingChanges()).toBe(false);
      expect(onPreviewRevert).toHaveBeenLastCalledWith({
        annotations: [annotation],
        comment: 'Persisted #Original',
      });
      expect(popover.isOpen).toBe(true);

      onUpdate.mockReturnValue(true);
      expect(popover.destroy()).toBe(true);
      host.remove();
    },
  );

  it('retains a rejected deferred creation delta for explicit retry', async () => {
    const host = document.body.createDiv();
    const creation = deferred<DocumentAnnotation>();
    const onUpdate = vi.fn(() => false);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate: () => creation.promise,
      onUpdate,
    });
    editComment(popover, 'Rejected creation draft');
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();

    const created = editableAnnotation({ color: '#ffd400', comment: '' });
    creation.resolve(created);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Rejected creation draft');
    expect(
      popover.element.querySelector('[data-editor-color="#5fb236"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(popover.hasPendingChanges).toBe(true);

    onUpdate.mockReturnValue(true);
    expect(popover.retryPendingUpdates()).toBe(true);
    expect(popover.hasPendingChanges).toBe(false);
    expect(onUpdate).toHaveBeenLastCalledWith({
      annotations: [created],
      color: '#5fb236',
      comment: 'Rejected creation draft',
    });

    popover.destroy();
    host.remove();
  });

  it('does not replay a rejected creation delta after newer comment and color updates succeed', async () => {
    vi.useFakeTimers();
    try {
      const host = document.body.createDiv();
      const creation = deferred<DocumentAnnotation>();
      const onUpdate = vi.fn(() => true).mockReturnValueOnce(false);
      const popover = new AnnotationEditorPopover(host);
      popover.open({
        ...editorRequest({ kind: 'selection', selection: selection() }),
        onCreate: () => creation.promise,
        onUpdate,
      });
      editComment(popover, 'Rejected creation draft');
      popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();

      const created = editableAnnotation({ color: '#ffd400', comment: '' });
      creation.resolve(created);
      await Promise.resolve();
      await Promise.resolve();
      expect(popover.hasPendingChanges).toBe(true);

      editComment(popover, 'Newer accepted comment');
      vi.advanceTimersByTime(300);
      popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#ffd400"]')?.click();
      expect(onUpdate).toHaveBeenNthCalledWith(2, {
        annotations: [created],
        comment: 'Newer accepted comment',
      });
      expect(onUpdate).toHaveBeenNthCalledWith(3, {
        annotations: [created],
        color: '#ffd400',
      });
      expect(popover.hasPendingChanges).toBe(false);

      expect(popover.close('external')).toBe(true);
      expect(popover.retryPendingUpdates()).toBe(true);
      expect(onUpdate).toHaveBeenCalledTimes(3);

      popover.destroy();
      host.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failed creation draft when a later update belongs to another annotation', async () => {
    const host = document.body.createDiv();
    const creation = deferred<DocumentAnnotation>();
    const created = editableAnnotation({ comment: '' });
    const replacement = editableAnnotation({
      identity: { id: asAnnotationId('annotation-2'), kind: 'stable' },
    });
    const onUpdate = vi.fn(() => true).mockReturnValueOnce(false);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate: () => creation.promise,
      onUpdate,
    });
    editComment(popover, 'Draft for the first annotation');
    popover.open({ ...editorRequest({ annotation: replacement, kind: 'annotation' }), onUpdate });

    creation.resolve(created);
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.hasPendingChanges).toBe(true);

    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    expect(onUpdate).toHaveBeenNthCalledWith(2, {
      annotations: [replacement],
      color: '#5fb236',
    });
    expect(popover.hasPendingChanges).toBe(true);

    expect(popover.retryPendingUpdates()).toBe(true);
    expect(onUpdate).toHaveBeenLastCalledWith({
      annotations: [created],
      comment: 'Draft for the first annotation',
    });

    popover.destroy();
    host.remove();
  });

  it('refreshes suggestions on caret selection and rejects stale Enter or click origins', () => {
    const host = document.body.createDiv();
    const suggest = vi.fn((_kind: 'link' | 'tag', query: string) => {
      if (query === 'con')
        return [{ display: 'Concept', insertion: '[[Concept]]', path: 'Concept.md' }];
      if (query === 'oth') return [{ display: 'Other', insertion: '[[Other]]', path: 'Other.md' }];
      return [];
    });
    const popover = new AnnotationEditorPopover(host, { suggest });
    popover.open(editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }));
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');

    comment.value = '[[con]] [[oth]]';
    comment.setSelectionRange(5, 5);
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    expect(popover.element.querySelector('[role="listbox"]')?.textContent).toBe('Concept');
    comment.setSelectionRange(13, 13);
    comment.dispatchEvent(new Event('select', { bubbles: true }));
    expect(popover.element.querySelector('[role="listbox"]')?.textContent).toBe('Other');

    comment.value = '[[con]] [[changed]]';
    comment.setSelectionRange(17, 17);
    comment.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(comment.value).toBe('[[con]] [[changed]]');
    expect(popover.element.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);

    comment.value = '[[con]]';
    comment.setSelectionRange(5, 5);
    comment.dispatchEvent(new Event('select', { bubbles: true }));
    const staleOption = popover.element.querySelector<HTMLElement>('[role="option"]');
    if (staleOption === null) throw new Error('Expected suggestion option.');
    comment.value = '[[changed]]';
    comment.setSelectionRange(9, 9);
    staleOption.click();
    expect(comment.value).toBe('[[changed]]');
    expect(popover.element.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);

    popover.destroy();
    host.remove();
  });

  it('flushes sub-debounce metadata before open replacement, target refresh, and destroy', () => {
    vi.useFakeTimers();
    try {
      const host = document.body.createDiv();
      const popover = new AnnotationEditorPopover(host);
      const onUpdate = vi.fn();
      const first = editableAnnotation();
      const second = editableAnnotation({
        comment: 'Second source #Two',
        identity: { id: asAnnotationId('annotation-2'), kind: 'stable' },
        links: [],
        tags: ['Two'],
      });
      const third = editableAnnotation({
        comment: 'Third source #Three',
        identity: { id: asAnnotationId('annotation-3'), kind: 'stable' },
        links: [],
        tags: ['Three'],
      });
      popover.open({ ...editorRequest({ annotation: first, kind: 'annotation' }), onUpdate });
      editComment(popover, 'Before replacement');
      popover.open({ ...editorRequest({ annotation: second, kind: 'annotation' }), onUpdate });
      expect(onUpdate).toHaveBeenNthCalledWith(1, {
        annotations: [first],
        comment: 'Before replacement',
      });

      editComment(popover, 'Before refresh');
      popover.updateTarget({ annotation: third, kind: 'annotation' });
      expect(onUpdate).toHaveBeenNthCalledWith(2, {
        annotations: [second],
        comment: 'Before refresh',
      });
      expect(
        popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
      ).toBe('Third source #Three');

      editComment(popover, 'Before destroy');
      popover.destroy();
      expect(onUpdate).toHaveBeenNthCalledWith(3, {
        annotations: [third],
        comment: 'Before destroy',
      });
      expect(onUpdate).toHaveBeenCalledTimes(3);
      host.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('vetoes open replacement when the current draft update is rejected', () => {
    const host = document.body.createDiv();
    const first = editableAnnotation();
    const second = editableAnnotation({
      comment: 'Second source',
      identity: { id: asAnnotationId('annotation-2'), kind: 'stable' },
    });
    const onUpdate = vi.fn(() => false);
    const popover = new AnnotationEditorPopover(host);
    expect(
      popover.open({ ...editorRequest({ annotation: first, kind: 'annotation' }), onUpdate }),
    ).toBe(true);
    editComment(popover, 'Rejected replacement draft');

    expect(
      popover.open({ ...editorRequest({ annotation: second, kind: 'annotation' }), onUpdate }),
    ).toBe(false);
    expect(popover.isOpen).toBe(true);
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Rejected replacement draft');

    onUpdate.mockReturnValue(true);
    expect(
      popover.open({ ...editorRequest({ annotation: second, kind: 'annotation' }), onUpdate }),
    ).toBe(true);
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Second source');
    popover.destroy();
    host.remove();
  });

  it('vetoes target refresh when the current draft update is rejected', () => {
    const host = document.body.createDiv();
    const first = editableAnnotation();
    const second = editableAnnotation({
      comment: 'Second source',
      identity: { id: asAnnotationId('annotation-2'), kind: 'stable' },
    });
    const onUpdate = vi.fn(() => false);
    const popover = new AnnotationEditorPopover(host);
    popover.open({ ...editorRequest({ annotation: first, kind: 'annotation' }), onUpdate });
    editComment(popover, 'Rejected refresh draft');

    expect(popover.updateTarget({ annotation: second, kind: 'annotation' })).toBe(false);
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Rejected refresh draft');

    onUpdate.mockReturnValue(true);
    expect(popover.updateTarget({ annotation: second, kind: 'annotation' })).toBe(true);
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Second source');
    popover.destroy();
    host.remove();
  });

  it('vetoes close and preserves its callback state when the current draft update is rejected', () => {
    const host = document.body.createDiv();
    const onClose = vi.fn();
    const onUpdate = vi.fn(() => false);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }),
      onClose,
      onUpdate,
    });
    editComment(popover, 'Rejected close draft');

    expect(popover.close('external')).toBe(false);
    expect(popover.isOpen).toBe(true);
    expect(popover.element.hidden).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    onUpdate.mockReturnValue(true);
    expect(popover.close('external')).toBe(true);
    expect(popover.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledWith('external');
    popover.destroy();
    host.remove();
  });

  it('vetoes destroy without removing state when the current draft update is rejected', () => {
    const host = document.body.createDiv();
    const onUpdate = vi.fn(() => false);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }),
      onUpdate,
    });
    editComment(popover, 'Rejected destroy draft');

    expect(popover.destroy()).toBe(false);
    expect(popover.isOpen).toBe(true);
    expect(popover.element.isConnected).toBe(true);
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Rejected destroy draft');

    onUpdate.mockReturnValue(true);
    expect(popover.destroy()).toBe(true);
    expect(popover.isOpen).toBe(false);
    expect(popover.element.isConnected).toBe(false);
    host.remove();
  });

  it('flushes a dirty draft before delete and never updates after deletion', () => {
    const host = document.body.createDiv();
    const annotation = editableAnnotation();
    const events: string[] = [];
    const onClose = vi.fn(() => {
      events.push('close');
    });
    const onDelete = vi.fn(() => {
      events.push('delete');
      return true;
    });
    const onUpdate = vi.fn(() => {
      events.push('update');
      return true;
    });
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation, kind: 'annotation' }),
      onClose,
      onDelete,
      onUpdate,
    });
    editComment(popover, 'Saved before delete');

    popover.element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();

    expect(events).toEqual(['update', 'delete', 'close']);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith({
      annotations: [annotation],
      comment: 'Saved before delete',
    });
    expect(onDelete).toHaveBeenCalledWith([annotation]);
    expect(popover.isOpen).toBe(false);
    popover.destroy();
    host.remove();
  });

  it('keeps a committed annotation open when its deletion is vetoed', () => {
    const host = document.body.createDiv();
    const annotation = editableAnnotation({ comment: 'Keep this note' });
    const onClose = vi.fn();
    const onDelete = vi.fn(() => false);
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation, kind: 'annotation' }),
      onClose,
      onDelete,
    });

    popover.element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();

    expect(onDelete).toHaveBeenCalledWith([annotation]);
    expect(onClose).not.toHaveBeenCalled();
    expect(popover.isOpen).toBe(true);
    expect(popover.element.hidden).toBe(false);

    popover.destroy();
    host.remove();
  });

  it('vetoes delete when the dirty draft flush is rejected and preserves retry ordering', () => {
    const host = document.body.createDiv();
    const annotation = editableAnnotation();
    const events: string[] = [];
    let acceptUpdate = false;
    const onClose = vi.fn(() => {
      events.push('close');
    });
    const onDelete = vi.fn(() => {
      events.push('delete');
      return true;
    });
    const onUpdate = vi.fn(() => {
      events.push(acceptUpdate ? 'update:accepted' : 'update:rejected');
      return acceptUpdate;
    });
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation, kind: 'annotation' }),
      onClose,
      onDelete,
      onUpdate,
    });
    editComment(popover, 'Rejected before delete');

    popover.element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(events).toEqual(['update:rejected']);
    expect(onDelete).not.toHaveBeenCalled();
    expect(popover.isOpen).toBe(true);
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Rejected before delete');

    acceptUpdate = true;
    popover.element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(events).toEqual(['update:rejected', 'update:accepted', 'delete', 'close']);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(popover.isOpen).toBe(false);
    popover.destroy();
    host.remove();
  });

  it('preserves selection pointer-down and transitions the same node through focus-safe lifecycle closes', async () => {
    const host = document.body.createDiv();
    const invoker = host.createEl('button');
    invoker.focus();
    const created = editableAnnotation({ color: '#5fb236' });
    const onCreate = vi.fn(async () => created);
    const onClose = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    const chosenSelection = selection();
    const openSelection = () => {
      popover.open({
        ...editorRequest({ kind: 'selection', selection: chosenSelection }),
        onClose,
        onCreate,
      });
    };
    openSelection();
    const sameNode = popover.element;
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.value = 'Caret range';
    comment.setSelectionRange(2, 7);
    const insidePointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    comment.dispatchEvent(insidePointer);
    expect(insidePointer.defaultPrevented).toBe(false);
    expect([comment.selectionStart, comment.selectionEnd]).toEqual([2, 7]);
    const editable = host.createDiv();
    editable.setAttribute('contenteditable', 'true');
    popover.element.append(editable);
    const editablePointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    editable.dispatchEvent(editablePointer);
    expect(editablePointer.defaultPrevented).toBe(false);
    const swatchPointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    popover.element.querySelector('[data-editor-color]')?.dispatchEvent(swatchPointer);
    expect(swatchPointer.defaultPrevented).toBe(true);
    comment.focus();
    expect(host.ownerDocument.activeElement).toBe(comment);
    expect(popover.element.hidden).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.element).toBe(sameNode);
    expect(popover.element.isConnected).toBe(true);
    expect(popover.element.hidden).toBe(false);
    expect(popover.element.querySelector('[data-action="delete-annotation"]')).not.toBeNull();

    popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.focus();
    expect(popover.element.hidden).toBe(false);
    popover.element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(popover.element.hidden).toBe(true);
    expect(onClose).toHaveBeenLastCalledWith('escape');
    expect(host.ownerDocument.activeElement).toBe(invoker);

    openSelection();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(popover.element.hidden).toBe(true);
    expect(onClose).toHaveBeenLastCalledWith('click-away');
    expect(onCreate).toHaveBeenCalledOnce();

    popover.destroy();
    host.remove();
  });

  it('stays open while focus returns to the owning annotation card', () => {
    const host = document.body.createDiv();
    const card = host.createEl('button');
    card.className = 'abyss-annotation-card';
    card.setAttribute('aria-current', 'true');
    const onClose = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }),
      onClose,
    });

    card.focus();
    card.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(popover.isOpen).toBe(true);
    expect(popover.element.hidden).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    popover.destroy();
    host.remove();
  });

  it('defers focus-away dismissal across native editor DOM replacement', async () => {
    const host = document.body.createDiv();
    const nativeLayer = document.body.createDiv({ cls: 'annotationEditorLayer' });
    const oldEditor = nativeLayer.createEl('button', { cls: 'highlightEditor' });
    const onClose = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }),
      onClose,
    });
    const samePopover = popover.element;
    oldEditor.focus();
    oldEditor.remove();
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const replacement = nativeLayer.createEl('button', { cls: 'highlightEditor' });
    replacement.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect({
      newFocused: host.ownerDocument.activeElement === replacement,
      newIsDistinct: replacement !== oldEditor,
      oldDisconnected: !oldEditor.isConnected,
      sameConnectedPopover: popover.element === samePopover && samePopover.isConnected,
    }).toEqual({
      newFocused: true,
      newIsDistinct: true,
      oldDisconnected: true,
      sameConnectedPopover: true,
    });
    expect(popover.isOpen).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    popover.destroy();
    nativeLayer.remove();
    host.remove();
  });

  it('keeps exact multiple selection visible while disabling unsafe batch controls', () => {
    const host = document.body.createDiv();
    const first = editableAnnotation();
    const second = editableAnnotation({
      identity: { id: asAnnotationId('annotation-2'), kind: 'stable' },
      selectedText: 'Another passage',
    });
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    const popover = new AnnotationEditorPopover(host);
    popover.open({
      ...editorRequest({ annotations: [first, second], kind: 'multiple' }),
      onDelete,
      onUpdate,
    });

    expect(popover.element.querySelector('[role="status"]')?.textContent).toContain(
      '2 annotations selected',
    );
    expect(
      popover.element.querySelector<HTMLElement>('.abyss-annotation-editor-metadata')?.hidden,
    ).toBe(true);
    expect(
      Array.from(popover.element.querySelectorAll('button[data-action]'), (button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Delete annotations']);
    const swatches = Array.from(
      popover.element.querySelectorAll<HTMLButtonElement>('[data-editor-color]'),
    );
    const deleteButton = popover.element.querySelector<HTMLButtonElement>(
      '[data-action="delete-annotation"]',
    );
    expect(swatches.every((button) => button.disabled)).toBe(true);
    expect(deleteButton?.disabled).toBe(true);
    expect(swatches[0]?.getAttribute('aria-describedby')).toBe(
      popover.element.querySelector('[data-batch-unavailable]')?.id,
    );
    expect(popover.element.querySelector('[data-batch-unavailable]')?.textContent).toContain(
      'cannot be changed together safely',
    );
    swatches[1]?.click();
    deleteButton?.click();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    popover.open(editorRequest({ annotation: first, kind: 'readonly' }));
    const readOnly = popover.element.querySelector<HTMLElement>(
      '.abyss-annotation-editor-readonly-metadata',
    );
    expect(readOnly?.hidden).toBe(false);
    expect(readOnly?.textContent).toContain('Reader prose');
    expect(readOnly?.textContent).toContain('#Important');
    expect(readOnly?.textContent).toContain('[[Concept]]');
    expect(readOnly?.querySelector('input, textarea, button')).toBeNull();
    expect(
      popover.element.querySelector<HTMLElement>('.abyss-annotation-editor-palette')?.hidden,
    ).toBe(true);
    expect(popover.element.querySelectorAll('button[data-action]')).toHaveLength(0);

    popover.destroy();
    host.remove();
  });

  it('does not render a blank comment field for a read-only annotation without metadata', () => {
    const host = document.body.createDiv();
    const annotation = editableAnnotation({ comment: '' });
    const popover = new AnnotationEditorPopover(host);
    popover.open(editorRequest({ annotation, kind: 'readonly' }));

    expect(popover.element.querySelector('[data-field="comment"]')).toBeNull();
    expect(popover.element.querySelector('[role="status"]')?.textContent).toBe(
      'Read-only annotation',
    );
    expect(popover.element.querySelector('[data-action]')).toBeNull();

    popover.destroy();
    host.remove();
  });

  it('cannot reopen after destruction and keeps teardown idempotent', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);

    expect(popover.destroy()).toBe(true);
    expect(popover.destroy()).toBe(true);
    expect(() =>
      popover.open(editorRequest({ annotation: editableAnnotation(), kind: 'annotation' })),
    ).toThrow(DOMException);
    expect(popover.element.isConnected).toBe(false);

    host.remove();
  });
});
