export interface PdfSelectionRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfTextSelection {
  readonly token: string;
  readonly text: string;
  readonly clientRect: PdfSelectionRect;
  readonly input: 'pointer' | 'touch' | 'keyboard';
}

export interface PdfSelectionObserver {
  onSelection(listener: (selection: PdfTextSelection | null) => void): () => void;
  validate(token: string): 'current' | 'stale';
  invalidate(): void;
}

interface SelectionIdentity {
  readonly anchorNode: Node;
  readonly anchorOffset: number;
  readonly focusNode: Node;
  readonly focusOffset: number;
  readonly textLayer: Element;
  readonly text: string;
}

interface ActiveSelection extends SelectionIdentity {
  readonly token: string;
}

let nextObserverSession = 0;
let nextSelectionIdentity = 0;

export class PdfDomSelectionObserver implements PdfSelectionObserver {
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window;
  private readonly listeners = new Set<(selection: PdfTextSelection | null) => void>();
  private readonly session = ++nextObserverSession;
  private active: ActiveSelection | null = null;
  private frame: number | null = null;
  private revision = 0;
  private input: PdfTextSelection['input'] = 'keyboard';
  private destroyed = false;

  constructor(private readonly root: HTMLElement) {
    this.ownerDocument = root.ownerDocument;
    const ownerWindow = this.ownerDocument.defaultView;
    if (ownerWindow === null) throw new DOMException('PDF selection owner has no window.');
    this.ownerWindow = ownerWindow;
    this.ownerDocument.addEventListener('selectionchange', this.onSelectionChange);
    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('touchstart', this.onTouchStart);
    this.root.addEventListener('keydown', this.onKeyDown);
  }

  onSelection(listener: (selection: PdfTextSelection | null) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  validate(token: string): 'current' | 'stale' {
    const active = this.active;
    if (token !== active?.token) return 'stale';
    const identity = this.selectionIdentity();
    if (identity === null || !sameSelection(identity, active)) return 'stale';
    return 'current';
  }

  invalidate(): void {
    if (this.destroyed) return;
    this.revision += 1;
    this.active = null;
    this.cancelFrame();
    this.emit(null);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = null;
    this.cancelFrame();
    this.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange);
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('touchstart', this.onTouchStart);
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.listeners.clear();
  }

  private readonly onSelectionChange = (): void => {
    if (this.destroyed || this.frame !== null) return;
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = null;
      this.publishCurrentSelection();
    });
  };

  private readonly onPointerDown = (): void => {
    this.input = 'pointer';
  };

  private readonly onTouchStart = (): void => {
    this.input = 'touch';
  };

  private readonly onKeyDown = (): void => {
    this.input = 'keyboard';
  };

  private publishCurrentSelection(): void {
    const identity = this.selectionIdentity();
    this.revision += 1;
    if (identity === null) {
      this.active = null;
      this.emit(null);
      return;
    }
    const token = `${this.session}.${this.revision}.${++nextSelectionIdentity}`;
    this.active = { ...identity, token };
    this.emit({
      token,
      text: identity.text,
      clientRect: selectionRect(this.ownerDocument.getSelection()?.getRangeAt(0) ?? null),
      input: this.input,
    });
  }

  private selectionIdentity(): SelectionIdentity | null {
    const selection = this.ownerDocument.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
    if (anchorNode === null || focusNode === null) return null;
    const text = selection.toString();
    if (text.trim().length === 0) return null;
    const anchorLayer = closestTextLayer(anchorNode, this.root);
    const focusLayer = closestTextLayer(focusNode, this.root);
    // PDF.js 6.2.108 highlightSelection only accepts one text layer, so a
    // cross-page selection has no palette instead of risking an invalid action.
    // Source: https://raw.githubusercontent.com/mozilla/pdf.js/v6.2.108/src/display/editor/tools.js
    if (anchorLayer === null || anchorLayer !== focusLayer) return null;
    return { anchorNode, anchorOffset, focusNode, focusOffset, textLayer: anchorLayer, text };
  }

  private emit(selection: PdfTextSelection | null): void {
    for (const listener of this.listeners) listener(selection);
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    this.ownerWindow.cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}

function closestTextLayer(node: Node, root: HTMLElement): Element | null {
  if (!root.contains(node)) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const textLayer = element?.closest('.textLayer') ?? null;
  return textLayer !== null && root.contains(textLayer) ? textLayer : null;
}

function sameSelection(left: SelectionIdentity, right: SelectionIdentity): boolean {
  return (
    left.anchorNode === right.anchorNode &&
    left.anchorOffset === right.anchorOffset &&
    left.focusNode === right.focusNode &&
    left.focusOffset === right.focusOffset &&
    left.textLayer === right.textLayer &&
    left.text === right.text
  );
}

function selectionRect(range: Range | null): PdfSelectionRect {
  if (range === null) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const { left, top, right, bottom, width, height } = range.getBoundingClientRect();
  return { left, top, right, bottom, width, height };
}
