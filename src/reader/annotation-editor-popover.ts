import { setIcon, setTooltip } from 'obsidian';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import { decodeAnnotationComment, updateAnnotationComment } from '../annotation-tokens.js';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import {
  annotationLinkTokenAtCursor,
  replaceAnnotationLinkSuggestion,
  type AnnotationLinkSuggestionProvider,
  type LinkSuggestion,
} from './link-suggestions.js';
import { ownerWindow } from './owner-dom.js';

export type AnnotationEditorTarget =
  | { readonly kind: 'selection'; readonly selection: PdfTextSelection }
  | { readonly kind: 'annotation'; readonly annotation: DocumentAnnotation }
  | { readonly kind: 'multiple'; readonly annotations: readonly DocumentAnnotation[] }
  | { readonly kind: 'readonly'; readonly annotation: DocumentAnnotation };

export interface AnnotationEditorCreation {
  readonly color: string;
  readonly comment: string;
  readonly selection: PdfTextSelection;
}

export interface AnnotationEditorUpdate {
  readonly annotations: readonly DocumentAnnotation[];
  readonly color?: string | undefined;
  readonly comment?: string | undefined;
}

export type AnnotationEditorCloseReason = 'escape' | 'click-away' | 'focus-away' | 'external';

export interface AnnotationEditorPopoverRequest {
  readonly target: AnnotationEditorTarget;
  readonly palette: readonly AnnotationPaletteEntry[];
  readonly color?: string | undefined;
  readonly position?: { readonly x: number; readonly y: number } | undefined;
  readonly onCreate: (
    creation: AnnotationEditorCreation,
  ) => DocumentAnnotation | null | void | Promise<DocumentAnnotation | null | void>;
  readonly onUpdate: (update: AnnotationEditorUpdate) => boolean | void;
  readonly onDelete: (annotations: readonly DocumentAnnotation[]) => boolean | void;
  readonly onClose: (reason: AnnotationEditorCloseReason) => void;
}

const DEFAULT_COLOR = '#ffd400';
const METADATA_DEBOUNCE_MS = 300;
let editorSequence = 0;

interface AnnotationEditorElements {
  readonly actions: HTMLDivElement;
  readonly comment: HTMLTextAreaElement;
  readonly element: HTMLDivElement;
  readonly links: HTMLInputElement;
  readonly metadata: HTMLDivElement;
  readonly palette: HTMLDivElement;
  readonly readOnly: HTMLDivElement;
  readonly status: HTMLDivElement;
  readonly suggestions: HTMLDivElement;
  readonly tags: HTMLInputElement;
}

interface AnnotationMetadataElements {
  readonly comment: HTMLTextAreaElement;
  readonly links: HTMLInputElement;
  readonly suggestions: HTMLDivElement;
  readonly tags: HTMLInputElement;
}

interface FixedViewportBounds {
  readonly bottom: number;
  readonly left: number;
  readonly originLeft: number;
  readonly originTop: number;
  readonly right: number;
  readonly top: number;
}

interface AnnotationCreationDraft {
  readonly color: string;
  readonly comment: string;
  readonly commentField: string;
  readonly linksField: string;
  readonly tagsField: string;
}

interface AnnotationCreationJob {
  readonly generation: number;
  readonly request: AnnotationEditorPopoverRequest;
  completed: boolean;
  draft: AnnotationCreationDraft;
  pendingUpdate: AnnotationEditorUpdate | null;
}

export class AnnotationEditorPopover {
  readonly element: HTMLDivElement;

  private readonly paletteElement: HTMLDivElement;
  private readonly metadataElement: HTMLDivElement;
  private readonly commentInput: HTMLTextAreaElement;
  private readonly tagsInput: HTMLInputElement;
  private readonly linksInput: HTMLInputElement;
  private readonly suggestionsElement: HTMLDivElement;
  private readonly readOnlyElement: HTMLDivElement;
  private readonly statusElement: HTMLDivElement;
  private readonly actionsElement: HTMLDivElement;
  private readonly cleanups: Array<() => void> = [];
  private active: AnnotationEditorPopoverRequest | null = null;
  private activeColor = DEFAULT_COLOR;
  private commentSource = '';
  private readonly dirtyMetadata = new Set<'links' | 'prose' | 'tags'>();
  private metadataTimer: number | null = null;
  private openGeneration = 0;
  private readonly pendingCreationUpdates = new Set<AnnotationCreationJob>();
  private previousFocus: HTMLElement | null = null;
  private selectionCreation: AnnotationCreationJob | null = null;
  private selectionCommitted = false;
  private suggestionIndex = -1;
  private suggestionItems: readonly LinkSuggestion[] = [];
  private suggestionOrigin: { readonly open: number; readonly query: string } | null = null;
  private destroyed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly linkSuggestions: AnnotationLinkSuggestionProvider | null = null,
    private readonly sourcePath = '',
  ) {
    const elements = createEditorElements(host);
    this.element = elements.element;
    this.paletteElement = elements.palette;
    this.metadataElement = elements.metadata;
    this.commentInput = elements.comment;
    this.tagsInput = elements.tags;
    this.linksInput = elements.links;
    this.suggestionsElement = elements.suggestions;
    this.readOnlyElement = elements.readOnly;
    this.statusElement = elements.status;
    this.actionsElement = elements.actions;
    host.append(this.element);
    this.registerElementListeners();
    this.registerDocumentListeners();
  }

  private registerElementListeners(): void {
    this.listen(this.element, 'pointerdown', (event) => {
      if (
        this.active?.target.kind === 'selection' &&
        !isEditablePointerTarget(event.target, ownerWindow(this.host))
      )
        event.preventDefault();
    });
    this.listen(this.element, 'click', (event) => {
      this.handlePrimaryClick(event);
    });
    this.listen(this.element, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof ownerWindow(this.host).Element)) return;
      const option = target.closest<HTMLElement>('[data-suggestion-index]');
      const index = Number(option?.dataset['suggestionIndex']);
      if (Number.isInteger(index)) this.chooseSuggestion(index);
    });
    this.listen(this.element, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof ownerWindow(this.host).Element)) return;
      if (target.closest('[data-action="delete-annotation"]') !== null) this.deleteTarget();
    });
    this.registerMetadataListeners();
  }

  private handlePrimaryClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof ownerWindow(this.host).Element)) return;
    const color = target.closest<HTMLElement>('[data-editor-color]')?.dataset['editorColor'];
    if (color === undefined) return;
    const previousColor = this.activeColor;
    this.activeColor = color;
    this.updatePressedColor();
    if (this.persistColor(color)) return;
    this.activeColor = previousColor;
    this.updatePressedColor();
  }

  private persistColor(color: string): boolean {
    const request = this.active;
    if (request?.target.kind === 'selection') {
      this.createSelection(this.metadataComment());
      return true;
    }
    if (request?.target.kind === 'annotation')
      return this.persistUpdate(request, { annotations: [request.target.annotation], color });
    if (request?.target.kind === 'multiple')
      return this.persistUpdate(request, { annotations: request.target.annotations, color });
    return false;
  }

  private registerMetadataListeners(): void {
    this.listen(this.commentInput, 'input', () => {
      this.metadataChanged('prose');
    });
    this.listen(this.tagsInput, 'input', () => {
      this.metadataChanged('tags');
    });
    this.listen(this.linksInput, 'input', () => {
      this.metadataChanged('links');
      this.updateSuggestions();
    });
    this.listen(this.linksInput, 'select', () => {
      this.updateSuggestions();
    });
    this.listen(this.linksInput, 'click', () => {
      this.updateSuggestions();
    });
    this.listen(this.linksInput, 'keyup', (event) => {
      if (isCaretMovementKey(event.key)) this.updateSuggestions();
    });
    this.listen(this.linksInput, 'keydown', (event) => {
      this.handleSuggestionKey(event);
    });
  }

  private registerDocumentListeners(): void {
    this.listenDocument('keydown', (event) => {
      if (this.active === null || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close('escape', true);
    });
    this.listenDocument('pointerdown', (event) => {
      if (this.active === null) return;
      const target = event.target;
      if (target instanceof ownerWindow(this.host).Element && this.element.contains(target)) return;
      this.close('click-away');
    });
    this.listenDocument('focusin', (event) => {
      if (this.active === null) return;
      const target = event.target;
      if (target instanceof ownerWindow(this.host).Element && this.element.contains(target)) return;
      this.close('focus-away');
    });
  }

  get isOpen(): boolean {
    return this.active !== null;
  }

  get hasPendingChanges(): boolean {
    return this.dirtyMetadata.size > 0 || this.pendingCreationUpdates.size > 0;
  }

  retryPendingUpdates(): boolean {
    for (const job of this.pendingCreationUpdates) {
      const update = job.pendingUpdate;
      if (update === null || job.request.onUpdate(update) !== false) {
        job.pendingUpdate = null;
        this.pendingCreationUpdates.delete(job);
      }
    }
    return this.pendingCreationUpdates.size === 0;
  }

  private persistUpdate(
    request: AnnotationEditorPopoverRequest,
    update: AnnotationEditorUpdate,
  ): boolean {
    if (request.onUpdate(update) === false) return false;
    this.removeSupersededCreationFields(update);
    return true;
  }

  private removeSupersededCreationFields(update: AnnotationEditorUpdate): void {
    for (const job of this.pendingCreationUpdates) {
      const pending = job.pendingUpdate;
      if (pending === null || !updatesOverlap(pending, update)) continue;
      job.pendingUpdate = removeAcceptedFields(pending, update);
      if (job.pendingUpdate === null) this.pendingCreationUpdates.delete(job);
    }
  }

  open(request: AnnotationEditorPopoverRequest): boolean {
    if (this.destroyed)
      throw new DOMException('Annotation editor popover destroyed.', 'InvalidStateError');
    if (!this.flushPendingMetadata()) return false;
    if (this.active === null) this.capturePreviousFocus();
    this.openGeneration += 1;
    this.active = request;
    this.cancelMetadataTimer();
    this.dirtyMetadata.clear();
    this.selectionCreation = null;
    this.selectionCommitted = false;
    this.render(request);
    this.element.hidden = false;
    const position = request.position ?? targetPosition(request.target);
    this.place(position.x, position.y);
    return true;
  }

  close(reason: AnnotationEditorCloseReason = 'external', restoreFocus = false): boolean {
    const request = this.active;
    if (request === null) return true;
    if (!this.flushPendingMetadata()) return false;
    this.openGeneration += 1;
    this.active = null;
    this.selectionCreation = null;
    this.element.hidden = true;
    if (restoreFocus) this.restoreFocus();
    this.previousFocus = null;
    request.onClose(reason);
    return true;
  }

  updateTarget(target: AnnotationEditorTarget): boolean {
    const request = this.active;
    if (request === null) return false;
    if (request.target.kind === 'selection' && target.kind === 'annotation') {
      const job =
        this.selectionCreation ??
        this.makeCreationJob(request, this.metadataComment(), this.openGeneration);
      this.finishSelectionCreation(job, target.annotation);
      return true;
    }
    if (!this.flushPendingMetadata()) return false;
    const next = { ...request, target };
    this.active = next;
    this.selectionCreation = null;
    this.selectionCommitted = target.kind !== 'selection';
    this.dirtyMetadata.clear();
    this.render(next);
    return true;
  }

  destroy(): boolean {
    if (this.destroyed) return true;
    if (!this.flushPendingMetadata()) return false;
    this.destroyed = true;
    this.openGeneration += 1;
    this.cancelMetadataTimer();
    this.active = null;
    this.selectionCreation = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.element.remove();
    return true;
  }

  private render(request: AnnotationEditorPopoverRequest): void {
    const annotation = singleAnnotation(request.target);
    const color = targetColor(request, annotation);
    this.activeColor = color;
    this.renderPalette(request.palette, color);
    this.populateMetadata(annotation);
    this.renderTargetState(request.target);
    this.hideSuggestions();
    this.renderActions(request.target);
  }

  private populateMetadata(annotation: DocumentAnnotation | null): void {
    const fields = annotationFields(annotation);
    this.commentSource = fields.source;
    this.commentInput.value = fields.prose;
    this.tagsInput.value = renderTags(fields.tags);
    this.linksInput.value = renderLinks(fields.links);
  }

  private renderTargetState(target: AnnotationEditorTarget): void {
    const readOnly = target.kind === 'readonly';
    const multiple = target.kind === 'multiple';
    this.paletteElement.hidden = readOnly;
    this.metadataElement.hidden = multiple || readOnly;
    this.readOnlyElement.hidden = !readOnly;
    this.readOnlyElement.replaceChildren();
    this.statusElement.hidden = !multiple && !readOnly;
    this.statusElement.textContent = targetStatus(target);
    this.element.setAttribute('aria-label', targetDialogLabel(target));
    if (readOnly) this.renderReadOnly(target.annotation);
  }

  private renderPalette(palette: readonly AnnotationPaletteEntry[], activeColor: string): void {
    this.paletteElement.replaceChildren();
    for (const entry of palette) {
      const button = ownerWindow(this.host).createEl('button');
      button.type = 'button';
      button.className = 'abyss-annotation-editor-swatch';
      button.dataset['editorColor'] = entry.color;
      button.dataset['shape'] = 'square';
      button.style.setProperty('--abyss-annotation-swatch-color', entry.color);
      button.setAttribute('aria-label', semanticColorLabel(entry));
      button.setAttribute('aria-pressed', String(entry.color === activeColor));
      this.paletteElement.append(button);
    }
  }

  private updatePressedColor(): void {
    this.paletteElement
      .querySelectorAll<HTMLButtonElement>('[data-editor-color]')
      .forEach((button) => {
        button.setAttribute(
          'aria-pressed',
          String(button.dataset['editorColor'] === this.activeColor),
        );
      });
  }

  private createSelection(comment: string): void {
    const request = this.active;
    if (request?.target.kind !== 'selection') return;
    if (this.selectionCommitted) {
      if (this.selectionCreation?.request === request)
        this.selectionCreation.draft = this.captureCreationDraft(comment);
      return;
    }
    const generation = this.openGeneration;
    const job = this.makeCreationJob(request, comment, generation);
    this.selectionCreation = job;
    this.selectionCommitted = true;
    try {
      const result = request.onCreate({
        color: this.activeColor,
        comment,
        selection: request.target.selection,
      });
      void Promise.resolve(result).then(
        (annotation) => {
          if (annotation !== null && annotation !== undefined)
            this.finishSelectionCreation(job, annotation);
        },
        (cause: unknown) => {
          if (generation !== this.openGeneration || this.active !== request) return;
          this.selectionCommitted = false;
          this.selectionCreation = null;
          console.error('[abyss-documents] Could not create selection annotation', { cause });
        },
      );
    } catch (cause) {
      this.selectionCommitted = false;
      this.selectionCreation = null;
      throw cause;
    }
  }

  private makeCreationJob(
    request: AnnotationEditorPopoverRequest,
    comment: string,
    generation: number,
  ): AnnotationCreationJob {
    return {
      completed: false,
      draft: this.captureCreationDraft(comment),
      generation,
      pendingUpdate: null,
      request,
    };
  }

  private captureCreationDraft(comment: string): AnnotationCreationDraft {
    return {
      color: this.activeColor,
      comment,
      commentField: this.commentInput.value,
      linksField: this.linksInput.value,
      tagsField: this.tagsInput.value,
    };
  }

  private finishSelectionCreation(
    job: AnnotationCreationJob,
    annotation: DocumentAnnotation,
  ): void {
    if (job.completed) return;
    job.completed = true;
    const { draft, request } = job;
    if (job.generation !== this.openGeneration || this.active !== request) {
      this.persistCreatedDraft(job, annotation);
      return;
    }
    const next = { ...request, target: { annotation, kind: 'annotation' as const } };
    this.active = next;
    this.selectionCreation = null;
    this.render(next);
    this.commentInput.value = draft.commentField;
    this.tagsInput.value = draft.tagsField;
    this.linksInput.value = draft.linksField;
    this.commentSource = draft.comment;
    this.activeColor = draft.color;
    this.updatePressedColor();
    this.dirtyMetadata.clear();
    this.persistCreatedDraft(job, annotation);
  }

  private persistCreatedDraft(job: AnnotationCreationJob, annotation: DocumentAnnotation): boolean {
    const { color, comment } = job.draft;
    const update: AnnotationEditorUpdate = {
      annotations: [annotation],
      ...(annotation.color === color ? {} : { color }),
      ...(annotation.comment === comment ? {} : { comment }),
    };
    if (update.color === undefined && update.comment === undefined) return true;
    job.pendingUpdate = update;
    if (job.request.onUpdate(update) === false) {
      this.pendingCreationUpdates.add(job);
      return false;
    }
    job.pendingUpdate = null;
    this.pendingCreationUpdates.delete(job);
    return true;
  }

  private metadataChanged(kind: 'links' | 'prose' | 'tags'): void {
    const request = this.active;
    if (
      request === null ||
      request.target.kind === 'readonly' ||
      request.target.kind === 'multiple'
    )
      return;
    this.dirtyMetadata.add(kind);
    if (request.target.kind === 'selection') {
      this.createSelection(this.metadataComment());
      return;
    }
    this.cancelMetadataTimer();
    this.metadataTimer = ownerWindow(this.host).setTimeout(() => {
      this.metadataTimer = null;
      this.persistMetadata();
    }, METADATA_DEBOUNCE_MS);
  }

  private metadataComment(): string {
    return updateAnnotationComment(this.commentSource, {
      ...(this.dirtyMetadata.has('prose') ? { prose: this.commentInput.value } : {}),
      ...(this.dirtyMetadata.has('tags') ? { tags: parseTagsField(this.tagsInput.value) } : {}),
      ...(this.dirtyMetadata.has('links') ? { links: parseLinksField(this.linksInput.value) } : {}),
    });
  }

  private persistMetadata(): boolean {
    const request = this.active;
    if (request?.target.kind !== 'annotation' || this.dirtyMetadata.size === 0) return true;
    const comment = this.metadataComment();
    if (!this.persistUpdate(request, { annotations: [request.target.annotation], comment }))
      return false;
    this.commentSource = comment;
    this.dirtyMetadata.clear();
    return true;
  }

  private updateSuggestions(): void {
    const cursor = this.linksInput.selectionStart;
    if (
      this.linkSuggestions === null ||
      cursor === null ||
      cursor !== this.linksInput.selectionEnd
    ) {
      this.hideSuggestions();
      return;
    }
    const token = annotationLinkTokenAtCursor(this.linksInput.value, cursor);
    if (token === null) {
      this.hideSuggestions();
      return;
    }
    this.suggestionOrigin = { open: token.open, query: token.query };
    this.suggestionItems = this.linkSuggestions.suggest(token.query, this.sourcePath);
    this.suggestionIndex = this.suggestionItems.length > 0 ? 0 : -1;
    this.suggestionsElement.replaceChildren();
    for (const [index, suggestion] of this.suggestionItems.entries()) {
      const option = ownerWindow(this.host).createDiv();
      option.dataset['suggestionIndex'] = String(index);
      option.id = `${this.suggestionsElement.id}-option-${index}`;
      option.setAttribute('aria-selected', String(index === this.suggestionIndex));
      option.setAttribute('role', 'option');
      option.textContent = suggestion.display;
      this.suggestionsElement.append(option);
    }
    this.suggestionsElement.hidden = this.suggestionItems.length === 0;
    this.linksInput.setAttribute('aria-expanded', String(!this.suggestionsElement.hidden));
    this.updateSuggestionSelection();
  }

  private handleSuggestionKey(event: KeyboardEvent): void {
    if (this.suggestionsElement.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.hideSuggestions();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.suggestionIndex =
        (this.suggestionIndex + direction + this.suggestionItems.length) %
        this.suggestionItems.length;
      this.updateSuggestionSelection();
      return;
    }
    if (event.key !== 'Enter' || this.suggestionIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.chooseSuggestion(this.suggestionIndex);
  }

  private chooseSuggestion(index: number): void {
    const suggestion = this.suggestionItems[index];
    const cursor = this.linksInput.selectionStart;
    if (
      suggestion === undefined ||
      cursor === null ||
      cursor !== this.linksInput.selectionEnd ||
      this.suggestionOrigin === null
    ) {
      this.hideSuggestions();
      return;
    }
    const token = annotationLinkTokenAtCursor(this.linksInput.value, cursor);
    if (token?.open !== this.suggestionOrigin.open || token.query !== this.suggestionOrigin.query) {
      this.hideSuggestions();
      return;
    }
    const replacement = replaceAnnotationLinkSuggestion(
      this.linksInput.value,
      cursor,
      suggestion.insertion,
    );
    if (replacement === null) return;
    this.linksInput.value = replacement.value;
    this.linksInput.setSelectionRange(replacement.cursor, replacement.cursor);
    this.hideSuggestions();
    this.metadataChanged('links');
    this.linksInput.focus();
  }

  private updateSuggestionSelection(): void {
    this.suggestionsElement.querySelectorAll('[role="option"]').forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === this.suggestionIndex));
    });
    const active = this.suggestionsElement.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active === null) this.linksInput.removeAttribute('aria-activedescendant');
    else this.linksInput.setAttribute('aria-activedescendant', active.id);
  }

  private hideSuggestions(): void {
    this.suggestionIndex = -1;
    this.suggestionItems = [];
    this.suggestionOrigin = null;
    this.suggestionsElement.replaceChildren();
    this.suggestionsElement.hidden = true;
    this.linksInput.setAttribute('aria-expanded', 'false');
    this.linksInput.removeAttribute('aria-activedescendant');
  }

  private cancelMetadataTimer(): void {
    if (this.metadataTimer === null) return;
    ownerWindow(this.host).clearTimeout(this.metadataTimer);
    this.metadataTimer = null;
  }

  private flushPendingMetadata(): boolean {
    this.cancelMetadataTimer();
    if (!this.retryPendingUpdates()) return false;
    return this.dirtyMetadata.size === 0 || this.persistMetadata();
  }

  private capturePreviousFocus(): void {
    const active = this.host.ownerDocument.activeElement;
    const owner = ownerWindow(this.host);
    if (active instanceof owner.HTMLElement && !this.element.contains(active))
      this.previousFocus = active;
  }

  private restoreFocus(): void {
    if (this.previousFocus?.isConnected === true) {
      this.previousFocus.focus();
      return;
    }
    if (this.host.isConnected) {
      this.host.tabIndex = -1;
      this.host.focus();
      return;
    }
    this.host.ownerDocument.body.focus();
  }

  private renderActions(target: AnnotationEditorTarget): void {
    this.actionsElement.replaceChildren();
    if (target.kind !== 'annotation' && target.kind !== 'multiple') return;
    const button = ownerWindow(this.host).createEl('button');
    button.type = 'button';
    button.className = 'clickable-icon abyss-annotation-editor-delete';
    button.dataset['action'] = 'delete-annotation';
    button.dataset['touchTarget'] = '44';
    const label = target.kind === 'multiple' ? 'Delete annotations' : 'Delete annotation';
    button.setAttribute('aria-label', label);
    setIcon(button, 'trash-2');
    setTooltip(button, label, { delay: 250 });
    this.actionsElement.append(button);
  }

  private renderReadOnly(annotation: DocumentAnnotation): void {
    const decoded = decodeAnnotationComment(annotation.comment);
    const values = [
      { label: 'Comment', value: decoded.prose.trim() },
      {
        label: 'Tags',
        value: renderTags(decoded.tags.length > 0 ? decoded.tags : annotation.tags),
      },
      {
        label: 'Links',
        value: renderLinks(decoded.links.length > 0 ? decoded.links : annotation.links),
      },
    ];
    for (const field of values) {
      if (field.value.length === 0) continue;
      const value = ownerWindow(this.host).createDiv();
      value.dataset['field'] = field.label.toLowerCase();
      value.setAttribute('aria-label', field.label);
      value.textContent = field.value;
      this.readOnlyElement.append(value);
    }
  }

  private deleteTarget(): void {
    const request = this.active;
    if (request === null) return;
    const annotations = targetAnnotations(request.target);
    if (annotations.length === 0 || !this.flushPendingMetadata()) return;
    if (request.onDelete(annotations) === false) return;
    this.close('external');
  }

  private place(x: number, y: number): void {
    const owner = ownerWindow(this.host);
    const viewport = fixedViewportBounds(owner, this.element);
    const bounds = this.element.getBoundingClientRect();
    this.element.dataset['overflow'] = 'scroll';
    this.element.style.maxWidth = `${Math.max(0, viewport.right - viewport.left)}px`;
    this.element.style.maxHeight = `${Math.max(0, viewport.bottom - viewport.top)}px`;
    this.element.style.left = `${clamp(x, viewport.left, viewport.right - bounds.width) - viewport.originLeft}px`;
    this.element.style.top = `${clamp(y, viewport.top, viewport.bottom - bounds.height) - viewport.originTop}px`;
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

  private listenDocument<K extends keyof DocumentEventMap>(
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
  ): void {
    this.host.ownerDocument.addEventListener(type, listener);
    this.cleanups.push(() => {
      this.host.ownerDocument.removeEventListener(type, listener);
    });
  }
}

function fixedViewportBounds(
  owner: ReturnType<typeof ownerWindow>,
  element: HTMLElement,
): FixedViewportBounds {
  const viewport = owner.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? owner.innerWidth);
  const bottom = top + (viewport?.height ?? owner.innerHeight);
  const containingBlock = element.offsetParent;
  if (containingBlock === null) return { bottom, left, originLeft: 0, originTop: 0, right, top };
  const bounds = containingBlock.getBoundingClientRect();
  return {
    bottom: Math.min(bottom, bounds.bottom),
    left: Math.max(left, bounds.left),
    originLeft: bounds.left,
    originTop: bounds.top,
    right: Math.min(right, bounds.right),
    top: Math.max(top, bounds.top),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function isEditablePointerTarget(
  target: EventTarget | null,
  owner: ReturnType<typeof ownerWindow>,
): boolean {
  if (!(target instanceof owner.Element)) return false;
  return (
    target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null
  );
}

function createEditorElements(host: HTMLElement): AnnotationEditorElements {
  const owner = ownerWindow(host);
  const element = owner.createDiv();
  element.className = 'abyss-annotation-editor-popover';
  element.dataset['annotationEditorPopover'] = '';
  element.setAttribute('aria-label', 'Edit annotation');
  element.setAttribute('role', 'dialog');
  element.hidden = true;
  const palette = owner.createDiv();
  palette.className = 'abyss-annotation-editor-palette';
  palette.setAttribute('aria-label', 'Annotation colors');
  palette.setAttribute('role', 'group');
  const metadata = owner.createDiv();
  metadata.className = 'abyss-annotation-editor-metadata';
  const inputs = createMetadataElements(owner);
  metadata.append(inputs.comment, inputs.tags, inputs.links, inputs.suggestions);
  const readOnly = owner.createDiv();
  readOnly.className = 'abyss-annotation-editor-readonly-metadata';
  readOnly.setAttribute('aria-label', 'Annotation metadata');
  readOnly.setAttribute('role', 'group');
  readOnly.hidden = true;
  const status = owner.createDiv();
  status.className = 'abyss-annotation-editor-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  const actions = owner.createDiv();
  actions.className = 'abyss-annotation-editor-actions';
  element.append(palette, metadata, readOnly, status, actions);
  return { actions, element, metadata, palette, readOnly, status, ...inputs };
}

function createMetadataElements(owner: ReturnType<typeof ownerWindow>): AnnotationMetadataElements {
  const comment = owner.createEl('textarea');
  comment.className = 'abyss-annotation-editor-comment';
  comment.setAttribute('aria-label', 'Comment');
  comment.placeholder = 'Add a comment…';
  comment.rows = 2;
  const tags = owner.createEl('input');
  tags.className = 'abyss-annotation-editor-tags';
  tags.setAttribute('aria-label', 'Tags');
  tags.placeholder = 'Add tags';
  tags.type = 'text';
  const links = owner.createEl('input');
  links.className = 'abyss-annotation-editor-links';
  links.setAttribute('aria-label', 'Links');
  links.placeholder = 'Add links';
  links.type = 'text';
  const suggestions = owner.createDiv();
  suggestions.className = 'abyss-annotation-link-suggestions';
  suggestions.id = `abyss-annotation-editor-suggestions-${++editorSequence}`;
  suggestions.setAttribute('aria-label', 'Link suggestions');
  suggestions.setAttribute('role', 'listbox');
  suggestions.hidden = true;
  links.setAttribute('aria-autocomplete', 'list');
  links.setAttribute('aria-controls', suggestions.id);
  links.setAttribute('aria-expanded', 'false');
  links.setAttribute('role', 'combobox');
  return { comment, links, suggestions, tags };
}

function singleAnnotation(target: AnnotationEditorTarget): DocumentAnnotation | null {
  return target.kind === 'annotation' || target.kind === 'readonly' ? target.annotation : null;
}

function targetAnnotations(target: AnnotationEditorTarget): readonly DocumentAnnotation[] {
  if (target.kind === 'annotation' || target.kind === 'readonly') return [target.annotation];
  if (target.kind === 'multiple') return target.annotations;
  return [];
}

function annotationFields(annotation: DocumentAnnotation | null): {
  readonly links: readonly string[];
  readonly prose: string;
  readonly source: string;
  readonly tags: readonly string[];
} {
  const source = annotation?.comment ?? '';
  const decoded = decodeAnnotationComment(source);
  const tags = decoded.tags.length > 0 ? decoded.tags : (annotation?.tags ?? []);
  const links = decoded.links.length > 0 ? decoded.links : (annotation?.links ?? []);
  return { links, prose: decoded.prose.trim(), source, tags };
}

function commonColor(annotations: readonly DocumentAnnotation[]): string {
  const first = annotations[0]?.color;
  if (first === null || first === undefined) return '';
  return annotations.every((annotation) => annotation.color === first) ? first : '';
}

function targetColor(
  request: AnnotationEditorPopoverRequest,
  annotation: DocumentAnnotation | null,
): string {
  if (request.target.kind === 'multiple') return commonColor(request.target.annotations);
  return annotation?.color ?? request.color ?? request.palette[0]?.color ?? DEFAULT_COLOR;
}

function targetDialogLabel(target: AnnotationEditorTarget): string {
  if (target.kind === 'readonly') return 'Annotation details';
  if (target.kind === 'multiple') return 'Edit selected annotations';
  return 'Edit annotation';
}

function targetStatus(target: AnnotationEditorTarget): string {
  if (target.kind === 'readonly') return 'Read-only annotation';
  if (target.kind !== 'multiple') return '';
  return `${target.annotations.length} annotations selected`;
}

function targetPosition(target: AnnotationEditorTarget): {
  readonly x: number;
  readonly y: number;
} {
  if (target.kind !== 'selection') return { x: 0, y: 0 };
  const rects = target.selection.clientRects;
  const rect = rects[rects.length - 1] ?? target.selection.clientRect;
  return { x: rect.left, y: rect.bottom + 8 };
}

function semanticColorLabel(entry: AnnotationPaletteEntry): string {
  const meaning = entry.meaning.trim();
  if (meaning.length > 0) return meaning;
  const name = entry.name.trim();
  return name.length > 0 ? name : 'Custom color';
}

function renderTags(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag.replace(/^#+/u, '')}`).join(' ');
}

function renderLinks(links: readonly string[]): string {
  return links
    .map((link) => (link.startsWith('[[') && link.endsWith(']]') ? link : `[[${link}]]`))
    .join(' ');
}

function parseTagsField(value: string): readonly string[] {
  const explicit = Array.from(value.matchAll(/#([\p{L}\p{N}_/-]+)/gu), (match) => match[1] ?? '');
  if (explicit.length > 0) return explicit.filter((tag) => tag.length > 0);
  return splitFieldValues(value);
}

function parseLinksField(value: string): readonly string[] {
  const explicit: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('[[', cursor);
    if (open < 0) break;
    const close = value.indexOf(']]', open + 2);
    if (close < 0) break;
    cursor = close + 2;
    const body = value.slice(open + 2, close);
    if (body.length > 0 && !body.includes('\n')) explicit.push(body);
  }
  if (explicit.length > 0) return explicit.filter((link) => link.length > 0);
  return splitFieldValues(value);
}

function splitFieldValues(value: string): readonly string[] {
  return value
    .split(/[\s,]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isCaretMovementKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End';
}

function updatesOverlap(left: AnnotationEditorUpdate, right: AnnotationEditorUpdate): boolean {
  return left.annotations.some((annotation) =>
    right.annotations.some((candidate) => sameAnnotation(annotation, candidate)),
  );
}

function removeAcceptedFields(
  pending: AnnotationEditorUpdate,
  accepted: AnnotationEditorUpdate,
): AnnotationEditorUpdate | null {
  const color = accepted.color === undefined ? pending.color : undefined;
  const comment = accepted.comment === undefined ? pending.comment : undefined;
  if (color === undefined && comment === undefined) return null;
  return {
    annotations: pending.annotations,
    ...(color === undefined ? {} : { color }),
    ...(comment === undefined ? {} : { comment }),
  };
}

function sameAnnotation(left: DocumentAnnotation, right: DocumentAnnotation): boolean {
  if (left.identity.kind !== right.identity.kind) return false;
  if (left.identity.kind === 'stable' && right.identity.kind === 'stable')
    return left.identity.id === right.identity.id;
  return (
    left.identity.kind === 'legacy' &&
    right.identity.kind === 'legacy' &&
    left.identity.fingerprint === right.identity.fingerprint
  );
}
