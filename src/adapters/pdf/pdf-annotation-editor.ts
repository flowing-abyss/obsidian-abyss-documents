import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { beginReaderTimedOperation } from '../../reader-performance.js';
import type { PdfCommentBridge } from './pdf-comment-bridge.js';
import type { PdfSelectionObserver, PdfTextSelection } from './pdf-selection-observer.js';

const SELECTION_TRANSACTION_TIMEOUT_MS = 2_000;

export type PdfAnnotationLogicalMode =
  'neutral' | 'one-shot' | 'quick-highlight' | 'ink' | 'freetext' | 'disabled';

export type PdfEditableAnnotationKind = 'highlight' | 'ink' | 'freetext';

export type PdfSelectionAction =
  | { readonly kind: 'highlight'; readonly color: string }
  | { readonly kind: 'comment'; readonly color: string; readonly seed: '' | '[[' | '#' };

export interface PdfAnnotationInteraction {
  onSelection(listener: (selection: PdfTextSelection | null) => void): () => void;
  onMode(listener: (mode: PdfAnnotationLogicalMode) => void): () => void;
  commitSelection(
    token: string,
    action: PdfSelectionAction,
    signal?: AbortSignal,
  ): Promise<'created' | 'dismissed'>;
  setQuickHighlight(state: { readonly enabled: boolean; readonly color: string }): Promise<void>;
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
  readonly firstSelectedEditor?:
    | {
        readonly mode?: number | undefined;
        readonly uid?: string | undefined;
      }
    | undefined;
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
  readonly commentBridge: Pick<PdfCommentBridge, 'reserveNextDialog'>;
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
  readonly reject: (reason: Error) => void;
  readonly listener: (event: unknown) => void;
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
  readonly manager: PdfAnnotationUiManager;
  readonly restoreNeutral: boolean;
  readonly revision: number;
}

interface ContextualEditSession {
  closing: Promise<void> | null;
  guarded: boolean;
  readonly id: string;
  readonly manager: PdfAnnotationUiManager;
  readonly mode: number;
  readonly onEditorsRendered: (event: unknown) => void;
  phase: 'awaiting-selection' | 'selected' | 'closing';
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
  private readonly dirtyListeners = new Set<(dirty: boolean) => void>();
  private readonly editorAddedListeners = new Set<(type: number | null) => void>();
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

  constructor(private readonly dependencies: PdfAnnotationEditorDependencies) {
    this.storage = dependencies.pdf.annotationStorage;
    dependencies.eventBus.on('annotationeditoruimanager', this.onManager);
    dependencies.eventBus.on('annotationeditormodechanged', this.onNativeMode);
    dependencies.eventBus.on('editingstateschanged', this.onEditingState);
  }

  async setTool(tool: PdfAnnotationTool, options: PdfAnnotationToolOptions = {}): Promise<void> {
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

  get hasContextualEdit(): boolean {
    return this.contextualEditSession !== null;
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
  ): Promise<'created' | 'dismissed'> {
    if (this.dependencies.selectionObserver.validate(token) === 'stale') return 'dismissed';
    const manager = this.requireManager();
    if (this.logicalMode !== 'neutral') return 'dismissed';
    if (signal?.aborted === true) throw abortReason(signal);
    const transaction = this.beginSelectionTransaction(signal);
    try {
      manager.updateParams(
        this.dependencies.annotationEditorParamsType.HIGHLIGHT_COLOR,
        action.color,
      );
      this.setLogicalMode('one-shot');
      await waitWithSignal(
        this.changeMode(this.dependencies.annotationEditorType.HIGHLIGHT),
        transaction.controller.signal,
      );
      if (this.dependencies.selectionObserver.validate(token) === 'stale') {
        await waitWithSignal(
          this.changeMode(this.dependencies.annotationEditorType.NONE),
          transaction.controller.signal,
        );
        return 'dismissed';
      }
      if (action.kind === 'highlight') {
        await this.createSelectionHighlight(manager, transaction);
      } else {
        await this.createSelectionComment(manager, action.seed, transaction);
      }
      await waitWithSignal(
        this.changeMode(this.dependencies.annotationEditorType.NONE),
        transaction.controller.signal,
      );
      return 'created';
    } catch (cause) {
      const failure = asError(cause);
      await this.abortSelectionTransaction(failure);
      throw failure;
    } finally {
      this.finishSelectionTransaction(transaction);
    }
  }

  private async createSelectionHighlight(
    manager: PdfAnnotationUiManager,
    transaction: PendingSelectionTransaction,
  ): Promise<void> {
    const created = deferred<void>();
    const unsubscribe = this.onEditorAdded((type) => {
      if (type === this.dependencies.annotationEditorType.HIGHLIGHT) {
        created.resolve(undefined);
      }
    });
    try {
      manager.highlightSelection('abyss-selection');
      await waitWithSignal(created.promise, transaction.controller.signal);
    } finally {
      unsubscribe();
    }
  }

  private async createSelectionComment(
    manager: PdfAnnotationUiManager,
    seed: '' | '[[' | '#',
    transaction: PendingSelectionTransaction,
  ): Promise<void> {
    const reservation = this.dependencies.commentBridge.reserveNextDialog(
      seed,
      transaction.controller.signal,
    );
    manager.commentSelection('abyss-selection');
    await waitWithSignal(reservation.opened, transaction.controller.signal);
    transaction.clearTimeout();
    await waitWithSignal(reservation.closed, transaction.controller.signal);
    transaction.armTimeout();
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
    const transaction = this.pendingSelectionTransaction;
    if (transaction !== null) {
      await this.abortAndWaitForTransaction(transaction, new DOMException(message, 'AbortError'));
      return;
    }
    const contextual = this.contextualEditSession;
    if (contextual === null) return;
    await this.closeContextualEditSession(contextual);
  }

  private async changeMode(mode: number, options: PdfAnnotationModeOptions = {}): Promise<void> {
    if (this.dependencies.viewer.annotationEditorMode === mode) return;
    this.cancelPendingModeChange('The PDF annotation tool change was superseded.');
    await new Promise<void>((resolve, reject) => {
      let timeoutId: number | null = window.setTimeout(() => {
        const pending = this.pendingModeChange;
        if (pending?.listener !== listener) return;
        this.pendingModeChange = null;
        this.dependencies.eventBus.off('annotationeditormodechanged', listener);
        timeoutId = null;
        reject(
          new DOMException('Changing the PDF annotation editor mode timed out.', 'TimeoutError'),
        );
      }, SELECTION_TRANSACTION_TIMEOUT_MS);
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
        const pending = this.pendingModeChange;
        if (pending !== null && pending.listener === listener) this.pendingModeChange = null;
        resolve();
      };
      this.pendingModeChange = { clearTimeout, listener, reject };
      this.dependencies.eventBus.on('annotationeditormodechanged', listener);
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
        this.pendingModeChange = null;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  setParameter(parameter: PdfAnnotationParameter, value: unknown): Promise<void> {
    return this.runOrQueueMutation((manager) => {
      manager.updateParams(this.parameterFor(parameter), value);
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

  /** Signals that PDF.js successfully mutated a native editor object outside AnnotationStorage. */
  notifyNativeMutation(): void {
    this.requireManager();
    this.emitDirty(true);
  }

  async save(signal: AbortSignal): Promise<Uint8Array> {
    const prepared = this.prepareSave(signal);
    const context = prepared instanceof Promise ? await prepared : prepared;
    const { manager, restoreNeutral, revision } = context;
    const finishSerialization = beginReaderTimedOperation('annotation-serialization');
    let outcome: { bytes: Uint8Array | null; failure: Error | null } = {
      bytes: null,
      failure: null,
    };
    let restoredMode: number | null = null;
    try {
      restoredMode = await this.pauseForSave(manager, revision, signal);
      if (restoreNeutral) restoredMode = this.dependencies.annotationEditorType.NONE;
      outcome = { bytes: await this.captureBytes(manager, revision, signal), failure: null };
    } catch (cause) {
      outcome = { bytes: null, failure: asError(cause) };
    } finally {
      const queuedIntents: QueuedToolIntent[] = [];
      let targetMode = restoredMode;
      let targetOptions: PdfAnnotationModeOptions = {};
      let restoreFailure: Error | null = null;
      do {
        const queued = this.takeQueuedToolIntent();
        if (queued !== null) {
          queuedIntents.push(queued);
          targetMode = this.modeFor(queued.tool);
          targetOptions = queued.options;
        }
        restoreFailure = await this.restoreAfterSave({
          manager,
          mode: targetMode,
          options: targetOptions,
          revision,
        });
      } while (restoreFailure === null && this.queuedToolIntent !== null);
      const failedDuringRestore = this.takeQueuedToolIntent();
      if (failedDuringRestore !== null) queuedIntents.push(failedDuringRestore);
      this.releaseSave(manager, revision);
      for (const queued of queuedIntents) this.settleQueuedToolIntent(queued, restoreFailure);
      outcome.failure ??= restoreFailure;
      finishSerialization();
    }
    return this.requireSaveBytes(outcome);
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
    const restoreNeutral = this.contextualEditSession !== null;
    const manager = this.requireManager();
    const revision = this.lifecycleRevision;
    const pendingAbort = this.abortInteractionForSave();
    if (pendingAbort === null) {
      return this.beginPreparedSave(manager, revision, restoreNeutral, signal);
    }
    return pendingAbort.then(() => {
      return this.beginPreparedSave(manager, revision, restoreNeutral, signal);
    });
  }

  private beginPreparedSave(
    manager: PdfAnnotationUiManager,
    revision: number,
    restoreNeutral: boolean,
    signal: AbortSignal,
  ): PreparedSave {
    if (manager !== this.manager || revision !== this.lifecycleRevision || this.destroyed) {
      throw this.staleError();
    }
    this.beginSave(signal);
    return { manager, restoreNeutral, revision };
  }

  private abortInteractionForSave(): Promise<void> | null {
    const pendingSelection = this.pendingSelectionTransaction;
    if (pendingSelection !== null) {
      return this.abortAndWaitForTransaction(
        pendingSelection,
        new DOMException('Saving aborted the PDF annotation interaction.', 'AbortError'),
      );
    }
    const contextual = this.contextualEditSession;
    return contextual === null ? null : this.closeContextualEditSession(contextual);
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
    readonly manager: PdfAnnotationUiManager;
    readonly mode: number | null;
    readonly options?: PdfAnnotationModeOptions | undefined;
    readonly revision: number;
  }): Promise<Error | null> {
    const { manager, mode, options = {}, revision } = context;
    if (
      mode === null ||
      manager !== this.manager ||
      revision !== this.lifecycleRevision ||
      this.destroyed
    ) {
      return null;
    }
    try {
      await this.changeMode(mode, options);
      return null;
    } catch (cause) {
      return asError(cause);
    }
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
    this.releaseContextualEditSession();
    const transaction = this.pendingSelectionTransaction;
    void this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was detached.', 'AbortError'),
    ).catch(() => undefined);
    this.managerEventsEnabled = false;
    this.lifecycleRevision += 1;
    if (transaction === null) {
      this.cancelPendingModeChange('The PDF annotation editor was detached from its document.');
    }
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
    const transaction = this.pendingSelectionTransaction;
    void this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was destroyed.', 'AbortError'),
    ).catch(() => undefined);
    this.destroyed = true;
    this.lifecycleRevision += 1;
    this.dependencies.eventBus.off('annotationeditoruimanager', this.onManager);
    this.dependencies.eventBus.off('annotationeditormodechanged', this.onNativeMode);
    this.dependencies.eventBus.off('editingstateschanged', this.onEditingState);
    if (transaction === null) {
      this.cancelPendingModeChange('The PDF annotation editor was destroyed.');
    }
    this.cancelQueuedToolIntent('The PDF annotation editor was destroyed.');
    this.cancelQueuedMutations();
    this.restoreCallbacks();
    this.manager = null;
    this.dirtyListeners.clear();
    this.editorAddedListeners.clear();
    this.modeListeners.clear();
    this.releaseContextualEditSession();
  }

  private readonly onManager = (event: unknown): void => {
    if (this.destroyed || !this.managerEventsEnabled) return;
    const data = record(event);
    if (data?.['source'] !== this.dependencies.viewer) return;
    const manager = data['uiManager'];
    if (!this.isUiManager(manager)) return;
    if (this.retiredManagers.has(manager)) return;
    const transaction = this.pendingSelectionTransaction;
    void this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was rebound.', 'AbortError'),
    ).catch(() => undefined);
    this.lifecycleRevision += 1;
    if (transaction === null) {
      this.cancelPendingModeChange('The PDF annotation editor was rebound.');
    }
    this.cancelQueuedToolIntent('The PDF annotation editor was rebound.');
    this.cancelQueuedMutations();
    this.releaseContextualEditSession();
    this.restoreCallbacks();
    this.manager = manager;
    this.ownCallbacks();
  };

  private readonly onNativeMode = (event: unknown): void => {
    if (this.destroyed) return;
    const data = record(event);
    if (data?.['source'] !== this.dependencies.viewer || typeof data['mode'] !== 'number') return;
    const mode = data['mode'];
    if (
      this.logicalMode === 'one-shot' &&
      mode === this.dependencies.annotationEditorType.HIGHLIGHT
    ) {
      return;
    }
    if (this.contextualEditSession?.mode === mode) return;
    this.setLogicalMode(this.logicalModeForNative(mode));
  };

  private readonly onEditingState = (event: unknown): void => {
    const session = this.contextualEditSession;
    if (this.destroyed || session === null) return;
    const data = record(event);
    if (data?.['source'] !== session.manager) return;
    const details = record(data['details']);
    const hasSelectedEditor = details?.['hasSelectedEditor'];
    if (hasSelectedEditor === true) {
      if (this.isRequestedEditorSelected(session)) session.phase = 'selected';
      return;
    }
    if (hasSelectedEditor !== false || session.phase !== 'selected') return;
    void this.closeContextualEditSession(session).catch((cause: unknown) => {
      console.error('[abyss-documents] Failed to close the PDF annotation editor', { cause });
    });
  };

  private isRequestedEditorSelected(session: ContextualEditSession): boolean {
    const selected = session.manager.firstSelectedEditor;
    return selected?.uid === session.id && selected.mode === session.mode;
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

  private async containFailedContextualEntry(session: ContextualEditSession): Promise<void> {
    if (this.contextualEditSession !== session) return;
    this.guardContextualEditSession(session);
    try {
      await this.closeContextualEditSession(session);
    } catch {
      // Keep the creator gate installed when PDF.js cannot confirm NONE.
    }
  }

  private readonly onContextualEditorsRendered = (event: unknown): void => {
    const session = this.contextualEditSession;
    const pageNumber = record(event)?.['pageNumber'];
    if (session === null || !Number.isInteger(pageNumber)) return;
    this.gateContextualLayer(session, (pageNumber as number) - 1);
  };

  private guardContextualEditSession(session: ContextualEditSession): void {
    if (session.guarded) return;
    session.guarded = true;
    session.manager.disableUserSelect(true);
    for (let pageIndex = 0; pageIndex < this.dependencies.pdf.numPages; pageIndex += 1) {
      this.gateContextualLayer(session, pageIndex);
    }
    this.dependencies.eventBus.on('editorsrendered', session.onEditorsRendered);
  }

  private gateContextualLayer(session: ContextualEditSession, pageIndex: number): void {
    const layer = session.manager.getLayer(pageIndex);
    layer?.disableClick();
    layer?.disableTextSelection();
  }

  private closeContextualEditSession(session: ContextualEditSession): Promise<void> {
    if (session.closing !== null) return session.closing;
    session.phase = 'closing';
    session.closing = this.changeMode(this.dependencies.annotationEditorType.NONE).then(() => {
      this.releaseContextualEditSession(session);
    });
    return session.closing;
  }

  private releaseContextualEditSession(session = this.contextualEditSession): void {
    if (session === null) return;
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
      void this.abortSelectionTransaction(
        signal === undefined ? undefined : abortReason(signal),
      ).catch(() => undefined);
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

  private abortSelectionTransaction(reason?: Error): Promise<void> {
    const transaction = this.pendingSelectionTransaction;
    if (transaction === null) return Promise.resolve();
    if (transaction.restoration !== null) return transaction.restoration;
    const failure =
      reason ?? new DOMException('The PDF annotation interaction was cancelled.', 'AbortError');
    transaction.controller.abort(failure);
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
      for (const listener of [...this.editorAddedListeners]) listener(type);
    };
    const ownedSet = (): void => {
      previousSet?.();
      this.emitDirty(true);
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
    return (
      typeof data?.['commentSelection'] === 'function' &&
      typeof data['disableUserSelect'] === 'function' &&
      typeof data['endCurrentEditing'] === 'function' &&
      typeof data['getLayer'] === 'function' &&
      typeof data['delete'] === 'function' &&
      typeof data['highlightSelection'] === 'function' &&
      typeof data['updateParams'] === 'function' &&
      typeof data['undo'] === 'function' &&
      typeof data['redo'] === 'function'
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
    pending.reject(new DOMException(message, 'AbortError'));
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

function asError(cause: unknown): Error {
  if (typeof cause === 'object' && cause !== null && 'name' in cause && 'message' in cause) {
    return cause as Error;
  }
  return cause instanceof Error ? cause : new Error(String(cause));
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
