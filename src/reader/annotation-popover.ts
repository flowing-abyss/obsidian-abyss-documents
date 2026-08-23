export type AnnotationCommentCloseReason =
  'blur' | 'escape' | 'delete-comment' | 'delete-annotation' | 'external';

export interface AnnotationPopoverRequest {
  readonly canDeleteAnnotation?: boolean | undefined;
  readonly color?: string | undefined;
  readonly comment: string;
  readonly onChange: (comment: string) => boolean | void;
  readonly onColor?: ((color: string) => void) | undefined;
  readonly onClose: (reason: AnnotationCommentCloseReason) => void;
  readonly onDeleteAnnotation: () => boolean | void;
  readonly onDeleteComment: () => boolean | void;
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

import type { AnnotationLinkSuggestionProvider, LinkSuggestion } from './link-suggestions.js';
import { ownerWindow } from './owner-dom.js';

let popoverSequence = 0;

export class AnnotationPopover {
  readonly element: HTMLDivElement;

  private readonly input: HTMLTextAreaElement;
  private readonly actions: HTMLDivElement;
  private readonly readOnlyReason: HTMLDivElement;
  private readonly suggestions: HTMLDivElement;
  private readonly cleanups: Array<() => void> = [];
  private active: AnnotationPopoverRequest | null = null;
  private passiveEdit: (() => void) | null = null;
  private previousFocus: HTMLElement | null = null;
  private destroyed = false;
  private mutationClose: AnnotationCommentCloseReason | null = null;
  private suggestionItems: readonly LinkSuggestion[] = [];
  private suggestionIndex = -1;
  private suggestionStart = -1;

  constructor(
    private readonly host: HTMLElement,
    private readonly linkSuggestions: AnnotationLinkSuggestionProvider | null = null,
    private readonly sourcePath = '',
  ) {
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
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.rows = 4;

    this.readOnlyReason = owner.createDiv();
    this.readOnlyReason.className = 'abyss-annotation-read-only-reason';
    this.readOnlyReason.dataset['region'] = 'annotation-read-only-reason';
    this.readOnlyReason.hidden = true;

    this.actions = owner.createDiv();
    this.actions.className = 'abyss-annotation-popover-actions';
    this.suggestions = this.createSuggestions(owner);
    this.element.append(this.input, this.suggestions, this.readOnlyReason, this.actions);
    host.append(this.element);

    this.listen(this.element, 'keydown', (event) => {
      if (event.target === this.input && this.handleSuggestionKey(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close(true, 'escape');
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
      if (target === this.input) {
        this.active?.onChange(this.input.value);
        this.updateSuggestions();
        return;
      }
      if (target.matches('input[data-action="annotation-color"]'))
        this.active?.onColor?.((target as HTMLInputElement).value);
    });
    this.listen(this.input, 'select', () => {
      this.updateSuggestions();
    });
    this.listen(this.input, 'focusout', (event) => {
      const related = event.relatedTarget;
      if (related instanceof ownerWindow(this.host).HTMLElement && this.element.contains(related))
        return;
      this.close(false, 'blur');
    });
  }

  private createSuggestions(owner: ReturnType<typeof ownerWindow>): HTMLDivElement {
    const suggestions = owner.createDiv();
    suggestions.className = 'abyss-annotation-link-suggestions';
    suggestions.setAttribute('role', 'listbox');
    suggestions.setAttribute('aria-label', 'Link suggestions');
    suggestions.id = `abyss-annotation-suggestions-${++popoverSequence}`;
    suggestions.hidden = true;
    this.input.setAttribute('aria-controls', suggestions.id);
    return suggestions;
  }

  open(request: AnnotationPopoverRequest): void {
    if (this.destroyed)
      throw new DOMException('Annotation popover destroyed.', 'InvalidStateError');
    this.closeForReplacement();
    const owner = ownerWindow(this.host);
    this.capturePreviousFocus(owner);
    this.active = request;
    this.passiveEdit = null;
    this.input.hidden = false;
    this.input.value = request.comment;
    this.hideSuggestions();
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
    this.closeForReplacement();
    const owner = ownerWindow(this.host);
    if (request.selected === true) this.capturePreviousFocus(owner);
    this.active = null;
    this.passiveEdit = request.onEdit ?? null;
    this.input.hidden = true;
    this.hideSuggestions();
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

  close(restoreFocus = false, reason: AnnotationCommentCloseReason = 'external'): void {
    if (this.mutationClose !== null) return;
    if (this.element.hidden) return;
    const request = this.active;
    this.element.hidden = true;
    this.active = null;
    this.passiveEdit = null;
    if (restoreFocus) this.previousFocus?.focus();
    this.previousFocus = null;
    this.hideSuggestions();
    request?.onClose(reason);
  }

  private closeForReplacement(): void {
    if (this.element.hidden) return;
    const previousFocus = this.previousFocus;
    this.close(false, 'external');
    this.previousFocus = previousFocus;
  }

  private capturePreviousFocus(owner: ReturnType<typeof ownerWindow>): void {
    const active = this.host.ownerDocument.activeElement;
    if (active instanceof owner.HTMLElement && this.element.contains(active)) return;
    this.previousFocus = active instanceof owner.HTMLElement ? active : null;
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
    );
  }

  updateColor(color: string): void {
    const input = this.actions.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
    if (input !== null) input.value = color;
  }

  private handleAction(action: string | undefined): void {
    if (action === 'insert-tag') this.insertText(' #tag');
    else if (action === 'insert-link') this.insertText(' [[Link]]');
    else if (action === 'delete-comment')
      this.commit('delete-comment', () => this.active?.onDeleteComment());
    else if (action === 'delete-annotation')
      this.commit('delete-annotation', () => this.active?.onDeleteAnnotation());
    else if (action === 'edit-comment') {
      const request = this.passiveEdit;
      request?.();
    } else if (action === 'cancel-comment') this.close(true);
  }

  private commit(reason: AnnotationCommentCloseReason, action: () => boolean | void): void {
    this.mutationClose = reason;
    let succeeded = false;
    try {
      succeeded = action() !== false;
    } finally {
      this.mutationClose = null;
    }
    if (!succeeded) return;
    this.close(true, reason);
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

  private updateSuggestions(): void {
    if (this.input.selectionStart !== this.input.selectionEnd) {
      this.hideSuggestions();
      return;
    }
    const token = annotationLinkTokenAtCursor(this.input.value, this.input.selectionStart);
    if (token === null || this.linkSuggestions === null) {
      this.hideSuggestions();
      return;
    }
    this.suggestionStart = token.open;
    this.suggestionItems = this.linkSuggestions.suggest(token.query, this.sourcePath);
    this.suggestionIndex = this.suggestionItems.length > 0 ? 0 : -1;
    this.suggestions.replaceChildren();
    for (const [index, suggestion] of this.suggestionItems.entries()) {
      const option = ownerWindow(this.host).createDiv();
      option.setAttribute('role', 'option');
      option.id = `${this.suggestions.id}-option-${index}`;
      option.setAttribute('aria-selected', String(index === this.suggestionIndex));
      option.textContent = suggestion.display;
      option.addEventListener('click', () => {
        this.chooseSuggestion(index);
      });
      this.suggestions.append(option);
    }
    this.suggestions.hidden = this.suggestionItems.length === 0;
    this.input.setAttribute('aria-expanded', String(!this.suggestions.hidden));
    this.updateSuggestionSelection();
  }

  private handleSuggestionKey(event: KeyboardEvent): boolean {
    if (this.suggestions.hidden) return false;
    if (!this.isSuggestionCursorCurrent()) {
      this.hideSuggestions();
      return false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hideSuggestions();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.suggestionIndex =
        (this.suggestionIndex + direction + this.suggestionItems.length) %
        this.suggestionItems.length;
      this.updateSuggestionSelection();
      return true;
    }
    if (event.key === 'Enter' && this.suggestionIndex >= 0) {
      event.preventDefault();
      this.chooseSuggestion(this.suggestionIndex);
      return true;
    }
    return false;
  }

  private chooseSuggestion(index: number): void {
    const suggestion = this.suggestionItems[index];
    if (
      suggestion === undefined ||
      this.suggestionStart < 0 ||
      this.input.selectionStart !== this.input.selectionEnd
    ) {
      this.hideSuggestions();
      return;
    }
    const token = annotationLinkTokenAtCursor(this.input.value, this.input.selectionStart);
    if (token?.open !== this.suggestionStart) {
      this.hideSuggestions();
      return;
    }
    if (token.close !== null && !isWikiLink(suggestion.insertion)) {
      this.input.setRangeText(suggestion.insertion, token.open, token.close + 2, 'end');
    } else if (token.close !== null) {
      this.input.setRangeText(
        wikiLinkTarget(suggestion.insertion),
        token.open + 2,
        token.targetEnd,
        'end',
      );
    } else {
      this.input.setRangeText(suggestion.insertion, token.open, this.input.selectionStart, 'end');
    }
    this.input.dispatchEvent(new (ownerWindow(this.host).Event)('input', { bubbles: true }));
    this.hideSuggestions();
    this.input.focus();
  }

  private isSuggestionCursorCurrent(): boolean {
    if (this.input.selectionStart !== this.input.selectionEnd) return false;
    return (
      annotationLinkTokenAtCursor(this.input.value, this.input.selectionStart)?.open ===
      this.suggestionStart
    );
  }

  private updateSuggestionSelection(): void {
    this.suggestions.querySelectorAll('[role="option"]').forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === this.suggestionIndex));
    });
    const active = this.suggestions.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active === null) this.input.removeAttribute('aria-activedescendant');
    else this.input.setAttribute('aria-activedescendant', active.id);
  }

  private hideSuggestions(): void {
    this.suggestionItems = [];
    this.suggestionIndex = -1;
    this.suggestionStart = -1;
    this.suggestions.replaceChildren();
    this.suggestions.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
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

interface AnnotationLinkToken {
  readonly close: number | null;
  readonly open: number;
  readonly query: string;
  readonly targetEnd: number;
}

function annotationLinkTokenAtCursor(value: string, cursor: number): AnnotationLinkToken | null {
  const open = value.lastIndexOf('[[', cursor);
  if (open < 0 || cursor < open + 2) return null;
  const closeIndex = value.indexOf(']]', open + 2);
  const close = closeIndex < 0 ? null : closeIndex;
  if (!cursorBelongsToToken(cursor, close)) return null;
  const aliasIndex = value.indexOf('|', open + 2);
  const targetEnd = targetEndForToken(aliasIndex, close, cursor);
  return { close, open, query: value.slice(open + 2, targetEnd), targetEnd };
}

function cursorBelongsToToken(cursor: number, close: number | null): boolean {
  return close === null || cursor <= close;
}

function targetEndForToken(alias: number, close: number | null, cursor: number): number {
  if (alias >= 0 && (close === null || alias < close)) return alias;
  return close ?? cursor;
}

function isWikiLink(value: string): boolean {
  return value.startsWith('[[') && value.endsWith(']]');
}

function wikiLinkTarget(value: string): string {
  return isWikiLink(value) ? (value.slice(2, -2).split('|', 1)[0] ?? '') : value;
}
