import { setIcon, setTooltip } from 'obsidian';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import {
  annotationCaretTokenAtCursor,
  replaceAnnotationSuggestion,
  type AnnotationSuggestion,
  type AnnotationSuggestionProvider,
} from './link-suggestions.js';
import { ownerWindow } from './owner-dom.js';
import { isolateTextEditing } from './text-editing-guard.js';

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
  ) =>
    | DocumentAnnotation
    | 'created'
    | 'dismissed'
    | null
    | void
    | Promise<DocumentAnnotation | 'created' | 'dismissed' | null | void>;
  readonly onPreviewUpdate?: ((update: AnnotationEditorUpdate) => void) | undefined;
  readonly onPreviewRevert?: ((update: AnnotationEditorUpdate) => void) | undefined;
  readonly onUpdate: (update: AnnotationEditorUpdate) => boolean | void;
  readonly onSelectionPreview?: ((creation: AnnotationEditorCreation) => void) | undefined;
  readonly onDelete: (annotations: readonly DocumentAnnotation[]) => boolean | void;
  readonly onClose: (reason: AnnotationEditorCloseReason) => void;
}

const DEFAULT_COLOR = '#ffd400';
const METADATA_DEBOUNCE_MS = 300;
const POPOVER_EDGE_INSET = 8;
const POPOVER_ANCHOR_GAP = 6;
const UNSAFE_BATCH_REASON = 'These annotations cannot be changed together safely.';
let editorSequence = 0;

interface AnnotationEditorElements {
  readonly actions: HTMLDivElement;
  readonly comment: HTMLTextAreaElement;
  readonly element: HTMLDivElement;
  readonly metadata: HTMLDivElement;
  readonly palette: HTMLDivElement;
  readonly readOnly: HTMLDivElement;
  readonly status: HTMLDivElement;
  readonly suggestions: HTMLDivElement;
}

interface AnnotationMetadataElements {
  readonly comment: HTMLTextAreaElement;
  readonly suggestions: HTMLDivElement;
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
}

interface AnnotationCreationJob {
  cancelled: boolean;
  deferredCloseReason: AnnotationEditorCloseReason | null;
  readonly generation: number;
  readonly request: AnnotationEditorPopoverRequest;
  completed: boolean;
  draft: AnnotationCreationDraft;
  pendingUpdate: AnnotationEditorUpdate | null;
  settlement: Promise<boolean> | null;
}

type SelectionCreationState = 'draft' | 'pending' | 'materialized';

interface AnnotationPopoverPlacement {
  readonly target: AnnotationEditorTarget;
  readonly x: number;
  readonly y: number;
}

export class AnnotationEditorPopover {
  readonly element: HTMLDivElement;

  private readonly paletteElement: HTMLDivElement;
  private readonly metadataElement: HTMLDivElement;
  private readonly commentInput: HTMLTextAreaElement;
  private readonly suggestionsElement: HTMLDivElement;
  private readonly readOnlyElement: HTMLDivElement;
  private readonly statusElement: HTMLDivElement;
  private readonly actionsElement: HTMLDivElement;
  private readonly cleanups: Array<() => void> = [];
  private active: AnnotationEditorPopoverRequest | null = null;
  private activeColor = DEFAULT_COLOR;
  private commentSource = '';
  private commentDirty = false;
  private metadataTimer: number | null = null;
  private focusAwayTimer: number | null = null;
  private openGeneration = 0;
  private placement: AnnotationPopoverPlacement | null = null;
  private readonly pendingCreationUpdates = new Set<AnnotationCreationJob>();
  private previousFocus: HTMLElement | null = null;
  private selectionCreation: AnnotationCreationJob | null = null;
  private selectionCreationState: SelectionCreationState = 'draft';
  private suggestionIndex = -1;
  private suggestionItems: readonly AnnotationSuggestion[] = [];
  private suggestionOrigin: { readonly open: number; readonly query: string } | null = null;
  private destroyed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly linkSuggestions: AnnotationSuggestionProvider | null = null,
    private readonly sourcePath = '',
  ) {
    const elements = createEditorElements(host);
    this.element = elements.element;
    this.paletteElement = elements.palette;
    this.metadataElement = elements.metadata;
    this.commentInput = elements.comment;
    this.suggestionsElement = elements.suggestions;
    this.readOnlyElement = elements.readOnly;
    this.statusElement = elements.status;
    this.actionsElement = elements.actions;
    host.append(this.element);
    this.registerElementListeners();
    this.registerDocumentListeners();
    this.registerViewportListeners();
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
      if (target.closest('[data-action="dismiss-selection"]') !== null) this.dismissSelection();
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
      const resized = this.resizeComment();
      if (resized) this.placeActive();
      this.commentChanged();
      this.updateSuggestions();
    });
    this.listen(this.commentInput, 'select', () => {
      this.updateSuggestions();
    });
    this.listen(this.commentInput, 'click', () => {
      this.updateSuggestions();
    });
    this.listen(this.commentInput, 'keyup', (event) => {
      if (isCaretMovementKey(event.key)) this.updateSuggestions();
    });
    this.listen(this.commentInput, 'keydown', (event) => {
      this.handleSuggestionKey(event);
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        this.close('escape', true);
      }
    });
    isolateTextEditing(this.commentInput);
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
      if (this.isAnnotationInteractionTarget(target)) return;
      this.close('click-away');
    });
    this.listenDocument('focusin', (event) => {
      if (this.active === null) return;
      this.cancelFocusAwayTimer();
      const target = event.target;
      if (target instanceof ownerWindow(this.host).Element && this.element.contains(target)) return;
      if (this.isAnnotationFocusTarget(target)) return;
      this.focusAwayTimer = ownerWindow(this.host).setTimeout(() => {
        this.focusAwayTimer = null;
        if (this.active === null) return;
        const focused = this.host.ownerDocument.activeElement;
        if (
          (focused instanceof ownerWindow(this.host).Element && this.element.contains(focused)) ||
          this.isAnnotationFocusTarget(focused)
        )
          return;
        this.close('focus-away');
      }, 0);
    });
  }

  private registerViewportListeners(): void {
    const owner = ownerWindow(this.host);
    const place = (): void => {
      if (this.active === null) return;
      this.applyViewportConstraints();
      this.resizeComment();
      this.placeActive();
    };
    owner.addEventListener('resize', place);
    this.cleanups.push(() => {
      owner.removeEventListener('resize', place);
    });
    const visualViewport = owner.visualViewport;
    visualViewport?.addEventListener('resize', place);
    this.cleanups.push(() => {
      visualViewport?.removeEventListener('resize', place);
    });
  }

  private isAnnotationInteractionTarget(target: EventTarget | null): boolean {
    return (
      target instanceof ownerWindow(this.host).Element &&
      this.host.contains(target) &&
      (target.closest(
        '.annotationEditorLayer :is(.highlightEditor, .inkEditor, .freeTextEditor).selectedEditor',
      ) !== null ||
        target.closest('.abyss-annotation-card[aria-current="true"]') !== null)
    );
  }

  private isAnnotationFocusTarget(target: EventTarget | null): boolean {
    if (this.isAnnotationInteractionTarget(target)) return true;
    return (
      this.active?.target.kind === 'annotation' &&
      target instanceof ownerWindow(this.host).Element &&
      this.host.contains(target) &&
      target.matches('.annotationEditorLayer.disabled.nonEditing')
    );
  }

  get isOpen(): boolean {
    return this.active !== null;
  }

  get hasPendingChanges(): boolean {
    return (
      this.commentDirty ||
      (this.selectionCreation !== null && !this.selectionCreation.completed) ||
      this.pendingCreationUpdates.size > 0
    );
  }

  async flushPendingChanges(): Promise<boolean> {
    const creation = this.selectionCreation;
    if (creation !== null && !creation.completed) {
      if (creation.settlement === null) return false;
      if (!(await creation.settlement)) return false;
      return this.flushPendingChanges();
    }
    if (!this.flushPendingMetadata()) return false;
    return this.retryPendingUpdates();
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
    const deferredCloseReason = this.selectionCreation?.deferredCloseReason;
    if (deferredCloseReason !== null && deferredCloseReason !== undefined) return false;
    if (!this.flushPendingMetadata()) return false;
    if (this.active === null) this.capturePreviousFocus();
    this.openGeneration += 1;
    this.cancelFocusAwayTimer();
    this.active = request;
    this.cancelMetadataTimer();
    this.commentDirty = false;
    this.selectionCreation = null;
    this.selectionCreationState = request.target.kind === 'selection' ? 'draft' : 'materialized';
    this.render(request);
    this.element.hidden = false;
    const position = request.position ?? targetPosition(request.target);
    this.placement = { target: request.target, x: position.x, y: position.y };
    this.applyViewportConstraints();
    this.resizeComment();
    this.place(position.x, position.y, request.target);
    return true;
  }

  close(reason: AnnotationEditorCloseReason = 'external', restoreFocus = false): boolean {
    const request = this.active;
    if (request === null) return true;
    if (!this.flushPendingMetadata()) return false;
    if (this.deferPendingSelectionClose(request, reason, restoreFocus)) return true;
    this.cancelPendingSelectionCreation(request);
    this.cancelFocusAwayTimer();
    this.openGeneration += 1;
    this.active = null;
    this.selectionCreation = null;
    this.placement = null;
    this.element.hidden = true;
    if (request.target.kind === 'selection' && this.selectionCreationState === 'draft')
      this.host.ownerDocument.getSelection()?.removeAllRanges();
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
    this.selectionCreationState = target.kind === 'selection' ? 'draft' : 'materialized';
    this.commentDirty = false;
    this.render(next);
    this.applyViewportConstraints();
    this.resizeComment();
    this.placeActive();
    return true;
  }

  destroy(): boolean {
    if (this.destroyed) return true;
    if (!this.flushPendingMetadata()) return false;
    this.destroyed = true;
    this.openGeneration += 1;
    this.cancelMetadataTimer();
    this.cancelFocusAwayTimer();
    this.active = null;
    this.selectionCreation = null;
    this.placement = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.element.remove();
    return true;
  }

  private render(request: AnnotationEditorPopoverRequest): void {
    const annotation = singleAnnotation(request.target);
    const color = targetColor(request, annotation);
    this.activeColor = color;
    this.renderPalette(request.palette, color, request.target.kind === 'multiple');
    this.populateMetadata(annotation);
    this.renderTargetState(request.target);
    this.hideSuggestions();
    this.renderActions(request.target);
  }

  private populateMetadata(annotation: DocumentAnnotation | null): void {
    this.commentSource = annotation?.comment ?? '';
    this.commentInput.value = this.commentSource;
  }

  private resizeComment(): boolean {
    const previous = this.commentInput.style.getPropertyValue('--abyss-annotation-comment-height');
    this.commentInput.setCssProps({ '--abyss-annotation-comment-height': 'auto' });
    const next = `${String(this.commentInput.scrollHeight)}px`;
    this.commentInput.setCssProps({
      '--abyss-annotation-comment-height': next,
    });
    return previous !== next;
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
    delete this.statusElement.dataset['batchUnavailable'];
    if (multiple) this.statusElement.dataset['batchUnavailable'] = '';
    this.element.setAttribute('aria-label', targetDialogLabel(target));
    if (readOnly) this.renderReadOnly(target.annotation);
  }

  private renderPalette(
    palette: readonly AnnotationPaletteEntry[],
    activeColor: string,
    disableBatch: boolean,
  ): void {
    this.paletteElement.replaceChildren();
    for (const entry of palette) {
      const button = ownerWindow(this.host).createEl('button');
      button.type = 'button';
      button.className = 'abyss-annotation-editor-swatch';
      button.dataset['editorColor'] = entry.color;
      button.dataset['shape'] = 'square';
      button.style.setProperty('--abyss-annotation-swatch-color', entry.color);
      const label = semanticColorLabel(entry);
      button.setAttribute('aria-label', label);
      setTooltip(button, label, { delay: 250 });
      button.setAttribute('aria-pressed', String(entry.color === activeColor));
      if (disableBatch) this.disableBatchAction(button);
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
    if (this.selectionCreationState !== 'draft') {
      if (this.selectionCreation?.request === request)
        this.selectionCreation.draft = this.captureCreationDraft(comment);
      return;
    }
    const generation = this.openGeneration;
    const job = this.makeCreationJob(request, comment, generation);
    this.selectionCreation = job;
    this.selectionCreationState = 'pending';
    try {
      const result = request.onCreate({
        color: this.activeColor,
        comment,
        selection: request.target.selection,
      });
      job.settlement = Promise.resolve(result)
        .then((annotation) => {
          if (job.cancelled) return false;
          if (annotation === 'dismissed') {
            if (generation === this.openGeneration && this.active === request) {
              this.selectionCreationState = 'draft';
            }
            return false;
          }
          if (annotation !== 'created' && annotation !== null && annotation !== undefined) {
            this.finishSelectionCreation(job, annotation);
            return true;
          }
          return false;
        })
        .catch((cause: unknown) => {
          if (!job.cancelled && generation === this.openGeneration && this.active === request) {
            this.selectionCreationState = 'draft';
            console.error('[abyss-documents] Could not create selection annotation', { cause });
          }
          return false;
        })
        .finally(() => {
          this.finishDeferredSelectionClose(job);
        });
    } catch (cause) {
      this.selectionCreationState = 'draft';
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
      cancelled: false,
      completed: false,
      deferredCloseReason: null,
      draft: this.captureCreationDraft(comment),
      generation,
      pendingUpdate: null,
      request,
      settlement: null,
    };
  }

  private captureCreationDraft(comment: string): AnnotationCreationDraft {
    return {
      color: this.activeColor,
      comment,
      commentField: this.commentInput.value,
    };
  }

  private finishSelectionCreation(
    job: AnnotationCreationJob,
    annotation: DocumentAnnotation,
  ): void {
    if (job.cancelled || job.completed) return;
    job.completed = true;
    const { draft, request } = job;
    if (job.generation !== this.openGeneration || this.active !== request) {
      this.persistCreatedDraft(job, annotation);
      return;
    }
    const next = { ...request, target: { annotation, kind: 'annotation' as const } };
    this.active = next;
    this.selectionCreation = null;
    this.selectionCreationState = 'materialized';
    this.render(next);
    this.commentInput.value = draft.commentField;
    this.resizeComment();
    this.commentSource = draft.comment;
    this.activeColor = draft.color;
    this.updatePressedColor();
    this.commentDirty = false;
    this.persistCreatedDraft(job, annotation);
    this.placeActive();
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
    this.pendingCreationUpdates.add(job);
    if (job.request.onUpdate(update) === false) return false;
    job.pendingUpdate = null;
    this.pendingCreationUpdates.delete(job);
    return true;
  }

  private commentChanged(): void {
    const request = this.active;
    if (
      request === null ||
      request.target.kind === 'readonly' ||
      request.target.kind === 'multiple'
    )
      return;
    this.commentDirty = true;
    if (request.target.kind === 'selection') {
      const comment = this.metadataComment();
      if (this.selectionCreationState === 'draft' && comment === this.commentSource) {
        this.commentDirty = false;
        return;
      }
      this.createSelection(comment);
      if (this.selectionCreationState !== 'draft') {
        request.onSelectionPreview?.({
          color: this.activeColor,
          comment,
          selection: request.target.selection,
        });
      }
      return;
    }
    request.onPreviewUpdate?.({
      annotations: [request.target.annotation],
      comment: this.metadataComment(),
    });
    this.cancelMetadataTimer();
    this.metadataTimer = ownerWindow(this.host).setTimeout(() => {
      this.metadataTimer = null;
      this.persistMetadata();
    }, METADATA_DEBOUNCE_MS);
  }

  private metadataComment(): string {
    return this.commentDirty ? this.commentInput.value : this.commentSource;
  }

  private persistMetadata(): boolean {
    const request = this.active;
    if (request?.target.kind !== 'annotation' || !this.commentDirty) return true;
    const annotation = request.target.annotation;
    const comment = this.metadataComment();
    const revert = (): void => {
      request.onPreviewRevert?.({
        annotations: [annotation],
        comment: this.commentSource,
      });
    };
    try {
      if (!this.persistUpdate(request, { annotations: [annotation], comment })) {
        revert();
        return false;
      }
    } catch (cause) {
      revert();
      throw cause;
    }
    this.commentSource = comment;
    this.commentDirty = false;
    return true;
  }

  private updateSuggestions(): void {
    const cursor = this.commentInput.selectionStart;
    if (this.linkSuggestions === null || cursor !== this.commentInput.selectionEnd) {
      this.hideSuggestions();
      return;
    }
    const token = annotationCaretTokenAtCursor(this.commentInput.value, cursor);
    if (token === null) {
      this.hideSuggestions();
      return;
    }
    this.suggestionOrigin = { open: token.open, query: token.query };
    this.suggestionItems = this.linkSuggestions.suggest(token.kind, token.query, this.sourcePath);
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
    this.commentInput.setAttribute('aria-expanded', String(!this.suggestionsElement.hidden));
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
    const cursor = this.commentInput.selectionStart;
    if (
      suggestion === undefined ||
      cursor !== this.commentInput.selectionEnd ||
      this.suggestionOrigin === null
    ) {
      this.hideSuggestions();
      return;
    }
    const token = annotationCaretTokenAtCursor(this.commentInput.value, cursor);
    if (token?.open !== this.suggestionOrigin.open || token.query !== this.suggestionOrigin.query) {
      this.hideSuggestions();
      return;
    }
    const replacement = replaceAnnotationSuggestion(
      this.commentInput.value,
      cursor,
      suggestion.insertion,
    );
    if (replacement === null) return;
    this.commentInput.value = replacement.value;
    const resized = this.resizeComment();
    if (resized) this.placeActive();
    this.commentInput.setSelectionRange(replacement.cursor, replacement.cursor);
    this.hideSuggestions();
    this.commentChanged();
    this.commentInput.focus();
  }

  private updateSuggestionSelection(): void {
    this.suggestionsElement.querySelectorAll('[role="option"]').forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === this.suggestionIndex));
    });
    const active = this.suggestionsElement.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active === null) this.commentInput.removeAttribute('aria-activedescendant');
    else this.commentInput.setAttribute('aria-activedescendant', active.id);
  }

  private hideSuggestions(): void {
    this.suggestionIndex = -1;
    this.suggestionItems = [];
    this.suggestionOrigin = null;
    this.suggestionsElement.replaceChildren();
    this.suggestionsElement.hidden = true;
    this.commentInput.setAttribute('aria-expanded', 'false');
    this.commentInput.removeAttribute('aria-activedescendant');
  }

  private cancelMetadataTimer(): void {
    if (this.metadataTimer === null) return;
    ownerWindow(this.host).clearTimeout(this.metadataTimer);
    this.metadataTimer = null;
  }

  private cancelFocusAwayTimer(): void {
    if (this.focusAwayTimer === null) return;
    ownerWindow(this.host).clearTimeout(this.focusAwayTimer);
    this.focusAwayTimer = null;
  }

  private flushPendingMetadata(): boolean {
    this.cancelMetadataTimer();
    if (!this.retryPendingUpdates()) return false;
    return !this.commentDirty || this.persistMetadata();
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
    if (target.kind === 'selection') {
      const button = this.contextAction('Dismiss selection', 'x');
      button.dataset['action'] = 'dismiss-selection';
      this.actionsElement.append(button);
      return;
    }
    if (target.kind !== 'annotation' && target.kind !== 'multiple') return;
    const label = target.kind === 'multiple' ? 'Delete annotations' : 'Delete annotation';
    const button = this.contextAction(label, 'trash-2');
    button.dataset['action'] = 'delete-annotation';
    if (target.kind === 'multiple') this.disableBatchAction(button);
    this.actionsElement.append(button);
  }

  private contextAction(label: string, icon: 'trash-2' | 'x'): HTMLButtonElement {
    const button = ownerWindow(this.host).createEl('button');
    button.type = 'button';
    button.className = 'clickable-icon abyss-annotation-editor-delete';
    button.dataset['touchTarget'] = '44';
    button.setAttribute('aria-label', label);
    setIcon(button, icon);
    setTooltip(button, label, { delay: 250 });
    return button;
  }

  private disableBatchAction(button: HTMLButtonElement): void {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-describedby', this.statusElement.id);
    button.title = UNSAFE_BATCH_REASON;
    setTooltip(button, UNSAFE_BATCH_REASON, { delay: 250 });
  }

  private renderReadOnly(annotation: DocumentAnnotation): void {
    if (annotation.comment.length === 0) return;
    const value = ownerWindow(this.host).createDiv();
    value.dataset['field'] = 'comment';
    value.setAttribute('aria-label', 'Comment');
    value.textContent = annotation.comment;
    this.readOnlyElement.append(value);
  }

  private deleteTarget(): void {
    const request = this.active;
    if (request === null) return;
    const annotations = targetAnnotations(request.target);
    if (annotations.length === 0 || !this.flushPendingMetadata()) return;
    if (request.onDelete(annotations) === false) return;
    this.close('external');
  }

  private dismissSelection(): void {
    if (this.active?.target.kind !== 'selection') return;
    this.close('external');
  }

  private cancelPendingSelectionCreation(request: AnnotationEditorPopoverRequest): void {
    if (request.target.kind !== 'selection' || this.selectionCreationState !== 'pending') return;
    if (this.selectionCreation?.request === request) this.selectionCreation.cancelled = true;
    this.selectionCreationState = 'draft';
  }

  private deferPendingSelectionClose(
    request: AnnotationEditorPopoverRequest,
    reason: AnnotationEditorCloseReason,
    restoreFocus: boolean,
  ): boolean {
    if (reason !== 'click-away' && reason !== 'focus-away') return false;
    const job = this.selectionCreation;
    if (
      request.target.kind !== 'selection' ||
      this.selectionCreationState !== 'pending' ||
      job?.request !== request
    )
      return false;
    job.deferredCloseReason = reason;
    this.cancelFocusAwayTimer();
    this.openGeneration += 1;
    this.active = null;
    this.placement = null;
    this.commentDirty = false;
    this.element.hidden = true;
    this.host.ownerDocument.getSelection()?.removeAllRanges();
    if (restoreFocus) this.restoreFocus();
    this.previousFocus = null;
    return true;
  }

  private finishDeferredSelectionClose(job: AnnotationCreationJob): void {
    const reason = job.deferredCloseReason;
    if (reason === null) return;
    job.deferredCloseReason = null;
    if (this.selectionCreation === job) this.selectionCreation = null;
    job.request.onClose(reason);
  }

  private place(x: number, y: number, target: AnnotationEditorTarget): void {
    const owner = ownerWindow(this.host);
    const viewport = fixedViewportBounds(owner, this.element);
    this.applyViewportConstraints(viewport);
    const bounds = this.element.getBoundingClientRect();
    const anchorTop = target.kind === 'selection' ? selectionAnchorRect(target.selection).top : y;
    const placedY =
      y + bounds.height > viewport.bottom ? anchorTop - POPOVER_ANCHOR_GAP - bounds.height : y;
    this.element.dataset['overflow'] = 'scroll';
    this.element.style.left = `${clamp(x, viewport.left, viewport.right - bounds.width) - viewport.originLeft}px`;
    this.element.style.top = `${clamp(placedY, viewport.top, viewport.bottom - bounds.height) - viewport.originTop}px`;
  }

  private placeActive(): void {
    const placement = this.placement;
    if (placement === null || this.active === null) return;
    this.place(placement.x, placement.y, placement.target);
  }

  private applyViewportConstraints(
    viewport = fixedViewportBounds(ownerWindow(this.host), this.element),
  ): void {
    this.element.style.maxWidth = `${Math.min(304, Math.max(0, viewport.right - viewport.left))}px`;
    this.element.style.maxHeight = `${Math.max(0, viewport.bottom - viewport.top)}px`;
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
  if (containingBlock === null)
    return {
      bottom: bottom - POPOVER_EDGE_INSET,
      left: left + POPOVER_EDGE_INSET,
      originLeft: 0,
      originTop: 0,
      right: right - POPOVER_EDGE_INSET,
      top: top + POPOVER_EDGE_INSET,
    };
  const bounds = containingBlock.getBoundingClientRect();
  return {
    bottom: Math.min(bottom, bounds.bottom) - POPOVER_EDGE_INSET,
    left: Math.max(left, bounds.left) + POPOVER_EDGE_INSET,
    originLeft: bounds.left,
    originTop: bounds.top,
    right: Math.min(right, bounds.right) - POPOVER_EDGE_INSET,
    top: Math.max(top, bounds.top) + POPOVER_EDGE_INSET,
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
  metadata.append(inputs.comment, inputs.suggestions);
  const readOnly = owner.createDiv();
  readOnly.className = 'abyss-annotation-editor-readonly-metadata';
  readOnly.setAttribute('aria-label', 'Annotation metadata');
  readOnly.setAttribute('role', 'group');
  readOnly.hidden = true;
  const status = owner.createDiv();
  status.className = 'abyss-annotation-editor-status';
  status.setAttribute('role', 'status');
  status.id = `${inputs.suggestions.id}-status`;
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
  const suggestions = owner.createDiv();
  suggestions.className = 'abyss-annotation-comment-suggestions';
  suggestions.id = `abyss-annotation-editor-suggestions-${++editorSequence}`;
  suggestions.setAttribute('aria-label', 'Comment suggestions');
  suggestions.setAttribute('role', 'listbox');
  suggestions.hidden = true;
  comment.setAttribute('aria-autocomplete', 'list');
  comment.setAttribute('aria-controls', suggestions.id);
  comment.setAttribute('aria-expanded', 'false');
  comment.setAttribute('role', 'combobox');
  return { comment, suggestions };
}

function singleAnnotation(target: AnnotationEditorTarget): DocumentAnnotation | null {
  return target.kind === 'annotation' || target.kind === 'readonly' ? target.annotation : null;
}

function targetAnnotations(target: AnnotationEditorTarget): readonly DocumentAnnotation[] {
  if (target.kind === 'annotation' || target.kind === 'readonly') return [target.annotation];
  if (target.kind === 'multiple') return target.annotations;
  return [];
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
  return `${target.annotations.length} annotations selected. ${UNSAFE_BATCH_REASON}`;
}

function targetPosition(target: AnnotationEditorTarget): {
  readonly x: number;
  readonly y: number;
} {
  if (target.kind !== 'selection') return { x: 0, y: 0 };
  const rect = selectionAnchorRect(target.selection);
  return { x: rect.left, y: rect.bottom + POPOVER_ANCHOR_GAP };
}

function selectionAnchorRect(selection: PdfTextSelection): PdfTextSelection['clientRect'] {
  return selection.clientRects[selection.clientRects.length - 1] ?? selection.clientRect;
}

function semanticColorLabel(entry: AnnotationPaletteEntry): string {
  const meaning = entry.meaning.trim();
  if (meaning.length > 0) return meaning;
  const name = entry.name.trim();
  return name.length > 0 ? name : 'Custom color';
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
