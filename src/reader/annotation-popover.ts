export interface AnnotationPopoverRequest {
  readonly canDeleteAnnotation?: boolean | undefined;
  readonly color?: string | undefined;
  readonly comment: string;
  readonly onColor?: ((color: string) => void) | undefined;
  readonly onDeleteAnnotation: () => boolean | void;
  readonly onDeleteComment: () => boolean | void;
  readonly onSave: (comment: string) => boolean | void;
  readonly readOnlyReason?: string | undefined;
  readonly x: number;
  readonly y: number;
}

export interface AnnotationPassivePopupRequest {
  readonly comment: string;
  readonly onEdit?: (() => void) | undefined;
  readonly readOnlyReason?: string | undefined;
  readonly selected?: boolean | undefined;
  readonly x: number;
  readonly y: number;
}

import { ownerWindow } from './owner-dom.js';

export class AnnotationPopover {
  readonly element: HTMLDivElement;

  private readonly input: HTMLTextAreaElement;
  private readonly actions: HTMLDivElement;
  private readonly readOnlyReason: HTMLDivElement;
  private readonly cleanups: Array<() => void> = [];
  private active: AnnotationPopoverRequest | null = null;
  private passiveEdit: (() => void) | null = null;
  private previousFocus: HTMLElement | null = null;
  private destroyed = false;

  constructor(private readonly host: HTMLElement) {
    const owner = ownerWindow(host);
    this.element = owner.createDiv();
    this.element.className = 'abyss-annotation-popover';
    this.element.dataset['annotationPopover'] = '';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Annotation comment');
    this.element.hidden = true;

    this.input = owner.createEl('textarea');
    this.input.className = 'abyss-annotation-comment';
    this.input.setAttribute('aria-label', 'Comment');
    this.input.rows = 4;

    this.readOnlyReason = owner.createDiv();
    this.readOnlyReason.className = 'abyss-annotation-read-only-reason';
    this.readOnlyReason.dataset['region'] = 'annotation-read-only-reason';
    this.readOnlyReason.hidden = true;

    this.actions = owner.createDiv();
    this.actions.className = 'abyss-annotation-popover-actions';
    this.element.append(this.input, this.readOnlyReason, this.actions);
    host.append(this.element);

    this.listen(this.element, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      if (!(target instanceof ownerWindow(this.host).HTMLButtonElement)) return;
      event.preventDefault();
      target.click();
    });
    this.listen(this.element, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof ownerWindow(this.host).Element)) return;
      this.handleAction(target.closest<HTMLElement>('[data-action]')?.dataset['action']);
    });
    this.listen(this.element, 'input', (event) => {
      const target = event.target;
      if (!(target instanceof ownerWindow(this.host).Element)) return;
      if (!target.matches('input[data-action="annotation-color"]')) return;
      this.active?.onColor?.((target as HTMLInputElement).value);
    });
  }

  open(request: AnnotationPopoverRequest): void {
    if (this.destroyed)
      throw new DOMException('Annotation popover destroyed.', 'InvalidStateError');
    const owner = ownerWindow(this.host);
    const active = this.host.ownerDocument.activeElement;
    if (!(active instanceof owner.HTMLElement && this.element.contains(active))) {
      this.previousFocus = active instanceof owner.HTMLElement ? active : null;
    }
    this.active = request;
    this.passiveEdit = null;
    this.input.hidden = false;
    this.input.value = request.comment;
    const readOnly = request.readOnlyReason !== undefined;
    this.input.readOnly = readOnly;
    this.readOnlyReason.hidden = !readOnly;
    this.readOnlyReason.textContent = request.readOnlyReason ?? '';
    this.renderActions(request);
    this.element.hidden = false;
    this.place(request.x, request.y, owner);
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  openPassive(request: AnnotationPassivePopupRequest): void {
    if (this.destroyed)
      throw new DOMException('Annotation popover destroyed.', 'InvalidStateError');
    const owner = ownerWindow(this.host);
    if (request.selected === true) {
      const active = this.host.ownerDocument.activeElement;
      this.previousFocus = active instanceof owner.HTMLElement ? active : null;
    }
    this.active = null;
    this.passiveEdit = request.onEdit ?? null;
    this.input.hidden = true;
    this.readOnlyReason.hidden = request.readOnlyReason === undefined;
    this.readOnlyReason.textContent = request.readOnlyReason ?? '';
    this.actions.replaceChildren();
    const content = owner.createDiv();
    content.className = 'abyss-annotation-comment-popup';
    content.dataset['region'] = 'annotation-comment-popup';
    content.textContent = request.comment;
    this.actions.append(content);
    if (request.selected === true) {
      if (request.onEdit !== undefined) {
        this.actions.append(this.button('edit-comment', 'Edit comment', 'Edit comment'));
      }
      this.actions.append(this.button('cancel-comment', 'Close', 'Close'));
    }
    this.element.hidden = false;
    this.place(request.x, request.y, owner);
    if (request.selected === true) {
      this.actions.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }

  close(restoreFocus = false): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.active = null;
    this.passiveEdit = null;
    if (restoreFocus) this.previousFocus?.focus();
    this.previousFocus = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close(false);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.element.remove();
  }

  private button(action: string, label: string, text: string): HTMLButtonElement {
    const button = ownerWindow(this.host).createEl('button');
    button.type = 'button';
    button.className = 'abyss-annotation-popover-button';
    button.dataset['action'] = action;
    button.setAttribute('aria-label', label);
    button.textContent = text;
    return button;
  }

  private renderActions(request: AnnotationPopoverRequest): void {
    this.actions.replaceChildren();
    if (request.readOnlyReason !== undefined) {
      this.actions.append(this.button('cancel-comment', 'Close', 'Close'));
      return;
    }
    if (request.color !== undefined && request.onColor !== undefined) {
      const color = ownerWindow(this.host).createEl('input');
      color.type = 'color';
      color.className = 'abyss-annotation-popover-color';
      color.value = request.color;
      color.dataset['action'] = 'annotation-color';
      color.setAttribute('aria-label', 'Annotation color');
      color.title = 'Annotation color';
      this.actions.append(color);
    }
    this.actions.append(
      this.button('insert-tag', 'Add tag', '#'),
      this.button('insert-link', 'Add link', '[[]]'),
      this.button('delete-comment', 'Delete comment', 'Delete comment'),
      ...(request.canDeleteAnnotation === false
        ? []
        : [this.button('delete-annotation', 'Delete annotation', 'Delete annotation')]),
      this.button('cancel-comment', 'Cancel', 'Cancel'),
      this.button('save-comment', 'Save comment', 'Save'),
    );
  }

  updateColor(color: string): void {
    const input = this.actions.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
    if (input !== null) input.value = color;
  }

  private handleAction(action: string | undefined): void {
    if (action === 'insert-tag') this.insertText(' #tag');
    else if (action === 'insert-link') this.insertText(' [[Link]]');
    else if (action === 'save-comment') this.commit(() => this.active?.onSave(this.input.value));
    else if (action === 'delete-comment') this.commit(() => this.active?.onDeleteComment());
    else if (action === 'delete-annotation') this.commit(() => this.active?.onDeleteAnnotation());
    else if (action === 'edit-comment') {
      const request = this.passiveEdit;
      request?.();
    } else if (action === 'cancel-comment') this.close(true);
  }

  private commit(action: () => boolean | void): void {
    if (action() === false) return;
    this.close(true);
  }

  private place(x: number, y: number, owner: Window): void {
    const viewport = owner.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? owner.innerWidth;
    const height = viewport?.height ?? owner.innerHeight;
    const bounds = this.element.getBoundingClientRect();
    this.element.style.left = `${Math.max(left, Math.min(x, left + width - bounds.width))}px`;
    this.element.style.top = `${Math.max(top, Math.min(y, top + height - bounds.height))}px`;
  }

  private insertText(text: string): void {
    const start = this.input.selectionStart;
    const end = this.input.selectionEnd;
    this.input.setRangeText(text, start, end, 'end');
    this.input.dispatchEvent(new (ownerWindow(this.host).Event)('input', { bubbles: true }));
    this.input.focus();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, listener);
    this.cleanups.push(() => {
      target.removeEventListener(type, listener);
    });
  }
}
