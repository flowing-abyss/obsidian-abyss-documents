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
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function editComment(popover: AnnotationEditorPopover, value: string): void {
  const input = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
  if (input === null) throw new Error('Expected comment field.');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AnnotationEditorPopover', () => {
  it('renders a writable annotation as square palette and inline metadata fields with only trash', () => {
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
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Reader prose');
    expect(popover.element.querySelector<HTMLInputElement>('[aria-label="Tags"]')?.value).toBe(
      '#Important',
    );
    expect(popover.element.querySelector<HTMLInputElement>('[aria-label="Links"]')?.value).toBe(
      '[[Concept]]',
    );
    expect(
      Array.from(popover.element.querySelectorAll('button[data-action]'), (button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Delete annotation']);
    expect(popover.element.textContent).not.toMatch(/Save|Cancel|Add Text|Comment|Link|Tag/u);

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
      left: '280px',
      maxHeight: '370px',
      maxWidth: '400px',
      overflow: 'scroll',
      top: '290px',
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
    }).toEqual({ left: '44px', maxHeight: '120px', maxWidth: '180px', top: '20px' });

    Reflect.deleteProperty(host.win, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('keeps an untouched selection lazy while swatches and first metadata input create immediately', async () => {
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

    const lazyCreate = vi.fn();
    popover.open({
      ...editorRequest({ kind: 'selection', selection: chosenSelection }),
      onCreate: lazyCreate,
    });
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.value = 'Draft thought';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    expect(lazyCreate).toHaveBeenCalledOnce();
    expect(lazyCreate).toHaveBeenCalledWith({
      color: '#ffd400',
      comment: 'Draft thought',
      selection: chosenSelection,
    });
    expect(popover.element.hidden).toBe(false);

    popover.destroy();
    host.remove();
  });

  it('applies the latest draft after deferred creation on the same open generation', async () => {
    const host = document.body.createDiv();
    const popover = new AnnotationEditorPopover(host);
    const creation = deferred<DocumentAnnotation>();
    const onCreate = vi.fn(() => creation.promise);
    const onUpdate = vi.fn();
    popover.open({
      ...editorRequest({ kind: 'selection', selection: selection() }),
      onCreate,
      onUpdate,
    });
    const sameNode = popover.element;
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    const tags = popover.element.querySelector<HTMLInputElement>('[aria-label="Tags"]');
    const links = popover.element.querySelector<HTMLInputElement>('[aria-label="Links"]');
    if (comment === null || tags === null || links === null)
      throw new Error('Expected metadata fields.');

    comment.value = 'Initial draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    comment.value = 'Latest draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    tags.value = '#Fresh';
    tags.dispatchEvent(new Event('input', { bubbles: true }));
    links.value = '[[New note]]';
    links.dispatchEvent(new Event('input', { bubbles: true }));
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    expect(onCreate).toHaveBeenCalledOnce();

    const created = editableAnnotation({ color: '#ffd400', comment: 'Initial draft' });
    creation.resolve(created);
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.element).toBe(sameNode);
    expect(comment.value).toBe('Latest draft');
    expect(tags.value).toBe('#Fresh');
    expect(links.value).toBe('[[New note]]');
    expect(
      popover.element.querySelector('[data-editor-color="#5fb236"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(onUpdate).toHaveBeenLastCalledWith({
      annotations: [created],
      color: '#5fb236',
      comment: 'Latest draft #Fresh [[New note]]',
    });

    popover.destroy();
    host.remove();
  });

  it('persists the latest pending creation draft after click-away without reopening the UI', async () => {
    const host = document.body.createDiv();
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
    const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    const tags = popover.element.querySelector<HTMLInputElement>('[aria-label="Tags"]');
    const links = popover.element.querySelector<HTMLInputElement>('[aria-label="Links"]');
    if (comment === null || tags === null || links === null)
      throw new Error('Expected metadata fields.');
    comment.value = 'Initial draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    comment.value = 'Closed draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    tags.value = '#Fresh';
    tags.dispatchEvent(new Event('input', { bubbles: true }));
    links.value = '[[Closed note]]';
    links.dispatchEvent(new Event('input', { bubbles: true }));
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(popover.element.hidden).toBe(true);
    expect(onClose).toHaveBeenCalledWith('click-away');

    const created = editableAnnotation({ color: '#ffd400', comment: 'Initial draft' });
    creation.resolve(created);
    await Promise.resolve();
    await Promise.resolve();
    expect(popover.element.hidden).toBe(true);
    expect(onUpdate).toHaveBeenCalledWith({
      annotations: [created],
      color: '#5fb236',
      comment: 'Closed draft #Fresh [[Closed note]]',
    });

    popover.destroy();
    host.remove();
  });

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
    comment.value = 'Replacement draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();

    const replacement = editableAnnotation({ comment: 'Replacement target' });
    popover.open({ ...editorRequest({ annotation: replacement, kind: 'annotation' }), onUpdate });
    const created = editableAnnotation({ color: '#ffd400', comment: 'Initial draft' });
    creation.resolve(created);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
    ).toBe('Replacement target');
    expect(onUpdate).toHaveBeenCalledWith({
      annotations: [created],
      color: '#5fb236',
      comment: 'Replacement draft',
    });

    popover.destroy();
    host.remove();
  });

  it('persists color immediately and debounces lossless metadata with wiki-link keyboard suggestions', () => {
    vi.useFakeTimers();
    try {
      const host = document.body.createDiv();
      const suggest = vi.fn((query: string, sourcePath: string) =>
        query === 'con' && sourcePath === 'Books/Book.pdf'
          ? [{ display: 'Concept', insertion: '[[Concept|Idea]]', path: 'Notes/Concept.md' }]
          : [],
      );
      const popover = new AnnotationEditorPopover(host, { suggest }, 'Books/Book.pdf');
      const onUpdate = vi.fn();
      const annotation = editableAnnotation();
      popover.open({
        ...editorRequest({ annotation, kind: 'annotation' }),
        onUpdate,
      });

      popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
      expect(onUpdate).toHaveBeenLastCalledWith({ annotations: [annotation], color: '#5fb236' });

      const comment = popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
      const tags = popover.element.querySelector<HTMLInputElement>('[aria-label="Tags"]');
      const links = popover.element.querySelector<HTMLInputElement>('[aria-label="Links"]');
      if (comment === null || tags === null || links === null)
        throw new Error('Expected metadata fields.');
      comment.value = 'Revised prose';
      comment.dispatchEvent(new Event('input', { bubbles: true }));
      tags.value = '#Renamed';
      tags.dispatchEvent(new Event('input', { bubbles: true }));
      links.value = '[[con';
      links.setSelectionRange(5, 5);
      links.dispatchEvent(new Event('input', { bubbles: true }));

      expect(links.getAttribute('role')).toBe('combobox');
      expect(popover.element.querySelector('[role="listbox"]')?.textContent).toBe('Concept');
      expect(links.getAttribute('aria-activedescendant')).toBe(
        popover.element.querySelector('[role="option"][aria-selected="true"]')?.id,
      );
      links.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
      links.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      expect(links.value).toBe('[[Concept|Idea]]');

      vi.advanceTimersByTime(299);
      expect(onUpdate).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(onUpdate).toHaveBeenLastCalledWith({
        annotations: [annotation],
        comment: 'Revised prose #Renamed [[Concept|Idea]]',
      });

      popover.destroy();
      host.remove();
    } finally {
      vi.useRealTimers();
    }
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

  it('refreshes suggestions on caret selection and rejects stale Enter or click origins', () => {
    const host = document.body.createDiv();
    const suggest = vi.fn((query: string) => {
      if (query === 'con')
        return [{ display: 'Concept', insertion: '[[Concept]]', path: 'Concept.md' }];
      if (query === 'oth') return [{ display: 'Other', insertion: '[[Other]]', path: 'Other.md' }];
      return [];
    });
    const popover = new AnnotationEditorPopover(host, { suggest });
    popover.open(editorRequest({ annotation: editableAnnotation(), kind: 'annotation' }));
    const links = popover.element.querySelector<HTMLInputElement>('[aria-label="Links"]');
    if (links === null) throw new Error('Expected links field.');

    links.value = '[[con]] [[oth]]';
    links.setSelectionRange(5, 5);
    links.dispatchEvent(new Event('input', { bubbles: true }));
    expect(popover.element.querySelector('[role="listbox"]')?.textContent).toBe('Concept');
    links.setSelectionRange(13, 13);
    links.dispatchEvent(new Event('select', { bubbles: true }));
    expect(popover.element.querySelector('[role="listbox"]')?.textContent).toBe('Other');

    links.value = '[[con]] [[changed]]';
    links.setSelectionRange(17, 17);
    links.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(links.value).toBe('[[con]] [[changed]]');
    expect(popover.element.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);

    links.value = '[[con]]';
    links.setSelectionRange(5, 5);
    links.dispatchEvent(new Event('select', { bubbles: true }));
    const staleOption = popover.element.querySelector<HTMLElement>('[role="option"]');
    if (staleOption === null) throw new Error('Expected suggestion option.');
    links.value = '[[changed]]';
    links.setSelectionRange(9, 9);
    staleOption.click();
    expect(links.value).toBe('[[changed]]');
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
        comment: 'Before replacement #Important [[Concept]]',
      });

      editComment(popover, 'Before refresh');
      popover.updateTarget({ annotation: third, kind: 'annotation' });
      expect(onUpdate).toHaveBeenNthCalledWith(2, {
        annotations: [second],
        comment: 'Before refresh #Two',
      });
      expect(
        popover.element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')?.value,
      ).toBe('Third source');

      editComment(popover, 'Before destroy');
      popover.destroy();
      expect(onUpdate).toHaveBeenNthCalledWith(3, {
        annotations: [third],
        comment: 'Before destroy #Three',
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
      comment: 'Saved before delete #Important [[Concept]]',
    });
    expect(onDelete).toHaveBeenCalledWith([annotation]);
    expect(popover.isOpen).toBe(false);
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
    popover.element.querySelector<HTMLInputElement>('[aria-label="Tags"]')?.focus();
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

  it('reduces multiple selection to common color/delete and renders read-only metadata without controls', () => {
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

    expect(popover.element.querySelector('[role="status"]')?.textContent).toBe(
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
    popover.element.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    expect(onUpdate).toHaveBeenCalledWith({ annotations: [first, second], color: '#5fb236' });
    popover.element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(onDelete).toHaveBeenCalledWith([first, second]);

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
});
