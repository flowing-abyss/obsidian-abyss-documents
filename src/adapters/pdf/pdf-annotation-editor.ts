import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { decodeAnnotationComment } from '../../annotation-tokens.js';
import type { AnnotationGeometry, DocumentAnnotation } from '../../document-core/annotations.js';
import { beginReaderTimedOperation } from '../../reader-performance.js';
import type { AnnotationPaletteEntry } from '../../settings.js';
import type {
  PdfAnnotationFocus,
  PdfAnnotationFocusActivation,
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
  readonly clientPosition?: { readonly x: number; readonly y: number } | undefined;
  readonly kind: 'root-click' | 'root-context' | 'sidebar';
  readonly preserveNativeSelection?: boolean | undefined;
  readonly rowId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
};

export interface PdfProjectedAnnotation {
  readonly aliases?: readonly string[];
  readonly annotation: DocumentAnnotation;
  readonly editorUid?: string;
  readonly stableId: string;
}

interface PdfProjectedTarget {
  readonly annotation: DocumentAnnotation;
  readonly canonicalId: string;
  readonly editorUid?: string;
}

export interface PdfProjectedHitTarget {
  readonly editorUid?: string;
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
  abortInteraction?(message: string): Promise<void>;
  suspendInteractions?(): Promise<void>;
  resumeInteractions?(): void;
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
  requestNativeTextEdit?(stableId: string): Promise<boolean> | null;
  onNativeTextEdit?(listener: () => boolean): () => void;
  selectAnnotation?(stableId: string): boolean;
  clearAnnotationSelection?(): void;
  retainSelection?(token: string): boolean;
  releaseSelection?(token: string): boolean;
  resolveAnnotationAnchor?(stableId: string): DOMRect | null;
  resolveSelectionAnchor?(token: string): DOMRect | null;
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
  readonly mustEnterInEditMode?: boolean | undefined;
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
  readonly hasSelection: boolean;
  getEditor(id: string): PdfNativeEditorReference | undefined;
  getLayer(pageIndex: number):
    | {
        disableClick(): void;
        disableTextSelection(): void;
        updateMode?(mode: number): void;
      }
    | undefined;
  highlightSelection(methodOfCreation?: string): void;
  redo(): void;
  setSelected?(editor: PdfNativeEditorReference): void;
  unselectAll(): void;
  undo(): void;
  updateParams(type: number, value: unknown): void;
}

interface PdfNativeEditorReference {
  enterInEditMode?(): void;
  readonly color?: string | undefined;
  readonly elementBeforePopup?: Element | null | undefined;
  getData?(): { readonly id?: string | undefined };
  getNonHCMColor?(): ArrayLike<number> | null;
  readonly mode?: number | undefined;
  readonly uid?: string | undefined;
}

interface MutableAnnotationStorage {
  [Symbol.iterator]?(): IterableIterator<[string, unknown]>;
  onAnnotationEditor: ((type: number | null) => void) | null;
  onResetModified: (() => void) | null;
  onSetModified: (() => void) | null;
  resetModified(): void;
}

interface PdfAnnotationEditorDependencies {
  readonly annotationRoot: HTMLElement;
  readonly annotationEditorParamsType: AnnotationEditorParameterConstants;
  readonly annotationEditorType: AnnotationEditorTypeConstants;
  readonly eventBus: PdfAnnotationEventBus;
  readonly onAnnotationSelectionClear?: () => void;
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
    Partial<
      Pick<
        PdfCommentBridge,
        | 'nativeEditorUidForAnnotation'
        | 'refreshAnnotationFocus'
        | 'resolveAnnotationAnchor'
        | 'selectAnnotation'
        | 'setSidebarUiManager'
        | 'synchronizeAnnotationSelection'
      >
    >;
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

interface ActivationMaterialization {
  readonly activation: AnnotationActivation;
  readonly baselineEditors: ReadonlySet<object>;
  editorConsumed: boolean;
  readonly mode: number;
  resetInProgress: boolean;
  setConsumed: boolean;
}

interface PendingAnnotationFocus {
  readonly activation: AnnotationActivation | null;
  readonly epoch: number;
  readonly focus: PdfAnnotationFocus | null;
  readonly lifecycleRevision: number;
  timeout: number | null;
}

interface SelectionHighlightReservation {
  readonly candidateNativeIds: () => ReadonlySet<string>;
  readonly created: Promise<DocumentAnnotation>;
  readonly current: () => DocumentAnnotation | null;
  readonly deleteOwnedNativeEditor: () => boolean;
  readonly inspect: () => DocumentAnnotation | null;
  readonly observed: () => boolean;
  readonly ownedNativeIds: () => ReadonlySet<string>;
  readonly recaptureObservedEditor: () => boolean;
  readonly refresh: () => void;
  readonly stop: () => void;
  readonly unsubscribe: () => void;
}

interface QueuedToolIntent {
  readonly manager: PdfAnnotationUiManager;
  options: PdfAnnotationModeOptions;
  readonly revision: number;
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
  readonly uid: string | null;
}

interface ContextualEditSession {
  closing: Promise<void> | null;
  guarded: boolean;
  id: string;
  readonly manager: PdfAnnotationUiManager;
  readonly mode: number;
  readonly onEditorsRendered: (event: unknown) => void;
  phase: 'awaiting-selection' | 'selected' | 'closing';
  readonly restoreUid: string | null;
  readonly suppressedToolbars: Map<HTMLElement, SuppressedNativeToolbar>;
  toolbarObserver: MutationObserver | null;
}

interface ContextualActivationFailureOwner {
  readonly activation: AnnotationActivation;
  cause: Error | null;
  containmentAttempted: boolean;
  readonly controller: AbortController;
  interrupt: ((cause: Error) => void) | null;
  readonly removeActivationAbort: () => void;
  readonly session: ContextualEditSession;
}

interface SuppressedNativeToolbar {
  readonly display: string;
  readonly hidden: HTMLElement['hidden'];
  readonly priority: string;
}

interface AnnotationActivation {
  readonly clientPosition?: { readonly x: number; readonly y: number } | undefined;
  readonly clearDeadline: () => void;
  contextualFailureOwner: ContextualActivationFailureOwner | null;
  readonly controller: AbortController;
  readonly deadline: number;
  readonly epoch: number;
  readonly focusActivation?: PdfAnnotationFocusActivation | undefined;
  readonly id: string;
  readonly lifecycleRevision: number;
  readonly manager: PdfAnnotationUiManager;
  readonly promise: Promise<PdfAnnotationActivationResult>;
  projected: DocumentAnnotation | null;
  readonly removeExternalAbort: () => void;
  timedOut: boolean;
}

interface DeferredAnnotationActivation {
  readonly clientPosition: { readonly x: number; readonly y: number } | undefined;
  readonly externalSignal: AbortSignal | undefined;
  readonly focusActivation: PdfAnnotationFocusActivation | undefined;
  readonly id: string;
  readonly run: (activation: AnnotationActivation) => Promise<PdfAnnotationActivationResult>;
}

type AnnotationActivationSettlement =
  | {
      readonly kind: 'resolved';
      readonly value: PdfAnnotationActivationResult;
    }
  | {
      readonly cause: Error;
      readonly kind: 'rejected';
    };

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

function optionalBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  return typeof value === 'boolean' ? value : undefined;
}

interface NativeAnnotationModeScope {
  readonly annotationRoot: HTMLElement;
}

function nativeAnnotationContainerInScope(
  container: unknown,
  layerDiv: unknown,
  annotationRoot: HTMLElement,
): boolean {
  const OwnerHTMLElement = annotationRoot.ownerDocument.defaultView?.HTMLElement;
  if (
    OwnerHTMLElement === undefined ||
    !(container instanceof OwnerHTMLElement) ||
    !(layerDiv instanceof OwnerHTMLElement)
  )
    return false;
  return (
    container.isConnected &&
    layerDiv.isConnected &&
    layerDiv.classList.contains('annotationLayer') &&
    annotationRoot.contains(layerDiv) &&
    layerDiv.contains(container) &&
    container.closest('.annotationLayer') === layerDiv
  );
}

function nativeAnnotationModeSourceMatches(
  sourceValue: unknown,
  editId: string,
  mode: number,
  scope: NativeAnnotationModeScope,
): boolean {
  const source = record(sourceValue);
  if (source === null) return false;
  const data = record(source['data']);
  return (
    source['annotationEditorType'] === mode &&
    data?.['id'] === editId &&
    nativeAnnotationContainerInScope(source['container'], source['layer'], scope.annotationRoot)
  );
}

function nativeAnnotationModeRequest(
  event: unknown,
  types: AnnotationEditorTypeConstants,
  annotationRoot: HTMLElement,
): PdfAnnotationModeRequest | null {
  const data = record(event);
  if (data === null) return null;
  const mode = data['mode'];
  const editId = data['editId'];
  if (
    typeof mode !== 'number' ||
    typeof editId !== 'string' ||
    editId.trim().length === 0 ||
    data['mustEnterInEditMode'] !== true ||
    (mode !== types.FREETEXT && mode !== types.HIGHLIGHT && mode !== types.INK) ||
    !nativeAnnotationModeSourceMatches(data['source'], editId, mode, {
      annotationRoot,
    })
  )
    return null;
  return {
    editComment: optionalBoolean(data, 'editComment'),
    editId,
    isFromKeyboard: optionalBoolean(data, 'isFromKeyboard'),
    mode,
    mustEnterInEditMode: true,
  };
}

export class PdfAnnotationEditor {
  private readonly nativeTextEditListeners = new Set<() => boolean>();
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
  private toolIntentRevision = 0;
  private queuedToolIntent: QueuedToolIntent | null = null;
  private readonly queuedMutations: QueuedMutation[] = [];
  private saveBarrier: ReturnType<typeof deferred<void>> | null = null;
  private readonly retiredManagers = new WeakSet<object>();
  private destroyed = false;
  private interactionsSuspended = false;
  private lifecycleRevision = 0;
  private saving = false;
  private logicalMode: PdfAnnotationLogicalMode = 'neutral';
  private contextualEditSession: ContextualEditSession | null = null;
  private pendingContextualClose: Promise<void> | null = null;
  private contextualActivationFailureOwner: ContextualActivationFailureOwner | null = null;
  private readonly reportedContextualEditingStateFailures = new WeakSet<ContextualEditSession>();
  private pendingContextualSaveRestore: ContextualSaveRestore | null = null;
  private activationEpoch = 0;
  private activationMaterialization: ActivationMaterialization | null = null;
  private activeActivation: AnnotationActivation | null = null;
  private annotationResolver: PdfAnnotationResolver | null = null;
  private readonly projectedTargets = new Map<string, PdfProjectedTarget>();
  private projectedHitGrid: PdfProjectedHitGrid = new Map();
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
    dependencies.eventBus.on('switchannotationeditormode', this.onNativeModeRequest);
    dependencies.eventBus.on('switchannotationeditorparams', this.onNativeParameter);
  }

  async setTool(tool: PdfAnnotationTool, options: PdfAnnotationToolOptions = {}): Promise<void> {
    const intentRevision = ++this.toolIntentRevision;
    await this.applyToolIntent(tool, options, intentRevision);
  }

  private async applyToolIntent(
    tool: PdfAnnotationTool,
    options: PdfAnnotationToolOptions,
    intentRevision: number,
  ): Promise<void> {
    if (this.interactionsSuspended) return;
    const pendingSelection = this.pendingSelectionTransaction;
    if (pendingSelection !== null) {
      await this.abortAndWaitForTransaction(
        pendingSelection,
        new DOMException('The PDF annotation selection was superseded by a tool.', 'AbortError'),
      );
      if (intentRevision !== this.toolIntentRevision) {
        throw new DOMException('The PDF annotation tool request was superseded.', 'AbortError');
      }
      if (this.toolIntentInterrupted()) return;
    }
    this.cancelAnnotationActivation('The PDF annotation activation was superseded by a tool.');
    this.cancelContextualSaveRestore();
    this.requireManager();
    const contextual = this.contextualEditSession;
    if (contextual !== null) await this.closeContextualEditSession(contextual);
    const modeOptions: PdfAnnotationModeOptions =
      options.isFromKeyboard === undefined ? {} : { isFromKeyboard: options.isFromKeyboard };
    if (this.saving)
      return this.queueToolIntent(tool, modeOptions, this.requireManager(), this.lifecycleRevision);
    const mode = this.modeFor(tool);
    await this.changeMode(mode, modeOptions);
  }

  private toolIntentInterrupted(): boolean {
    return this.destroyed || this.interactionsSuspended;
  }

  async editAnnotation(request: {
    readonly id: string;
    readonly kind: PdfEditableAnnotationKind;
    readonly editComment: boolean;
  }): Promise<void> {
    if (this.interactionsSuspended) return;
    const saveBarrier = this.waitForSaveRelease();
    if (saveBarrier !== null) {
      await saveBarrier;
      return this.editAnnotation(request);
    }
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
      restoreUid: null,
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

  releaseSelection(token: string): boolean {
    return this.dependencies.selectionObserver.release?.(token) ?? false;
  }

  retainSelection(token: string): boolean {
    return this.dependencies.selectionObserver.retain?.(token) ?? false;
  }

  onAnnotationFocus(listener: (focus: PdfAnnotationFocus | null) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.annotationFocusListeners.add(listener);
    return () => {
      this.annotationFocusListeners.delete(listener);
    };
  }

  setAnnotationProjection(annotations: readonly PdfProjectedAnnotation[]): void {
    this.projectedTargets.clear();
    for (const [identity, target] of pdfProjectedTargetIndex(annotations))
      this.projectedTargets.set(identity, target);
    this.projectedHitGrid = pdfProjectedHitGrid(annotations);
  }

  hitTestProjectedAnnotation(
    pageIndex: number,
    point: { readonly x: number; readonly y: number },
  ): PdfProjectedHitTarget | null {
    return this.hitTestProjectedAnnotations(pageIndex, point)[0] ?? null;
  }

  hitTestProjectedAnnotations(
    pageIndex: number,
    point: { readonly x: number; readonly y: number },
  ): readonly PdfProjectedHitTarget[] {
    const cell = this.projectedHitGrid.get(pageIndex)?.get(pdfProjectedHitCellKey(point));
    if (cell === undefined) return [];
    const hits: PdfProjectedHitTarget[] = [];
    const seen = new Set<string>();
    for (let index = cell.length - 1; index >= 0; index -= 1) {
      const region = cell[index];
      if (region === undefined || !pdfProjectedHitRegionContains(region, point)) continue;
      const key = `${region.target.stableId}\u0000${region.target.editorUid ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(region.target);
    }
    return hits;
  }

  setAnnotationResolver(resolver: PdfAnnotationResolver | null): void {
    this.annotationResolver = resolver;
  }

  focusAnnotation(
    stableId: string,
    source: PdfAnnotationActivationSource,
  ): Promise<PdfAnnotationActivationResult> {
    const requestedId = stableId.trim();
    if (
      requestedId.length === 0 ||
      source.signal?.aborted === true ||
      this.destroyed ||
      this.interactionsSuspended
    )
      return Promise.resolve('cancelled');
    const id = this.projectedTargets.get(requestedId)?.canonicalId ?? requestedId;
    const contextualClose = this.pendingContextualClose;
    return this.startAnnotationActivation({
      clientPosition: source.clientPosition,
      externalSignal: source.signal,
      focusActivation: sidebarFocusActivation(source),
      id,
      run: async (activation) => {
        if (contextualClose !== null) {
          await waitWithSignal(contextualClose, activation.controller.signal);
          try {
            await waitWithSignal(nextTask(), activation.controller.signal);
          } finally {
            if (this.pendingContextualClose === contextualClose) this.pendingContextualClose = null;
          }
          if (!this.isCurrentActivation(activation)) return 'cancelled';
        }
        const projected = await this.resolveProjectedAnnotation(id, activation);
        if (!this.isCurrentActivation(activation) || projected === null) return 'cancelled';
        return this.focusResolvedAnnotation(id, source, projected, activation);
      },
    });
  }

  requestNativeTextEdit(stableId: string): Promise<boolean> | null {
    const requestedId = stableId.trim();
    const target = this.projectedTargets.get(requestedId);
    const id = target?.canonicalId ?? requestedId;
    const activation = this.activeActivation;
    if (activation === null) return this.requestSettledNativeTextEdit(id);
    const annotation = target?.annotation ?? activation.projected;
    if (!this.nativeTextActivationMatches(activation, id, annotation)) return null;
    // The second click can land on the bare page while PDF.js materializes the
    // first click's editor. Keep that intent within the existing activation.
    return activation.promise.then(
      (result) => {
        if (
          result !== 'editable' ||
          !this.isActivationEpochCurrent(activation) ||
          this.activationUnavailable(activation.controller.signal)
        )
          return false;
        const session = this.contextualEditSession;
        return session?.id === activation.id && this.enterNativeTextEditSession(session);
      },
      () => false, // The original focus request owns activation failure reporting.
    );
  }

  private requestSettledNativeTextEdit(id: string): Promise<boolean> | null {
    const session = this.contextualEditSession;
    if (
      session?.id !== id ||
      session.mode !== this.dependencies.annotationEditorType.FREETEXT ||
      session.phase !== 'selected'
    )
      return null;
    const epoch = this.activationEpoch;
    const revision = this.lifecycleRevision;
    const manager = this.manager;
    return Promise.resolve().then(() => {
      if (!this.nativeTextRequestCurrent(epoch, revision, manager)) return false;
      return this.enterNativeTextEditSession(session);
    });
  }

  private nativeTextRequestCurrent(
    epoch: number,
    revision: number,
    manager: PdfAnnotationUiManager | null,
  ): boolean {
    return (
      epoch === this.activationEpoch &&
      revision === this.lifecycleRevision &&
      manager === this.manager &&
      !this.activationUnavailable(undefined) &&
      !this.saving &&
      this.managerEventsEnabled
    );
  }

  private nativeTextActivationMatches(
    activation: AnnotationActivation,
    id: string,
    annotation: DocumentAnnotation | null,
  ): boolean {
    return (
      annotation?.type === 'free-text' &&
      annotationIsWritable(annotation) &&
      activation.id === id &&
      this.isCurrentActivation(activation)
    );
  }

  private nativeTextSessionAvailable(session: ContextualEditSession): boolean {
    return (
      this.contextualEditSession === session &&
      session.manager === this.manager &&
      session.phase === 'selected' &&
      session.closing === null &&
      this.dependencies.viewer.annotationEditorMode ===
        this.dependencies.annotationEditorType.FREETEXT &&
      this.isRequestedEditorSelected(session)
    );
  }

  private enterNativeTextEditSession(session: ContextualEditSession): boolean {
    if (
      this.activationUnavailable(undefined) ||
      this.saving ||
      !this.managerEventsEnabled ||
      !this.nativeTextSessionAvailable(session)
    )
      return false;
    const native = session.manager.firstSelectedEditor;
    if (native?.enterInEditMode === undefined) return false;
    const epoch = this.activationEpoch;
    const revision = this.lifecycleRevision;
    if (![...this.nativeTextEditListeners].every((listener) => listener())) return false;
    if (!this.nativeTextHandoffCurrent(session, native, epoch, revision)) return false;
    this.clearPendingAnnotationFocus();
    this.cancelContextualSaveRestore();
    this.releaseContextualEditSession(session);
    this.restoreNativeTextLayers(session.manager);
    this.setLogicalMode('freetext');
    native.enterInEditMode();
    return true;
  }

  private nativeTextHandoffCurrent(
    session: ContextualEditSession,
    native: PdfNativeEditorReference,
    epoch: number,
    revision: number,
  ): boolean {
    return (
      this.nativeTextRequestCurrent(epoch, revision, session.manager) &&
      this.nativeTextSessionAvailable(session) &&
      session.manager.firstSelectedEditor === native
    );
  }

  private restoreNativeTextLayers(manager: PdfAnnotationUiManager): void {
    // Restore the mode's click and passive-layer handling disabled by contextual guards.
    for (let index = 0; index < this.dependencies.pdf.numPages; index += 1)
      manager.getLayer(index)?.updateMode?.(this.dependencies.annotationEditorType.FREETEXT);
  }

  selectAnnotation(stableId: string): boolean {
    if (this.destroyed || this.interactionsSuspended) return false;
    const requestedId = stableId.trim();
    if (requestedId.length === 0) return false;
    const target = this.projectedTargets.get(requestedId);
    const id = target?.canonicalId ?? requestedId;
    this.cancelAnnotationActivation('The PDF annotation activation was superseded by selection.');
    return (
      this.dependencies.commentBridge.synchronizeAnnotationSelection?.(
        id,
        target?.editorUid ?? this.editorUidOptions(id).editorUid,
      ) ?? false
    );
  }

  clearAnnotationSelection(): void {
    if (this.destroyed) return;
    this.cancelAnnotationActivation('The PDF annotation activation was cleared.');
    this.dependencies.onAnnotationSelectionClear?.();
  }

  resolveAnnotationAnchor(stableId: string): DOMRect | null {
    const requestedId = stableId.trim();
    if (this.destroyed || requestedId.length === 0) return null;
    const target = this.projectedTargets.get(requestedId);
    const id = target?.canonicalId ?? requestedId;
    return (
      this.dependencies.commentBridge.resolveAnnotationAnchor?.(
        id,
        target?.editorUid ?? this.editorUidOptions(id).editorUid,
      ) ?? null
    );
  }

  resolveSelectionAnchor(token: string): DOMRect | null {
    return this.dependencies.selectionObserver.resolveAnchor?.(token) ?? null;
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
        ...focusActivationOptions(activation.focusActivation),
        ...clientPositionOptions(activation.clientPosition),
        ...this.editorUidOptions(id),
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
        ...focusActivationOptions(activation.focusActivation),
        ...clientPositionOptions(activation.clientPosition),
        editableOnly: true,
        includeSelectedPeers: true,
        ...this.editorUidOptions(id),
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
    if (id.length === 0 || this.destroyed || this.interactionsSuspended)
      return Promise.resolve('cancelled');
    return this.startAnnotationActivation({
      clientPosition: undefined,
      externalSignal: undefined,
      focusActivation: undefined,
      id,
      run: (activation) => this.activateWithinEpoch({ ...request, id }, undefined, activation),
    });
  }

  private startAnnotationActivation(
    request: DeferredAnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    const { clientPosition, externalSignal, focusActivation, id, run } = request;
    if (this.activationUnavailable(externalSignal)) return Promise.resolve('cancelled');
    const saveBarrier = this.waitForSaveRelease(externalSignal);
    if (saveBarrier !== null)
      return this.resumeActivationAfterSave(saveBarrier, {
        clientPosition,
        externalSignal,
        focusActivation,
        id,
        run,
      });
    const current = this.activeActivation;
    const reusable = reusableActivation(current, id, focusActivation);
    if (reusable !== null) return reusable.promise;
    this.cancelAnnotationActivation('The PDF annotation activation was superseded.');
    const manager = this.availableActivationManager(externalSignal);
    if (manager === null) return Promise.resolve('cancelled');
    const controller = new AbortController();
    const onExternalAbort = (): void => {
      if (externalSignal !== undefined) controller.abort(abortReason(externalSignal));
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const settled = deferred<PdfAnnotationActivationResult>();
    let deadlineTimer: number | null = null;
    const activation: AnnotationActivation = {
      clientPosition,
      clearDeadline: () => {
        const timer = deadlineTimer;
        deadlineTimer = null;
        if (timer !== null) window.clearTimeout(timer);
      },
      contextualFailureOwner: null,
      controller,
      deadline: Date.now() + ANNOTATION_ACTIVATION_TIMEOUT_MS,
      epoch: ++this.activationEpoch,
      focusActivation,
      id,
      lifecycleRevision: this.lifecycleRevision,
      manager,
      promise: settled.promise,
      projected: this.projectedTargets.get(id)?.annotation ?? null,
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
    this.runAnnotationActivation(activation, run, settled);
    return activation.promise;
  }

  private resumeActivationAfterSave(
    saveBarrier: Promise<void>,
    request: DeferredAnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    const { clientPosition, externalSignal, focusActivation, id, run } = request;
    return saveBarrier.then(
      () =>
        this.startAnnotationActivation({
          clientPosition,
          externalSignal,
          focusActivation,
          id,
          run,
        }),
      (cause: unknown) => {
        if (externalSignal?.aborted === true || isAbortFailure(cause)) return 'cancelled';
        throw cause;
      },
    );
  }

  private activationUnavailable(signal: AbortSignal | undefined): boolean {
    return this.destroyed || this.interactionsSuspended || signal?.aborted === true;
  }

  private availableActivationManager(
    signal: AbortSignal | undefined,
  ): PdfAnnotationUiManager | null {
    return this.activationUnavailable(signal) ? null : this.manager;
  }

  private runAnnotationActivation(
    activation: AnnotationActivation,
    run: (activation: AnnotationActivation) => Promise<PdfAnnotationActivationResult>,
    settled: ReturnType<typeof deferred<PdfAnnotationActivationResult>>,
  ): void {
    void this.finalizeAnnotationActivation(activation, run, settled).catch(() => undefined);
  }

  private async finalizeAnnotationActivation(
    activation: AnnotationActivation,
    run: (activation: AnnotationActivation) => Promise<PdfAnnotationActivationResult>,
    settled: ReturnType<typeof deferred<PdfAnnotationActivationResult>>,
  ): Promise<void> {
    let settlement: AnnotationActivationSettlement;
    try {
      const result = await this.runAnnotationActivationWithinOwnership(activation, run);
      const contextualRejection = this.rejectRecordedContextualFailure(activation);
      if (contextualRejection !== null) await contextualRejection;
      const finalResult =
        result === 'cancelled' && activation.timedOut
          ? await this.focusTimedOutProjection(activation)
          : result;
      const rejectionAfterFallback = this.rejectRecordedContextualFailure(activation);
      if (rejectionAfterFallback !== null) await rejectionAfterFallback;
      settlement = {
        kind: 'resolved',
        value: this.isOwnedActivation(activation) ? finalResult : 'cancelled',
      };
    } catch (cause) {
      settlement = {
        cause: this.contextualActivationFailureCause(activation) ?? asError(cause),
        kind: 'rejected',
      };
    }

    this.publishAnnotationActivationSettlement(activation, settlement, settled);
  }

  private async runAnnotationActivationWithinOwnership(
    activation: AnnotationActivation,
    run: (activation: AnnotationActivation) => Promise<PdfAnnotationActivationResult>,
  ): Promise<PdfAnnotationActivationResult> {
    try {
      return await run(activation);
    } catch (cause) {
      const contextualRejection = this.rejectRecordedContextualFailure(activation);
      if (contextualRejection !== null) await contextualRejection;
      if (
        !this.isOwnedActivation(activation) ||
        activation.controller.signal.aborted ||
        isAbortFailure(cause)
      )
        return 'cancelled';
      throw cause;
    }
  }

  private publishAnnotationActivationSettlement(
    activation: AnnotationActivation,
    settlement: AnnotationActivationSettlement,
    settled: ReturnType<typeof deferred<PdfAnnotationActivationResult>>,
  ): void {
    const cleanupFailure = this.cleanupAnnotationActivation(activation);
    const establishedUi = settlement.kind === 'resolved' && settlement.value !== 'cancelled';
    try {
      if (cleanupFailure !== null && (settlement.kind === 'rejected' || establishedUi))
        this.reportAnnotationActivationCleanupFailure(activation.id, cleanupFailure);
    } finally {
      const publishedSettlement: AnnotationActivationSettlement =
        cleanupFailure !== null && settlement.kind === 'resolved' && !establishedUi
          ? { cause: cleanupFailure, kind: 'rejected' }
          : settlement;
      if (publishedSettlement.kind === 'resolved') settled.resolve(publishedSettlement.value);
      else settled.reject(publishedSettlement.cause);
    }
  }

  private cleanupAnnotationActivation(activation: AnnotationActivation): Error | null {
    const failures: Error[] = [];
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (cause) {
        failures.push(asError(cause));
      }
    };
    attempt(activation.clearDeadline);
    attempt(activation.removeExternalAbort);
    attempt(() => {
      this.clearPendingAnnotationFocus(activation);
    });
    attempt(() => {
      this.clearContextualActivationFailureOwner(activation);
    });
    attempt(() => {
      if (this.activeActivation === activation) this.activeActivation = null;
    });
    if (failures.length === 0) return null;
    if (failures.length === 1) return failures[0] ?? null;
    return new AggregateError(failures, 'Failed to clean up the PDF annotation activation.');
  }

  private reportAnnotationActivationCleanupFailure(
    annotationId: string,
    cleanupFailure: Error,
  ): void {
    console.warn('[abyss-documents] Failed to clean up the PDF annotation activation', {
      annotationId,
      cause: cleanupFailure,
    });
  }

  private async resolveProjectedAnnotation(
    id: string,
    activation: AnnotationActivation,
  ): Promise<DocumentAnnotation | null> {
    const projected = this.projectedTargets.get(id)?.annotation ?? null;
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
        {
          ...focusActivationOptions(activation.focusActivation),
          ...clientPositionOptions(activation.clientPosition),
          ...this.editorUidOptions(activation.id),
          forceReadonly: true,
        },
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
    } catch (cause) {
      return this.handleContextualActivationFailure(cause, session, projected, activation);
    }
  }

  private async handleContextualActivationFailure(
    cause: unknown,
    session: ContextualEditSession | null,
    projected: DocumentAnnotation | undefined,
    activation: AnnotationActivation,
  ): Promise<PdfAnnotationActivationResult> {
    if (session === null) {
      if (!this.isCurrentActivation(activation) || isAbortFailure(cause)) return 'cancelled';
      throw cause;
    }
    const contextualFailure = this.contextualActivationFailureCause(activation);
    if (contextualFailure !== null)
      return this.rejectAfterContextualContainment(contextualFailure, session, activation);
    if (!this.isCurrentActivation(activation) || isAbortFailure(cause))
      return this.failContextualActivation(session, projected, activation);
    this.recordContextualActivationFailure(session, cause);
    return this.rejectAfterContextualContainment(cause, session, activation);
  }

  private async rejectAfterContextualContainment(
    cause: unknown,
    session: ContextualEditSession,
    activation: AnnotationActivation,
  ): Promise<never> {
    const contextualFailure = this.contextualActivationFailureCause(activation);
    const primaryCause = contextualFailure ?? asError(cause);
    if (!this.claimContextualFailureContainment(activation, contextualFailure)) throw primaryCause;
    const containmentSignal = contextualFailure === null ? activation.controller.signal : undefined;
    try {
      await this.containFailedContextualEntry(session, containmentSignal);
    } catch (containmentCause) {
      await this.handleContextualContainmentFailure({
        activation,
        containmentCause,
        containmentSignal,
        contextualFailure,
        primaryCause,
        session,
      });
    }
    throw primaryCause;
  }

  private claimContextualFailureContainment(
    activation: AnnotationActivation,
    contextualFailure: Error | null,
  ): boolean {
    if (contextualFailure === null) return true;
    const owner = activation.contextualFailureOwner;
    if (owner === null || owner.containmentAttempted) return false;
    owner.containmentAttempted = true;
    return true;
  }

  private async handleContextualContainmentFailure(context: {
    readonly activation: AnnotationActivation;
    readonly containmentCause: unknown;
    readonly containmentSignal: AbortSignal | undefined;
    readonly contextualFailure: Error | null;
    readonly primaryCause: Error;
    readonly session: ContextualEditSession;
  }): Promise<void> {
    const finalCause = await this.retryContextualContainment(context);
    this.reportSecondaryContextualContainmentFailure(finalCause, context);
  }

  private async retryContextualContainment(context: {
    readonly containmentCause: unknown;
    readonly containmentSignal: AbortSignal | undefined;
    readonly session: ContextualEditSession;
  }): Promise<unknown> {
    if (!this.canRetryContextualContainment(context.session)) return context.containmentCause;
    try {
      await this.closeContextualEditSession(
        context.session,
        context.containmentSignal === undefined ? {} : { signal: context.containmentSignal },
      );
      return context.containmentCause;
    } catch (closingCause) {
      return closingCause;
    }
  }

  private canRetryContextualContainment(session: ContextualEditSession): boolean {
    return (
      session.phase !== 'closing' &&
      session.closing === null &&
      this.contextualEditSession === session
    );
  }

  private reportSecondaryContextualContainmentFailure(
    cause: unknown,
    context: {
      readonly activation: AnnotationActivation;
      readonly contextualFailure: Error | null;
      readonly primaryCause: Error;
    },
  ): void {
    if (
      cause === context.primaryCause ||
      isAbortFailure(cause) ||
      !this.ownsContextualContainment(context.activation, context.contextualFailure)
    )
      return;
    console.warn(
      '[abyss-documents] Failed to contain the PDF annotation editor after activation failure',
      { cause: asError(cause) },
    );
  }

  private ownsContextualContainment(
    activation: AnnotationActivation,
    contextualFailure: Error | null,
  ): boolean {
    return contextualFailure === null
      ? this.isCurrentActivation(activation)
      : this.isOwnedActivation(activation);
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
    const editorUid = this.nativeEditorUid(request.id);
    const session: ContextualEditSession = {
      closing: null,
      guarded: false,
      id: request.id,
      manager: activation.manager,
      mode: this.modeFor(request.kind),
      onEditorsRendered: this.onContextualEditorsRendered,
      phase: 'awaiting-selection',
      restoreUid: editorUid,
      suppressedToolbars: new Map(),
      toolbarObserver: null,
    };
    const controller = new AbortController();
    const onActivationAbort = (): void => {
      controller.abort(abortReason(activation.controller.signal));
    };
    if (activation.controller.signal.aborted) onActivationAbort();
    else activation.controller.signal.addEventListener('abort', onActivationAbort, { once: true });
    const failureOwner: ContextualActivationFailureOwner = {
      activation,
      cause: null,
      containmentAttempted: false,
      controller,
      interrupt: null,
      removeActivationAbort: () => {
        activation.controller.signal.removeEventListener('abort', onActivationAbort);
      },
      session,
    };
    activation.contextualFailureOwner = failureOwner;
    this.contextualActivationFailureOwner = failureOwner;
    this.contextualEditSession = session;
    return session;
  }

  private async selectContextualEditor(
    request: { readonly editComment: boolean; readonly id: string },
    session: ContextualEditSession,
    activation: AnnotationActivation,
  ): Promise<boolean> {
    const signal = this.contextualActivationSignal(session, activation);
    const editId = this.nativeEditorUid(request.id);
    await this.changeMode(session.mode, { editComment: request.editComment, editId }, { signal });
    if (!this.isActiveContextualSession(session, activation)) return false;
    if (!(await this.waitForRequestedEditor(session, activation))) return false;
    if (!this.isCurrentActivation(activation)) return false;
    await waitWithSignal(nextTask(), signal);
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
    const signal = this.contextualActivationSignal(session, activation);
    const editorUid = this.nativeEditorUid(id);
    const focused = await waitWithSignal(
      this.dependencies.commentBridge.focusAnnotation(id, signal, projected, {
        ...focusActivationOptions(activation.focusActivation),
        ...clientPositionOptions(activation.clientPosition),
        editableOnly: true,
        ...(editorUid === id ? {} : { editorUid }),
        preserveSelection: true,
      }),
      signal,
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
    } catch (cause) {
      if (!this.isCurrentActivation(activation) || isAbortFailure(cause)) return 'cancelled';
      throw cause;
    }
    if (!this.isCurrentActivation(activation)) return 'cancelled';
    const focused = await waitWithSignal(
      this.dependencies.commentBridge.focusAnnotation(
        activation.id,
        activation.controller.signal,
        projected,
        {
          ...focusActivationOptions(activation.focusActivation),
          ...clientPositionOptions(activation.clientPosition),
          ...this.editorUidOptions(activation.id),
          forceReadonly: true,
        },
      ),
      activation.controller.signal,
    );
    if (!this.isCurrentActivation(activation) || !focused) return 'cancelled';
    this.releaseActivationFocus(activation, false);
    return 'readonly';
  }

  private waitForRequestedEditor(
    session: ContextualEditSession,
    activation: AnnotationActivation,
  ): Promise<boolean> {
    const owner = activation.contextualFailureOwner;
    const signal = this.contextualActivationSignal(session, activation);
    try {
      if (this.trySelectRequestedEditor(session)) return Promise.resolve(true);
    } catch (cause) {
      return Promise.reject(
        this.recordContextualActivationFailure(session, cause) ?? asError(cause),
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.dependencies.eventBus.off('editingstateschanged', check);
        this.dependencies.eventBus.off('editorsrendered', check);
        signal.removeEventListener('abort', onAbort);
        if (owner?.interrupt === fail) owner.interrupt = null;
      };
      const finish = (selected: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(selected);
      };
      const fail = (cause: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      };
      const check = (): void => {
        if (settled) return;
        try {
          if (signal.aborted || this.contextualEditSession !== session) finish(false);
          else if (this.trySelectRequestedEditor(session)) finish(true);
        } catch (cause) {
          const failure = this.recordContextualActivationFailure(session, cause);
          if (failure === null) fail(asError(cause));
        }
      };
      const onAbort = (): void => {
        finish(false);
      };
      if (owner?.session === session) owner.interrupt = fail;
      this.dependencies.eventBus.on('editingstateschanged', check);
      this.dependencies.eventBus.on('editorsrendered', check);
      signal.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  private trySelectRequestedEditor(session: ContextualEditSession): boolean {
    if (this.isRequestedEditorSelected(session)) return true;
    const editorUid = this.editorUidOptions(session.id).editorUid;
    this.dependencies.commentBridge.selectAnnotation?.(session.id, editorUid);
    if (!this.isRequestedEditorSelected(session) && editorUid !== undefined)
      this.dependencies.commentBridge.selectAnnotation?.(session.id);
    return this.isRequestedEditorSelected(session);
  }

  private contextualActivationSignal(
    session: ContextualEditSession,
    activation: AnnotationActivation,
  ): AbortSignal {
    const owner = activation.contextualFailureOwner;
    return owner?.session === session ? owner.controller.signal : activation.controller.signal;
  }

  private contextualFailureOwnerForSession(
    session: ContextualEditSession,
  ): ContextualActivationFailureOwner | null {
    const owner = this.contextualActivationFailureOwner;
    return owner?.session === session ? owner : null;
  }

  private contextualActivationFailureCause(activation: AnnotationActivation): Error | null {
    return activation.contextualFailureOwner?.cause ?? null;
  }

  private rejectRecordedContextualFailure(activation: AnnotationActivation): Promise<never> | null {
    const owner = activation.contextualFailureOwner;
    const cause = owner?.cause ?? null;
    if (owner === null || cause === null) return null;
    return this.rejectAfterContextualContainment(cause, owner.session, activation);
  }

  private recordContextualActivationFailure(
    session: ContextualEditSession,
    cause: unknown,
  ): Error | null {
    const owner = this.contextualFailureOwnerForSession(session);
    if (owner === null) return null;
    if (owner.cause !== null) return owner.cause;
    if (!this.isCurrentActivation(owner.activation) || isAbortFailure(cause)) return null;
    const failure = asError(cause);
    owner.cause = failure;
    owner.interrupt?.(failure);
    if (!owner.controller.signal.aborted) owner.controller.abort(failure);
    return failure;
  }

  private clearContextualActivationFailureOwner(activation: AnnotationActivation): void {
    const owner = activation.contextualFailureOwner;
    if (owner === null) return;
    owner.interrupt = null;
    try {
      owner.removeActivationAbort();
    } finally {
      activation.contextualFailureOwner = null;
      if (this.contextualActivationFailureOwner === owner)
        this.contextualActivationFailureOwner = null;
    }
  }

  private isCurrentActivation(activation: AnnotationActivation): boolean {
    return this.isOwnedActivation(activation) && !activation.controller.signal.aborted;
  }

  private isOwnedActivation(activation: AnnotationActivation): boolean {
    return this.activeActivation === activation && this.isActivationEpochCurrent(activation);
  }

  private isActivationEpochCurrent(activation: AnnotationActivation): boolean {
    return (
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
    if (this.interactionsSuspended) return false;
    this.cancelAnnotationActivation('Deleting the PDF annotation cancelled its activation.');
    const deleted = this.dependencies.commentBridge.deleteAnnotations(annotations);
    if (deleted) this.cancelContextualSaveRestore();
    return deleted;
  }

  updateAnnotations(update: PdfAnnotationUpdate): boolean {
    if (this.interactionsSuspended) return false;
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
    readonly color: string | null;
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
    return kind === null ? null : { color: nativeEditorColor(native), id, kind, mode };
  }

  onNativeTextEdit(listener: () => boolean): () => void {
    this.nativeTextEditListeners.add(listener);
    return () => this.nativeTextEditListeners.delete(listener);
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
    if (this.interactionsSuspended) return 'dismissed';
    if (!this.restoreSelectionToken(token)) return 'dismissed';
    const saveBarrier = this.waitForSaveRelease(signal);
    if (saveBarrier !== null) {
      await saveBarrier;
      return this.commitSelection(token, action, signal);
    }
    const manager = this.requireManager();
    if (this.logicalMode !== 'neutral') return 'dismissed';
    if (signal?.aborted === true) throw abortReason(signal);
    const defaultPreparation = this.prepareGlobalHighlightDefault(manager, action.color, signal);
    if (defaultPreparation !== null) {
      await defaultPreparation;
      if (!this.restoreSelectionToken(token)) return 'dismissed';
    }
    const transaction = this.beginSelectionTransaction(signal);
    const highlight = this.reserveSelectionHighlight(manager);
    try {
      this.setLogicalMode('one-shot');
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
      // Returning from NONE is the commit point. Before this line the exact
      // PDF.js editor created for the gesture remains transaction-owned.
      return annotation;
    } catch (cause) {
      return await this.rejectSelectionCommit(asError(cause), highlight);
    } finally {
      highlight.unsubscribe();
      this.finishSelectionTransaction(transaction);
    }
  }

  private async rejectSelectionCommit(
    failure: Error,
    highlight: SelectionHighlightReservation,
  ): Promise<never> {
    let rollbackFailure: Error | null = null;
    let abortFailure: Error | null = null;
    try {
      rollbackFailure = await this.rollbackSelectionHighlight(highlight);
    } catch (rollbackCause) {
      rollbackFailure = asError(rollbackCause);
    } finally {
      try {
        await this.abortSelectionTransaction(failure);
      } catch (abortCause) {
        abortFailure = asError(abortCause);
      }
    }
    if (rollbackFailure === null && abortFailure !== null) throw abortFailure;
    const secondaryFailures = [rollbackFailure, abortFailure].filter(
      (secondary): secondary is Error => secondary !== null && secondary !== failure,
    );
    if (secondaryFailures.length === 0) throw failure;
    throw new AggregateError(
      [failure, ...secondaryFailures],
      'The PDF selection annotation could not be rolled back.',
    );
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
    void created.promise.catch(() => undefined);
    const commentBridge = this.dependencies.commentBridge;
    const existingIds = commentBridge.nativeEditorIds(manager);
    const ownership = new SelectionHighlightOwnership(
      manager,
      this.dependencies.annotationEditorType.HIGHLIGHT,
      () => commentBridge.nativeEditorIds(manager),
      existingIds,
    );
    let current: DocumentAnnotation | null = null;
    let frame: number | null = null;
    let normalizationFailure: Error | null = null;
    let observed = false;
    let stopped = false;
    const resolveCurrent = (): boolean => {
      if (normalizationFailure !== null) throw normalizationFailure;
      try {
        const annotation = commentBridge.normalizeSelectionHighlight(manager, existingIds);
        if (annotation === null) return false;
        ownership.captureNormalizedIds();
        current ??= annotation;
        created.resolve(annotation);
        return true;
      } catch (cause) {
        normalizationFailure = asError(cause);
        throw normalizationFailure;
      }
    };
    const stopRetries = (): void => {
      stopped = true;
      if (frame === null) return;
      window.cancelAnimationFrame(frame);
      frame = null;
    };
    const refresh = (): void => {
      if (stopped || current !== null) return;
      try {
        if (resolveCurrent() || frame !== null) return;
      } catch (cause) {
        stopRetries();
        created.reject(asError(cause));
        return;
      }
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
      ownership.captureCallbackEditor();
    });
    return {
      candidateNativeIds: () => ownership.candidateNativeIds(),
      created: created.promise,
      current: () => current,
      deleteOwnedNativeEditor: () => ownership.deleteOwnedEditor(),
      inspect: () => {
        if (current === null) resolveCurrent();
        return current;
      },
      observed: () => observed,
      ownedNativeIds: () => ownership.ownedNativeIds(),
      recaptureObservedEditor: () => ownership.captureCallbackEditor(observed),
      refresh,
      stop: stopRetries,
      unsubscribe: () => {
        stopRetries();
        unsubscribe();
      },
    };
  }

  private async rollbackSelectionHighlight(
    reservation: SelectionHighlightReservation,
  ): Promise<Error | null> {
    let annotation: DocumentAnnotation | null = null;
    reservation.stop();
    try {
      annotation = reservation.inspect();
    } catch {
      // The exact runtime-id closure below remains available even when public
      // annotation normalization fails.
    }
    try {
      reservation.recaptureObservedEditor();
      const nativeIds = reservation.ownedNativeIds();
      const deleted =
        annotation === null
          ? reservation.deleteOwnedNativeEditor()
          : this.dependencies.commentBridge.deleteAnnotations([annotation]);
      if (!deleted) {
        if (annotation === null && reservation.candidateNativeIds().size === 0) return null;
        throw new DOMException(
          'The PDF selection annotation could not be deleted during rollback.',
          'InvalidStateError',
        );
      }
      await this.waitForSelectionRollbackCleanup(reservation, nativeIds);
      return null;
    } catch (cause) {
      return asError(cause);
    }
  }

  private waitForSelectionRollbackCleanup(
    reservation: SelectionHighlightReservation,
    nativeIds: ReadonlySet<string>,
  ): Promise<void> {
    if (nativeIds.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let frame: number | null = null;
      const timeout = window.setTimeout(() => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        reject(
          new DOMException('The PDF selection annotation rollback timed out.', 'TimeoutError'),
        );
      }, SELECTION_TRANSACTION_TIMEOUT_MS);
      const check = (): void => {
        const remaining = reservation.ownedNativeIds();
        if (![...nativeIds].some((id) => remaining.has(id))) {
          window.clearTimeout(timeout);
          resolve();
          return;
        }
        frame = window.requestAnimationFrame(check);
      };
      check();
    });
  }

  private async createSelectionHighlight(
    manager: PdfAnnotationUiManager,
    transaction: PendingSelectionTransaction,
    reservation: SelectionHighlightReservation,
  ): Promise<DocumentAnnotation> {
    // PDF.js 6.4.299 snapshots the live DOM selection inside this call before
    // its asynchronous mode switch. Keep it before the first await so a view
    // transition cannot invalidate the selection geometry.
    // Source: https://github.com/mozilla/pdf.js/blob/v6.4.299/src/display/editor/tools.js
    manager.highlightSelection('abyss-selection');
    await this.enterCapturedSelectionMode(transaction);
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
    await this.enterCapturedSelectionMode(transaction);
    const annotation = await waitWithSignal(reservation.opened, transaction.controller.signal);
    transaction.clearTimeout();
    await waitWithSignal(reservation.closed, transaction.controller.signal);
    transaction.armTimeout();
    return annotation;
  }

  private async enterCapturedSelectionMode(
    transaction: PendingSelectionTransaction,
  ): Promise<void> {
    await waitWithSignal(
      this.changeMode(this.dependencies.annotationEditorType.HIGHLIGHT),
      transaction.controller.signal,
    );
  }

  async setQuickHighlight(state: {
    readonly enabled: boolean;
    readonly color: string;
  }): Promise<void> {
    if (this.interactionsSuspended) return;
    const intentRevision = ++this.toolIntentRevision;
    await this.applyToolIntent('select', {}, intentRevision);
    if (intentRevision !== this.toolIntentRevision) {
      throw new DOMException('The PDF annotation tool request was superseded.', 'AbortError');
    }
    if (state.enabled) {
      await this.prepareGlobalHighlightDefault(this.requireManager(), state.color);
    }
  }

  private prepareGlobalHighlightDefault(
    manager: PdfAnnotationUiManager,
    color: string,
    signal?: AbortSignal,
  ): Promise<void> | null {
    if (signal?.aborted === true) throw abortReason(signal);
    const contextual = this.contextualEditSession;
    if (contextual !== null) {
      return this.closeContextualEditSession(
        contextual,
        signal === undefined ? {} : { signal },
      ).then(() => this.continueGlobalHighlightDefault(manager, color, signal));
    }
    this.requireGlobalHighlightManager(manager);
    const nativeMode = this.dependencies.viewer.annotationEditorMode;
    if (typeof nativeMode !== 'number') {
      throw new DOMException('The PDF annotation editor mode is unavailable.', 'InvalidStateError');
    }
    if (nativeMode !== this.dependencies.annotationEditorType.NONE) {
      return this.changeMode(
        this.dependencies.annotationEditorType.NONE,
        {},
        signal === undefined ? {} : { signal },
      ).then(() => this.continueGlobalHighlightDefault(manager, color, signal));
    }
    this.writeGlobalHighlightDefault(manager, color);
    return null;
  }

  private continueGlobalHighlightDefault(
    manager: PdfAnnotationUiManager,
    color: string,
    signal?: AbortSignal,
  ): Promise<void> | void {
    return this.prepareGlobalHighlightDefault(manager, color, signal) ?? undefined;
  }

  private requireGlobalHighlightManager(manager: PdfAnnotationUiManager): void {
    if (manager !== this.manager || this.destroyed) throw this.staleError();
  }

  private writeGlobalHighlightDefault(manager: PdfAnnotationUiManager, color: string): void {
    this.requireGlobalHighlightManager(manager);
    manager.unselectAll();
    if (manager.hasSelection) {
      throw new DOMException(
        'The selected PDF annotation could not be released before changing the highlight default.',
        'InvalidStateError',
      );
    }
    manager.updateParams(this.dependencies.annotationEditorParamsType.HIGHLIGHT_COLOR, color);
    this.emitColor(color);
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
    const closing = this.closeContextualEditSession(contextual);
    this.pendingContextualClose = closing;
    void closing.catch(() => {
      if (this.pendingContextualClose === closing) this.pendingContextualClose = null;
    });
    await closing;
  }

  async suspendInteractions(): Promise<void> {
    if (this.destroyed || this.interactionsSuspended) return;
    this.interactionsSuspended = true;
    this.cancelQueuedToolIntent('The PDF annotation interaction is closing.');
    try {
      await this.abortInteraction('The PDF annotation interaction is closing.');
    } catch (cause) {
      this.interactionsSuspended = false;
      throw cause;
    }
  }

  resumeInteractions(): void {
    if (!this.destroyed) this.interactionsSuspended = false;
  }

  private async changeMode(
    mode: number,
    options: PdfAnnotationModeOptions = {},
    wait: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (wait.signal?.aborted === true) throw abortReason(wait.signal);
    if (this.dependencies.viewer.annotationEditorMode === mode) return;
    this.cancelPendingModeChange('The PDF annotation tool change was superseded.');
    const materialization = this.beginActivationMaterialization(mode, options);
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
        this.requestNativeMode(mode, options);
      } catch (cause) {
        this.dependencies.eventBus.off('annotationeditormodechanged', listener);
        clearTimeout();
        removeAbort();
        this.pendingModeChange = null;
        reject(asError(cause));
      }
    }).finally(() => {
      if (this.activationMaterialization === materialization) {
        this.activationMaterialization = null;
      }
    });
  }

  private requestNativeMode(mode: number, options: PdfAnnotationModeOptions): void {
    this.dependencies.viewer.annotationEditorMode = {
      mode,
      ...(options.isFromKeyboard === undefined ? {} : { isFromKeyboard: options.isFromKeyboard }),
      ...(options.editId === undefined
        ? {}
        : {
            editComment: options.editComment === true,
            editId: options.editId,
          }),
    };
  }

  private beginActivationMaterialization(
    mode: number,
    options: PdfAnnotationModeOptions,
  ): ActivationMaterialization | null {
    const activation = this.activeActivation;
    if (activation === null || !this.isCurrentActivation(activation)) return null;
    if (options.editId !== this.nativeEditorUid(activation.id)) return null;
    const materialization: ActivationMaterialization = {
      activation,
      baselineEditors: new Set(this.nativeStorageEditors()),
      editorConsumed: false,
      mode,
      resetInProgress: false,
      setConsumed: false,
    };
    this.activationMaterialization = materialization;
    return materialization;
  }

  private consumeActivationMaterializationCallback(
    callback: 'editor' | 'set',
    type?: number | null,
  ): boolean {
    const materialization = this.activationMaterialization;
    if (materialization === null || !this.isCurrentActivation(materialization.activation))
      return false;
    if (callback === 'editor') return this.consumeMaterializedEditor(materialization, type);
    return this.consumeMaterializedSet(materialization);
  }

  private consumeMaterializedEditor(
    materialization: ActivationMaterialization,
    type: number | null | undefined,
  ): boolean {
    if (materialization.editorConsumed || type !== materialization.mode) return false;
    if (this.materializedActivationEditor(materialization) === null) return false;
    materialization.editorConsumed = true;
    return true;
  }

  private consumeMaterializedSet(materialization: ActivationMaterialization): boolean {
    if (materialization.setConsumed || materialization.editorConsumed) return false;
    if (this.materializedActivationEditor(materialization) === null) return false;
    materialization.setConsumed = true;
    materialization.resetInProgress = true;
    try {
      this.storage.resetModified();
    } finally {
      materialization.resetInProgress = false;
    }
    return true;
  }

  private materializedActivationEditor(
    materialization: ActivationMaterialization,
  ): PdfNativeEditorReference | null {
    for (const editor of this.nativeStorageEditors()) {
      if (materialization.baselineEditors.has(editor)) continue;
      if (editor.mode !== materialization.mode) continue;
      if (nativeEditorAnnotationId(editor) === materialization.activation.id) return editor;
    }
    return null;
  }

  private nativeStorageEditors(): PdfNativeEditorReference[] {
    const iterator = this.storage[Symbol.iterator];
    if (iterator === undefined) return [];
    const editors: PdfNativeEditorReference[] = [];
    try {
      for (const [, value] of iterator.call(this.storage)) {
        const candidate = record(value) as PdfNativeEditorReference | null;
        if (
          candidate !== null &&
          typeof candidate.mode === 'number' &&
          nativeEditorAnnotationId(candidate) !== undefined
        )
          editors.push(candidate);
      }
    } catch {
      return [];
    }
    return editors;
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
    const initialTarget = initialSaveRestoreTarget(
      this.pendingContextualSaveRestore === contextualRestore ? contextualRestore : null,
      restoredMode,
    );
    let targetContextualRestore = initialTarget.contextualRestore;
    let targetMode = initialTarget.mode;
    let targetOptions = initialTarget.options;
    let restoreFailure: Error | null = null;
    try {
      do {
        const queued = this.takeQueuedToolIntent(manager, revision);
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
    } catch (cause) {
      restoreFailure = asError(cause);
    } finally {
      const failedDuringRestore = this.takeQueuedToolIntent(manager, revision);
      if (failedDuringRestore !== null) queuedIntents.push(failedDuringRestore);
      this.clearOwnedContextualSaveRestore(contextualRestore);
      this.releaseSave(manager, revision);
      this.synchronizeLogicalModeAfterSave();
      for (const queued of queuedIntents) this.settleQueuedToolIntent(queued, restoreFailure);
    }
    return restoreFailure;
  }

  private requireSaveBytes(outcome: {
    readonly bytes: Uint8Array | null;
    readonly failure: Error | null;
  }): Uint8Array {
    if (outcome.bytes !== null) {
      if (outcome.failure !== null && outcome.failure.name !== 'AbortError') {
        console.warn('[abyss-documents] PDF bytes were saved but editor focus was not restored', {
          cause: outcome.failure,
        });
      }
      return outcome.bytes;
    }
    if (outcome.failure !== null) throw outcome.failure;
    throw this.staleError();
  }

  private prepareSave(signal: AbortSignal): PreparedSave | Promise<PreparedSave> {
    const manager = this.requireManager();
    const revision = this.lifecycleRevision;
    const pendingInteraction = this.waitForInteractionBeforeSave(signal);
    if (pendingInteraction === null) {
      return this.beginPreparedSave(manager, revision, signal);
    }
    return pendingInteraction.then(() => {
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
    const pendingInteraction = this.waitForInteractionBeforeSave(signal);
    if (pendingInteraction !== null)
      return pendingInteraction.then(() => this.beginPreparedSave(manager, revision, signal));
    this.beginSave(signal);
    const contextual = this.contextualEditSession;
    if (contextual === null) return { contextualRestore: null, manager, revision };
    const contextualRestore = {
      id: contextual.id,
      mode: contextual.mode,
      uid: nativeEditorUid(manager.firstSelectedEditor),
    };
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

  private waitForInteractionBeforeSave(signal: AbortSignal): Promise<void> | null {
    const pending: Array<Promise<unknown>> = [];
    const pendingSelection = this.pendingSelectionTransaction;
    if (pendingSelection !== null) pending.push(pendingSelection.settled.promise);
    const activation = this.activeActivation;
    if (activation !== null) pending.push(activation.promise.catch(() => 'cancelled'));
    if (pending.length === 0) return null;
    return waitWithSignal(
      Promise.all(pending).then(() => undefined),
      signal,
    );
  }

  private beginSave(signal: AbortSignal): void {
    if (this.saving) {
      throw new DOMException('A PDF annotation save is already active.', 'InvalidStateError');
    }
    this.throwIfAborted(signal);
    this.saving = true;
    this.saveBarrier = deferred<void>();
  }

  private waitForSaveRelease(signal?: AbortSignal): Promise<void> | null {
    const barrier = this.saveBarrier;
    if (!this.saving || barrier === null) return null;
    return signal === undefined ? barrier.promise : waitWithSignal(barrier.promise, signal);
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
      const failure = this.completeRestoredContextualSession(restoredSession);
      if (failure !== null) await this.neutralizeFailedRestore(manager, revision);
      return failure;
    } catch (cause) {
      if (restoredSession !== null) this.releaseContextualEditSession(restoredSession);
      return asError(cause);
    }
  }

  private async neutralizeFailedRestore(
    manager: PdfAnnotationUiManager,
    revision: number,
  ): Promise<void> {
    if (
      manager !== this.manager ||
      revision !== this.lifecycleRevision ||
      this.dependencies.viewer.annotationEditorMode === this.dependencies.annotationEditorType.NONE
    )
      return;
    try {
      await this.changeMode(this.dependencies.annotationEditorType.NONE);
    } catch {
      // The captured bytes remain authoritative; the bounded warning is emitted at save exit.
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
      restoreUid: contextualRestore.uid,
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
    this.dependencies.eventBus.off('switchannotationeditormode', this.onNativeModeRequest);
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
    this.clearModeListeners();
    this.colorListeners.clear();
    this.projectedTargets.clear();
    this.projectedHitGrid.clear();
    this.annotationResolver = null;
    this.releaseContextualEditSession();
    this.clearPendingAnnotationFocus();
    this.removeBridgeFocusListener();
    this.annotationFocusListeners.clear();
  }

  private clearModeListeners(): void {
    this.modeListeners.clear();
    this.nativeTextEditListeners.clear();
  }

  private nativeEditorUid(annotationId: string): string {
    return (
      this.dependencies.commentBridge.nativeEditorUidForAnnotation?.(annotationId) ??
      this.projectedTargets.get(annotationId)?.editorUid ??
      annotationId
    );
  }

  private editorUidOptions(annotationId: string): { readonly editorUid?: string } {
    const editorUid = this.nativeEditorUid(annotationId);
    return editorUid === annotationId ? {} : { editorUid };
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

  private readonly onNativeModeRequest = (event: unknown): void => {
    if (this.destroyed || !this.managerEventsEnabled) return;
    const manager = this.manager;
    if (manager === null) return;
    const request = nativeAnnotationModeRequest(
      event,
      this.dependencies.annotationEditorType,
      this.dependencies.annotationRoot,
    );
    if (request === null || !this.isCurrentNativeModeRequest(request, manager)) return;
    if (this.enterCurrentNativeTextEditor(request, manager)) return;
    this.dependencies.viewer.annotationEditorMode = request;
  };

  private enterCurrentNativeTextEditor(
    request: PdfAnnotationModeRequest,
    manager: PdfAnnotationUiManager,
  ): boolean {
    if (
      request.mode !== this.dependencies.annotationEditorType.FREETEXT ||
      request.editComment === true ||
      this.dependencies.viewer.annotationEditorMode !== request.mode ||
      typeof request.editId !== 'string'
    )
      return false;
    const identities = new Set([request.editId, this.nativeEditorUid(request.editId)]);
    const candidates = [
      manager.firstSelectedEditor,
      ...Array.from(this.dependencies.commentBridge.nativeEditorIds(manager), (id) =>
        manager.getEditor(id),
      ),
    ];
    const native = candidates.find(
      (candidate) =>
        candidate?.mode === request.mode &&
        nativeEditorIdentityIds(candidate).some((id) => identities.has(id)),
    );
    if (native?.enterInEditMode === undefined) return false;
    // PDFViewer ignores same-mode requests, including mustEnterInEditMode.
    // The already materialized FreeText editor can enter its native text mode.
    native.enterInEditMode();
    return true;
  }

  private isCurrentNativeModeRequest(
    request: PdfAnnotationModeRequest,
    manager: PdfAnnotationUiManager,
  ): boolean {
    const projected =
      typeof request.editId === 'string' ? this.projectedTargets.get(request.editId) : undefined;
    const kind = this.editableKindForMode(request.mode);
    if (projected !== undefined)
      return (
        kind !== null && projected.annotation.type === (kind === 'freetext' ? 'free-text' : kind)
      );
    if (typeof request.editId !== 'string') return false;
    const editor = manager.getEditor(request.editId);
    return (
      this.dependencies.commentBridge.nativeEditorIds(manager).has(request.editId) &&
      editor?.mode === request.mode
    );
  }

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
    if (this.shouldIgnoreContextualEditingState(session)) return;
    try {
      this.applyContextualEditingState(session, record(data['details'])?.['hasSelectedEditor']);
    } catch (cause) {
      this.handleContextualEditingStateFailure(session, cause);
    }
  };

  private shouldIgnoreContextualEditingState(session: ContextualEditSession): boolean {
    const failureOwner = this.contextualFailureOwnerForSession(session);
    return (
      failureOwner !== null &&
      (failureOwner.cause !== null || !this.isCurrentActivation(failureOwner.activation))
    );
  }

  private handleContextualEditingStateFailure(
    session: ContextualEditSession,
    cause: unknown,
  ): void {
    const failureOwner = this.contextualFailureOwnerForSession(session);
    if (failureOwner !== null) {
      if (
        failureOwner.cause !== null ||
        !this.isCurrentActivation(failureOwner.activation) ||
        isAbortFailure(cause)
      )
        return;
      this.recordContextualActivationFailure(session, cause);
      return;
    }
    if (isAbortFailure(cause)) return;
    if (this.reportedContextualEditingStateFailures.has(session)) return;
    this.reportedContextualEditingStateFailures.add(session);
    console.error('[abyss-documents] Failed to synchronize the PDF annotation editor selection', {
      annotationId: session.id,
      cause: asError(cause),
    });
  }

  private applyContextualEditingState(
    session: ContextualEditSession,
    hasSelectedEditor: unknown,
  ): void {
    if (hasSelectedEditor === true) {
      if (this.isRequestedEditorSelected(session)) session.phase = 'selected';
      return;
    }
    if (hasSelectedEditor !== false || session.phase !== 'selected') return;
    if (this.isRequestedEditorSelected(session)) return;
    void this.closeContextualEditSession(session).catch((cause: unknown) => {
      console.error('[abyss-documents] Failed to close the PDF annotation editor', { cause });
    });
  }

  private isRequestedEditorSelected(session: ContextualEditSession): boolean {
    const selected = session.manager.firstSelectedEditor;
    if (selected?.mode !== session.mode) return false;
    const selectedId = nativeEditorAnnotationId(selected);
    if (selectedId === session.id) return true;
    if (session.restoreUid === null || nativeEditorUid(selected) !== session.restoreUid)
      return false;
    if (selectedId !== undefined && selectedId.length > 0) session.id = selectedId;
    return true;
  }

  private async enterContextualEditSession(
    session: ContextualEditSession,
    tool: PdfAnnotationTool,
    options: PdfAnnotationModeOptions,
  ): Promise<void> {
    if (this.saving)
      await this.queueToolIntent(tool, options, session.manager, this.lifecycleRevision);
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
    const failureOwner = this.contextualFailureOwnerForSession(session);
    if (failureOwner !== null && failureOwner.cause !== null) session.phase = 'closing';
    this.guardContextualEditSession(session);
    await this.closeContextualEditSession(session, signal === undefined ? {} : { signal });
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
    if (this.contextualToolbarSuppressionUnavailable(session)) return;
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

  private contextualToolbarSuppressionUnavailable(session: ContextualEditSession): boolean {
    return session.phase === 'closing' || session.toolbarObserver !== null;
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
      if (session.closing === closing) session.closing = null;
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
      if (this.consumeActivationMaterializationCallback('editor', type)) return;
      this.emitMutation();
      for (const listener of [...this.editorAddedListeners]) listener(type);
    };
    const ownedSet = (): void => {
      previousSet?.();
      if (this.consumeActivationMaterializationCallback('set')) return;
      this.emitMutation();
      if (!this.saving) this.emitDirty(true);
    };
    const ownedReset = (): void => {
      previousReset?.();
      if (this.activationMaterialization?.resetInProgress === true) return;
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
    manager: PdfAnnotationUiManager,
    revision: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queued = this.queuedToolIntent;
      if (queued === null) {
        this.queuedToolIntent = {
          manager,
          options: { ...options },
          revision,
          tool,
          waiters: [{ resolve, reject }],
        };
        return;
      }
      if (queued.manager !== manager || queued.revision !== revision) {
        this.settleQueuedToolIntent(queued, queuedToolLifecycleError());
        this.queuedToolIntent = {
          manager,
          options: { ...options },
          revision,
          tool,
          waiters: [{ resolve, reject }],
        };
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

  private takeQueuedToolIntent(
    manager: PdfAnnotationUiManager,
    revision: number,
  ): QueuedToolIntent | null {
    const queued = this.queuedToolIntent;
    this.queuedToolIntent = null;
    if (queued !== null && (queued.manager !== manager || queued.revision !== revision)) {
      this.settleQueuedToolIntent(queued, queuedToolLifecycleError());
      return null;
    }
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
    if (this.interactionsSuspended) {
      return Promise.reject(
        new DOMException('The PDF annotation interaction is closing.', 'AbortError'),
      );
    }
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
    const barrier = this.saveBarrier;
    this.saveBarrier = null;
    this.saving = false;
    this.applyQueuedMutations(manager, revision);
    barrier?.resolve(undefined);
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
      'unselectAll',
      'undo',
      'updateParams',
    ] as const;
    return (
      typeof data['hasSelection'] === 'boolean' &&
      methods.every((method) => typeof data[method] === 'function')
    );
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

class SelectionHighlightOwnership {
  private ownedEditor: PdfNativeEditorReference | null = null;
  private readonly ownedIdAliases = new Set<string>();

  constructor(
    private readonly manager: PdfAnnotationUiManager,
    private readonly highlightMode: number,
    private readonly readNativeIds: () => ReadonlySet<string>,
    private readonly baselineIds: ReadonlySet<string>,
  ) {}

  candidateNativeIds(): ReadonlySet<string> {
    const ids = new Set(this.readNativeIds());
    for (const id of this.baselineIds) ids.delete(id);
    return ids;
  }

  captureCallbackEditor(observed = true): boolean {
    if (!observed || this.ownedEditor !== null) return false;
    const ids = this.candidateNativeIds();
    const editor = this.uniqueCandidateEditor(ids);
    if (editor === null) return false;
    this.ownedEditor = editor;
    for (const id of ids) this.ownedIdAliases.add(id);
    for (const id of nativeEditorIdentityIds(editor)) this.ownedIdAliases.add(id);
    return true;
  }

  captureNormalizedIds(): void {
    if (this.ownedEditor !== null) return;
    const ids = this.candidateNativeIds();
    if (ids.size !== 1) return;
    const id = ids.values().next().value;
    if (typeof id === 'string') this.ownedIdAliases.add(id);
  }

  ownedNativeIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const id of this.candidateNativeIds()) {
      if (this.isOwnedId(id)) ids.add(id);
    }
    return ids;
  }

  deleteOwnedEditor(): boolean {
    if (this.manager.setSelected === undefined || this.ownedEditor === null) return false;
    this.manager.setSelected(this.ownedEditor);
    this.manager.delete();
    return true;
  }

  private isOwnedId(id: string): boolean {
    if (this.ownedIdAliases.has(id)) return true;
    return this.ownedEditor !== null && this.manager.getEditor(id) === this.ownedEditor;
  }

  private uniqueCandidateEditor(ids: ReadonlySet<string>): PdfNativeEditorReference | null {
    if (ids.size === 0) return null;
    const selected = this.manager.firstSelectedEditor;
    const selectedAliases = new Set(
      selected === undefined ? [] : nativeEditorIdentityIds(selected),
    );
    let candidate: PdfNativeEditorReference | null = null;
    for (const id of ids) {
      const editor = this.manager.getEditor(id) ?? (selectedAliases.has(id) ? selected : undefined);
      if (editor?.mode !== this.highlightMode) return null;
      if (candidate !== null && candidate !== editor) return null;
      candidate = editor;
    }
    return candidate;
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

function nativeEditorIdentityIds(native: PdfNativeEditorReference): readonly string[] {
  const ids = new Set<string>();
  const annotationId = nativeEditorAnnotationId(native);
  if (annotationId !== undefined && annotationId.length > 0) ids.add(annotationId);
  const uid = nativeEditorUid(native);
  if (uid !== null) ids.add(uid);
  const elementId = native.elementBeforePopup?.id.trim();
  if (elementId !== undefined && elementId.length > 0) ids.add(elementId);
  return [...ids];
}

function reusableActivation(
  activation: AnnotationActivation | null,
  id: string,
  focusActivation: PdfAnnotationFocusActivation | undefined,
): AnnotationActivation | null {
  return activation?.id === id &&
    sameFocusActivation(activation.focusActivation, focusActivation) &&
    !activation.controller.signal.aborted
    ? activation
    : null;
}

function sameFocusActivation(
  left: PdfAnnotationFocusActivation | undefined,
  right: PdfAnnotationFocusActivation | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.rowId === right.rowId;
}

function initialSaveRestoreTarget(
  contextualRestore: ContextualSaveRestore | null,
  restoredMode: number | null,
): {
  readonly contextualRestore: ContextualSaveRestore | null;
  readonly mode: number | null;
  readonly options: PdfAnnotationModeOptions;
} {
  return {
    contextualRestore,
    mode: contextualRestore?.mode ?? restoredMode,
    options:
      contextualRestore === null
        ? {}
        : {
            editComment: false,
            editId: contextualRestore.uid ?? contextualRestore.id,
          },
  };
}

function documentAnnotationId(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function pdfProjectedTarget(projected: PdfProjectedAnnotation): PdfProjectedTarget {
  const annotationId = documentAnnotationId(projected.annotation);
  const stableId = projected.stableId.trim();
  const editorUid = projected.editorUid?.trim();
  return {
    annotation: projected.annotation,
    canonicalId: stableId.length === 0 ? annotationId : stableId,
    ...(editorUid === undefined || editorUid.length === 0 ? {} : { editorUid }),
  };
}

function pdfProjectedAliases(
  projected: PdfProjectedAnnotation,
  target: PdfProjectedTarget,
): ReadonlySet<string> {
  return new Set(
    [
      target.canonicalId,
      documentAnnotationId(projected.annotation),
      target.editorUid,
      ...(projected.aliases ?? []),
    ]
      .map((alias) => alias?.trim())
      .filter((alias): alias is string => alias !== undefined && alias.length > 0),
  );
}

interface PdfProjectedEntry {
  readonly aliases: ReadonlySet<string>;
  readonly target: PdfProjectedTarget;
}

interface PdfProjectedHitRegion {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly shape: PdfProjectedHitShape;
  readonly target: PdfProjectedHitTarget;
  readonly top: number;
}

interface PdfProjectedHitPoint {
  readonly x: number;
  readonly y: number;
}

type PdfProjectedHitShape =
  | { readonly kind: 'rectangle' }
  | { readonly center: PdfProjectedHitPoint; readonly kind: 'circle'; readonly radius: number }
  | { readonly kind: 'polygon'; readonly points: readonly PdfProjectedHitPoint[] }
  | {
      readonly end: PdfProjectedHitPoint;
      readonly kind: 'segment';
      readonly radius: number;
      readonly start: PdfProjectedHitPoint;
    };

type PdfProjectedHitGrid = Map<number, Map<string, PdfProjectedHitRegion[]>>;

const PDF_PROJECTED_HIT_CELL_SIZE = 64;
const PDF_PROJECTED_POINT_HIT_RADIUS = 8;

function pdfProjectedHitGrid(annotations: readonly PdfProjectedAnnotation[]): PdfProjectedHitGrid {
  const grid: PdfProjectedHitGrid = new Map();
  for (const projected of annotations) {
    const target = pdfProjectedTarget(projected);
    const anchor = projected.annotation.anchor;
    if (anchor.kind !== 'fixed-page') continue;
    for (const rect of pdfAnnotationHitRegions(anchor.geometry)) {
      const region: PdfProjectedHitRegion = {
        ...rect,
        target: {
          stableId: target.canonicalId,
          ...(target.editorUid === undefined ? {} : { editorUid: target.editorUid }),
        },
      };
      pdfProjectedHitGridInsert(grid, anchor.pageIndex, region);
    }
  }
  return grid;
}

function pdfProjectedHitGridInsert(
  grid: PdfProjectedHitGrid,
  pageIndex: number,
  region: PdfProjectedHitRegion,
): void {
  let page = grid.get(pageIndex);
  if (page === undefined) {
    page = new Map();
    grid.set(pageIndex, page);
  }
  const firstColumn = Math.floor(region.left / PDF_PROJECTED_HIT_CELL_SIZE);
  const lastColumn = Math.floor(region.right / PDF_PROJECTED_HIT_CELL_SIZE);
  const firstRow = Math.floor(region.top / PDF_PROJECTED_HIT_CELL_SIZE);
  const lastRow = Math.floor(region.bottom / PDF_PROJECTED_HIT_CELL_SIZE);
  for (let column = firstColumn; column <= lastColumn; column += 1) {
    for (let row = firstRow; row <= lastRow; row += 1) {
      const key = `${String(column)}:${String(row)}`;
      const cell = page.get(key);
      if (cell === undefined) page.set(key, [region]);
      else cell.push(region);
    }
  }
}

function pdfProjectedHitCellKey(point: { readonly x: number; readonly y: number }): string {
  return `${String(Math.floor(point.x / PDF_PROJECTED_HIT_CELL_SIZE))}:${String(
    Math.floor(point.y / PDF_PROJECTED_HIT_CELL_SIZE),
  )}`;
}

function pdfProjectedHitRegionContains(
  region: PdfProjectedHitRegion,
  point: PdfProjectedHitPoint,
): boolean {
  if (
    point.x < region.left ||
    point.x > region.right ||
    point.y < region.top ||
    point.y > region.bottom
  )
    return false;
  switch (region.shape.kind) {
    case 'rectangle':
      return true;
    case 'circle':
      return pdfProjectedSquaredDistance(point, region.shape.center) <= region.shape.radius ** 2;
    case 'polygon':
      return pdfProjectedPointInPolygon(point, region.shape.points);
    case 'segment':
      return (
        pdfProjectedSquaredDistanceToSegment(point, region.shape.start, region.shape.end) <=
        region.shape.radius ** 2
      );
  }
}

function pdfProjectedSquaredDistance(
  first: PdfProjectedHitPoint,
  second: PdfProjectedHitPoint,
): number {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2;
}

function pdfProjectedSquaredDistanceToSegment(
  point: PdfProjectedHitPoint,
  start: PdfProjectedHitPoint,
  end: PdfProjectedHitPoint,
): number {
  const lengthSquared = pdfProjectedSquaredDistance(start, end);
  if (lengthSquared === 0) return pdfProjectedSquaredDistance(point, start);
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) /
        lengthSquared,
    ),
  );
  return pdfProjectedSquaredDistance(point, {
    x: start.x + projection * (end.x - start.x),
    y: start.y + projection * (end.y - start.y),
  });
}

function pdfProjectedPointInPolygon(
  point: PdfProjectedHitPoint,
  polygon: readonly PdfProjectedHitPoint[],
): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current, current += 1
  ) {
    const currentPoint = polygon[current];
    const previousPoint = polygon[previous];
    if (currentPoint === undefined || previousPoint === undefined) continue;
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pdfAnnotationHitRegions(
  geometry: AnnotationGeometry,
): ReadonlyArray<Omit<PdfProjectedHitRegion, 'target'>> {
  switch (geometry.kind) {
    case 'point':
      return [pdfProjectedCircleHitRegion(geometry.point, PDF_PROJECTED_POINT_HIT_RADIUS)];
    case 'rectangle': {
      const { height, width, x, y } = geometry.rectangle;
      return [
        pdfProjectedHitRegion(
          [
            { x, y },
            { x: x + width, y: y + height },
          ],
          { kind: 'rectangle' },
        ),
      ];
    }
    case 'quadrilaterals':
      return geometry.quadrilaterals.map((quadrilateral) => {
        const points = [
          quadrilateral.topLeft,
          quadrilateral.topRight,
          quadrilateral.bottomRight,
          quadrilateral.bottomLeft,
        ];
        return pdfProjectedHitRegion(points, { kind: 'polygon', points });
      });
    case 'ink':
      return geometry.paths.flatMap(pdfProjectedInkHitRegions);
  }
}

function pdfProjectedInkHitRegions(
  path: readonly PdfProjectedHitPoint[],
): ReadonlyArray<Omit<PdfProjectedHitRegion, 'target'>> {
  const radius = PDF_PROJECTED_POINT_HIT_RADIUS / 2;
  const first = path[0];
  if (first === undefined) return [];
  if (path.length === 1) return [pdfProjectedCircleHitRegion(first, radius)];
  return path.slice(1).map((end, index) => {
    const start = path[index] ?? end;
    return pdfProjectedHitRegion([start, end], { end, kind: 'segment', radius, start }, radius);
  });
}

function pdfProjectedCircleHitRegion(
  center: PdfProjectedHitPoint,
  radius: number,
): Omit<PdfProjectedHitRegion, 'target'> {
  return pdfProjectedHitRegion([center], { center, kind: 'circle', radius }, radius);
}

function pdfProjectedHitRegion(
  points: readonly PdfProjectedHitPoint[],
  shape: PdfProjectedHitShape,
  padding = 0,
): Omit<PdfProjectedHitRegion, 'target'> {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  return {
    bottom: Math.max(...ys) + padding,
    left: Math.min(...xs) - padding,
    right: Math.max(...xs) + padding,
    shape,
    top: Math.min(...ys) - padding,
  };
}

function pdfProjectedTargetIndex(
  annotations: readonly PdfProjectedAnnotation[],
): Map<string, PdfProjectedTarget> {
  const entries: PdfProjectedEntry[] = annotations.map((projected) => {
    const target = pdfProjectedTarget(projected);
    return { aliases: pdfProjectedAliases(projected, target), target };
  });
  const indexed = new Map(entries.map(({ target }) => [target.canonicalId, target]));
  const aliases = unambiguousProjectedAliases(entries, new Set(indexed.keys()));
  for (const [alias, target] of aliases) indexed.set(alias, target);
  return indexed;
}

function unambiguousProjectedAliases(
  entries: readonly PdfProjectedEntry[],
  canonicalIds: ReadonlySet<string>,
): Map<string, PdfProjectedTarget> {
  const candidates = new Map<string, PdfProjectedTarget | null>();
  for (const { aliases, target } of entries) {
    for (const alias of aliases) {
      if (canonicalIds.has(alias)) continue;
      const current = candidates.get(alias);
      if (current === undefined) candidates.set(alias, target);
      else if (current?.canonicalId !== target.canonicalId) candidates.set(alias, null);
    }
  }
  return new Map(
    [...candidates].filter((entry): entry is [string, PdfProjectedTarget] => entry[1] !== null),
  );
}

function nativeEditorUid(native: PdfNativeEditorReference | undefined): string | null {
  const uid = native?.uid?.trim();
  return uid === undefined || uid.length === 0 ? null : uid;
}

function nativeEditorColor(native: PdfNativeEditorReference | undefined): string | null {
  const nonHcm = nativeEditorNonHcmColor(native);
  if (nonHcm !== null) return rgbColor(nonHcm);
  return normalizedNativeHexColor(native?.color);
}

function nativeEditorNonHcmColor(
  native: PdfNativeEditorReference | undefined,
): ArrayLike<number> | null {
  try {
    const color = native?.getNonHCMColor?.() ?? null;
    return color !== null && color.length >= 3 ? color : null;
  } catch {
    return null;
  }
}

function normalizedNativeHexColor(color: string | undefined): string | null {
  const authored = color?.trim();
  return authored !== undefined && /^#[\da-f]{6}$/iu.test(authored) ? authored.toLowerCase() : null;
}

function rgbColor(color: ArrayLike<number>): string {
  return `#${[color[0], color[1], color[2]]
    .map(normalizedColorByte)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function normalizedColorByte(value: number | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(255, Math.round(numeric))) : 0;
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

function isAbortFailure(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
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

function queuedToolLifecycleError(): DOMException {
  return new DOMException(
    'The PDF annotation editor changed before applying the tool.',
    'AbortError',
  );
}

function remainingDeadlineMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function clientPositionOptions(
  clientPosition: { readonly x: number; readonly y: number } | undefined,
): { readonly clientPosition?: { readonly x: number; readonly y: number } | undefined } {
  return clientPosition === undefined ? {} : { clientPosition };
}

function sidebarFocusActivation(
  source: PdfAnnotationActivationSource,
): PdfAnnotationFocusActivation | undefined {
  const rowId = source.rowId?.trim();
  return source.kind === 'sidebar' && rowId !== undefined && rowId.length > 0
    ? { kind: 'sidebar', rowId }
    : undefined;
}

function focusActivationOptions(activation: PdfAnnotationFocusActivation | undefined): {
  readonly activation?: PdfAnnotationFocusActivation | undefined;
} {
  return activation === undefined ? {} : { activation };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
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
