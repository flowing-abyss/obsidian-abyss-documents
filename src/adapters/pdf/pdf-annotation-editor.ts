import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { decodeAnnotationComment } from '../../annotation-tokens.js';
import type { DocumentAnnotation } from '../../document-core/annotations.js';
import { beginReaderTimedOperation } from '../../reader-performance.js';
import type { AnnotationPaletteEntry } from '../../settings.js';
import type {
  PdfAnnotationFocus,
  PdfAnnotationUpdate,
  PdfCommentBridge,
} from './pdf-comment-bridge.js';
import type { PdfSelectionObserver, PdfTextSelection } from './pdf-selection-observer.js';

const SELECTION_TRANSACTION_TIMEOUT_MS = 2_000;
const ANNOTATION_ACTIVATION_TIMEOUT_MS = 20_000;

export type PdfAnnotationLogicalMode =
  'neutral' | 'one-shot' | 'quick-highlight' | 'ink' | 'freetext' | 'disabled';

export type PdfEditableAnnotationKind = 'highlight' | 'ink' | 'freetext';

export type PdfAnnotationActivationResult = 'editable' | 'readonly' | 'cancelled';

export type PdfAnnotationActivationSource = {
  readonly kind: 'root-click' | 'root-context' | 'sidebar';
  readonly preserveNativeSelection?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
};

export interface PdfProjectedAnnotation {
  readonly annotation: DocumentAnnotation;
  readonly stableId: string;
}

export type PdfAnnotationResolver = (
  stableId: string,
  signal: AbortSignal,
) => Promise<DocumentAnnotation | null>;

export type PdfSelectionAction =
  | { readonly kind: 'highlight'; readonly color: string }
  | { readonly kind: 'comment'; readonly color: string; readonly seed: string };

export interface PdfAnnotationInteraction {
  onColor(listener: (color: string) => void): () => void;
  onAnnotationFocus(listener: (focus: PdfAnnotationFocus | null) => void): () => void;
  onSelection(listener: (selection: PdfTextSelection | null) => void): () => void;
  onMode(listener: (mode: PdfAnnotationLogicalMode) => void): () => void;
  commitSelection(
    token: string,
    action: PdfSelectionAction,
    signal?: AbortSignal,
  ): Promise<DocumentAnnotation | 'dismissed'>;
  deleteAnnotations(annotations: readonly DocumentAnnotation[]): boolean;
  focusAnnotation(
    stableId: string,
    source: PdfAnnotationActivationSource,
  ): Promise<PdfAnnotationActivationResult>;
  setPalette?(palette: readonly AnnotationPaletteEntry[]): void;
  setQuickHighlight(state: { readonly enabled: boolean; readonly color: string }): Promise<void>;
  updateAnnotations(update: PdfAnnotationUpdate): boolean;
}

export type PdfAnnotationTool = 'select' | 'highlight' | 'ink' | 'freetext';

export type PdfAnnotationParameter =
  | 'freetext-size'
  | 'freetext-color'
  | 'freetext-opacity'
  | 'ink-color'
  | 'ink-thickness'
  | 'ink-opacity'
  | 'highlight-color'
  | 'highlight-thickness'
  | 'highlight-free';

export interface PdfAnnotationToolOptions {
  readonly isFromKeyboard?: boolean | undefined;
}

interface AnnotationEditorTypeConstants {
  readonly DISABLE: number;
  readonly NONE: number;
  readonly FREETEXT: number;
  readonly HIGHLIGHT: number;
  readonly INK: number;
}

interface AnnotationEditorParameterConstants {
  readonly FREETEXT_SIZE: number;
  readonly FREETEXT_COLOR: number;
  readonly FREETEXT_OPACITY: number;
  readonly INK_COLOR: number;
  readonly INK_THICKNESS: number;
  readonly INK_OPACITY: number;
  readonly HIGHLIGHT_COLOR: number;
  readonly HIGHLIGHT_THICKNESS: number;
  readonly HIGHLIGHT_FREE: number;
}

interface PdfAnnotationEventBus {
  on(name: string, listener: (event: unknown) => void): void;
  off(name: string, listener: (event: unknown) => void): void;
}

interface PdfAnnotationViewer {
  annotationEditorMode: number | PdfAnnotationModeRequest;
}

interface PdfAnnotationModeRequest extends PdfAnnotationToolOptions {
  readonly editComment?: boolean | undefined;
  readonly editId?: string | null | undefined;
  readonly mode: number;
}

interface PdfAnnotationModeOptions extends PdfAnnotationToolOptions {
  readonly editComment?: boolean | undefined;
  readonly editId?: string | undefined;
}

interface PdfAnnotationUiManager {
  commentSelection(methodOfCreation?: string): void;
  delete(): void;
  disableUserSelect(value?: boolean): void;
  endCurrentEditing(): void;
  readonly firstSelectedEditor?: PdfNativeEditorReference | undefined;
  getEditor(id: string): PdfNativeEditorReference | undefined;
  getLayer(pageIndex: number):
    | {
        disableClick(): void;
        disableTextSelection(): void;
      }
    | undefined;
  highlightSelection(methodOfCreation?: string): void;
  redo(): void;
  undo(): void;
  updateParams(type: number, value: unknown): void;
}

interface PdfNativeEditorReference {
  readonly elementBeforePopup?: Element | null | undefined;
  getData?(): { readonly id?: string | undefined };
  readonly mode?: number | undefined;
  readonly uid?: string | undefined;
}

interface MutableAnnotationStorage {
  onAnnotationEditor: ((type: number | null) => void) | null;
  onResetModified: (() => void) | null;
  onSetModified: (() => void) | null;
}

interface PdfAnnotationEditorDependencies {
  readonly annotationEditorParamsType: AnnotationEditorParameterConstants;
  readonly annotationEditorType: AnnotationEditorTypeConstants;
  readonly eventBus: PdfAnnotationEventBus;
  readonly pdf: PDFDocumentProxy;
  readonly commentBridge: Pick<
    PdfCommentBridge,
    | 'beginPersistence'
    | 'deleteAnnotations'
    | 'endPersistence'
    | 'focusAnnotation'
    | 'nativeEditorIds'
    | 'normalizeCreatedAnnotation'
    | 'normalizeSelectionHighlight'
    | 'onAnnotationFocus'
    | 'reserveNextDialog'
    | 'updateAnnotations'
  > &
    Partial<Pick<PdfCommentBridge, 'refreshAnnotationFocus' | 'setSidebarUiManager'>>;
  readonly selectionObserver: PdfSelectionObserver;
  readonly viewer: PdfAnnotationViewer;
}

interface CallbackOwnership {
  readonly ownedEditor: (type: number | null) => void;
  readonly ownedReset: () => void;
  readonly ownedSet: () => void;
  readonly previousEditor: ((type: number | null) => void) | null;
  readonly previousReset: (() => void) | null;
  readonly previousSet: (() => void) | null;
}

interface PendingModeChange {
  readonly clearTimeout: () => void;
  readonly removeAbort: () => void;
  readonly reject: (reason: Error) => void;
  readonly listener: (event: unknown) => void;
  readonly resolve: () => void;
}

interface PendingAnnotationFocus {
  readonly activation: AnnotationActivation | null;
  readonly epoch: number;
  readonly focus: PdfAnnotationFocus | null;
  readonly lifecycleRevision: number;
  timeout: number | null;
}

interface SelectionHighlightReservation {
  readonly created: Promise<DocumentAnnotation>;
  readonly current: () => DocumentAnnotation | null;
  readonly observed: () => boolean;
  readonly refresh: () => void;
  readonly unsubscribe: () => void;
}

interface QueuedToolIntent {
  options: PdfAnnotationModeOptions;
  tool: PdfAnnotationTool;
  readonly waiters: Array<{
    readonly reject: (reason: Error) => void;
    readonly resolve: () => void;
  }>;
}

interface QueuedMutation {
  readonly apply: (manager: PdfAnnotationUiManager) => void;
  readonly reject: (reason: Error) => void;
  readonly resolve: () => void;
}

interface PreparedSave {
  readonly contextualRestore: ContextualSaveRestore | null;
  readonly manager: PdfAnnotationUiManager;
  readonly revision: number;
}

interface ContextualSaveRestore {
  readonly id: string;
  readonly mode: number;
}

interface ContextualEditSession {
  closing: Promise<void> | null;
  guarded: boolean;
  readonly id: string;
  readonly manager: PdfAnnotationUiManager;
  readonly mode: number;
  readonly onEditorsRendered: (event: unknown) => void;
  phase: 'awaiting-selection' | 'selected' | 'closing';
  readonly suppressedToolbars: Map<HTMLElement, SuppressedNativeToolbar>;
  toolbarObserver: MutationObserver | null;
}

interface SuppressedNativeToolbar {
  readonly display: string;
  readonly hidden: boolean;
  readonly priority: string;
}

interface AnnotationActivation {
  readonly clearDeadline: () => void;
  readonly controller: AbortController;
  readonly deadline: number;
  readonly epoch: number;
  readonly id: string;
  readonly lifecycleRevision: number;
  readonly manager: PdfAnnotationUiManager;
  readonly promise: Promise<PdfAnnotationActivationResult>;
  projected: DocumentAnnotation | null;
  readonly removeExternalAbort: () => void;
  timedOut: boolean;
}

interface PendingSelectionTransaction {
  readonly armTimeout: () => void;
  readonly controller: AbortController;
  readonly clearTimeout: () => void;
  readonly removeExternalAbort: () => void;
  restoration: Promise<void> | null;
  readonly settled: ReturnType<typeof deferred<void>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export class PdfAnnotationEditor {
  private readonly annotationFocusListeners = new Set<(focus: PdfAnnotationFocus | null) => void>();
  private readonly colorListeners = new Set<(color: string) => void>();
  private readonly dirtyListeners = new Set<(dirty: boolean) => void>();
  private readonly editorAddedListeners = new Set<(type: number | null) => void>();
  private readonly mutationListeners = new Set<() => void>();
  private readonly modeListeners = new Set<(mode: PdfAnnotationLogicalMode) => void>();
  private readonly storage: MutableAnnotationStorage;
  private callbackOwnership: CallbackOwnership | null = null;
  private manager: PdfAnnotationUiManager | null = null;
  private managerEventsEnabled = true;
  private pendingModeChange: PendingModeChange | null = null;
  private pendingSelectionTransaction: PendingSelectionTransaction | null = null;
  private queuedToolIntent: QueuedToolIntent | null = null;
  private readonly queuedMutations: QueuedMutation[] = [];
  private readonly retiredManagers = new WeakSet<object>();
  private destroyed = false;
  private lifecycleRevision = 0;
  private saving = false;
  private logicalMode: PdfAnnotationLogicalMode = 'neutral';
  private contextualEditSession: ContextualEditSession | null = null;
  private pendingContextualSaveRestore: ContextualSaveRestore | null = null;
  private activationEpoch = 0;
  private activeActivation: AnnotationActivation | null = null;
  private annotationResolver: PdfAnnotationResolver | null = null;
  private readonly projectedAnnotations = new Map<string, DocumentAnnotation>();
  private readonly removeBridgeFocusListener: () => void;
  private pendingAnnotationFocus: PendingAnnotationFocus | null = null;

  constructor(private readonly dependencies: PdfAnnotationEditorDependencies) {
    this.storage = dependencies.pdf.annotationStorage;
    this.removeBridgeFocusListener = dependencies.commentBridge.onAnnotationFocus(
      this.onBridgeAnnotationFocus,
    );
    dependencies.eventBus.on('annotationeditoruimanager', this.onManager);
    dependencies.eventBus.on('annotationeditormodechanged', this.onNativeMode);
    dependencies.eventBus.on('editingstateschanged', this.onEditingState);
    dependencies.eventBus.on('switchannotationeditorparams', this.onNativeParameter);
  }

  async setTool(tool: PdfAnnotationTool, options: PdfAnnotationToolOptions = {}): Promise<void> {
    this.cancelAnnotationActivation('The PDF annotation activation was superseded by a tool.');
    this.cancelContextualSaveRestore();
    this.requireManager();
    const contextual = this.contextualEditSession;
    if (contextual !== null) await this.closeContextualEditSession(contextual);
    const modeOptions: PdfAnnotationModeOptions =
      options.isFromKeyboard === undefined ? {} : { isFromKeyboard: options.isFromKeyboard };
    if (this.saving) return this.queueToolIntent(tool, modeOptions);
    const mode = this.modeFor(tool);
    await this.changeMode(mode, modeOptions);
  }

  async editAnnotation(request: {
    readonly id: string;
    readonly kind: PdfEditableAnnotationKind;
    readonly editComment: boolean;
  }): Promise<void> {
    const manager = this.requireManager();
    if (this.logicalMode !== 'neutral' || this.contextualEditSession !== null) return;
    const editId = request.id.trim();
    if (editId.length === 0) {
      throw new DOMException('The PDF annotation id is empty.', 'InvalidStateError');
    }
    const options: PdfAnnotationModeOptions = {
      editComment: request.editComment,
      editId,
    };
    const mode = this.modeFor(request.kind);
    const session: ContextualEditSession = {
      closing: null,
      guarded: false,
      id: editId,
      manager,
      mode,
      onEditorsRendered: this.onContextualEditorsRendered,
      phase: 'awaiting-selection',
      suppressedToolbars: new Map(),
      toolbarObserver: null,
    };
    this.contextualEditSession = session;
    try {
      await this.enterContextualEditSession(session, request.kind, options);
    } catch (cause) {
      await this.containFailedContextualEntry(session);
      throw cause;
    }
  }

  onSelection(listener: (selection: PdfTextSelection | null) => void): () => void {
    return this.dependencies.selectionObserver.onSelection(listener);
  }

  onAnnotationFocus(listener: (focus: PdfAnnotationFocus | null) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.annotationFocusListeners.add(listener);
    return () => {
      this.annotationFocusListeners.delete(listener);
    };
  }

  setAnnotationProjection(annotations: readonly PdfProjectedAnnotation[]): void {
    this.projectedAnnotations.clear();
    for (const { annotation, stableId } of annotations) {
      const id = stableId.trim();
      if (id.length > 0) this.projectedAnnotations.set(id, annotation);
      if (annotation.identity.kind === 'stable')
        this.projectedAnnotations.set(annotation.identity.id, annotation);
    }
  }

  setAnnotationResolver(resolver: PdfAnnotationResolver | null): void {
    this.annotationResolver = resolver;
  }

  focusAnnotation(
    stableId: string,
    source: PdfAnnotationActivationSource,
  ): Promise<PdfAnnotationActivationResult> {
    const id = stableId.trim();
    if (id.length === 0 || source.signal?.aborted === true || this.destroyed)
      return Promise.resolve('cancelled');
    return this.startAnnotationActivation(id, source.signal, async (activation) => {
      const projected = await this.resolveProjectedAnnotation(id, activation);
      if (!this.isCurrentActivation(activation) || projected === null) return 'cancelled';
      return this.focusResolvedAnnotation(id, source, projected, activation);
    });
  }

  private focusResolvedAnnotation(
    id: string,
    source: PdfAnnotationActivationSource,
    projected: DocumentAnnotation,
    activation: AnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    const kind = editableKindForAnnotation(projected);
    if (kind === null || !annotationIsWritable(projected))
      return this.focusReadonlyProjected(id, projected, activation);
    if (source.preserveNativeSelection === true)
      return this.focusPreservedNativeSelection(id, projected, activation);
    return this.activateWithinEpoch(
      { anchor: projected.anchor, editComment: false, id, kind },
      projected,
      activation,
    );
  }

  private async focusReadonlyProjected(
    id: string,
    projected: DocumentAnnotation,
    activation: AnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    const focused = await waitWithSignal(
      this.dependencies.commentBridge.focusAnnotation(id, activation.controller.signal, projected, {
        forceReadonly: true,
      }),
      activation.controller.signal,
    );
    if (!this.isCurrentActivation(activation) || !focused) return 'cancelled';
    this.releaseActivationFocus(activation, false);
    return 'readonly';
  }

  private async focusPreservedNativeSelection(
    id: string,
    projected: DocumentAnnotation,
    activation: AnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    await waitWithSignal(nextTask(), activation.controller.signal);
    if (!this.isCurrentActivation(activation)) return 'cancelled';
    const focused = await waitWithSignal(
      this.dependencies.commentBridge.focusAnnotation(id, activation.controller.signal, projected, {
        editableOnly: true,
        preserveSelection: true,
      }),
      activation.controller.signal,
    );
    if (!this.isCurrentActivation(activation) || !focused) return 'cancelled';
    this.releaseActivationFocus(activation, true);
    return 'editable';
  }

  activateAnnotation(request: {
    readonly anchor: DocumentAnnotation['anchor'];
    readonly editComment: boolean;
    readonly id: string;
    readonly kind: PdfEditableAnnotationKind;
  }): Promise<PdfAnnotationActivationResult> {
    const id = request.id.trim();
    if (id.length === 0 || this.destroyed) return Promise.resolve('cancelled');
    return this.startAnnotationActivation(id, undefined, (activation) =>
      this.activateWithinEpoch({ ...request, id }, undefined, activation),
    );
  }

  private startAnnotationActivation(
    id: string,
    externalSignal: AbortSignal | undefined,
    run: (activation: AnnotationActivation) => Promise<PdfAnnotationActivationResult>,
  ): Promise<PdfAnnotationActivationResult> {
    const current = this.activeActivation;
    if (current !== null && current.id === id && !current.controller.signal.aborted)
      return current.promise;
    this.cancelAnnotationActivation('The PDF annotation activation was superseded.');
    const manager = this.manager;
    if (manager === null || this.destroyed || externalSignal?.aborted === true)
      return Promise.resolve('cancelled');
    const controller = new AbortController();
    const onExternalAbort = (): void => {
      if (externalSignal !== undefined) controller.abort(abortReason(externalSignal));
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const settled = deferred<PdfAnnotationActivationResult>();
    let deadlineTimer: number | null = null;
    const activation: AnnotationActivation = {
      clearDeadline: () => {
        const timer = deadlineTimer;
        deadlineTimer = null;
        if (timer !== null) window.clearTimeout(timer);
      },
      controller,
      deadline: Date.now() + ANNOTATION_ACTIVATION_TIMEOUT_MS,
      epoch: ++this.activationEpoch,
      id,
      lifecycleRevision: this.lifecycleRevision,
      manager,
      promise: settled.promise,
      projected: this.projectedAnnotations.get(id) ?? null,
      removeExternalAbort: () => {
        externalSignal?.removeEventListener('abort', onExternalAbort);
      },
      timedOut: false,
    };
    deadlineTimer = window.setTimeout(() => {
      if (!this.isOwnedActivation(activation)) return;
      activation.timedOut = true;
      controller.abort(
        new DOMException('The PDF annotation activation timed out.', 'TimeoutError'),
      );
    }, remainingDeadlineMs(activation.deadline));
    this.activeActivation = activation;
    run(activation)
      .catch(() => 'cancelled' as const)
      .then(async (result) => {
        const finalResult =
          result === 'cancelled' && activation.timedOut
            ? await this.focusTimedOutProjection(activation)
            : result;
        settled.resolve(this.isOwnedActivation(activation) ? finalResult : 'cancelled');
      })
      .finally(() => {
        activation.clearDeadline();
        activation.removeExternalAbort();
        this.clearPendingAnnotationFocus(activation);
        if (this.activeActivation === activation) this.activeActivation = null;
      })
      .catch(() => undefined);
    return activation.promise;
  }

  private async resolveProjectedAnnotation(
    id: string,
    activation: AnnotationActivation,
  ): Promise<DocumentAnnotation | null> {
    const projected = this.projectedAnnotations.get(id) ?? null;
    if (this.annotationResolver === null || (projected !== null && annotationIsWritable(projected)))
      return projected;
    const resolved = await waitWithSignal(
      this.annotationResolver(id, activation.controller.signal),
      activation.controller.signal,
    );
    if (!this.isCurrentActivation(activation)) return null;
    activation.projected = resolved ?? projected;
    return activation.projected;
  }

  private async focusTimedOutProjection(
    activation: AnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    const projected = activation.projected;
    if (
      !this.isOwnedActivation(activation) ||
      projected === null ||
      !this.canFocusTimedOutProjection()
    )
      return 'cancelled';
    const controller = new AbortController();
    try {
      const focusing = this.dependencies.commentBridge.focusAnnotation(
        activation.id,
        controller.signal,
        projected,
        { forceReadonly: true },
      );
      const focused = await Promise.race([
        focusing,
        new Promise<false>((resolve) => {
          queueMicrotask(() => {
            resolve(false);
          });
        }),
      ]);
      if (!this.isOwnedActivation(activation) || !focused || !this.canFocusTimedOutProjection())
        return 'cancelled';
      this.releaseActivationFocus(activation, false);
      return 'readonly';
    } catch {
      return 'cancelled';
    } finally {
      controller.abort(
        new DOMException('The deadline fallback readiness check completed.', 'AbortError'),
      );
    }
  }

  private canFocusTimedOutProjection(): boolean {
    return (
      this.contextualEditSession === null &&
      this.dependencies.viewer.annotationEditorMode === this.dependencies.annotationEditorType.NONE
    );
  }

  private async activateWithinEpoch(
    request: {
      readonly anchor: DocumentAnnotation['anchor'];
      readonly editComment: boolean;
      readonly id: string;
      readonly kind: PdfEditableAnnotationKind;
    },
    projected: DocumentAnnotation | undefined,
    activation: AnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    let session: ContextualEditSession | null = null;
    try {
      if (!(await this.prepareContextualActivation(activation))) return 'cancelled';
      session = this.beginContextualActivation(request, activation);
      if (!(await this.selectContextualEditor(request, session, activation)))
        return this.failContextualActivation(session, projected, activation);
      if (!(await this.focusContextualEditor(request.id, projected, session, activation)))
        return this.failContextualActivation(session, projected, activation);
      return 'editable';
    } catch {
      return session === null
        ? 'cancelled'
        : this.failContextualActivation(session, projected, activation);
    }
  }

  private async prepareContextualActivation(activation: AnnotationActivation): Promise<boolean> {
    const contextual = this.contextualEditSession;
    if (contextual !== null) {
      await waitWithSignal(
        this.closeContextualEditSession(contextual, {
          signal: activation.controller.signal,
        }),
        activation.controller.signal,
      );
      if (!this.isCurrentActivation(activation)) return false;
    }
    if (
      this.logicalMode !== 'neutral' ||
      this.dependencies.viewer.annotationEditorMode !== this.dependencies.annotationEditorType.NONE
    ) {
      await this.changeMode(
        this.dependencies.annotationEditorType.NONE,
        {},
        { signal: activation.controller.signal },
      );
      if (!this.isCurrentActivation(activation)) return false;
    }
    this.setLogicalMode('neutral');
    return true;
  }

  private beginContextualActivation(
    request: { readonly id: string; readonly kind: PdfEditableAnnotationKind },
    activation: AnnotationActivation,
  ): ContextualEditSession {
    const session: ContextualEditSession = {
      closing: null,
      guarded: false,
      id: request.id,
      manager: activation.manager,
      mode: this.modeFor(request.kind),
      onEditorsRendered: this.onContextualEditorsRendered,
      phase: 'awaiting-selection',
      suppressedToolbars: new Map(),
      toolbarObserver: null,
    };
    this.contextualEditSession = session;
    return session;
  }

  private async selectContextualEditor(
    request: { readonly editComment: boolean; readonly id: string },
    session: ContextualEditSession,
    activation: AnnotationActivation,
  ): Promise<boolean> {
    await this.changeMode(
      session.mode,
      { editComment: request.editComment, editId: request.id },
      { signal: activation.controller.signal },
    );
    if (!this.isActiveContextualSession(session, activation)) return false;
    if (!(await this.waitForRequestedEditor(session, activation.controller.signal))) return false;
    if (!this.isCurrentActivation(activation)) return false;
    await waitWithSignal(nextTask(), activation.controller.signal);
    if (!this.isActiveContextualSession(session, activation)) return false;
    if (!this.isRequestedEditorSelected(session)) return false;
    this.guardContextualEditSession(session);
    session.phase = 'selected';
    return true;
  }

  private async focusContextualEditor(
    id: string,
    projected: DocumentAnnotation | undefined,
    session: ContextualEditSession,
    activation: AnnotationActivation,
  ): Promise<boolean> {
    const focused = await waitWithSignal(
      this.dependencies.commentBridge.focusAnnotation(id, activation.controller.signal, projected, {
        editableOnly: true,
        preserveSelection: true,
      }),
      activation.controller.signal,
    );
    if (!this.isActiveContextualSession(session, activation) || !focused) return false;
    this.releaseActivationFocus(activation, true);
    return true;
  }

  private isActiveContextualSession(
    session: ContextualEditSession,
    activation: AnnotationActivation,
  ): boolean {
    return this.contextualEditSession === session && this.isCurrentActivation(activation);
  }

  private async failContextualActivation(
    session: ContextualEditSession,
    projected: DocumentAnnotation | undefined,
    activation: AnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    try {
      await this.containFailedContextualEntry(session, activation.controller.signal);
    } catch {
      return 'cancelled';
    }
    if (!this.isCurrentActivation(activation)) return 'cancelled';
    const focused = await waitWithSignal(
      this.dependencies.commentBridge.focusAnnotation(
        activation.id,
        activation.controller.signal,
        projected,
        { forceReadonly: true },
      ),
      activation.controller.signal,
    );
    if (!this.isCurrentActivation(activation) || !focused) return 'cancelled';
    this.releaseActivationFocus(activation, false);
    return 'readonly';
  }

  private waitForRequestedEditor(
    session: ContextualEditSession,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.isRequestedEditorSelected(session)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (selected: boolean): void => {
        if (settled) return;
        settled = true;
        this.dependencies.eventBus.off('editingstateschanged', check);
        this.dependencies.eventBus.off('editorsrendered', check);
        signal.removeEventListener('abort', onAbort);
        resolve(selected);
      };
      const check = (): void => {
        if (signal.aborted || this.contextualEditSession !== session) finish(false);
        else if (this.isRequestedEditorSelected(session)) finish(true);
      };
      const onAbort = (): void => {
        finish(false);
      };
      this.dependencies.eventBus.on('editingstateschanged', check);
      this.dependencies.eventBus.on('editorsrendered', check);
      signal.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  private isCurrentActivation(activation: AnnotationActivation): boolean {
    return this.isOwnedActivation(activation) && !activation.controller.signal.aborted;
  }

  private isOwnedActivation(activation: AnnotationActivation): boolean {
    return (
      this.activeActivation === activation &&
      activation.epoch === this.activationEpoch &&
      activation.lifecycleRevision === this.lifecycleRevision &&
      activation.manager === this.manager &&
      !this.destroyed
    );
  }

  private cancelAnnotationActivation(message: string): void {
    const activation = this.activeActivation;
    this.activationEpoch += 1;
    this.clearPendingAnnotationFocus();
    if (activation === null || activation.controller.signal.aborted) return;
    activation.controller.abort(new DOMException(message, 'AbortError'));
  }

  private cancelContextualSaveRestore(): void {
    this.pendingContextualSaveRestore = null;
  }

  private clearOwnedContextualSaveRestore(restore: ContextualSaveRestore | null): void {
    if (this.pendingContextualSaveRestore === restore) this.pendingContextualSaveRestore = null;
  }

  deleteAnnotations(annotations: readonly DocumentAnnotation[]): boolean {
    this.cancelAnnotationActivation('Deleting the PDF annotation cancelled its activation.');
    const deleted = this.dependencies.commentBridge.deleteAnnotations(annotations);
    if (deleted) this.cancelContextualSaveRestore();
    return deleted;
  }

  updateAnnotations(update: PdfAnnotationUpdate): boolean {
    return this.dependencies.commentBridge.updateAnnotations(update);
  }

  onColor(listener: (color: string) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.colorListeners.add(listener);
    return () => {
      this.colorListeners.delete(listener);
    };
  }

  get hasContextualEdit(): boolean {
    return this.contextualEditSession !== null;
  }

  resolveNativeEditor(internalId: string): {
    readonly id: string;
    readonly kind: PdfEditableAnnotationKind;
    readonly mode: number;
  } | null {
    const manager = this.manager;
    if (this.destroyed || manager === null) return null;
    const native = manager.getEditor(internalId.trim());
    const id = nativeEditorAnnotationId(native);
    const mode = native?.mode;
    if (id === undefined || id.length === 0 || typeof mode !== 'number') return null;
    const kind = this.editableKindForMode(mode);
    return kind === null ? null : { id, kind, mode };
  }

  onMode(listener: (mode: PdfAnnotationLogicalMode) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.modeListeners.add(listener);
    listener(this.logicalMode);
    return () => {
      this.modeListeners.delete(listener);
    };
  }

  async commitSelection(
    token: string,
    action: PdfSelectionAction,
    signal?: AbortSignal,
  ): Promise<DocumentAnnotation | 'dismissed'> {
    if (!this.restoreSelectionToken(token)) return 'dismissed';
    const manager = this.requireManager();
    if (this.logicalMode !== 'neutral') return 'dismissed';
    if (signal?.aborted === true) throw abortReason(signal);
    const transaction = this.beginSelectionTransaction(signal);
    const highlight = this.reserveSelectionHighlight(manager);
    try {
      manager.updateParams(
        this.dependencies.annotationEditorParamsType.HIGHLIGHT_COLOR,
        action.color,
      );
      this.emitColor(action.color);
      this.setLogicalMode('one-shot');
      await waitWithSignal(
        this.changeMode(this.dependencies.annotationEditorType.HIGHLIGHT),
        transaction.controller.signal,
      );
      const resolved = await this.resolveSelectionAnnotation({
        action,
        highlight,
        manager,
        transaction,
        token,
      });
      const annotation = this.applyAdoptedCommentSeed(
        resolved.annotation,
        action,
        resolved.adopted,
      );
      await waitWithSignal(
        this.changeMode(this.dependencies.annotationEditorType.NONE),
        transaction.controller.signal,
      );
      return annotation;
    } catch (cause) {
      const failure = asError(cause);
      await this.abortSelectionTransaction(failure);
      throw failure;
    } finally {
      highlight.unsubscribe();
      this.finishSelectionTransaction(transaction);
    }
  }

  private restoreSelectionToken(token: string): boolean {
    if (this.dependencies.selectionObserver.validate(token) === 'current') return true;
    return this.dependencies.selectionObserver.restore?.(token) === 'current';
  }

  private async resolveSelectionAnnotation(context: {
    readonly action: PdfSelectionAction;
    readonly highlight: SelectionHighlightReservation;
    readonly manager: PdfAnnotationUiManager;
    readonly token: string;
    readonly transaction: PendingSelectionTransaction;
  }): Promise<{ readonly adopted: boolean; readonly annotation: DocumentAnnotation }> {
    const { action, highlight, manager, token, transaction } = context;
    highlight.refresh();
    let annotation = highlight.current();
    if (annotation === null && highlight.observed())
      annotation = await waitWithSignal(highlight.created, transaction.controller.signal);
    if (annotation === null && this.dependencies.selectionObserver.validate(token) === 'stale')
      annotation = await waitWithSignal(highlight.created, transaction.controller.signal);
    if (annotation !== null) return { adopted: true, annotation };
    const created =
      action.kind === 'highlight'
        ? await this.createSelectionHighlight(manager, transaction, highlight)
        : await this.createSelectionComment(manager, action.seed, transaction);
    return { adopted: false, annotation: created };
  }

  private applyAdoptedCommentSeed(
    annotation: DocumentAnnotation,
    action: PdfSelectionAction,
    adopted: boolean,
  ): DocumentAnnotation {
    if (!adopted || action.kind !== 'comment' || action.seed.length === 0) return annotation;
    if (
      !this.dependencies.commentBridge.updateAnnotations({
        annotations: [annotation],
        comment: action.seed,
      })
    )
      return annotation;
    const decoded = decodeAnnotationComment(action.seed);
    return Object.freeze({
      ...annotation,
      comment: action.seed,
      links: decoded.links,
      tags: decoded.tags,
    });
  }

  private reserveSelectionHighlight(
    manager: PdfAnnotationUiManager,
  ): SelectionHighlightReservation {
    const created = deferred<DocumentAnnotation>();
    const existingIds = this.dependencies.commentBridge.nativeEditorIds(manager);
    let current: DocumentAnnotation | null = null;
    let frame: number | null = null;
    let observed = false;
    let stopped = false;
    const resolveCurrent = (): boolean => {
      const annotation = this.dependencies.commentBridge.normalizeSelectionHighlight(
        manager,
        existingIds,
      );
      if (annotation === null) return false;
      current ??= annotation;
      created.resolve(annotation);
      return true;
    };
    const refresh = (): void => {
      if (stopped || current !== null) return;
      if (resolveCurrent() || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        refresh();
      });
    };
    const unsubscribe = this.onEditorAdded((type) => {
      if (type !== this.dependencies.annotationEditorType.HIGHLIGHT) return;
      observed = true;
      queueMicrotask(refresh);
      refresh();
    });
    return {
      created: created.promise,
      current: () => current,
      observed: () => observed,
      refresh,
      unsubscribe: () => {
        stopped = true;
        unsubscribe();
        if (frame !== null) window.cancelAnimationFrame(frame);
      },
    };
  }

  private async createSelectionHighlight(
    manager: PdfAnnotationUiManager,
    transaction: PendingSelectionTransaction,
    reservation: SelectionHighlightReservation,
  ): Promise<DocumentAnnotation> {
    manager.highlightSelection('abyss-selection');
    return waitWithSignal(reservation.created, transaction.controller.signal);
  }

  private async createSelectionComment(
    manager: PdfAnnotationUiManager,
    seed: string,
    transaction: PendingSelectionTransaction,
  ): Promise<DocumentAnnotation> {
    const reservation = this.dependencies.commentBridge.reserveNextDialog(
      seed,
      transaction.controller.signal,
    );
    manager.commentSelection('abyss-selection');
    const annotation = await waitWithSignal(reservation.opened, transaction.controller.signal);
    transaction.clearTimeout();
    await waitWithSignal(reservation.closed, transaction.controller.signal);
    transaction.armTimeout();
    return annotation;
  }

  async setQuickHighlight(state: {
    readonly enabled: boolean;
    readonly color: string;
  }): Promise<void> {
    if (state.enabled) {
      await this.setParameter('highlight-color', state.color);
      await this.setTool('highlight');
      return;
    }
    await this.setTool('select');
  }

  async abortInteraction(message: string): Promise<void> {
    this.cancelAnnotationActivation(message);
    this.cancelContextualSaveRestore();
    const transaction = this.pendingSelectionTransaction;
    if (transaction !== null) {
      await this.abortAndWaitForTransaction(transaction, new DOMException(message, 'AbortError'));
      return;
    }
    const contextual = this.contextualEditSession;
    if (contextual === null) return;
    await this.closeContextualEditSession(contextual);
  }

  private async changeMode(
    mode: number,
    options: PdfAnnotationModeOptions = {},
    wait: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (wait.signal?.aborted === true) throw abortReason(wait.signal);
    if (this.dependencies.viewer.annotationEditorMode === mode) return;
    this.cancelPendingModeChange('The PDF annotation tool change was superseded.');
    await new Promise<void>((resolve, reject) => {
      let timeoutId: number | null =
        wait.signal === undefined
          ? window.setTimeout(() => {
              const pending = this.pendingModeChange;
              if (pending?.listener !== listener) return;
              this.pendingModeChange = null;
              this.dependencies.eventBus.off('annotationeditormodechanged', listener);
              removeAbort();
              timeoutId = null;
              reject(
                new DOMException(
                  'Changing the PDF annotation editor mode timed out.',
                  'TimeoutError',
                ),
              );
            }, SELECTION_TRANSACTION_TIMEOUT_MS)
          : null;
      const clearTimeout = (): void => {
        const currentTimeout = timeoutId;
        timeoutId = null;
        if (currentTimeout !== null) window.clearTimeout(currentTimeout);
      };
      const listener = (event: unknown): void => {
        const data = record(event);
        if (data?.['source'] !== this.dependencies.viewer || data['mode'] !== mode) return;
        this.dependencies.eventBus.off('annotationeditormodechanged', listener);
        clearTimeout();
        removeAbort();
        const pending = this.pendingModeChange;
        if (pending !== null && pending.listener === listener) this.pendingModeChange = null;
        resolve();
      };
      const onAbort = (): void => {
        const pending = this.pendingModeChange;
        if (pending?.listener !== listener || wait.signal === undefined) return;
        this.pendingModeChange = null;
        this.dependencies.eventBus.off('annotationeditormodechanged', listener);
        clearTimeout();
        removeAbort();
        reject(abortReason(wait.signal));
      };
      const removeAbort = (): void => {
        wait.signal?.removeEventListener('abort', onAbort);
      };
      this.pendingModeChange = { clearTimeout, listener, reject, removeAbort, resolve };
      this.dependencies.eventBus.on('annotationeditormodechanged', listener);
      wait.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.dependencies.viewer.annotationEditorMode = {
          mode,
          ...(options.isFromKeyboard === undefined
            ? {}
            : { isFromKeyboard: options.isFromKeyboard }),
          ...(options.editId === undefined
            ? {}
            : {
                editComment: options.editComment === true,
                editId: options.editId,
              }),
        };
      } catch (cause) {
        this.dependencies.eventBus.off('annotationeditormodechanged', listener);
        clearTimeout();
        removeAbort();
        this.pendingModeChange = null;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  setParameter(parameter: PdfAnnotationParameter, value: unknown): Promise<void> {
    const operation = this.runOrQueueMutation((manager) => {
      manager.updateParams(this.parameterFor(parameter), value);
    });
    if (!isColorParameter(parameter) || typeof value !== 'string' || value.trim().length === 0)
      return operation;
    return operation.then(() => {
      this.emitColor(value);
    });
  }

  undo(): Promise<void> {
    return this.runOrQueueMutation((manager) => {
      manager.undo();
    });
  }

  redo(): Promise<void> {
    return this.runOrQueueMutation((manager) => {
      manager.redo();
    });
  }

  deleteSelection(): Promise<void> {
    return this.runOrQueueMutation((manager) => {
      manager.delete();
    });
  }

  onDirty(listener: (dirty: boolean) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.dirtyListeners.add(listener);
    return () => {
      this.dirtyListeners.delete(listener);
    };
  }

  onMutation(listener: () => void): () => void {
    if (this.destroyed) return () => undefined;
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  /** Signals that PDF.js successfully mutated a native editor object outside AnnotationStorage. */
  notifyNativeMutation(): void {
    this.requireManager();
    this.emitMutation();
    this.emitDirty(true);
  }

  /** Synchronizes a successful native color mutation performed by the comment bridge. */
  notifyNativeColorChange(color: string): void {
    if (this.destroyed || color.trim().length === 0) return;
    this.emitColor(color);
  }

  async save(signal: AbortSignal): Promise<Uint8Array> {
    this.dependencies.commentBridge.beginPersistence();
    try {
      return await this.saveDuringPersistence(signal);
    } finally {
      this.dependencies.commentBridge.endPersistence();
    }
  }

  private async saveDuringPersistence(signal: AbortSignal): Promise<Uint8Array> {
    const prepared = this.prepareSave(signal);
    const context = prepared instanceof Promise ? await prepared : prepared;
    const { manager, revision } = context;
    const finishSerialization = beginReaderTimedOperation('annotation-serialization');
    let outcome: { bytes: Uint8Array | null; failure: Error | null } = {
      bytes: null,
      failure: null,
    };
    let restoredMode: number | null = null;
    try {
      restoredMode = await this.pauseForSave(manager, revision, signal);
      outcome = { bytes: await this.captureBytes(manager, revision, signal), failure: null };
    } catch (cause) {
      outcome = { bytes: null, failure: asError(cause) };
    } finally {
      const restoreFailure = await this.finishSave(context, restoredMode);
      outcome.failure ??= restoreFailure;
      finishSerialization();
    }
    return this.requireSaveBytes(outcome);
  }

  private async finishSave(
    context: PreparedSave,
    restoredMode: number | null,
  ): Promise<Error | null> {
    const { contextualRestore, manager, revision } = context;
    const queuedIntents: QueuedToolIntent[] = [];
    let targetContextualRestore =
      this.pendingContextualSaveRestore === contextualRestore ? contextualRestore : null;
    let targetMode = targetContextualRestore?.mode ?? restoredMode;
    let targetOptions: PdfAnnotationModeOptions =
      targetContextualRestore === null
        ? {}
        : { editComment: false, editId: targetContextualRestore.id };
    let restoreFailure: Error | null = null;
    do {
      const queued = this.takeQueuedToolIntent();
      if (queued !== null) {
        queuedIntents.push(queued);
        targetMode = this.modeFor(queued.tool);
        targetOptions = queued.options;
        targetContextualRestore = null;
      }
      restoreFailure = await this.restoreAfterSave({
        contextualRestore: targetContextualRestore,
        manager,
        mode: targetMode,
        options: targetOptions,
        revision,
      });
    } while (restoreFailure === null && this.queuedToolIntent !== null);
    const failedDuringRestore = this.takeQueuedToolIntent();
    if (failedDuringRestore !== null) queuedIntents.push(failedDuringRestore);
    this.clearOwnedContextualSaveRestore(contextualRestore);
    this.releaseSave(manager, revision);
    this.synchronizeLogicalModeAfterSave();
    for (const queued of queuedIntents) this.settleQueuedToolIntent(queued, restoreFailure);
    return restoreFailure;
  }

  private requireSaveBytes(outcome: {
    readonly bytes: Uint8Array | null;
    readonly failure: Error | null;
  }): Uint8Array {
    if (outcome.failure !== null) throw outcome.failure;
    if (outcome.bytes === null) throw this.staleError();
    return outcome.bytes;
  }

  private prepareSave(signal: AbortSignal): PreparedSave | Promise<PreparedSave> {
    const manager = this.requireManager();
    const revision = this.lifecycleRevision;
    const pendingSelection = this.waitForSelectionBeforeSave(signal);
    if (pendingSelection === null) {
      return this.beginPreparedSave(manager, revision, signal);
    }
    return pendingSelection.then(() => {
      return this.beginPreparedSave(manager, revision, signal);
    });
  }

  private beginPreparedSave(
    manager: PdfAnnotationUiManager,
    revision: number,
    signal: AbortSignal,
  ): PreparedSave | Promise<PreparedSave> {
    if (manager !== this.manager || revision !== this.lifecycleRevision || this.destroyed) {
      throw this.staleError();
    }
    this.beginSave(signal);
    const contextual = this.contextualEditSession;
    if (contextual === null) return { contextualRestore: null, manager, revision };
    const contextualRestore = { id: contextual.id, mode: contextual.mode };
    this.pendingContextualSaveRestore = contextualRestore;
    return this.closeContextualEditSession(contextual).then(
      () => ({ contextualRestore, manager, revision }),
      (cause: unknown) => {
        if (this.pendingContextualSaveRestore === contextualRestore)
          this.pendingContextualSaveRestore = null;
        this.releaseSave(manager, revision);
        throw cause;
      },
    );
  }

  private waitForSelectionBeforeSave(signal: AbortSignal): Promise<void> | null {
    const pendingSelection = this.pendingSelectionTransaction;
    return pendingSelection === null
      ? null
      : waitWithSignal(pendingSelection.settled.promise, signal);
  }

  private beginSave(signal: AbortSignal): void {
    if (this.saving) {
      throw new DOMException('A PDF annotation save is already active.', 'InvalidStateError');
    }
    this.throwIfAborted(signal);
    this.saving = true;
  }

  private async pauseForSave(
    manager: PdfAnnotationUiManager,
    revision: number,
    signal: AbortSignal,
  ): Promise<number> {
    this.requireCurrentSave(manager, revision, signal);
    manager.endCurrentEditing();
    this.requireCurrentSave(manager, revision, signal);
    const currentMode = this.dependencies.viewer.annotationEditorMode;
    if (typeof currentMode !== 'number') {
      throw new DOMException('The PDF annotation editor mode is unavailable.', 'InvalidStateError');
    }
    if (currentMode !== this.dependencies.annotationEditorType.NONE) {
      await this.changeMode(this.dependencies.annotationEditorType.NONE);
    }
    this.requireCurrentSave(manager, revision, signal);
    return currentMode;
  }

  private async captureBytes(
    manager: PdfAnnotationUiManager,
    revision: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const bytes = await this.dependencies.pdf.saveDocument();
    this.requireCurrentSave(manager, revision, signal);
    return ownPdfBytes(bytes);
  }

  private async restoreAfterSave(context: {
    readonly contextualRestore: ContextualSaveRestore | null;
    readonly manager: PdfAnnotationUiManager;
    readonly mode: number | null;
    readonly options?: PdfAnnotationModeOptions | undefined;
    readonly revision: number;
  }): Promise<Error | null> {
    const { contextualRestore, manager, mode, options = {}, revision } = context;
    if (
      mode === null ||
      manager !== this.manager ||
      revision !== this.lifecycleRevision ||
      this.destroyed
    ) {
      return null;
    }
    const restoredSession = this.beginRestoredContextualSession(contextualRestore, manager);
    try {
      await this.changeMode(mode, options);
      return this.completeRestoredContextualSession(restoredSession);
    } catch (cause) {
      if (restoredSession !== null) this.releaseContextualEditSession(restoredSession);
      return asError(cause);
    }
  }

  private beginRestoredContextualSession(
    contextualRestore: ContextualSaveRestore | null,
    manager: PdfAnnotationUiManager,
  ): ContextualEditSession | null {
    if (contextualRestore === null) {
      this.releaseContextualEditSession();
      return null;
    }
    const restoredSession: ContextualEditSession = {
      closing: null,
      guarded: false,
      id: contextualRestore.id,
      manager,
      mode: contextualRestore.mode,
      onEditorsRendered: this.onContextualEditorsRendered,
      phase: 'awaiting-selection',
      suppressedToolbars: new Map(),
      toolbarObserver: null,
    };
    this.contextualEditSession = restoredSession;
    return restoredSession;
  }

  private completeRestoredContextualSession(session: ContextualEditSession | null): Error | null {
    if (session === null) return null;
    if (!this.isRequestedEditorSelected(session)) {
      this.releaseContextualEditSession(session);
      return new DOMException(
        'The PDF annotation target could not be restored after saving.',
        'InvalidStateError',
      );
    }
    this.guardContextualEditSession(session);
    session.phase = 'selected';
    return null;
  }

  private requireCurrentSave(
    manager: PdfAnnotationUiManager,
    revision: number,
    signal: AbortSignal,
  ): void {
    this.throwIfAborted(signal);
    if (manager !== this.manager || revision !== this.lifecycleRevision || this.destroyed) {
      throw this.staleError();
    }
  }

  detachFromDocument(): void {
    if (this.destroyed) return;
    this.cancelAnnotationActivation('The PDF annotation activation was detached.');
    this.cancelContextualSaveRestore();
    this.releaseContextualEditSession();
    const transaction = this.pendingSelectionTransaction;
    void this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was detached.', 'AbortError'),
    ).catch(() => undefined);
    this.managerEventsEnabled = false;
    this.lifecycleRevision += 1;
    if (transaction === null) {
      this.cancelPendingModeChange('The PDF annotation editor was detached from its document.');
    } else this.completePendingModeChange();
    this.cancelQueuedToolIntent('The PDF annotation editor was detached from its document.');
    this.cancelQueuedMutations();
    if (this.manager !== null) this.retiredManagers.add(this.manager);
    this.restoreCallbacks();
    this.manager = null;
  }

  resumeDocumentLifecycle(): void {
    if (!this.destroyed) this.managerEventsEnabled = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelAnnotationActivation('The PDF annotation activation was destroyed.');
    this.cancelContextualSaveRestore();
    const transaction = this.pendingSelectionTransaction;
    void this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was destroyed.', 'AbortError'),
    ).catch(() => undefined);
    this.destroyed = true;
    this.lifecycleRevision += 1;
    this.dependencies.eventBus.off('annotationeditoruimanager', this.onManager);
    this.dependencies.eventBus.off('annotationeditormodechanged', this.onNativeMode);
    this.dependencies.eventBus.off('editingstateschanged', this.onEditingState);
    this.dependencies.eventBus.off('switchannotationeditorparams', this.onNativeParameter);
    if (transaction === null) {
      this.cancelPendingModeChange('The PDF annotation editor was destroyed.');
    } else this.completePendingModeChange();
    this.cancelQueuedToolIntent('The PDF annotation editor was destroyed.');
    this.cancelQueuedMutations();
    this.restoreCallbacks();
    this.manager = null;
    this.dirtyListeners.clear();
    this.editorAddedListeners.clear();
    this.mutationListeners.clear();
    this.modeListeners.clear();
    this.colorListeners.clear();
    this.projectedAnnotations.clear();
    this.annotationResolver = null;
    this.releaseContextualEditSession();
    this.clearPendingAnnotationFocus();
    this.removeBridgeFocusListener();
    this.annotationFocusListeners.clear();
  }

  private readonly onBridgeAnnotationFocus = (focus: PdfAnnotationFocus | null): void => {
    const activation = this.activeActivation;
    this.clearPendingAnnotationFocus();
    if (activation !== null) {
      if (focus === null || !focusIncludesStableId(focus, activation.id)) return;
      this.pendingAnnotationFocus = {
        activation,
        epoch: activation.epoch,
        focus,
        lifecycleRevision: activation.lifecycleRevision,
        timeout: null,
      };
      return;
    }
    if (focus === null && this.deferSelectedContextualFocusLoss()) return;
    if (focus?.editable === false) {
      const pending: PendingAnnotationFocus = {
        activation: null,
        epoch: this.activationEpoch,
        focus,
        lifecycleRevision: this.lifecycleRevision,
        timeout: null,
      };
      pending.timeout = window.setTimeout(() => {
        if (
          this.pendingAnnotationFocus !== pending ||
          this.activeActivation !== null ||
          pending.epoch !== this.activationEpoch ||
          pending.lifecycleRevision !== this.lifecycleRevision ||
          this.destroyed
        )
          return;
        this.pendingAnnotationFocus = null;
        this.emitAnnotationFocus(pending.focus);
      }, 0);
      this.pendingAnnotationFocus = pending;
      return;
    }
    this.emitAnnotationFocus(focus);
  };

  private deferSelectedContextualFocusLoss(): boolean {
    const session = this.contextualEditSession;
    if (session?.phase !== 'selected' || !this.isRequestedEditorSelected(session)) return false;
    const pending: PendingAnnotationFocus = {
      activation: null,
      epoch: this.activationEpoch,
      focus: null,
      lifecycleRevision: this.lifecycleRevision,
      timeout: null,
    };
    pending.timeout = window.setTimeout(() => {
      if (
        this.pendingAnnotationFocus !== pending ||
        pending.epoch !== this.activationEpoch ||
        pending.lifecycleRevision !== this.lifecycleRevision ||
        this.destroyed
      )
        return;
      this.pendingAnnotationFocus = null;
      if (
        this.contextualEditSession === session &&
        session.phase === 'selected' &&
        this.isRequestedEditorSelected(session)
      )
        return;
      this.emitAnnotationFocus(null);
    }, 0);
    this.pendingAnnotationFocus = pending;
    return true;
  }

  private emitAnnotationFocus(focus: PdfAnnotationFocus | null): void {
    for (const listener of this.annotationFocusListeners) listener(focus);
  }

  private releaseActivationFocus(activation: AnnotationActivation, editable: boolean): void {
    const pending = this.pendingAnnotationFocus;
    if (
      pending?.activation !== activation ||
      pending.focus?.editable !== editable ||
      !focusIncludesStableId(pending.focus, activation.id) ||
      !this.isOwnedActivation(activation)
    )
      return;
    this.pendingAnnotationFocus = null;
    this.emitAnnotationFocus(pending.focus);
  }

  private clearPendingAnnotationFocus(activation?: AnnotationActivation): void {
    const pending = this.pendingAnnotationFocus;
    if (pending === null) return;
    if (activation !== undefined && pending.activation !== activation) return;
    if (pending.timeout !== null) window.clearTimeout(pending.timeout);
    this.pendingAnnotationFocus = null;
  }

  private readonly onManager = (event: unknown): void => {
    if (this.destroyed || !this.managerEventsEnabled) return;
    const data = record(event);
    if (data?.['source'] !== this.dependencies.viewer) return;
    const manager = data['uiManager'];
    if (!this.isUiManager(manager)) return;
    if (this.retiredManagers.has(manager)) return;
    this.cancelAnnotationActivation('The PDF annotation activation was rebound.');
    this.cancelContextualSaveRestore();
    const transaction = this.pendingSelectionTransaction;
    void this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was rebound.', 'AbortError'),
    ).catch(() => undefined);
    this.lifecycleRevision += 1;
    if (transaction === null) {
      this.cancelPendingModeChange('The PDF annotation editor was rebound.');
    } else this.completePendingModeChange();
    this.cancelQueuedToolIntent('The PDF annotation editor was rebound.');
    this.cancelQueuedMutations();
    this.releaseContextualEditSession();
    this.restoreCallbacks();
    this.manager = manager;
    this.dependencies.commentBridge.setSidebarUiManager?.(manager);
    this.ownCallbacks();
  };

  private readonly onNativeMode = (event: unknown): void => {
    if (this.destroyed) return;
    const data = record(event);
    if (data?.['source'] !== this.dependencies.viewer || typeof data['mode'] !== 'number') return;
    const mode = data['mode'];
    this.releaseClosingContextualSession(mode);
    if (this.saving) return;
    if (
      this.logicalMode === 'one-shot' &&
      mode === this.dependencies.annotationEditorType.HIGHLIGHT
    ) {
      return;
    }
    if (this.contextualEditSession?.mode === mode) return;
    this.setLogicalMode(this.logicalModeForNative(mode));
  };

  private releaseClosingContextualSession(mode: number): void {
    if (mode !== this.dependencies.annotationEditorType.NONE) return;
    const contextual = this.contextualEditSession;
    if (contextual?.phase !== 'closing') return;
    this.releaseContextualEditSession(contextual);
  }

  private synchronizeLogicalModeAfterSave(): void {
    const mode = this.dependencies.viewer.annotationEditorMode;
    if (typeof mode !== 'number') return;
    const contextual = this.contextualEditSession;
    this.setLogicalMode(contextual?.mode === mode ? 'neutral' : this.logicalModeForNative(mode));
  }

  private readonly onNativeParameter = (event: unknown): void => {
    if (this.destroyed) return;
    const data = record(event);
    const type = data?.['type'];
    const value = data?.['value'];
    if (!this.isColorParameterType(type) || typeof value !== 'string' || value.trim().length === 0)
      return;
    this.emitColor(value);
  };

  private isColorParameterType(type: unknown): boolean {
    const parameters = this.dependencies.annotationEditorParamsType;
    return (
      type === parameters.FREETEXT_COLOR ||
      type === parameters.INK_COLOR ||
      type === parameters.HIGHLIGHT_COLOR
    );
  }

  private emitColor(color: string): void {
    for (const listener of this.colorListeners) listener(color);
  }

  private readonly onEditingState = (event: unknown): void => {
    if (this.destroyed) return;
    const data = record(event);
    if (data?.['source'] !== this.manager) return;
    this.dependencies.commentBridge.refreshAnnotationFocus?.();
    const session = this.contextualEditSession;
    if (session === null) return;
    this.applyContextualEditingState(session, record(data['details'])?.['hasSelectedEditor']);
  };

  private applyContextualEditingState(
    session: ContextualEditSession,
    hasSelectedEditor: unknown,
  ): void {
    if (hasSelectedEditor === true) {
      if (this.isRequestedEditorSelected(session)) session.phase = 'selected';
      return;
    }
    if (hasSelectedEditor !== false || session.phase !== 'selected') return;
    void this.closeContextualEditSession(session).catch((cause: unknown) => {
      console.error('[abyss-documents] Failed to close the PDF annotation editor', { cause });
    });
  }

  private isRequestedEditorSelected(session: ContextualEditSession): boolean {
    const selected = session.manager.firstSelectedEditor;
    return nativeEditorAnnotationId(selected) === session.id && selected?.mode === session.mode;
  }

  private async enterContextualEditSession(
    session: ContextualEditSession,
    tool: PdfAnnotationTool,
    options: PdfAnnotationModeOptions,
  ): Promise<void> {
    if (this.saving) await this.queueToolIntent(tool, options);
    else await this.changeMode(session.mode, options);
    if (!this.isRequestedEditorSelected(session)) {
      this.guardContextualEditSession(session);
      await this.closeContextualEditSession(session);
      return;
    }
    this.guardContextualEditSession(session);
    session.phase = 'selected';
  }

  private async containFailedContextualEntry(
    session: ContextualEditSession,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.contextualEditSession !== session) return;
    this.guardContextualEditSession(session);
    await this.closeContextualEditSession(session, signal === undefined ? {} : { signal }).catch(
      () => undefined,
    );
  }

  private readonly onContextualEditorsRendered = (event: unknown): void => {
    const session = this.contextualEditSession;
    const pageNumber = record(event)?.['pageNumber'];
    if (session === null || !Number.isInteger(pageNumber)) return;
    this.gateContextualLayer(session, (pageNumber as number) - 1);
  };

  private guardContextualEditSession(session: ContextualEditSession): void {
    if (!session.guarded) {
      session.guarded = true;
      session.manager.disableUserSelect(true);
      for (let pageIndex = 0; pageIndex < this.dependencies.pdf.numPages; pageIndex += 1) {
        this.gateContextualLayer(session, pageIndex);
      }
      this.dependencies.eventBus.on('editorsrendered', session.onEditorsRendered);
    }
    this.suppressContextualToolbar(session);
  }

  private gateContextualLayer(session: ContextualEditSession, pageIndex: number): void {
    const layer = session.manager.getLayer(pageIndex);
    layer?.disableClick();
    layer?.disableTextSelection();
    this.suppressContextualToolbar(session);
  }

  private suppressContextualToolbar(session: ContextualEditSession): void {
    if (session.toolbarObserver !== null) return;
    const editor = session.manager.firstSelectedEditor;
    if (nativeEditorAnnotationId(editor) !== session.id) return;
    const anchor = editor?.elementBeforePopup;
    const owner = anchor?.ownerDocument.defaultView;
    if (anchor === undefined || anchor === null || owner === null || owner === undefined) return;
    const root = anchor.closest<HTMLElement>('.annotationEditorLayer') ?? anchor;
    const suppress = (): void => {
      if (this.contextualEditSession !== session || session.phase === 'closing') return;
      const selector = root === anchor ? '.editToolbar' : '.selectedEditor .editToolbar';
      for (const toolbar of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
        if (!session.suppressedToolbars.has(toolbar)) {
          session.suppressedToolbars.set(toolbar, {
            display: toolbar.style.getPropertyValue('display'),
            hidden: toolbar.hidden,
            priority: toolbar.style.getPropertyPriority('display'),
          });
        }
        toolbar.hidden = true;
        toolbar.setCssProps({ display: 'none' });
      }
    };
    suppress();
    session.toolbarObserver = new owner.MutationObserver(suppress);
    session.toolbarObserver.observe(root, {
      attributeFilter: ['class'],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  private closeContextualEditSession(
    session: ContextualEditSession,
    wait: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (session.closing !== null) return session.closing;
    session.phase = 'closing';
    const transition = this.changeMode(this.dependencies.annotationEditorType.NONE, {}, wait).then(
      () => {
        this.releaseContextualEditSession(session);
      },
    );
    const closing = transition.finally(() => {
      if (
        session.closing === closing &&
        (this.contextualEditSession !== session || wait.signal?.aborted !== true)
      )
        session.closing = null;
    });
    session.closing = closing;
    return closing;
  }

  private releaseContextualEditSession(session = this.contextualEditSession): void {
    if (session === null) return;
    session.toolbarObserver?.disconnect();
    session.toolbarObserver = null;
    for (const [toolbar, state] of session.suppressedToolbars) {
      toolbar.hidden = state.hidden;
      if (state.display.length === 0) toolbar.style.removeProperty('display');
      else toolbar.style.setProperty('display', state.display, state.priority);
    }
    session.suppressedToolbars.clear();
    if (session.guarded) {
      this.dependencies.eventBus.off('editorsrendered', session.onEditorsRendered);
      session.manager.disableUserSelect(false);
      session.guarded = false;
    }
    if (this.contextualEditSession === session) this.contextualEditSession = null;
  }

  private setLogicalMode(mode: PdfAnnotationLogicalMode): void {
    if (this.logicalMode === mode) return;
    this.logicalMode = mode;
    for (const listener of [...this.modeListeners]) listener(mode);
  }

  private beginSelectionTransaction(signal: AbortSignal | undefined): PendingSelectionTransaction {
    const controller = new AbortController();
    let timeoutId: number | null = null;
    const onExternalAbort = (): void => {
      if (signal === undefined) return;
      void this.abortSelectionTransaction(abortReason(signal)).catch(() => undefined);
    };
    if (signal !== undefined) signal.addEventListener('abort', onExternalAbort, { once: true });
    const clearTransactionTimeout = (): void => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };
    const transaction: PendingSelectionTransaction = {
      armTimeout: () => {
        clearTransactionTimeout();
        timeoutId = window.setTimeout(() => {
          void this.abortSelectionTransaction(
            new DOMException('The PDF annotation interaction timed out.', 'TimeoutError'),
          ).catch(() => undefined);
        }, SELECTION_TRANSACTION_TIMEOUT_MS);
      },
      controller,
      clearTimeout: clearTransactionTimeout,
      settled: deferred<void>(),
      removeExternalAbort: () => {
        signal?.removeEventListener('abort', onExternalAbort);
      },
      restoration: null,
    };
    this.pendingSelectionTransaction = transaction;
    transaction.armTimeout();
    return transaction;
  }

  private finishSelectionTransaction(transaction: PendingSelectionTransaction): void {
    transaction.removeExternalAbort();
    transaction.clearTimeout();
    if (this.pendingSelectionTransaction === transaction) this.pendingSelectionTransaction = null;
    transaction.settled.resolve(undefined);
  }

  private abortSelectionTransaction(reason: Error): Promise<void> {
    const transaction = this.pendingSelectionTransaction;
    if (transaction === null) return Promise.resolve();
    if (transaction.restoration !== null) return transaction.restoration;
    transaction.controller.abort(reason);
    transaction.clearTimeout();
    transaction.restoration = this.restoreNeutralMode();
    void transaction.restoration.catch(() => undefined);
    return transaction.restoration;
  }

  private async abortAndWaitForTransaction(
    transaction: PendingSelectionTransaction,
    reason: Error,
  ): Promise<void> {
    let failure: Error | null = null;
    try {
      await this.abortSelectionTransaction(reason);
    } catch (cause) {
      failure = asError(cause);
    }
    await transaction.settled.promise;
    if (failure !== null) throw failure;
  }

  private restoreNeutralMode(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timeoutId: number | null = window.setTimeout(() => {
        const failure = new DOMException(
          'Restoring the PDF annotation editor mode timed out.',
          'TimeoutError',
        );
        reject(failure);
        this.cancelPendingModeChange(failure.message);
      }, SELECTION_TRANSACTION_TIMEOUT_MS);
      const settle = (failure?: unknown): void => {
        if (timeoutId === null) return;
        window.clearTimeout(timeoutId);
        timeoutId = null;
        if (failure === undefined) {
          this.setLogicalMode('neutral');
          resolve();
        } else reject(asError(failure));
      };
      this.changeMode(this.dependencies.annotationEditorType.NONE).then(
        () => {
          settle();
        },
        (cause: unknown) => {
          settle(cause);
        },
      );
    });
  }

  private logicalModeForNative(mode: number): PdfAnnotationLogicalMode {
    const types = this.dependencies.annotationEditorType;
    if (mode === types.NONE) return 'neutral';
    if (mode === types.HIGHLIGHT) return 'quick-highlight';
    if (mode === types.INK) return 'ink';
    if (mode === types.FREETEXT) return 'freetext';
    return 'disabled';
  }

  private ownCallbacks(): void {
    const previousEditor = this.storage.onAnnotationEditor;
    const previousSet = this.storage.onSetModified;
    const previousReset = this.storage.onResetModified;
    const ownedEditor = (type: number | null): void => {
      previousEditor?.(type);
      this.emitMutation();
      for (const listener of [...this.editorAddedListeners]) listener(type);
    };
    const ownedSet = (): void => {
      previousSet?.();
      this.emitMutation();
      if (!this.saving) this.emitDirty(true);
    };
    const ownedReset = (): void => {
      previousReset?.();
      this.emitDirty(false);
    };
    this.callbackOwnership = {
      ownedEditor,
      ownedReset,
      ownedSet,
      previousEditor,
      previousReset,
      previousSet,
    };
    this.storage.onAnnotationEditor = ownedEditor;
    this.storage.onSetModified = ownedSet;
    this.storage.onResetModified = ownedReset;
  }

  private restoreCallbacks(): void {
    const ownership = this.callbackOwnership;
    this.callbackOwnership = null;
    if (ownership === null) return;
    if (this.storage.onAnnotationEditor === ownership.ownedEditor) {
      this.storage.onAnnotationEditor = ownership.previousEditor;
    }
    if (this.storage.onSetModified === ownership.ownedSet) {
      this.storage.onSetModified = ownership.previousSet;
    }
    if (this.storage.onResetModified === ownership.ownedReset) {
      this.storage.onResetModified = ownership.previousReset;
    }
  }

  private emitDirty(dirty: boolean): void {
    for (const listener of [...this.dirtyListeners]) listener(dirty);
  }

  private emitMutation(): void {
    for (const listener of [...this.mutationListeners]) listener();
  }

  private onEditorAdded(listener: (type: number | null) => void): () => void {
    this.editorAddedListeners.add(listener);
    return () => {
      this.editorAddedListeners.delete(listener);
    };
  }

  private queueToolIntent(
    tool: PdfAnnotationTool,
    options: PdfAnnotationModeOptions,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queued = this.queuedToolIntent;
      if (queued === null) {
        this.queuedToolIntent = { tool, options: { ...options }, waiters: [{ resolve, reject }] };
        return;
      }
      queued.tool = tool;
      queued.options = { ...options };
      queued.waiters.push({ resolve, reject });
    });
  }

  private settleQueuedToolIntent(queued: QueuedToolIntent | null, failure: Error | null): void {
    if (queued === null) return;
    for (const waiter of queued.waiters) {
      if (failure === null) waiter.resolve();
      else waiter.reject(failure);
    }
  }

  private takeQueuedToolIntent(): QueuedToolIntent | null {
    const queued = this.queuedToolIntent;
    this.queuedToolIntent = null;
    return queued;
  }

  private cancelQueuedToolIntent(message: string): void {
    const queued = this.queuedToolIntent;
    this.queuedToolIntent = null;
    if (queued === null) return;
    const failure = new DOMException(message, 'AbortError');
    for (const waiter of queued.waiters) waiter.reject(failure);
  }

  private runOrQueueMutation(apply: (manager: PdfAnnotationUiManager) => void): Promise<void> {
    const manager = this.requireManager();
    if (!this.saving) {
      apply(manager);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queuedMutations.push({ apply, resolve, reject });
    });
  }

  private releaseSave(manager: PdfAnnotationUiManager, revision: number): void {
    this.saving = false;
    this.applyQueuedMutations(manager, revision);
  }

  private applyQueuedMutations(manager: PdfAnnotationUiManager, revision: number): void {
    const mutations = this.queuedMutations.splice(0);
    if (manager !== this.manager || revision !== this.lifecycleRevision || this.destroyed) {
      const failure = new DOMException(
        'The PDF annotation editor changed during save.',
        'AbortError',
      );
      for (const mutation of mutations) mutation.reject(failure);
      return;
    }
    for (const mutation of mutations) {
      try {
        mutation.apply(manager);
        mutation.resolve();
      } catch (cause) {
        mutation.reject(asError(cause));
      }
    }
  }

  private cancelQueuedMutations(): void {
    const mutations = this.queuedMutations.splice(0);
    const failure = new DOMException('The PDF annotation editor lifecycle changed.', 'AbortError');
    for (const mutation of mutations) mutation.reject(failure);
  }

  private requireManager(): PdfAnnotationUiManager {
    if (this.destroyed) {
      throw new DOMException('The PDF annotation editor was destroyed.', 'InvalidStateError');
    }
    if (this.manager === null) {
      throw new DOMException('The PDF annotation editor is not ready.', 'InvalidStateError');
    }
    return this.manager;
  }

  private isUiManager(value: unknown): value is PdfAnnotationUiManager {
    const data = record(value);
    if (data === null) return false;
    const methods = [
      'commentSelection',
      'delete',
      'disableUserSelect',
      'endCurrentEditing',
      'getEditor',
      'getLayer',
      'highlightSelection',
      'redo',
      'undo',
      'updateParams',
    ] as const;
    return methods.every((method) => typeof data[method] === 'function');
  }

  private modeFor(tool: PdfAnnotationTool): number {
    const types = this.dependencies.annotationEditorType;
    switch (tool) {
      case 'select':
        return types.NONE;
      case 'highlight':
        return types.HIGHLIGHT;
      case 'ink':
        return types.INK;
      case 'freetext':
        return types.FREETEXT;
    }
  }

  private editableKindForMode(mode: number | undefined): PdfEditableAnnotationKind | null {
    const types = this.dependencies.annotationEditorType;
    if (mode === types.HIGHLIGHT) return 'highlight';
    if (mode === types.INK) return 'ink';
    if (mode === types.FREETEXT) return 'freetext';
    return null;
  }

  private parameterFor(parameter: PdfAnnotationParameter): number {
    const types = this.dependencies.annotationEditorParamsType;
    const values: Record<PdfAnnotationParameter, number> = {
      'freetext-size': types.FREETEXT_SIZE,
      'freetext-color': types.FREETEXT_COLOR,
      'freetext-opacity': types.FREETEXT_OPACITY,
      'ink-color': types.INK_COLOR,
      'ink-thickness': types.INK_THICKNESS,
      'ink-opacity': types.INK_OPACITY,
      'highlight-color': types.HIGHLIGHT_COLOR,
      'highlight-thickness': types.HIGHLIGHT_THICKNESS,
      'highlight-free': types.HIGHLIGHT_FREE,
    };
    return values[parameter];
  }

  private cancelPendingModeChange(message: string): void {
    const pending = this.pendingModeChange;
    if (pending === null) return;
    this.pendingModeChange = null;
    this.dependencies.eventBus.off('annotationeditormodechanged', pending.listener);
    pending.clearTimeout();
    pending.removeAbort();
    pending.reject(new DOMException(message, 'AbortError'));
  }

  private completePendingModeChange(): void {
    const pending = this.pendingModeChange;
    if (pending === null) return;
    this.pendingModeChange = null;
    this.dependencies.eventBus.off('annotationeditormodechanged', pending.listener);
    pending.clearTimeout();
    pending.removeAbort();
    pending.resolve();
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException('Saving PDF annotations was cancelled.', 'AbortError');
  }

  private staleError(): DOMException {
    return new DOMException('The PDF annotation editor changed during save.', 'InvalidStateError');
  }
}

function nativeEditorAnnotationId(
  native: PdfNativeEditorReference | undefined,
): string | undefined {
  let persistedId: string | undefined;
  try {
    persistedId = native?.getData?.().id?.trim();
  } catch {
    persistedId = undefined;
  }
  return persistedId === undefined || persistedId.length === 0 ? native?.uid?.trim() : persistedId;
}

function editableKindForAnnotation(
  annotation: DocumentAnnotation,
): PdfEditableAnnotationKind | null {
  if (annotation.type === 'highlight') return 'highlight';
  if (annotation.type === 'ink') return 'ink';
  if (annotation.type === 'free-text') return 'freetext';
  return null;
}

function annotationIsWritable(annotation: DocumentAnnotation): boolean {
  return (
    annotation.capabilities.color.available &&
    annotation.capabilities.comment.available &&
    annotation.capabilities.deletion.available
  );
}

function focusIncludesStableId(focus: PdfAnnotationFocus, id: string): boolean {
  return focus.annotations.some(
    (annotation) => annotation.identity.kind === 'stable' && annotation.identity.id === id,
  );
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function asError(cause: unknown): Error {
  if (typeof cause === 'object' && cause !== null && 'name' in cause && 'message' in cause) {
    return cause as Error;
  }
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isColorParameter(parameter: PdfAnnotationParameter): boolean {
  return (
    parameter === 'freetext-color' || parameter === 'ink-color' || parameter === 'highlight-color'
  );
}

function ownPdfBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return Uint8Array.from(bytes);
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (typeof reason === 'object' && reason !== null && 'name' in reason && 'message' in reason) {
    return reason as Error;
  }
  return new DOMException('The PDF annotation interaction was cancelled.', 'AbortError');
}

function remainingDeadlineMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(asError(cause));
      },
    );
  });
}
