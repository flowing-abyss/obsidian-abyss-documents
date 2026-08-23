import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfDomSelectionObserver, type PdfTextSelection } from './pdf-selection-observer.js';

function selectionRoot(ownerDocument: Document = window.document): HTMLElement {
  const root = ownerDocument.body.createDiv();
  const page = root.createDiv();
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

function dispatchSelection(document: Document): void {
  document.dispatchEvent(new Event('selectionchange'));
}

function emitSelection(root: HTMLElement, input: 'pointer' | 'touch' | 'keyboard'): void {
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error('Expected an owner window.');
  let event: Event;
  if (input === 'pointer') event = new ownerWindow.Event('pointerdown');
  else if (input === 'touch') event = new ownerWindow.Event('touchstart');
  else event = new ownerWindow.KeyboardEvent('keydown', { key: 'ArrowRight' });
  root.dispatchEvent(event);
  dispatchSelection(root.ownerDocument);
}

function setSelectionRect(range: Range): void {
  Object.defineProperty(range, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 }),
  });
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => {
      resolve();
    }),
  );
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('PdfDomSelectionObserver', () => {
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
      clientRect: { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 },
      input: 'pointer',
    });
    expect(selections[0]?.token).toEqual(expect.any(String));
    expect(observer.validate(selections[0]?.token ?? '')).toBe('current');
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
    const first = selections[0];
    if (first === null || first === undefined) throw new Error('Expected the first selection.');
    selectText(document, text, 11, 18);
    emitSelection(root, 'pointer');
    await nextFrame();
    const second = selections[1];
    if (second === null || second === undefined) throw new Error('Expected the second selection.');

    expect(observer.validate(first.token)).toBe('stale');
    expect(observer.validate(second.token)).toBe('current');
    observer.invalidate();
    expect(observer.validate(second.token)).toBe('stale');
    expect(selections).toHaveLength(3);
    expect(selections[2]).toBeNull();
  });

  it('uses ownerDocument and ownerWindow in popouts', async () => {
    const popup = document.implementation.createHTMLDocument('PDF popout');
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const ownerWindow = {
      cancelAnimationFrame: vi.fn(),
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
});
