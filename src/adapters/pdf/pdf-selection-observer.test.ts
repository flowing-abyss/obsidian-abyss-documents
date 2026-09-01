import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfDomSelectionObserver, type PdfTextSelection } from './pdf-selection-observer.js';

function selectionRoot(ownerDocument: Document = window.document): HTMLElement {
  const root = ownerDocument.body.createDiv();
  const page = root.createDiv({ cls: 'page' });
  page.dataset['pageNumber'] = '3';
  const layer = page.createDiv({ cls: 'textLayer' });
  const text = ownerDocument.createTextNode('A selected passage');
  layer.append(text);
  return root;
}

function selectText(document: Document, node: Node, start = 2, end = 10): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  setSelectionRect(range);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectTextInReverse(document: Document, node: Node, start = 2, end = 10): void {
  const selection = document.getSelection();
  selection?.setBaseAndExtent(node, end, node, start);
  const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
  if (range !== null) setSelectionRect(range);
}

function placeCaret(document: Document, node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function mockDetachedSelectionGeometry(
  document: Document,
  expected: {
    readonly end: number;
    readonly endNode?: Node;
    readonly start: number;
    readonly startNode?: Node;
  },
): { setTop(top: number): void } {
  const createRange = document.createRange.bind(document);
  let top = 36;
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    const rect = (): DOMRect => DOMRect.fromRect({ height: 24, width: 26, x: 12, y: top });
    const isExpectedSelection = (): boolean =>
      range.startOffset === expected.start &&
      range.endOffset === expected.end &&
      (expected.startNode === undefined || range.startContainer === expected.startNode) &&
      (expected.endNode === undefined || range.endContainer === expected.endNode);
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        isExpectedSelection() ? rect() : DOMRect.fromRect({ height: 0, width: 0, x: 0, y: 0 }),
    });
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => (isExpectedSelection() ? [rect()] : []),
    });
    return range;
  });
  return {
    setTop(nextTop: number): void {
      top = nextTop;
    },
  };
}

function dispatchSelection(document: Document): void {
  document.dispatchEvent(new Event('selectionchange'));
}

function emitSelection(root: HTMLElement, input: 'pointer' | 'touch' | 'keyboard'): void {
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error('Expected an owner window.');
  if (input === 'pointer') {
    root.dispatchEvent(
      new ownerWindow.PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
  } else if (input === 'touch') root.dispatchEvent(new ownerWindow.Event('touchstart'));
  else root.dispatchEvent(new ownerWindow.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  dispatchSelection(root.ownerDocument);
  if (input === 'pointer') {
    root.dispatchEvent(
      new ownerWindow.PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
  } else if (input === 'touch') root.dispatchEvent(new ownerWindow.Event('touchend'));
}

function setSelectionRect(range: Range): void {
  const rects = [
    { left: 10, top: 20, right: 40, bottom: 32, width: 30, height: 12 },
    { left: 12, top: 36, right: 38, bottom: 60, width: 26, height: 24 },
  ];
  Object.defineProperty(range, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 }),
  });
  Object.defineProperty(range, 'getClientRects', {
    configurable: true,
    value: () => rects,
  });
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => {
      resolve();
    }),
  );
}

function primaryPointer(
  target: EventTarget,
  type: 'pointercancel' | 'pointerdown' | 'pointermove' | 'pointerup',
  init: PointerEventInit = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: 12,
      clientY: 24,
      isPrimary: true,
      pointerId: 7,
      pointerType: 'mouse',
      ...init,
    }),
  );
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('PdfDomSelectionObserver', () => {
  it('publishes a pointer selection once after its primary drag ends', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text, 2, 6);
    dispatchSelection(document);
    await nextFrame();
    selectText(document, text, 2, 10);
    dispatchSelection(document);
    await nextFrame();

    expect(listener).not.toHaveBeenCalled();

    primaryPointer(text, 'pointerup');
    dispatchSelection(document);
    await nextFrame();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ input: 'pointer', text: 'selected' });
    observer.destroy();
  });

  it('keeps a visible preview after PDF.js clears the native pointer selection', async () => {
    const root = selectionRoot();
    const textLayer = root.querySelector<HTMLElement>('.textLayer');
    const text = textLayer?.firstChild;
    if (textLayer === null || text?.nodeType !== Node.TEXT_NODE)
      throw new Error('Expected a text layer with a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text, 2, 10);
    primaryPointer(text, 'pointerup');
    dispatchSelection(document);
    await nextFrame();

    document.getSelection()?.removeAllRanges();
    dispatchSelection(document);
    await nextFrame();

    const preview = textLayer.querySelector<HTMLElement>('[data-abyss-selection-preview]');
    expect(preview?.getAttribute('aria-hidden')).toBe('true');
    expect(preview?.querySelectorAll('[data-abyss-selection-preview-rect]')).toHaveLength(2);

    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published selection.');
    expect(
      (
        observer as unknown as {
          release(token: string): boolean;
        }
      ).release(published.token),
    ).toBe(true);
    expect(textLayer.querySelector('[data-abyss-selection-preview]')).toBeNull();
    observer.destroy();
  });

  it('retains a keyboard selection while its annotation editor owns the token', async () => {
    const root = selectionRoot();
    const textLayer = root.querySelector<HTMLElement>('.textLayer');
    const text = textLayer?.firstChild;
    if (textLayer === null || text?.nodeType !== Node.TEXT_NODE)
      throw new Error('Expected a text layer with a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published keyboard selection.');

    expect(
      (
        observer as unknown as {
          retain(token: string): boolean;
        }
      ).retain(published.token),
    ).toBe(true);
    document.getSelection()?.removeAllRanges();
    dispatchSelection(document);
    await nextFrame();

    expect(listener).toHaveBeenCalledExactlyOnceWith(published);
    expect(textLayer.querySelector('[data-abyss-selection-preview]')).not.toBeNull();
    expect(observer.release(published.token)).toBe(true);
    expect(textLayer.querySelector('[data-abyss-selection-preview]')).toBeNull();
    observer.destroy();
  });

  it('resolves the live last selection rectangle and rejects a replaced text layer', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published selection.');

    mockDetachedSelectionGeometry(document, { start: 2, end: 10 });

    expect(observer.resolveAnchor(published.token)).toEqual(
      DOMRect.fromRect({ height: 24, width: 26, x: 12, y: 36 }),
    );
    root.querySelector('.textLayer')?.remove();
    expect(observer.resolveAnchor(published.token)).toBeNull();
    observer.destroy();
  });

  it('remeasures the saved selection after focus moves to another caret', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published selection.');
    const textarea = document.body.createEl('textarea', { text: 'Comment editor' });
    const caret = textarea.firstChild ?? textarea.appendChild(document.createTextNode('Comment'));
    placeCaret(document, caret, 2);
    const geometry = mockDetachedSelectionGeometry(document, { start: 2, end: 10 });

    expect(observer.resolveAnchor(published.token)).toEqual(
      DOMRect.fromRect({ height: 24, width: 26, x: 12, y: 36 }),
    );
    geometry.setTop(96);
    expect(observer.resolveAnchor(published.token)).toEqual(
      DOMRect.fromRect({ height: 24, width: 26, x: 12, y: 96 }),
    );
    observer.destroy();
  });

  it('normalizes reverse saved endpoints without restoring the browser selection', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectTextInReverse(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published reverse selection.');
    const otherText = document.body.appendChild(document.createTextNode('Other focus'));
    placeCaret(document, otherText, 3);
    mockDetachedSelectionGeometry(document, { start: 2, end: 10 });

    expect(observer.resolveAnchor(published.token)).toEqual(
      DOMRect.fromRect({ height: 24, width: 26, x: 12, y: 36 }),
    );
    expect(document.getSelection()?.anchorNode).toBe(otherText);
    expect(document.getSelection()?.anchorOffset).toBe(3);
    observer.destroy();
  });

  it('normalizes a reverse selection across text nodes by document order', async () => {
    const root = selectionRoot();
    const layer = root.querySelector<HTMLElement>('.textLayer');
    if (layer === null) throw new Error('Expected a text layer.');
    const first = document.createTextNode('Alpha ');
    const second = document.createTextNode('Beta');
    layer.replaceChildren(first, second);
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    const selection = document.getSelection();
    selection?.setBaseAndExtent(second, 4, first, 1);
    const selectedRange = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
    if (selectedRange !== null) setSelectionRect(selectedRange);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published cross-node selection.');
    const otherText = document.body.appendChild(document.createTextNode('Other focus'));
    placeCaret(document, otherText, 3);
    mockDetachedSelectionGeometry(document, {
      start: 1,
      end: 4,
      startNode: first,
      endNode: second,
    });

    expect(observer.resolveAnchor(published.token)).toEqual(
      DOMRect.fromRect({ height: 24, width: 26, x: 12, y: 36 }),
    );
    expect(document.getSelection()?.anchorNode).toBe(otherText);
    observer.destroy();
  });

  it('rejects saved endpoints moved outside their active text layer', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published selection.');
    root.createDiv({ cls: 'detached-copy' }).append(text);
    mockDetachedSelectionGeometry(document, { start: 2, end: 10 });

    expect(observer.resolveAnchor(published.token)).toBeNull();
    observer.destroy();
  });

  it('rejects saved endpoints whose offsets no longer fit the text nodes', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (!(text instanceof Text)) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const published = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (published === null || published === undefined)
      throw new Error('Expected a published selection.');
    text.data = 'Tiny';

    expect(observer.resolveAnchor(published.token)).toBeNull();
    observer.destroy();
  });

  it('cannot resolve a saved anchor after invalidation or destruction', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const invalidated = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (invalidated === null || invalidated === undefined)
      throw new Error('Expected a published selection.');
    observer.invalidate();

    expect(observer.resolveAnchor(invalidated.token)).toBeNull();

    listener.mockClear();
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const destroyed = listener.mock.calls.find(([value]) => value !== null)?.[0];
    if (destroyed === null || destroyed === undefined)
      throw new Error('Expected a republished selection.');
    observer.destroy();

    expect(observer.resolveAnchor(destroyed.token)).toBeNull();
  });

  it('publishes pointerup before a same-turn render of the unchanged selected text layer', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text, 2, 10);
    dispatchSelection(document);
    primaryPointer(text, 'pointerup');
    observer.handleTextLayerRendered(2);

    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: 'pointer', pageIndex: 2, text: 'selected' }),
    );
    await nextFrame();
    expect(listener).toHaveBeenCalledOnce();
    observer.destroy();
  });

  it('invalidates the pending pointer snapshot when its selected text layer is replaced', async () => {
    const root = selectionRoot();
    const layer = root.querySelector<HTMLElement>('.textLayer');
    const text = layer?.firstChild;
    if (layer === null || text?.nodeType !== Node.TEXT_NODE)
      throw new Error('Expected a text layer and text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text, 2, 10);
    dispatchSelection(document);
    primaryPointer(text, 'pointerup');
    const replacement = createDiv({ cls: 'textLayer' });
    replacement.append(document.createTextNode('Replacement text layer'));
    layer.replaceWith(replacement);
    document.getSelection()?.removeAllRanges();
    dispatchSelection(document);
    observer.handleTextLayerRendered(2);

    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    expect(observer.validate('unpublished-selection')).toBe('stale');
    expect(observer.restore('unpublished-selection')).toBe('stale');
    await nextFrame();
    expect(listener).toHaveBeenCalledOnce();
    observer.destroy();
  });

  it('does not publish a pending pointer snapshot for another page render', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text, 2, 10);
    dispatchSelection(document);
    primaryPointer(text, 'pointerup');
    observer.handleTextLayerRendered(0);

    expect(listener).not.toHaveBeenCalled();
    await nextFrame();
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: 'pointer', pageIndex: 2, text: 'selected' }),
    );
    observer.destroy();
  });

  it('does not flush a pending collapsed pointer selection for another page render', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    document.getSelection()?.removeAllRanges();
    dispatchSelection(document);
    primaryPointer(text, 'pointerup');
    observer.handleTextLayerRendered(0);

    expect(listener).not.toHaveBeenCalled();
    await nextFrame();
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    observer.destroy();
  });

  it('keeps a finalized selection across unrelated page renders', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'pointer');
    await nextFrame();
    const finalized = listener.mock.calls[0]?.[0];
    if (finalized === null || finalized === undefined)
      throw new Error('Expected a finalized selection.');

    observer.handleTextLayerRendered(0);
    observer.handleTextLayerRendered(1);

    expect(listener).toHaveBeenCalledExactlyOnceWith(finalized);
    expect(observer.validate(finalized.token)).toBe('current');
    observer.destroy();
  });

  it('keeps a finalized selection when its page reports the same connected text layer', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'pointer');
    await nextFrame();
    const finalized = listener.mock.calls[0]?.[0];
    if (finalized === null || finalized === undefined)
      throw new Error('Expected a finalized selection.');

    observer.handleTextLayerRendered(2);

    expect(listener).toHaveBeenCalledExactlyOnceWith(finalized);
    expect(observer.validate(finalized.token)).toBe('current');
    observer.destroy();
  });

  it('invalidates a finalized selection only when its captured text layer is replaced', async () => {
    const root = selectionRoot();
    const layer = root.querySelector<HTMLElement>('.textLayer');
    const text = layer?.firstChild;
    if (layer === null || text?.nodeType !== Node.TEXT_NODE)
      throw new Error('Expected a text layer and text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    selectText(document, text, 2, 10);
    emitSelection(root, 'pointer');
    await nextFrame();
    const finalized = listener.mock.calls[0]?.[0];
    if (finalized === null || finalized === undefined)
      throw new Error('Expected a finalized selection.');
    const replacement = createDiv({ cls: 'textLayer' });
    replacement.append(document.createTextNode('Replacement text layer'));

    layer.replaceWith(replacement);
    observer.handleTextLayerRendered(2);

    expect(listener.mock.calls.map(([selection]) => selection)).toEqual([finalized, null]);
    expect(observer.validate(finalized.token)).toBe('stale');
    observer.destroy();
  });

  it('clears both pending and finalized selections on explicit lifecycle invalidation', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text, 2, 6);
    dispatchSelection(document);
    primaryPointer(text, 'pointerup');
    observer.invalidate();
    await nextFrame();
    expect(listener.mock.calls.map(([selection]) => selection)).toEqual([null]);

    root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    selectText(document, text, 2, 10);
    dispatchSelection(document);
    await nextFrame();
    const finalized = listener.mock.calls[1]?.[0];
    if (finalized === null || finalized === undefined)
      throw new Error('Expected a finalized selection.');
    observer.invalidate();

    expect(listener.mock.calls.map(([selection]) => selection)).toEqual([null, finalized, null]);
    expect(observer.validate(finalized.token)).toBe('stale');
    observer.destroy();
  });

  it('does not revive a drag selection after lifecycle invalidation', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text);
    dispatchSelection(document);
    observer.invalidate();
    await nextFrame();

    expect(listener.mock.calls.map(([selection]) => selection)).toEqual([null]);

    selectText(document, text, 3, 9);
    root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    dispatchSelection(document);
    await nextFrame();
    expect(listener.mock.calls.map(([selection]) => selection)).toEqual([
      null,
      expect.objectContaining({ input: 'keyboard' }),
    ]);
    primaryPointer(text, 'pointerup');
    await nextFrame();
    expect(listener).toHaveBeenCalledTimes(2);
    observer.destroy();
  });

  it('keeps keyboard modifiers from publishing during a held pointer drag', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text);
    root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
    dispatchSelection(document);
    await nextFrame();

    expect(listener).not.toHaveBeenCalled();
    primaryPointer(text, 'pointerup');
    await nextFrame();
    expect(listener).toHaveBeenCalledOnce();
    observer.destroy();
  });

  it.each([
    { clientX: 500, clientY: 50 },
    { clientX: 50, clientY: -10 },
    { clientX: 50, clientY: 110 },
  ])('cancels a captured pointer outside at $clientX,$clientY', async (position) => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown');
    selectText(document, text);
    dispatchSelection(document);
    primaryPointer(root, 'pointermove', position);
    primaryPointer(root, 'pointerup', position);
    await nextFrame();

    expect(listener).not.toHaveBeenCalled();
    observer.destroy();
  });

  it.each(['pointercancel', 'outside'] as const)(
    'cancels a primary drag after %s without publishing its selection',
    async (ending) => {
      const root = selectionRoot();
      const text = root.querySelector('.textLayer')?.firstChild;
      if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
      const outside = document.body.createDiv();
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const observer = new PdfDomSelectionObserver(root);
      const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
      observer.onSelection(listener);

      primaryPointer(root, 'pointerdown');
      selectText(document, text);
      dispatchSelection(document);
      if (ending === 'pointercancel') primaryPointer(window, 'pointercancel');
      else {
        primaryPointer(outside, 'pointermove', { clientX: 500, clientY: 500 });
        primaryPointer(outside, 'pointerup', { clientX: 500, clientY: 500 });
      }
      dispatchSelection(document);
      await nextFrame();

      expect(listener).not.toHaveBeenCalled();
      observer.destroy();
    },
  );

  it('keeps a cancelled touch-pointer gesture suppressed through its compatibility touchend', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    primaryPointer(root, 'pointerdown', { pointerType: 'touch' });
    root.dispatchEvent(new Event('touchstart', { bubbles: true }));
    selectText(document, text);
    dispatchSelection(document);
    primaryPointer(window, 'pointercancel', { pointerType: 'touch' });
    root.dispatchEvent(new Event('touchend', { bubbles: true }));
    await nextFrame();

    expect(listener).not.toHaveBeenCalled();
    observer.destroy();
  });

  it.each(['touchcancel', 'outside'] as const)(
    'keeps a touch selection suppressed after %s',
    async (ending) => {
      const root = selectionRoot();
      const text = root.querySelector('.textLayer')?.firstChild;
      if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const observer = new PdfDomSelectionObserver(root);
      const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
      observer.onSelection(listener);

      root.dispatchEvent(new Event('touchstart', { bubbles: true }));
      selectText(document, text);
      dispatchSelection(document);
      const end = new Event(ending === 'touchcancel' ? 'touchcancel' : 'touchend', {
        bubbles: true,
      });
      if (ending === 'outside') {
        Object.defineProperty(end, 'changedTouches', {
          configurable: true,
          value: [{ clientX: 500, clientY: 500 }],
        });
      }
      (ending === 'touchcancel' ? window : root).dispatchEvent(end);
      dispatchSelection(document);
      await nextFrame();

      expect(listener).not.toHaveBeenCalled();
      observer.destroy();
    },
  );

  it('emits one rAF-coalesced token for an owned selection', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const selections: Array<PdfTextSelection | null> = [];
    observer.onSelection((selection) => selections.push(selection));

    selectText(document, text);
    emitSelection(root, 'pointer');
    dispatchSelection(document);
    dispatchSelection(document);
    await nextFrame();

    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({
      text: 'selected',
      pageIndex: 2,
      clientRect: { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 },
      clientRects: [
        { left: 10, top: 20, right: 40, bottom: 32, width: 30, height: 12 },
        { left: 12, top: 36, right: 38, bottom: 60, width: 26, height: 24 },
      ],
      input: 'pointer',
    });
    expect(selections[0]?.token).toEqual(expect.any(String));
    expect(observer.validate(selections[0]?.token ?? '')).toBe('current');

    dispatchSelection(document);
    await nextFrame();
    expect(selections).toHaveLength(1);
  });

  it('publishes only the latest immutable keyboard range scheduled for one frame', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);
    root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));

    selectText(document, text, 0, 1);
    dispatchSelection(document);
    selectText(document, text, 2, 10);
    dispatchSelection(document);
    await nextFrame();

    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: 'keyboard', text: 'selected' }),
    );
    observer.destroy();
  });

  it('dismisses collapsed outside and cross-page selections', async () => {
    const root = selectionRoot();
    const secondLayer = root.createDiv({ cls: 'textLayer' });
    secondLayer.append(document.createTextNode('Other page'));
    root.append(secondLayer);
    const outside = document.createTextNode('Outside');
    document.body.append(outside);
    const owned = root.querySelector('.textLayer')?.firstChild;
    const other = secondLayer.firstChild;
    if (owned?.nodeType !== Node.TEXT_NODE || other?.nodeType !== Node.TEXT_NODE) {
      throw new Error('Expected text nodes.');
    }
    const observer = new PdfDomSelectionObserver(root);
    const selections: Array<PdfTextSelection | null> = [];
    observer.onSelection((selection) => selections.push(selection));

    selectText(document, owned, 1, 1);
    emitSelection(root, 'keyboard');
    await nextFrame();
    selectText(document, outside, 0, 7);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const range = document.createRange();
    range.setStart(owned, 1);
    range.setEnd(other, 5);
    setSelectionRect(range);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    emitSelection(root, 'keyboard');
    await nextFrame();

    expect(selections).toEqual([null, null, null]);
  });

  it('cannot restore a finalized selection after a null publication clears it', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const selections: Array<PdfTextSelection | null> = [];
    observer.onSelection((selection) => selections.push(selection));
    selectText(document, text, 2, 10);
    emitSelection(root, 'keyboard');
    await nextFrame();
    const finalized = selections[0];
    if (finalized === null || finalized === undefined)
      throw new Error('Expected a finalized selection.');

    document.getSelection()?.removeAllRanges();
    dispatchSelection(document);
    await nextFrame();

    expect(selections).toEqual([finalized, null]);
    expect(observer.validate(finalized.token)).toBe('stale');
    expect(observer.restore(finalized.token)).toBe('stale');
    observer.destroy();
  });

  it('invalidates rapid reselection and stale action clicks', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const selections: Array<PdfTextSelection | null> = [];
    observer.onSelection((selection) => selections.push(selection));

    selectText(document, text, 2, 10);
    emitSelection(root, 'pointer');
    await nextFrame();
    const first = selections.find((selection): selection is PdfTextSelection => selection !== null);
    if (first === undefined) throw new Error('Expected the first selection.');
    selectText(document, text, 11, 18);
    emitSelection(root, 'pointer');
    await nextFrame();
    const second = selections.find(
      (selection): selection is PdfTextSelection =>
        selection !== null && selection.token !== first.token,
    );
    if (second === undefined) throw new Error('Expected the second selection.');

    expect(observer.validate(first.token)).toBe('stale');
    expect(observer.validate(second.token)).toBe('current');
    observer.invalidate();
    expect(observer.validate(second.token)).toBe('stale');
    expect(selections).toEqual([first, null, second, null]);
  });

  it('restores the owned text range after metadata focus clears browser selection', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const observer = new PdfDomSelectionObserver(root);
    const selections: Array<PdfTextSelection | null> = [];
    observer.onSelection((selection) => selections.push(selection));
    selectText(document, text, 2, 10);
    emitSelection(root, 'pointer');
    await nextFrame();
    const owned = selections.find((selection): selection is PdfTextSelection => selection !== null);
    if (owned === undefined) throw new Error('Expected the owned selection.');

    document.getSelection()?.removeAllRanges();
    dispatchSelection(document);
    await nextFrame();

    expect(observer.validate(owned.token)).toBe('stale');
    expect(observer.restore(owned.token)).toBe('current');
    expect(document.getSelection()?.toString()).toBe(owned.text);
    observer.invalidate();
    expect(observer.restore(owned.token)).toBe('stale');
  });

  it('does not invalidate the owned range when the annotation popover receives pointer input', async () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const popover = root.createDiv();
    popover.dataset['annotationEditorPopover'] = '';
    const swatch = popover.createEl('button');
    const observer = new PdfDomSelectionObserver(root);
    const selections: Array<PdfTextSelection | null> = [];
    observer.onSelection((selection) => selections.push(selection));
    selectText(document, text, 2, 10);
    emitSelection(root, 'pointer');
    await nextFrame();
    const owned = selections.find((selection): selection is PdfTextSelection => selection !== null);
    if (owned === undefined) throw new Error('Expected the owned selection.');

    primaryPointer(swatch, 'pointerdown');

    expect(observer.validate(owned.token)).toBe('current');
    expect(selections).toEqual([owned]);
  });

  it('uses ownerDocument and ownerWindow in popouts', async () => {
    const popup = document.implementation.createHTMLDocument('PDF popout');
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const windowListeners = new Map<string, EventListener>();
    const ownerWindow = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, listener);
      }),
      cancelAnimationFrame: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame,
    } as unknown as Window;
    Object.defineProperty(popup, 'defaultView', { configurable: true, value: ownerWindow });
    const root = selectionRoot(popup);
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const selection = {
      anchorNode: text,
      anchorOffset: 2,
      focusNode: text,
      focusOffset: 10,
      getRangeAt: () => ({
        getBoundingClientRect: () => ({
          left: 10,
          top: 20,
          right: 40,
          bottom: 60,
          width: 30,
          height: 40,
        }),
      }),
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'selected',
    } as unknown as Selection;
    vi.spyOn(popup, 'getSelection').mockReturnValue(selection);
    const observer = new PdfDomSelectionObserver(root);
    const selections: Array<PdfTextSelection | null> = [];
    observer.onSelection((selection) => selections.push(selection));

    root.dispatchEvent(new Event('touchstart'));
    popup.dispatchEvent(new Event('selectionchange'));
    const touchEnd = new Event('touchend');
    Object.defineProperty(touchEnd, 'target', { configurable: true, value: root });
    windowListeners.get('touchend')?.(touchEnd);
    frames.shift()?.(0);

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(selections[0]).toMatchObject({ text: 'selected', input: 'touch' });
  });

  it('cleans listeners on destroy', () => {
    const root = selectionRoot();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const observer = new PdfDomSelectionObserver(root);

    observer.destroy();
    observer.destroy();

    expect(add).toHaveBeenCalledWith('selectionchange', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('selectionchange', expect.any(Function));
  });

  it('cancels pending publication, unsubscribes, and stays inert after teardown', () => {
    const root = selectionRoot();
    const text = root.querySelector('.textLayer')?.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected a text node.');
    const scheduled: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scheduled.push(callback);
      return 42;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    const unsubscribe = observer.onSelection(listener);

    selectText(document, text);
    dispatchSelection(document);
    observer.invalidate();

    expect(cancel).toHaveBeenCalledWith(42);
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    unsubscribe();
    unsubscribe();
    scheduled.shift()?.(0);
    expect(listener).toHaveBeenCalledOnce();

    observer.destroy();
    observer.invalidate();
    const inertCleanup = observer.onSelection(listener);
    inertCleanup();
    dispatchSelection(document);
    root.dispatchEvent(new Event('pointerdown'));
    root.dispatchEvent(new Event('touchstart'));
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('dismisses whitespace-only text-layer selections', async () => {
    const root = selectionRoot();
    const layer = root.querySelector('.textLayer');
    if (layer === null) throw new Error('Expected a text layer.');
    const whitespace = document.createTextNode('   \n  ');
    layer.replaceChildren(whitespace);
    const observer = new PdfDomSelectionObserver(root);
    const listener = vi.fn<(selection: PdfTextSelection | null) => void>();
    observer.onSelection(listener);

    selectText(document, whitespace, 0, whitespace.data.length);
    dispatchSelection(document);
    await nextFrame();

    expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    observer.destroy();
  });
});
