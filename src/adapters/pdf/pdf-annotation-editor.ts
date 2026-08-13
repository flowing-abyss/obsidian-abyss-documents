import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';

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
  delete(): void;
  endCurrentEditing(): void;
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export class PdfAnnotationEditor {
  private readonly dirtyListeners = new Set<(dirty: boolean) => void>();
  private readonly storage: MutableAnnotationStorage;
  private callbackOwnership: CallbackOwnership | null = null;
  private manager: PdfAnnotationUiManager | null = null;
  private managerEventsEnabled = true;
  private pendingModeChange: PendingModeChange | null = null;
  private readonly retiredManagers = new WeakSet<object>();
  private destroyed = false;
  private lifecycleRevision = 0;
  private saving = false;

  constructor(private readonly dependencies: PdfAnnotationEditorDependencies) {
    this.storage = dependencies.pdf.annotationStorage;
    dependencies.eventBus.on('annotationeditoruimanager', this.onManager);
  }

  async setTool(tool: PdfAnnotationTool, options: PdfAnnotationToolOptions = {}): Promise<void> {
    this.requireManager();
    if (this.saving) {
      throw new DOMException('The PDF annotation editor is capturing a save.', 'InvalidStateError');
    }
    const mode = this.modeFor(tool);
    await this.changeMode(mode, options);
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

  setParameter(parameter: PdfAnnotationParameter, value: unknown): void {
    this.requireManager().updateParams(this.parameterFor(parameter), value);
  }

  undo(): void {
    this.requireManager().undo();
  }

  redo(): void {
    this.requireManager().redo();
  }

  deleteSelection(): void {
    this.requireManager().delete();
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
    const manager = this.requireManager();
    this.beginSave(signal);
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
      outcome.failure = await this.restoreAfterSave(
        manager,
        revision,
        restoredMode,
        outcome.failure,
      );
      this.saving = false;
    }
    if (outcome.failure !== null) throw outcome.failure;
    if (outcome.bytes === null) throw this.staleError();
    return outcome.bytes;
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
    return Uint8Array.from(bytes);
  }

  private async restoreAfterSave(
    manager: PdfAnnotationUiManager,
    revision: number,
    mode: number | null,
    failure: Error | null,
  ): Promise<Error | null> {
    if (
      mode === null ||
      manager !== this.manager ||
      revision !== this.lifecycleRevision ||
      this.destroyed
    ) {
      return failure;
    }
    try {
      await this.changeMode(mode);
      return failure;
    } catch (cause) {
      return failure ?? asError(cause);
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
    this.managerEventsEnabled = false;
    this.lifecycleRevision += 1;
    this.cancelPendingModeChange('The PDF annotation editor was detached from its document.');
    if (this.manager !== null) this.retiredManagers.add(this.manager);
    this.restoreCallbacks();
    this.manager = null;
  }

  resumeDocumentLifecycle(): void {
    if (!this.destroyed) this.managerEventsEnabled = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifecycleRevision += 1;
    this.dependencies.eventBus.off('annotationeditoruimanager', this.onManager);
    this.cancelPendingModeChange('The PDF annotation editor was destroyed.');
    this.restoreCallbacks();
    this.manager = null;
    this.dirtyListeners.clear();
  }

  private readonly onManager = (event: unknown): void => {
    if (this.destroyed || !this.managerEventsEnabled) return;
    const data = record(event);
    if (data?.['source'] !== this.dependencies.viewer) return;
    const manager = data['uiManager'];
    if (!this.isUiManager(manager)) return;
    if (this.retiredManagers.has(manager)) return;
    this.lifecycleRevision += 1;
    this.cancelPendingModeChange('The PDF annotation editor was rebound.');
    this.restoreCallbacks();
    this.manager = manager;
    this.ownCallbacks();
  };

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
      typeof data?.['endCurrentEditing'] === 'function' &&
      typeof data['delete'] === 'function' &&
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
