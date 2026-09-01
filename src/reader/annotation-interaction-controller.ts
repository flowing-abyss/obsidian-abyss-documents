import type {
  PdfAnnotationActivationResult,
  PdfAnnotationActivationSource,
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfAnnotationTool,
} from '../adapters/pdf/pdf-annotation-editor.js';
import type { PdfAnnotationFocus } from '../adapters/pdf/pdf-comment-bridge.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import type {
  AnnotationEditorCloseContext,
  AnnotationEditorCreation,
  AnnotationEditorPopoverRequest,
  AnnotationEditorTarget,
  AnnotationEditorUpdate,
} from './annotation-editor-popover.js';
import { focusableTarget, ownerWindow, type ReaderOwnerWindow } from './owner-dom.js';

export interface QuickHighlightState {
  readonly armed: boolean;
  readonly color: string;
}

export interface AnnotationInteractionHost {
  setQuickHighlightState(state: QuickHighlightState): void;
  openAnnotationEditor(request: AnnotationEditorPopoverRequest): boolean;
  closeAnnotationEditor(): boolean;
  flushAnnotationEditor(): Promise<boolean>;
}

export type AnnotationInteractionInvalidation = 'zoom' | 'layout' | 'navigation' | 'session';

export interface AnnotationInteractionControllerOptions {
  readonly color?: string;
  readonly onColorChange?: (color: string) => void;
  readonly onFailure?: (
    action: string,
    cause: unknown,
    context: Readonly<Record<string, unknown>>,
  ) => void;
  readonly onModeChange?: (mode: PdfAnnotationLogicalMode) => void;
  readonly onToolColorChange?: (tool: 'ink' | 'freetext', color: string) => void;
  readonly onAnnotationPreview?: (update: AnnotationEditorUpdate) => void;
  readonly onAnnotationDelete?: (annotations: readonly DocumentAnnotation[]) => void;
  readonly onAnnotationUpdate?: (update: AnnotationEditorUpdate) => void;
  readonly onSelectionCreateCommit?: (
    creation: AnnotationEditorCreation,
    annotation: DocumentAnnotation,
  ) => void;
  readonly onSelectionCreateDiscard?: (creation: AnnotationEditorCreation) => void;
  readonly onSelectionCreatePreview?: (creation: AnnotationEditorCreation) => void;
  readonly onSelectionCreateStart?: (creation: AnnotationEditorCreation) => void;
}

interface QueuedStickySelection {
  readonly color: string;
  readonly intentRevision: number;
  readonly selection: PdfTextSelection;
}

const DEFAULT_COLOR = '#ffd400';
const NATIVE_FOCUS_GUARD_MS = 250;

export class AnnotationInteractionController {
  private readonly cleanups: Array<() => void> = [];
  private activeAbort: AbortController | null = null;
  private activeColor: string;
  private activeEditorKind: AnnotationEditorTarget['kind'] | null = null;
  private contextualColorMutationDepth = 0;
  private activeSelectionRevision = 0;
  private ownedSelectionRevision: number | null = null;
  private destroyed = false;
  private nativeNeutralization: Promise<void> = Promise.resolve();
  private nativeFocusGuard: NeutralizationFocusTracker | null = null;
  private mode: PdfAnnotationLogicalMode = 'neutral';
  private palette: readonly AnnotationPaletteEntry[];
  private quickRequestRevision = 0;
  private queuedStickySelection: QueuedStickySelection | null = null;
  private stickyArmed = false;
  private stickyArming = false;
  private stickyIntentRevision = 0;
  private activeSelectionToken: string | null = null;
  private lastStickySelectionToken: string | null = null;

  constructor(
    private readonly interaction: PdfAnnotationInteraction,
    private readonly host: AnnotationInteractionHost,
    palette: readonly AnnotationPaletteEntry[],
    private readonly options: AnnotationInteractionControllerOptions = {},
  ) {
    this.palette = palette;
    this.activeColor = options.color ?? palette[0]?.color ?? DEFAULT_COLOR;
    interaction.setPalette?.(palette);
    this.cleanups.push(
      interaction.onColor((color) => {
        this.handleColor(color);
      }),
      interaction.onMode((mode) => {
        this.handleMode(mode);
      }),
      interaction.onSelection((selection) => {
        this.handleSelection(selection);
      }),
      interaction.onAnnotationFocus((focus) => {
        this.handleAnnotationFocus(focus);
      }),
    );
  }

  get color(): string {
    return this.activeColor;
  }

  get quickHighlightArmed(): boolean {
    return this.stickyArmed;
  }

  waitForNativeEditorNeutralization(): Promise<void> {
    return this.nativeNeutralization;
  }

  requestTool(tool: PdfAnnotationTool, color?: string): boolean {
    if (this.destroyed || (tool !== 'highlight' && tool !== 'select')) return false;
    if (!this.closeActiveSelection()) return false;
    this.discardQueuedStickySelection();
    const enabled = tool === 'highlight';
    if (enabled && color !== undefined && color.trim().length > 0) this.setActiveColor(color);
    this.stickyArmed = false;
    this.stickyArming = enabled;
    if (!enabled) {
      this.lastStickySelectionToken = null;
      this.abortCommit('The PDF annotation selection was cancelled by Select.');
    }
    this.publishQuickHighlightState();
    const revision = ++this.quickRequestRevision;
    this.contain(this.applyQuickHighlight(enabled, revision));
    return true;
  }

  async activateAnnotation(
    stableId: string,
    source: PdfAnnotationActivationSource,
  ): Promise<PdfAnnotationActivationResult> {
    if (activationUnavailable(this.destroyed, source)) return 'cancelled';
    this.discardQueuedStickySelection();
    if (this.activeEditorKind === 'annotation') {
      if (!(await this.host.flushAnnotationEditor())) return 'cancelled';
      if (activationUnavailable(this.destroyed, source)) return 'cancelled';
    } else if (!this.closeActiveSelection()) return 'cancelled';
    this.abortCommit('The PDF annotation selection was superseded by annotation activation.');
    return this.interaction.focusAnnotation(stableId, source);
  }

  selectAnnotation(stableId: string): boolean {
    if (this.destroyed) return false;
    return this.interaction.selectAnnotation?.(stableId) ?? false;
  }

  selectColor(color: string): boolean {
    if (
      this.destroyed ||
      this.mode === 'ink' ||
      this.mode === 'freetext' ||
      this.mode === 'disabled'
    )
      return false;
    this.setActiveColor(color);
    this.publishQuickHighlightState();
    if (this.stickyArmed || !this.stickyArming) return true;
    if (this.activeAbort !== null) return true;
    const revision = ++this.quickRequestRevision;
    this.contain(this.applyQuickHighlight(true, revision));
    return true;
  }

  updatePalette(palette: readonly AnnotationPaletteEntry[]): void {
    if (this.destroyed) return;
    this.palette = palette;
    this.interaction.setPalette?.(palette);
    const activeColor = this.activeColor.toLocaleLowerCase();
    if (!palette.some(({ color }) => color.toLocaleLowerCase() === activeColor))
      this.setActiveColor(palette[0]?.color ?? DEFAULT_COLOR);
    if (this.activeAbort !== null) {
      this.publishQuickHighlightState();
      return;
    }
    if (!this.closeActiveSelection()) return;
    this.publishQuickHighlightState();
    if (this.stickyArmed || !this.stickyArming) return;
    const revision = ++this.quickRequestRevision;
    this.contain(this.applyQuickHighlight(true, revision));
  }

  invalidate(reason: AnnotationInteractionInvalidation): void {
    if (this.destroyed) return;
    this.discardQueuedStickySelection();
    if (
      (reason === 'zoom' || reason === 'layout') &&
      this.activeEditorKind !== null &&
      this.activeEditorKind !== 'selection'
    )
      return;
    if (!this.closeActiveSelection()) return;
    this.abortCommit('The PDF annotation selection was invalidated.');
  }

  destroy(): boolean {
    if (this.destroyed) return true;
    if (!this.closeActiveSelection()) return false;
    this.discardQueuedStickySelection();
    this.destroyed = true;
    this.stopNativeFocusGuard();
    this.quickRequestRevision += 1;
    this.abortCommit('The PDF annotation interaction was closed.');
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    return true;
  }

  private handleMode(mode: PdfAnnotationLogicalMode): void {
    if (this.destroyed) return;
    this.mode = mode;
    this.options.onModeChange?.(mode);
    this.disarmStickyForTerminalMode(mode);
    if (this.activeAbort !== null) {
      this.publishQuickHighlightState();
      return;
    }
    if (mode !== 'neutral' && !this.closeActiveSelection()) return;
    this.publishQuickHighlightState();
  }

  private disarmStickyForTerminalMode(mode: PdfAnnotationLogicalMode): void {
    if (mode !== 'ink' && mode !== 'freetext' && mode !== 'disabled') return;
    this.discardQueuedStickySelection();
    this.stickyArmed = false;
    if (!this.stickyArming) return;
    this.stickyArming = false;
    this.quickRequestRevision += 1;
  }

  private handleColor(color: string): void {
    if (
      this.destroyed ||
      color.trim().length === 0 ||
      this.contextualColorMutationDepth > 0 ||
      this.mode === 'ink' ||
      this.mode === 'freetext' ||
      this.mode === 'disabled'
    )
      return;
    this.setActiveColor(color);
    this.publishQuickHighlightState();
  }

  private handleSelection(selection: PdfTextSelection | null): void {
    if (this.activeAbort !== null) {
      this.queueActiveStickySelection(selection);
      return;
    }
    if (selection === null) {
      this.handleClearedSelection();
      return;
    }
    if (this.stickyArming) {
      this.queueStickySelection(selection);
      return;
    }
    if (this.destroyed || this.mode !== 'neutral') {
      this.closeActiveSelection();
      return;
    }
    if (this.stickyArmed) {
      this.commitStickySelection(selection);
      return;
    }
    if (this.activeEditorKind === 'selection' && this.activeSelectionToken === selection.token)
      return;
    this.openSelectionEditor(selection);
  }

  private handleClearedSelection(): void {
    if (this.ownedSelectionRevision === this.activeSelectionRevision) return;
    this.activeSelectionToken = null;
    this.closeActiveSelection();
  }

  private commitStickySelection(selection: PdfTextSelection, color = this.activeColor): void {
    if (selection.token === this.lastStickySelectionToken) return;
    this.lastStickySelectionToken = selection.token;
    const revision = this.activeSelectionRevision + 1;
    this.activeSelectionRevision = revision;
    const creation = { color, comment: '', selection };
    void this.createSelection(revision, creation, false)
      .catch(() => undefined)
      .finally(() => {
        this.replayQueuedStickySelection();
      });
  }

  private openSelectionEditor(selection: PdfTextSelection): void {
    const revision = this.activeSelectionRevision + 1;
    const opened = this.host.openAnnotationEditor({
      color: this.activeColor,
      onClose: (_reason, context) => {
        if (revision !== this.activeSelectionRevision) return;
        const materialized = this.activeEditorKind === 'annotation';
        this.activeEditorKind = null;
        this.activeSelectionToken = null;
        this.ownedSelectionRevision = null;
        this.activeSelectionRevision += 1;
        if (materialized) this.neutralizeNativeEditor(context);
        else this.abortCommit('The PDF annotation selection editor was closed.');
      },
      onCreate: (creation) => this.createSelection(revision, creation),
      onDelete: (annotations) => this.deleteAnnotations(annotations),
      onPreviewRevert: (update) => this.options.onAnnotationPreview?.(update),
      onPreviewUpdate: (update) => this.options.onAnnotationPreview?.(update),
      onSelectionPreview: (creation) => this.options.onSelectionCreatePreview?.(creation),
      onUpdate: (update) => this.updateAnnotations(update),
      palette: this.palette,
      resolveAnchor: (target) => {
        if (target.kind === 'annotation')
          return (
            this.interaction.resolveAnnotationAnchor?.(annotationIdentity(target.annotation)) ??
            null
          );
        if (target.kind !== 'selection') return null;
        if (this.interaction.resolveSelectionAnchor === undefined)
          return selectionAnchor(selection);
        return this.interaction.resolveSelectionAnchor(selection.token);
      },
      target: { kind: 'selection', selection },
    });
    if (opened) {
      this.activeEditorKind = 'selection';
      this.activeSelectionToken = selection.token;
      this.activeSelectionRevision = revision;
      this.ownedSelectionRevision = revision;
    }
  }

  private handleAnnotationFocus(focus: PdfAnnotationFocus | null): void {
    if (this.ignoreAnnotationFocus(focus)) return;
    const first = focus?.annotations[0];
    if (focus === null || first === undefined) {
      this.closeActiveSelection();
      return;
    }
    if (!isUsableClientPosition(focus.position)) {
      this.releaseAnnotationFocusLease(focus);
      return;
    }
    const target = this.annotationFocusTarget(focus, first);
    const neutralizeOnClose = target.kind !== 'readonly' || focus.editable;
    const revision = this.activeSelectionRevision + 1;
    let opened: boolean;
    try {
      opened = this.host.openAnnotationEditor({
        color: first.color ?? undefined,
        onClose: (_reason, context) => {
          this.releaseAnnotationFocusLease(focus);
          if (revision !== this.activeSelectionRevision) {
            if (this.activeEditorKind === null && neutralizeOnClose)
              this.neutralizeNativeEditor(context);
            return;
          }
          this.activeEditorKind = null;
          this.ownedSelectionRevision = null;
          this.activeSelectionRevision += 1;
          if (neutralizeOnClose) this.neutralizeNativeEditor(context);
        },
        onCreate: () => 'dismissed' as const,
        onDelete: (annotations) => this.deleteAnnotations(annotations),
        onPreviewRevert: (update) => this.options.onAnnotationPreview?.(update),
        onPreviewUpdate: (update) => this.options.onAnnotationPreview?.(update),
        onUpdate: (update) => this.updateAnnotations(update),
        palette: this.palette,
        position: focus.position,
        resolveAnchor: (resolvedTarget) => {
          const annotation = singleTargetAnnotation(resolvedTarget) ?? first;
          return this.interaction.resolveAnnotationAnchor?.(annotationIdentity(annotation)) ?? null;
        },
        target,
      });
    } catch (cause) {
      this.releaseAnnotationFocusLease(focus);
      throw cause;
    }
    this.finishAnnotationFocusOpen(opened, target, revision, focus);
  }

  private ignoreAnnotationFocus(focus: PdfAnnotationFocus | null): boolean {
    if (!this.destroyed && this.activeAbort === null) return false;
    if (focus !== null) this.releaseAnnotationFocusLease(focus);
    return true;
  }

  private finishAnnotationFocusOpen(
    opened: boolean,
    target: AnnotationEditorTarget,
    revision: number,
    focus: PdfAnnotationFocus,
  ): void {
    if (!opened) {
      this.releaseAnnotationFocusLease(focus);
      return;
    }
    this.activeEditorKind = target.kind;
    this.activeSelectionRevision = revision;
    this.ownedSelectionRevision = revision;
  }

  private releaseAnnotationFocusLease(focus: PdfAnnotationFocus): void {
    focus.lease?.release();
  }

  private annotationFocusTarget(
    focus: PdfAnnotationFocus,
    first: DocumentAnnotation,
  ): AnnotationEditorTarget {
    if (focus.annotations.length > 1) return { annotations: focus.annotations, kind: 'multiple' };
    return focus.editable
      ? { annotation: first, kind: 'annotation' }
      : { annotation: first, kind: 'readonly' };
  }

  private async createSelection(
    revision: number,
    creation: AnnotationEditorCreation,
    materializeEditor = true,
  ): Promise<DocumentAnnotation | 'dismissed'> {
    if (this.destroyed || revision !== this.activeSelectionRevision) return 'dismissed';
    this.setActiveColor(creation.color);
    this.publishQuickHighlightState();
    const abort = new AbortController();
    this.abortCommit('The PDF annotation selection was superseded.');
    this.activeAbort = abort;
    try {
      this.options.onSelectionCreateStart?.(creation);
      const result = await this.interaction.commitSelection(
        creation.selection.token,
        creation.comment.length === 0
          ? { color: creation.color, kind: 'highlight' }
          : { color: creation.color, kind: 'comment', seed: creation.comment },
        abort.signal,
      );
      this.finishSelectionCreation({ abort, creation, materializeEditor, result, revision });
      return result;
    } catch (cause) {
      this.failSelectionCreation(creation, abort, cause);
      throw cause;
    }
  }

  private deleteAnnotations(annotations: readonly DocumentAnnotation[]): boolean {
    if (!this.interaction.deleteAnnotations(annotations)) return false;
    this.options.onAnnotationDelete?.(annotations);
    return true;
  }

  private finishSelectionCreation(context: {
    readonly abort: AbortController;
    readonly creation: AnnotationEditorCreation;
    readonly materializeEditor: boolean;
    readonly result: DocumentAnnotation | 'dismissed';
    readonly revision: number;
  }): void {
    const { abort, creation, materializeEditor, result, revision } = context;
    const ownsTransaction = this.activeAbort === abort;
    if (ownsTransaction) {
      this.activeAbort = null;
      this.publishQuickHighlightState();
    }
    if (result === 'dismissed') {
      this.options.onSelectionCreateDiscard?.(creation);
      return;
    }
    if (!ownsTransaction || revision !== this.activeSelectionRevision) {
      this.options.onSelectionCreateDiscard?.(creation);
      return;
    }
    if (materializeEditor) this.activeEditorKind = 'annotation';
    this.options.onSelectionCreateCommit?.(creation, result);
    if (materializeEditor) this.ownedSelectionRevision = revision;
  }

  private failSelectionCreation(
    creation: AnnotationEditorCreation,
    abort: AbortController,
    cause: unknown,
  ): void {
    this.options.onSelectionCreateDiscard?.(creation);
    if (this.activeAbort !== abort) return;
    this.activeAbort = null;
    this.publishQuickHighlightState();
    if (isAbortFailure(cause)) return;
    this.options.onFailure?.('create selection annotation', cause, {
      token: creation.selection.token,
    });
  }

  private updateAnnotations(update: AnnotationEditorUpdate): boolean {
    this.contextualColorMutationDepth += 1;
    let updated: boolean;
    try {
      updated = this.interaction.updateAnnotations(update);
    } finally {
      this.contextualColorMutationDepth -= 1;
    }
    if (updated === false) return false;
    this.rememberContextualColor(update);
    this.options.onAnnotationUpdate?.(update);
    return true;
  }

  private rememberContextualColor(update: AnnotationEditorUpdate): void {
    const color = update.color;
    if (color === undefined || color.trim().length === 0) return;
    const tools = new Set(
      update.annotations
        .map((annotation) => annotationToolForType(annotation.type))
        .filter((tool): tool is 'highlight' | 'ink' | 'freetext' => tool !== null),
    );
    if (tools.size !== 1) return;
    const [tool] = tools;
    if (tool === 'highlight') {
      this.setActiveColor(color);
      this.publishQuickHighlightState();
      return;
    }
    if (tool !== undefined) this.options.onToolColorChange?.(tool, color);
  }

  private async applyQuickHighlight(enabled: boolean, revision: number): Promise<void> {
    try {
      await this.interaction.setQuickHighlight({ color: this.activeColor, enabled });
      if (this.destroyed || revision !== this.quickRequestRevision) return;
      this.stickyArming = false;
      this.stickyArmed = enabled;
      this.publishQuickHighlightState();
      this.replayQueuedStickySelection();
    } catch (cause) {
      if (this.destroyed || revision !== this.quickRequestRevision) return;
      this.discardQueuedStickySelection();
      this.stickyArmed = false;
      this.stickyArming = false;
      this.publishQuickHighlightState();
      if (isAbortFailure(cause)) return;
      this.host.closeAnnotationEditor();
      this.options.onModeChange?.(this.mode);
      this.options.onFailure?.(enabled ? 'arm Quick Highlight' : 'disarm Quick Highlight', cause, {
        color: this.activeColor,
      });
    }
  }

  private closeActiveSelection(): boolean {
    const revision = this.activeSelectionRevision;
    if (!this.host.closeAnnotationEditor()) return false;
    this.activeEditorKind = null;
    this.activeSelectionToken = null;
    this.ownedSelectionRevision = null;
    if (this.activeSelectionRevision === revision) this.activeSelectionRevision += 1;
    return true;
  }

  private abortCommit(message: string): void {
    const abort = this.activeAbort;
    this.activeAbort = null;
    abort?.abort(new DOMException(message, 'AbortError'));
  }

  private queueStickySelection(selection: PdfTextSelection): void {
    if (this.destroyed) return;
    this.queuedStickySelection = {
      color: this.activeColor,
      intentRevision: this.stickyIntentRevision,
      selection,
    };
  }

  private queueActiveStickySelection(selection: PdfTextSelection | null): void {
    if (selection !== null && (this.stickyArmed || this.stickyArming))
      this.queueStickySelection(selection);
  }

  private replayQueuedStickySelection(): void {
    if (
      this.destroyed ||
      this.activeAbort !== null ||
      this.stickyArming ||
      !this.stickyArmed ||
      this.mode !== 'neutral'
    )
      return;
    const queued = this.queuedStickySelection;
    this.queuedStickySelection = null;
    if (queued?.intentRevision !== this.stickyIntentRevision) return;
    this.commitStickySelection(queued.selection, queued.color);
  }

  private discardQueuedStickySelection(): void {
    this.stickyIntentRevision += 1;
    this.queuedStickySelection = null;
  }

  private neutralizeNativeEditor(context?: AnnotationEditorCloseContext): void {
    this.stopNativeFocusGuard();
    const focus = trackNeutralizationFocus(context?.focusTarget);
    this.nativeFocusGuard = focus;
    const neutralize = this.interaction.abortInteraction?.('The PDF annotation editor was closed.');
    if (neutralize === undefined) {
      focus?.restore();
      this.stopNativeFocusGuard(focus);
      return;
    }
    this.nativeNeutralization = neutralize
      .then(() => {
        if (!this.destroyed && this.nativeFocusGuard === focus) focus?.restore();
      })
      .catch((cause: unknown) => {
        console.error('[abyss-documents] Unexpected annotation interaction controller failure', {
          cause,
        });
      })
      .finally(() => {
        if (!this.destroyed && this.nativeFocusGuard === focus) focus?.settle();
        else focus?.stop();
      });
  }

  private stopNativeFocusGuard(expected?: NeutralizationFocusTracker | null): void {
    const focus = this.nativeFocusGuard;
    if (focus === null || (expected !== undefined && focus !== expected)) return;
    this.nativeFocusGuard = null;
    focus.stop();
  }

  private publishQuickHighlightState(): void {
    this.host.setQuickHighlightState({
      armed: this.stickyArmed,
      color: this.activeColor,
    });
  }

  private setActiveColor(color: string): void {
    if (color === this.activeColor) return;
    this.activeColor = color;
    this.options.onColorChange?.(color);
  }

  private contain(operation: Promise<void>): void {
    operation.catch((cause: unknown) => {
      console.error('[abyss-documents] Unexpected annotation interaction controller failure', {
        cause,
      });
    });
  }
}

interface NeutralizationFocusTracker {
  restore(): void;
  settle(): void;
  stop(): void;
}

function trackNeutralizationFocus(
  initialTarget: HTMLElement | undefined,
): NeutralizationFocusTracker | null {
  if (initialTarget?.isConnected !== true) return null;
  const document = initialTarget.ownerDocument;
  const owner = ownerWindow(initialTarget);
  const initialFocusTarget =
    userFocusTarget(document.activeElement, owner) ?? userFocusTarget(initialTarget, owner);
  if (initialFocusTarget === null) return null;
  let target: HTMLElement = initialFocusTarget;
  let restoreFrame: number | null = null;
  let stopTimer: number | null = null;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('focusin', onFocus, true);
    if (restoreFrame !== null) owner.cancelAnimationFrame(restoreFrame);
    if (stopTimer !== null) owner.clearTimeout(stopTimer);
    restoreFrame = null;
    stopTimer = null;
  };
  const restore = (): void => {
    if (stopped || !target.isConnected || document.activeElement === target) return;
    if (userFocusTarget(document.activeElement, owner) !== null) return;
    target.focus({ preventScroll: true });
  };
  const scheduleRestore = (): void => {
    if (stopped || restoreFrame !== null) return;
    restoreFrame = owner.requestAnimationFrame(() => {
      restoreFrame = null;
      restore();
    });
  };
  const onFocus = (event: FocusEvent): void => {
    const candidate = userFocusTarget(event.target, owner);
    if (candidate !== null) {
      target = candidate;
      return;
    }
    if (readerFocusSink(event.target, owner)) scheduleRestore();
  };
  document.addEventListener('focusin', onFocus, true);
  return {
    restore,
    settle: () => {
      restore();
      if (stopped) return;
      if (stopTimer !== null) owner.clearTimeout(stopTimer);
      stopTimer = owner.setTimeout(stop, NATIVE_FOCUS_GUARD_MS);
    },
    stop,
  };
}

function readerFocusSink(target: EventTarget | null, owner: ReaderOwnerWindow): boolean {
  return (
    target instanceof owner.HTMLElement &&
    target.matches(
      '.pdfViewerContainer, [data-region="document"], .annotationEditorLayer, .annotationEditorLayer .selectedEditor',
    )
  );
}

function userFocusTarget(target: EventTarget | null, owner: ReaderOwnerWindow): HTMLElement | null {
  const candidate = focusableTarget(target, owner);
  if (candidate === null) return null;
  if (
    readerFocusSink(candidate, owner) ||
    candidate.closest('[data-annotation-editor-popover][hidden]') !== null
  )
    return null;
  return candidate;
}

function isUsableClientPosition(
  position: { readonly x: number; readonly y: number } | undefined,
): position is { readonly x: number; readonly y: number } {
  return (
    position !== undefined &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    (position.x !== 0 || position.y !== 0)
  );
}

function isAbortFailure(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
  );
}

function activationSourceAborted(source: PdfAnnotationActivationSource): boolean {
  return source.signal?.aborted === true;
}

function activationUnavailable(destroyed: boolean, source: PdfAnnotationActivationSource): boolean {
  return destroyed || activationSourceAborted(source);
}

function annotationToolForType(
  type: DocumentAnnotation['type'],
): 'highlight' | 'ink' | 'freetext' | null {
  if (type === 'highlight' || type === 'underline') return 'highlight';
  if (type === 'ink') return 'ink';
  if (type === 'free-text') return 'freetext';
  return null;
}

function annotationIdentity(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function singleTargetAnnotation(target: AnnotationEditorTarget): DocumentAnnotation | null {
  if (target.kind === 'annotation' || target.kind === 'readonly') return target.annotation;
  if (target.kind === 'multiple' && target.annotations.length === 1)
    return target.annotations[0] ?? null;
  return null;
}

function selectionAnchor(selection: PdfTextSelection): DOMRect {
  const rect = selection.clientRects[selection.clientRects.length - 1] ?? selection.clientRect;
  return new DOMRect(rect.left, rect.top, rect.width, rect.height);
}
