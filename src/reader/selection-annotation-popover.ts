import { setIcon, type IconName } from 'obsidian';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import { ownerWindow } from './owner-dom.js';

export type SelectionAnnotationIntent =
  | { readonly type: 'highlight'; readonly color: string }
  | { readonly type: 'comment'; readonly color: string }
  | { readonly type: 'link'; readonly color: string }
  | { readonly type: 'tag'; readonly color: string }
  | { readonly type: 'dismiss' };

export interface SelectionAnnotationPopoverRequest {
  readonly selection: PdfTextSelection;
  readonly palette: readonly AnnotationPaletteEntry[];
  readonly onIntent: (intent: SelectionAnnotationIntent) => void;
}

const DEFAULT_COLOR = '#ffd400';
const POPOVER_GAP = 8;

interface VisualViewportBounds {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export class SelectionAnnotationPopover {
  readonly element: HTMLDivElement;

  private readonly cleanups: Array<() => void> = [];
  private readonly activeCleanups: Array<() => void> = [];
  private active: SelectionAnnotationPopoverRequest | null = null;
  private frame: number | null = null;
  private previousFocus: HTMLElement | null = null;
  private destroyed = false;

  constructor(private readonly host: HTMLElement) {
    const owner = ownerWindow(host);
    this.element = owner.createDiv();
    this.element.className = 'abyss-selection-annotation-popover';
    this.element.dataset['region'] = 'selection-annotation-popover';
    this.element.setAttribute('aria-label', 'Selection actions');
    this.element.setAttribute('role', 'toolbar');
    this.element.hidden = true;
    host.append(this.element);

    this.listen(this.element, 'pointerdown', (event) => {
      event.preventDefault();
    });
    this.listen(this.element, 'keydown', (event) => {
      this.handleKeydown(event);
    });
    this.listen(this.element, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof ownerWindow(this.host).Element)) return;
      const button = target.closest<HTMLButtonElement>('button[data-selection-intent]');
      if (button !== null) this.emitAction(button);
    });
  }

  get isOpen(): boolean {
    return this.active !== null;
  }

  open(request: SelectionAnnotationPopoverRequest): void {
    if (this.destroyed)
      throw new DOMException('Selection annotation popover destroyed.', 'InvalidStateError');
    this.close(false, true);
    this.capturePreviousFocus();
    this.active = request;
    this.render(request.palette);
    this.listenActive(this.host.ownerDocument, 'keydown', (event) => {
      this.handleKeydown(event);
    });
    this.listenActive(this.host.ownerDocument, 'pointerdown', (event) => {
      const target = event.target;
      if (target instanceof ownerWindow(this.host).Element && !this.element.contains(target))
        this.dismiss(true);
    });
    this.frame = ownerWindow(this.host).requestAnimationFrame(() => {
      this.frame = null;
      if (this.active !== request) return;
      this.applyViewportSize();
      this.element.hidden = false;
      this.place(request.selection);
    });
  }

  close(restoreFocus = false, preservePreviousFocus = false): void {
    this.clearActiveListeners();
    this.cancelFrame();
    this.element.hidden = true;
    this.active = null;
    if (restoreFocus) this.restoreFocus();
    if (!preservePreviousFocus) this.previousFocus = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close(false);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.element.remove();
  }

  private render(palette: readonly AnnotationPaletteEntry[]): void {
    this.element.replaceChildren();
    const owner = ownerWindow(this.host);
    const swatches = owner.createDiv();
    swatches.className = 'abyss-selection-annotation-swatch-strip';
    swatches.dataset['overflow'] = 'scroll';
    swatches.dataset['region'] = 'selection-swatch-strip';
    swatches.setAttribute('aria-label', 'Highlight colors');
    swatches.setAttribute('role', 'group');
    for (const entry of palette) {
      const label = semanticLabel(entry);
      const button = this.button('highlight', `Highlight: ${label}`, 'highlighter');
      button.classList.add('abyss-selection-annotation-swatch');
      button.dataset['selectionColor'] = entry.color;
      button.style.backgroundColor = entry.color;
      swatches.append(button);
    }
    const actions = owner.createDiv();
    actions.className = 'abyss-selection-annotation-actions';
    actions.dataset['region'] = 'selection-actions';
    actions.setAttribute('aria-label', 'Selection actions');
    actions.setAttribute('role', 'group');
    actions.append(
      this.button('comment', 'Add a comment', 'message-square-plus'),
      this.button('link', 'Add link', 'link-2'),
      this.button('tag', 'Add tag', 'tag'),
    );
    this.element.append(swatches, actions);
    this.setRovingFocus(0, false);
  }

  private button(
    intent: Extract<SelectionAnnotationIntent, { readonly type: string }>['type'],
    label: string,
    icon: IconName,
  ): HTMLButtonElement {
    const button = ownerWindow(this.host).createEl('button');
    button.type = 'button';
    button.className = 'clickable-icon abyss-selection-annotation-popover-button';
    button.dataset['selectionIntent'] = intent;
    button.dataset['touchTarget'] = '44';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, icon);
    return button;
  }

  private emitAction(button: HTMLButtonElement): void {
    const request = this.active;
    if (request === null) return;
    const action = button.dataset['selectionIntent'];
    if (action === 'highlight') {
      const color = button.dataset['selectionColor'];
      if (color === undefined) return;
      request.onIntent({ color, type: 'highlight' });
    } else {
      const type = metadataIntent(action);
      if (type === null) return;
      request.onIntent({ color: request.palette[0]?.color ?? DEFAULT_COLOR, type });
    }
    this.close(false);
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.dismiss(true);
      return;
    }
    const buttons = this.buttons();
    const current = event.target;
    const index =
      current instanceof ownerWindow(this.host).HTMLButtonElement ? buttons.indexOf(current) : -1;
    if (index === -1 || buttons.length === 0) return;
    const next = rovingIndex(event.key, index, buttons.length);
    if (next === null) return;
    event.preventDefault();
    this.setRovingFocus(next, true);
  }

  private dismiss(restoreFocus: boolean): void {
    const request = this.active;
    if (request === null) return;
    this.close(restoreFocus);
    request.onIntent({ type: 'dismiss' });
  }

  private buttons(): HTMLButtonElement[] {
    return Array.from(this.element.querySelectorAll<HTMLButtonElement>('button'));
  }

  private setRovingFocus(index: number, focus: boolean): void {
    const buttons = this.buttons();
    for (const [buttonIndex, button] of buttons.entries())
      button.tabIndex = buttonIndex === index ? 0 : -1;
    if (focus) buttons[index]?.focus();
  }

  private capturePreviousFocus(): void {
    if (this.previousFocus !== null) return;
    const owner = ownerWindow(this.host);
    const active = this.host.ownerDocument.activeElement;
    if (active instanceof owner.HTMLElement && !this.element.contains(active))
      this.previousFocus = active;
  }

  private place(selection: PdfTextSelection): void {
    const bounds = this.element.getBoundingClientRect();
    const viewport = viewportBounds(ownerWindow(this.host), this.element);
    const selectionRect = selection.clientRect;
    const below = selectionRect.bottom + POPOVER_GAP;
    const above = selectionRect.top - bounds.height - POPOVER_GAP;
    const spaceBelow = viewport.bottom - selectionRect.bottom;
    const spaceAbove = selectionRect.top - viewport.top;
    const desiredTop =
      spaceBelow >= bounds.height + POPOVER_GAP || spaceBelow >= spaceAbove ? below : above;
    const desiredLeft = selectionRect.left + selectionRect.width / 2 - bounds.width / 2;
    this.element.style.left = `${clamp(desiredLeft, viewport.left, viewport.right - bounds.width)}px`;
    this.element.style.top = `${clamp(desiredTop, viewport.top, viewport.bottom - bounds.height)}px`;
  }

  private applyViewportSize(): void {
    const viewport = viewportBounds(ownerWindow(this.host), this.element);
    this.element.style.maxWidth = `${Math.max(0, viewport.right - viewport.left)}px`;
    this.element.style.maxHeight = `${Math.max(0, viewport.bottom - viewport.top)}px`;
  }

  private restoreFocus(): void {
    const previousFocus = this.previousFocus;
    if (previousFocus?.isConnected === true) {
      previousFocus.focus();
      return;
    }
    if (this.host.isConnected) {
      this.host.tabIndex = -1;
      this.host.focus();
      return;
    }
    this.host.ownerDocument.body.focus();
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    ownerWindow(this.host).cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void;
  private listen(target: HTMLElement, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.cleanups.push(() => {
      target.removeEventListener(type, listener);
    });
  }

  private listenActive<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
  ): void {
    target.addEventListener(type, listener);
    this.activeCleanups.push(() => {
      target.removeEventListener(type, listener);
    });
  }

  private clearActiveListeners(): void {
    for (const cleanup of this.activeCleanups.splice(0)) cleanup();
  }
}

function semanticLabel(entry: AnnotationPaletteEntry): string {
  const meaning = entry.meaning.trim();
  if (meaning.length > 0) return meaning;
  const name = entry.name.trim();
  return name.length > 0 ? `Custom color — ${name}` : 'Custom color';
}

function viewportBounds(owner: Window, element: HTMLElement): VisualViewportBounds {
  const viewport = rawViewportBounds(owner);
  const insets = safeAreaInsets(owner, element);
  return {
    bottom: viewport.bottom - insets.bottom,
    left: viewport.left + insets.left,
    right: viewport.right - insets.right,
    top: viewport.top + insets.top,
  };
}

function rawViewportBounds(owner: Window): VisualViewportBounds {
  const viewport = owner.visualViewport as VisualViewport | null | undefined;
  if (viewport === null || viewport === undefined) {
    return { bottom: owner.innerHeight, left: 0, right: owner.innerWidth, top: 0 };
  }
  return {
    bottom: viewport.offsetTop + viewport.height,
    left: viewport.offsetLeft,
    right: viewport.offsetLeft + viewport.width,
    top: viewport.offsetTop,
  };
}

function safeAreaInsets(
  owner: Window,
  element: HTMLElement,
): Record<'bottom' | 'left' | 'right' | 'top', number> {
  return {
    bottom: safeAreaInset(owner, element, 'bottom'),
    left: safeAreaInset(owner, element, 'left'),
    right: safeAreaInset(owner, element, 'right'),
    top: safeAreaInset(owner, element, 'top'),
  };
}

function safeAreaInset(
  owner: Window,
  element: HTMLElement,
  edge: 'bottom' | 'left' | 'right' | 'top',
): number {
  const value = owner
    .getComputedStyle(element)
    .getPropertyValue(`--abyss-selection-safe-area-${edge}`)
    .trim();
  const inset = Number.parseFloat(value);
  return Number.isFinite(inset) ? inset : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function rovingIndex(key: string, index: number, length: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % length;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + length) % length;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return null;
}

function metadataIntent(action: string | undefined): 'comment' | 'link' | 'tag' | null {
  if (action === 'comment' || action === 'link' || action === 'tag') return action;
  return null;
}
