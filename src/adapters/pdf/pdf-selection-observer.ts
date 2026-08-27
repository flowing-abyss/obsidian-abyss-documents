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
  readonly pageIndex: number;
  readonly clientRect: PdfSelectionRect;
  readonly clientRects: readonly PdfSelectionRect[];
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
  readonly pageIndex: number;
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
  private pointerGesture: {
    cancelled: boolean;
    readonly pointerId: number;
    readonly pointerType: string;
  } | null = null;
  private touchGesture = false;
  private suppressPointerSelection = false;
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
    this.ownerWindow.addEventListener('pointercancel', this.onPointerCancel, true);
    this.ownerWindow.addEventListener('pointermove', this.onPointerMove, true);
    this.ownerWindow.addEventListener('pointerup', this.onPointerUp, true);
    this.ownerWindow.addEventListener('touchcancel', this.onTouchCancel, true);
    this.ownerWindow.addEventListener('touchend', this.onTouchEnd, true);
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
    this.pointerGesture = null;
    this.touchGesture = false;
    this.suppressPointerSelection = true;
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
    this.ownerWindow.removeEventListener('pointercancel', this.onPointerCancel, true);
    this.ownerWindow.removeEventListener('pointermove', this.onPointerMove, true);
    this.ownerWindow.removeEventListener('pointerup', this.onPointerUp, true);
    this.ownerWindow.removeEventListener('touchcancel', this.onTouchCancel, true);
    this.ownerWindow.removeEventListener('touchend', this.onTouchEnd, true);
    this.listeners.clear();
  }

  private readonly onSelectionChange = (): void => {
    if (
      this.destroyed ||
      this.frame !== null ||
      this.pointerGesture !== null ||
      this.touchGesture ||
      this.suppressPointerSelection
    )
      return;
    this.schedulePublication();
  };

  private schedulePublication(): void {
    if (this.destroyed || this.frame !== null) return;
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = null;
      this.publishCurrentSelection();
    });
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!isPrimaryPointer(event)) return;
    this.input = event.pointerType === 'touch' ? 'touch' : 'pointer';
    this.suppressPointerSelection = false;
    this.pointerGesture = {
      cancelled: false,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
    };
    this.dismissPublishedSelection();
  };

  private readonly onTouchStart = (): void => {
    this.input = 'touch';
    this.suppressPointerSelection = false;
    this.touchGesture = true;
    this.dismissPublishedSelection();
  };

  private readonly onKeyDown = (): void => {
    if (this.pointerGesture !== null || this.touchGesture) return;
    this.input = 'keyboard';
    this.suppressPointerSelection = false;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (gesture === null || !samePointer(event, gesture.pointerId) || gesture.cancelled) return;
    if (eventTargetInside(event, this.root)) return;
    gesture.cancelled = true;
    if (gesture.pointerType === 'touch') this.touchGesture = false;
    this.dismissPublishedSelection();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (gesture === null || !samePointer(event, gesture.pointerId)) return;
    gesture.cancelled = true;
    if (gesture.pointerType === 'touch') this.touchGesture = false;
    this.pointerGesture = null;
    this.suppressPointerSelection = true;
    this.dismissPublishedSelection();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (gesture === null || !samePointer(event, gesture.pointerId)) return;
    const cancelled = gesture.cancelled || !eventTargetInside(event, this.root);
    if (gesture.pointerType === 'touch') this.touchGesture = false;
    this.pointerGesture = null;
    if (cancelled) {
      this.suppressPointerSelection = true;
      this.dismissPublishedSelection();
      return;
    }
    this.suppressPointerSelection = false;
    this.schedulePublication();
  };

  private readonly onTouchCancel = (): void => {
    if (!this.touchGesture) return;
    this.touchGesture = false;
    this.suppressPointerSelection = true;
    this.dismissPublishedSelection();
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
    if (!this.touchGesture) return;
    this.touchGesture = false;
    if (!eventTargetInside(event, this.root)) {
      this.suppressPointerSelection = true;
      this.dismissPublishedSelection();
      return;
    }
    this.suppressPointerSelection = false;
    this.schedulePublication();
  };

  private publishCurrentSelection(): void {
    const identity = this.selectionIdentity();
    if (identity === null) {
      this.revision += 1;
      this.active = null;
      this.emit(null);
      return;
    }
    if (this.active !== null && sameSelection(identity, this.active)) return;
    this.revision += 1;
    const token = `${this.session}.${this.revision}.${++nextSelectionIdentity}`;
    this.active = { ...identity, token };
    const range = this.ownerDocument.getSelection()?.getRangeAt(0) ?? null;
    this.emit({
      token,
      text: identity.text,
      pageIndex: identity.pageIndex,
      clientRect: selectionRect(range),
      clientRects: selectionRects(range),
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
    const pageIndex = selectionPageIndex(anchorLayer);
    if (pageIndex === null) return null;
    return {
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
      textLayer: anchorLayer,
      text,
      pageIndex,
    };
  }

  private emit(selection: PdfTextSelection | null): void {
    for (const listener of this.listeners) listener(selection);
  }

  private dismissPublishedSelection(): void {
    this.cancelFrame();
    if (this.active === null) return;
    this.revision += 1;
    this.active = null;
    this.emit(null);
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    this.ownerWindow.cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}

function isPrimaryPointer(event: PointerEvent): boolean {
  return event.button === 0 && event.isPrimary !== false;
}

function samePointer(event: PointerEvent, pointerId: number): boolean {
  return event.pointerId === pointerId || event.pointerId === 0 || pointerId === 0;
}

function eventTargetInside(event: Event, root: HTMLElement): boolean {
  const point = eventClientPoint(event);
  if (point !== null && pointOutside(point, root.getBoundingClientRect())) return false;
  const target = event.target;
  return target !== null && 'nodeType' in target && root.contains(target as Node);
}

function eventClientPoint(event: Event): { readonly x: number; readonly y: number } | null {
  if (
    'clientX' in event &&
    'clientY' in event &&
    typeof event.clientX === 'number' &&
    typeof event.clientY === 'number'
  )
    return { x: event.clientX, y: event.clientY };
  if (!('changedTouches' in event)) return null;
  const touch = (event.changedTouches as readonly Touch[] | undefined)?.[0];
  return touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
}

function pointOutside(point: { readonly x: number; readonly y: number }, bounds: DOMRect): boolean {
  if (bounds.width <= 0 && bounds.height <= 0) return false;
  return (
    point.x < bounds.left ||
    point.x > bounds.right ||
    point.y < bounds.top ||
    point.y > bounds.bottom
  );
}

function closestTextLayer(node: Node, root: HTMLElement): Element | null {
  if (!root.contains(node)) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const textLayer = element?.closest('.textLayer') ?? null;
  return textLayer !== null && root.contains(textLayer) ? textLayer : null;
}

function selectionPageIndex(textLayer: Element): number | null {
  const pageNumber = Number(
    textLayer.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber'],
  );
  return Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber - 1 : null;
}

function sameSelection(left: SelectionIdentity, right: SelectionIdentity): boolean {
  return (
    left.anchorNode === right.anchorNode &&
    left.anchorOffset === right.anchorOffset &&
    left.focusNode === right.focusNode &&
    left.focusOffset === right.focusOffset &&
    left.textLayer === right.textLayer &&
    left.text === right.text &&
    left.pageIndex === right.pageIndex
  );
}

function selectionRect(range: Range | null): PdfSelectionRect {
  if (range === null) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const { left, top, right, bottom, width, height } = range.getBoundingClientRect();
  return { left, top, right, bottom, width, height };
}

function selectionRects(range: Range | null): readonly PdfSelectionRect[] {
  if (range === null || typeof range.getClientRects !== 'function') return [];
  return Array.from(range.getClientRects(), ({ left, top, right, bottom, width, height }) => ({
    left,
    top,
    right,
    bottom,
    width,
    height,
  }));
}
