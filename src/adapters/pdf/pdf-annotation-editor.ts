import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { beginReaderTimedOperation } from '../../reader-performance.js';
import type { PdfCommentBridge } from './pdf-comment-bridge.js';
import type { PdfSelectionObserver, PdfTextSelection } from './pdf-selection-observer.js';

const SELECTION_TRANSACTION_TIMEOUT_MS = 2_000;

export type PdfAnnotationLogicalMode =
  'neutral' | 'one-shot' | 'quick-highlight' | 'ink' | 'freetext' | 'disabled';

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
  readonly mode: number;
}

interface PdfAnnotationUiManager {
  commentSelection(methodOfCreation?: string): void;
  delete(): void;
  endCurrentEditing(): void;
  highlightSelection(methodOfCreation?: string): void;
  redo(): void;
  undo(): void;
  updateParams(type: number, value: unknown): void;
}

interface MutableAnnotationStorage {
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
  readonly ownedReset: () => void;
  readonly ownedSet: () => void;
  readonly previousReset: (() => void) | null;
  readonly previousSet: (() => void) | null;
}

interface PendingModeChange {
  readonly reject: (reason: Error) => void;
  readonly listener: (event: unknown) => void;
}

interface QueuedToolIntent {
  options: PdfAnnotationToolOptions;
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

interface PendingSelectionTransaction {
  readonly controller: AbortController;
  readonly clearTimeout: () => void;
  readonly settled: ReturnType<typeof deferred<void>>;
  readonly removeExternalAbort: () => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export class PdfAnnotationEditor {
  private readonly dirtyListeners = new Set<(dirty: boolean) => void>();
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

  constructor(private readonly dependencies: PdfAnnotationEditorDependencies) {
    this.storage = dependencies.pdf.annotationStorage;
    dependencies.eventBus.on('annotationeditoruimanager', this.onManager);
    dependencies.eventBus.on('annotationeditormodechanged', this.onNativeMode);
  }

  async setTool(tool: PdfAnnotationTool, options: PdfAnnotationToolOptions = {}): Promise<void> {
    this.requireManager();
    if (this.saving) return this.queueToolIntent(tool, options);
    const mode = this.modeFor(tool);
    await this.changeMode(mode, options);
  }

  onSelection(listener: (selection: PdfTextSelection | null) => void): () => void {
    return this.dependencies.selectionObserver.onSelection(listener);
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
    const manager = this.requireManager();
    if (this.dependencies.selectionObserver.validate(token) === 'stale') return 'dismissed';
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
        const dirty = deferred<void>();
        const unsubscribe = this.onDirty((value) => {
          if (value) dirty.resolve(undefined);
        });
        try {
          manager.highlightSelection('abyss-selection');
          await waitWithSignal(dirty.promise, transaction.controller.signal);
        } finally {
          unsubscribe();
        }
      } else {
        const reservation = this.dependencies.commentBridge.reserveNextDialog(
          action.seed,
          transaction.controller.signal,
        );
        manager.commentSelection('abyss-selection');
        await waitWithSignal(reservation.opened, transaction.controller.signal);
        await waitWithSignal(reservation.closed, transaction.controller.signal);
      }
      await waitWithSignal(
        this.changeMode(this.dependencies.annotationEditorType.NONE),
        transaction.controller.signal,
      );
      return 'created';
    } catch (cause) {
      this.abortSelectionTransaction(asError(cause));
      throw cause;
    } finally {
      this.finishSelectionTransaction(transaction);
    }
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
    if (transaction === null) return;
    this.abortSelectionTransaction(new DOMException(message, 'AbortError'));
    await transaction.settled.promise;
  }

  private async changeMode(mode: number, options: PdfAnnotationToolOptions = {}): Promise<void> {
    if (this.dependencies.viewer.annotationEditorMode === mode) return;
    this.cancelPendingModeChange('The PDF annotation tool change was superseded.');
    await new Promise<void>((resolve, reject) => {
      const listener = (event: unknown): void => {
        const data = record(event);
        if (data?.['source'] !== this.dependencies.viewer || data['mode'] !== mode) return;
        this.dependencies.eventBus.off('annotationeditormodechanged', listener);
        const pending = this.pendingModeChange;
        if (pending !== null && pending.listener === listener) this.pendingModeChange = null;
        resolve();
      };
      this.pendingModeChange = { listener, reject };
      this.dependencies.eventBus.on('annotationeditormodechanged', listener);
      try {
        this.dependencies.viewer.annotationEditorMode =
          options.isFromKeyboard === undefined
            ? { mode }
            : { mode, isFromKeyboard: options.isFromKeyboard };
      } catch (cause) {
        this.dependencies.eventBus.off('annotationeditormodechanged', listener);
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
    const manager = prepared instanceof Promise ? await prepared : prepared;
    const finishSerialization = beginReaderTimedOperation('annotation-serialization');
    const revision = this.lifecycleRevision;
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
      const queuedIntents: QueuedToolIntent[] = [];
      let targetMode = restoredMode;
      let targetOptions: PdfAnnotationToolOptions = {};
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

  private prepareSave(
    signal: AbortSignal,
  ): PdfAnnotationUiManager | Promise<PdfAnnotationUiManager> {
    const manager = this.requireManager();
    const pendingAbort = this.abortInteractionForSave();
    if (pendingAbort === null) {
      this.beginSave(signal);
      return manager;
    }
    return pendingAbort.then(() => {
      this.beginSave(signal);
      return manager;
    });
  }

  private abortInteractionForSave(): Promise<void> | null {
    const pendingSelection = this.pendingSelectionTransaction;
    if (pendingSelection === null) return null;
    this.abortSelectionTransaction(
      new DOMException('Saving aborted the PDF annotation interaction.', 'AbortError'),
    );
    return pendingSelection.settled.promise;
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
    readonly options?: PdfAnnotationToolOptions | undefined;
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
    if (manager !== this.manager || revision !== this.lifecycleRevision) throw this.staleError();
  }

  detachFromDocument(): void {
    if (this.destroyed) return;
    this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was detached.', 'AbortError'),
    );
    this.managerEventsEnabled = false;
    this.lifecycleRevision += 1;
    this.cancelPendingModeChange('The PDF annotation editor was detached from its document.');
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
    this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was destroyed.', 'AbortError'),
    );
    this.destroyed = true;
    this.lifecycleRevision += 1;
    this.dependencies.eventBus.off('annotationeditoruimanager', this.onManager);
    this.dependencies.eventBus.off('annotationeditormodechanged', this.onNativeMode);
    this.cancelPendingModeChange('The PDF annotation editor was destroyed.');
    this.cancelQueuedToolIntent('The PDF annotation editor was destroyed.');
    this.cancelQueuedMutations();
    this.restoreCallbacks();
    this.manager = null;
    this.dirtyListeners.clear();
    this.modeListeners.clear();
  }

  private readonly onManager = (event: unknown): void => {
    if (this.destroyed || !this.managerEventsEnabled) return;
    const data = record(event);
    if (data?.['source'] !== this.dependencies.viewer) return;
    const manager = data['uiManager'];
    if (!this.isUiManager(manager)) return;
    if (this.retiredManagers.has(manager)) return;
    this.abortSelectionTransaction(
      new DOMException('The PDF annotation interaction was rebound.', 'AbortError'),
    );
    this.lifecycleRevision += 1;
    this.cancelPendingModeChange('The PDF annotation editor was rebound.');
    this.cancelQueuedToolIntent('The PDF annotation editor was rebound.');
    this.cancelQueuedMutations();
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
    this.setLogicalMode(this.logicalModeForNative(mode));
  };

  private setLogicalMode(mode: PdfAnnotationLogicalMode): void {
    if (this.logicalMode === mode) return;
    this.logicalMode = mode;
    for (const listener of [...this.modeListeners]) listener(mode);
  }

  private beginSelectionTransaction(signal: AbortSignal | undefined): PendingSelectionTransaction {
    const controller = new AbortController();
    let timeoutId: number | null = null;
    const onExternalAbort = (): void => {
      this.abortSelectionTransaction(signal === undefined ? undefined : abortReason(signal));
    };
    if (signal !== undefined) signal.addEventListener('abort', onExternalAbort, { once: true });
    const transaction: PendingSelectionTransaction = {
      controller,
      clearTimeout: () => {
        if (timeoutId === null) return;
        window.clearTimeout(timeoutId);
        timeoutId = null;
      },
      settled: deferred<void>(),
      removeExternalAbort: () => {
        signal?.removeEventListener('abort', onExternalAbort);
      },
    };
    this.pendingSelectionTransaction = transaction;
    timeoutId = window.setTimeout(() => {
      this.abortSelectionTransaction(
        new DOMException('The PDF annotation interaction timed out.', 'TimeoutError'),
      );
    }, SELECTION_TRANSACTION_TIMEOUT_MS);
    return transaction;
  }

  private finishSelectionTransaction(transaction: PendingSelectionTransaction): void {
    transaction.removeExternalAbort();
    transaction.clearTimeout();
    if (this.pendingSelectionTransaction === transaction) this.pendingSelectionTransaction = null;
    transaction.settled.resolve(undefined);
  }

  private abortSelectionTransaction(reason?: Error): void {
    const transaction = this.pendingSelectionTransaction;
    if (transaction === null || transaction.controller.signal.aborted) return;
    const failure =
      reason ?? new DOMException('The PDF annotation interaction was cancelled.', 'AbortError');
    transaction.controller.abort(failure);
    this.cancelPendingModeChange(failure.message);
    try {
      if (
        this.dependencies.viewer.annotationEditorMode !==
        this.dependencies.annotationEditorType.NONE
      ) {
        this.dependencies.viewer.annotationEditorMode = {
          mode: this.dependencies.annotationEditorType.NONE,
        };
      }
    } catch (cause) {
      console.error('[abyss-documents] Failed to restore the PDF annotation editor mode', {
        cause,
      });
    }
    this.setLogicalMode('neutral');
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
    const previousSet = this.storage.onSetModified;
    const previousReset = this.storage.onResetModified;
    const ownedSet = (): void => {
      previousSet?.();
      this.emitDirty(true);
    };
    const ownedReset = (): void => {
      previousReset?.();
      this.emitDirty(false);
    };
    this.callbackOwnership = { ownedReset, ownedSet, previousReset, previousSet };
    this.storage.onSetModified = ownedSet;
    this.storage.onResetModified = ownedReset;
  }

  private restoreCallbacks(): void {
    const ownership = this.callbackOwnership;
    this.callbackOwnership = null;
    if (ownership === null) return;
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

  private queueToolIntent(
    tool: PdfAnnotationTool,
    options: PdfAnnotationToolOptions,
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
      typeof data['endCurrentEditing'] === 'function' &&
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
