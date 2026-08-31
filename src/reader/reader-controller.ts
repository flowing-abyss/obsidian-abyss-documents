import { Notice, type TFile } from 'obsidian';
import type {
  PdfAnnotationEditor,
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfAnnotationTool,
} from '../adapters/pdf/pdf-annotation-editor.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import { StaleAnnotationCacheReadError, type AnnotationCache } from '../annotation-cache.js';
import { decodeAnnotationComment } from '../annotation-tokens.js';
import { AutosaveScheduler, type SaveReason } from '../autosave-scheduler.js';
import type {
  AnnotationExportRecord,
  AnnotationSink,
  DocumentAnnotation,
} from '../document-core/annotations.js';
import type { DocumentAdapterRegistry } from '../document-core/document-adapter.js';
import type {
  DocumentLocation,
  DocumentSession,
  DocumentViewport,
  PdfPageRect,
  SearchHit,
  ViewportEvent,
} from '../document-core/document.js';
import { DocumentCancelledError, DocumentOpenError } from '../document-core/errors.js';
import {
  DEFAULT_READER_LAYOUT,
  type ReaderLayout,
  type ReaderScale,
  type ReadingProfileId,
} from '../document-core/reading.js';
import {
  SaveConflictError,
  isNativeSaveRecoveryFailure,
  type BaseToken,
  type DocumentSaveCoordinator,
  type NativeDocumentSaveRequest,
  type NativeEditableSaveSession,
  type NativeSaveRecoveryFailure,
  type VerifiedReloadListener,
  type VerifiedReloadSource,
} from '../document-core/save-coordinator.js';
import {
  beginReaderTimedOperation,
  incrementReaderCounter,
  markReaderPerformance,
  markReaderPerformanceOnce,
  readerPerformanceSnapshot,
  recordSuccessfulAnnotationSave,
} from '../reader-performance.js';
import { DEFAULT_SETTINGS, type PluginSettings } from '../settings.js';
import type {
  AnnotationEditorCreation,
  AnnotationEditorUpdate,
} from './annotation-editor-popover.js';
import {
  AnnotationInteractionController,
  type AnnotationInteractionControllerOptions,
} from './annotation-interaction-controller.js';
import {
  AnnotationProjection,
  withoutViewportObservationIdentities,
  type AnnotationProjectionRow,
  type AnnotationProjectionViewportEvent,
  type AnnotationProjectionViewportObservation,
} from './annotation-projection.js';
import type { AnnotationToolbarIntent } from './annotation-toolbar.js';
import {
  applyAnnotationTransfer,
  resolveAnnotationHref,
  type AnnotationHrefReference,
  type AnnotationTransferService,
} from './annotation-transfer.js';
import { annotationLocation, type AnnotationPanelActivation } from './annotations-panel.js';
import { ReaderShell, type ReaderShellIntent } from './reader-shell.js';
import { ReadingProfileService, type ObsidianTheme } from './reading-profiles.js';
import type { SaveConflictAction } from './save-conflict-modal.js';
import { SaveFailureNoticeBoundary } from './save-failure-boundary.js';
import type { ReaderSidebarCallbacks, ReaderSidebarTab } from './sidebar.js';

export type ShellFactory = (
  host: HTMLElement,
  onIntent: (intent: ReaderShellIntent) => void,
  options: { readonly sourcePath: string },
) => ReaderShell;

export interface ReaderProfileState {
  readonly annotations?: PluginSettings['annotations'];
  readonly reading: PluginSettings['reading'];
  readonly layout: PluginSettings['layout'];
  readonly profileByFingerprint: Readonly<Record<string, ReadingProfileId>>;
  readonly layoutByFingerprint: Readonly<Record<string, ReaderLayout>>;
  updateLayoutForFingerprint(fingerprint: string, layout: ReaderLayout): void | Promise<void>;
  updateProfileForFingerprint(fingerprint: string, profile: ReadingProfileId): void | Promise<void>;
}

export interface AnnotationSaveLifecycleSnapshot {
  readonly activeSerializations: number;
  readonly activeWrites: number;
  readonly committedRevision: number;
  readonly failures: number;
  readonly inFlight: boolean;
  readonly isDirty: boolean;
  readonly newestGeneration: number;
  readonly paused: boolean;
  readonly pendingRevision: number;
  readonly recoveries: number;
  readonly savedGeneration: number;
  readonly saves: number;
}

/** Narrow test-only fault contract for annotation cache/extraction acceptance scenarios. */
export interface AnnotationLoadTestFault {
  readonly cacheRead?: 'fail';
  readonly extractionDelayMs?: number;
  readonly extractionFailure?: boolean;
}

/** Read-only test telemetry for deterministic annotation-load fault acceptance scenarios. */
export interface AnnotationLoadTestSnapshot {
  readonly cacheReadFaults: number;
  readonly extractionFaults: number;
  readonly loadsFailed: number;
  readonly loadsSettled: number;
  readonly loadsStarted: number;
}

interface MutableAnnotationLoadTestSnapshot {
  cacheReadFaults: number;
  extractionFaults: number;
  loadsFailed: number;
  loadsSettled: number;
  loadsStarted: number;
}

function emptyAnnotationLoadTestSnapshot(): MutableAnnotationLoadTestSnapshot {
  return {
    cacheReadFaults: 0,
    extractionFaults: 0,
    loadsFailed: 0,
    loadsSettled: 0,
    loadsStarted: 0,
  };
}

const DEFAULT_PROFILE_STATE: ReaderProfileState = {
  reading: DEFAULT_SETTINGS.reading,
  layout: DEFAULT_SETTINGS.layout,
  profileByFingerprint: {},
  layoutByFingerprint: {},
  updateLayoutForFingerprint: () => undefined,
  updateProfileForFingerprint: () => undefined,
};

interface LayoutPolicySnapshot {
  readonly default: ReaderLayout;
  readonly rememberPerDocument: boolean;
}

interface ReaderControllerServices {
  readonly annotationCache?: AnnotationCache;
  readonly profileService?: ReadingProfileService;
  readonly saveCoordinator?: Pick<DocumentSaveCoordinator, 'save'> &
    Partial<Pick<DocumentSaveCoordinator, 'inspectRecovery' | 'recover' | 'register'>>;
  readonly resolveSaveConflict?: (path: string) => Promise<SaveConflictAction>;
  readonly confirmSaveRecovery?: (path: string, current: BaseToken) => Promise<boolean>;
  readonly saveFailureBoundary?: SaveFailureNoticeBoundary;
  readonly annotationTransfer?: Pick<
    AnnotationTransferService,
    'build' | 'copyAnnotationLink' | 'insertAnnotationIntoActiveMarkdown'
  >;
  readonly annotationExporter?: {
    run(source: TFile, records: readonly AnnotationExportRecord[]): Promise<TFile | null>;
  };
}

interface NativeEditableSessionFactory extends DocumentSession {
  createNativeEditableSession(
    onRevision: (revision: number) => void,
  ): NativeEditableSaveSession | null;
}

interface NativeRevisionWrite {
  readonly native: NativeEditableSaveSession;
  readonly reason: SaveReason;
  readonly revision: number;
  readonly session: DocumentSession;
}

interface AnnotationEditorViewport extends DocumentViewport {
  readonly annotationEditor: PdfAnnotationEditor | null;
}

interface AnnotationInteractionViewport extends DocumentViewport {
  readonly annotationInteraction: PdfAnnotationInteraction | null;
}

interface AnnotationSelectionProjectionViewport extends DocumentViewport {
  projectSelectionRects(selection: PdfTextSelection): readonly PdfPageRect[];
}

interface AnnotationToolRequest {
  readonly color: string | null;
  readonly editor: PdfAnnotationEditor;
  readonly previous: PdfAnnotationTool;
  readonly revision: number;
  readonly shell: ReaderShell;
  readonly tool: PdfAnnotationTool;
  readonly viewport: DocumentViewport;
}

interface AnnotationSelectionRetryRequest {
  readonly nativeId: string;
}

interface NavigationOptions {
  readonly annotationSelectionRetry?: AnnotationSelectionRetryRequest;
  readonly onArrive?: () => void;
  readonly onFailure?: () => void;
  readonly retainAnnotationActivation?: boolean;
}

interface NavigationFailureContext {
  readonly cause: unknown;
  readonly onFailure: (() => void) | undefined;
  readonly revision: number;
  readonly shell: ReaderShell;
  readonly target: number;
  readonly viewport: DocumentViewport;
}

interface PendingAnnotationSelectionRetry {
  attempts: number;
  readonly nativeId: string;
  readonly pageIndex: number;
  readonly shell: ReaderShell;
  timeoutId: number;
  readonly viewport: DocumentViewport;
}

type ContextViewportEvent = Extract<
  ViewportEvent,
  {
    readonly type: 'annotation-layer-rendered' | 'annotation-select' | 'geometry-change';
  }
>;

type WritableAnnotationTool = Exclude<PdfAnnotationTool, 'select'>;

const ANNOTATION_SELECTION_RETRY_LIMIT = 3;
const ANNOTATION_SELECTION_RETRY_TIMEOUT_MS = 2_000;

interface CleanPeerReloadContext {
  readonly file: TFile;
  readonly host: HTMLElement;
  readonly lifecycleGeneration: number;
  readonly native: NativeEditableSaveSession;
  readonly scheduler: AutosaveScheduler;
  readonly session: DocumentSession;
}

interface VerifiedAnnotationMarker {
  readonly file: TFile;
  readonly projectionRevision: number;
  readonly revision: number;
  readonly session: DocumentSession & AnnotationListingSession;
  readonly shell: ReaderShell;
  readonly source: VerifiedReloadSource;
  readonly token: BaseToken;
}

interface VerifiedAnnotationRefresh {
  readonly abort: AbortController;
  readonly marker: VerifiedAnnotationMarker;
}

type AnnotationExportPreparationStage = 'save' | 'annotation-load' | 'verified-refresh';

class AnnotationExportPreparationError extends Error {
  constructor(
    readonly path: string,
    readonly stage: AnnotationExportPreparationStage,
    readonly cause: unknown,
  ) {
    super(`Could not prepare PDF annotations for export during ${stage}.`);
    this.name = 'AnnotationExportPreparationError';
  }
}

class SaveDiscardedError extends SaveConflictError {
  constructor(conflict: SaveConflictError) {
    super(conflict.path, conflict.expected, conflict.actual);
  }
}

class AutomaticSaveDeferredError extends Error {
  constructor() {
    super('Automatic PDF annotation saving yielded to an open annotation editor.');
    this.name = 'AutomaticSaveDeferredError';
  }
}

export class ReaderController {
  private queue: Promise<void> = Promise.resolve();
  private activeOpen: AbortController | null = null;
  private lifecycleRequestGeneration = 0;
  private session: DocumentSession | null = null;
  private viewport: DocumentViewport | null = null;
  private shell: ReaderShell | null = null;
  private unsubscribeViewport: (() => void) | null = null;
  private currentPageIndex = 0;
  private navigationPageIndex = 0;
  private pendingNavigationPageIndex: number | null = null;
  private navigationRequestRevision = 0;
  private currentProfile: ReadingProfileId = 'default';
  private currentLayout: ReaderLayout = DEFAULT_READER_LAYOUT;
  private layoutPolicy = captureLayoutPolicy(DEFAULT_PROFILE_STATE.layout);
  private outlineLoadedFor: DocumentSession | null = null;
  private outlineLoadingFor: DocumentSession | null = null;
  private currentSearchQuery = '';
  private annotationAbort: AbortController | null = null;
  private annotationIntentFor: DocumentSession | null = null;
  private annotationProjectionRevision = 0;
  private readonly annotationProjection = new AnnotationProjection();
  private annotationProjectionFrame: number | null = null;
  private annotationProjectionFrameWindow: Window | null = null;
  private annotationProjectionEvents: AnnotationProjectionViewportObservation[] = [];
  private annotationLiveRevision = 0;
  private annotationsLoadedFor: DocumentSession | null = null;
  private annotationsLoadingFor: DocumentSession | null = null;
  private currentAnnotations: readonly DocumentAnnotation[] = [];
  private verifiedAnnotationAbort: AbortController | null = null;
  private verifiedAnnotationFailureCause: unknown = null;
  private verifiedAnnotationFailedMarker: VerifiedAnnotationMarker | null = null;
  private verifiedAnnotationInvalidation: Promise<void> | null = null;
  private verifiedAnnotationInvalidationFor: DocumentSession | null = null;
  private verifiedAnnotationMarker: VerifiedAnnotationMarker | null = null;
  private verifiedAnnotationRefresh: Promise<void> | null = null;
  private verifiedAnnotationRefreshFor: DocumentSession | null = null;
  private readonly annotationCache: AnnotationCache | null;
  private readonly profileService: ReadingProfileService;
  private readonly saveCoordinator: ReaderControllerServices['saveCoordinator'];
  private readonly saveFailureBoundary: SaveFailureNoticeBoundary;
  private nativeSaveSession: NativeEditableSaveSession | null = null;
  private autosave: AutosaveScheduler | null = null;
  private saveAbort: AbortController | null = null;
  private recoveryAbort: AbortController | null = null;
  private unregisterSaveBroadcast: (() => void) | null = null;
  private unregisterAnnotationEditorClose: (() => void) | null = null;
  private lastAutosaveFailureKey: string | null = null;
  private lastAnnotationFailureKey: string | null = null;
  private lastAnnotationExportPreparationFailureKey: string | null = null;
  private annotationToolRequestRevision = 0;
  private annotationInteractionController: AnnotationInteractionController | null = null;
  private annotationActivationAbort: AbortController | null = null;
  private pendingAnnotationSelectionRetry: PendingAnnotationSelectionRetry | null = null;
  private currentAnnotationTool: PdfAnnotationTool = 'select';
  private annotationToolColors = annotationToolColorDefaults(
    DEFAULT_SETTINGS.annotations.palette[0]?.color ?? '#ffd400',
  );
  private readonly saveFailureOwner = {};
  private currentFile: TFile | null = null;
  private currentHost: HTMLElement | null = null;
  private lifecycleFlushActive = false;
  private manualSaveOverrideDepth = 0;
  private readonly automaticSaveWakeListeners = new Set<() => void>();
  private annotationLoadTestFault: AnnotationLoadTestFault | null = null;
  private annotationLoadTestSnapshotState: MutableAnnotationLoadTestSnapshot =
    emptyAnnotationLoadTestSnapshot();

  constructor(
    private readonly registry: DocumentAdapterRegistry,
    private readonly createShell: ShellFactory = (host, onIntent) =>
      new ReaderShell(host, onIntent),
    private readonly profileState: ReaderProfileState = DEFAULT_PROFILE_STATE,
    private readonly services: ReaderControllerServices = {},
  ) {
    this.annotationCache = services.annotationCache ?? null;
    this.profileService = services.profileService ?? new ReadingProfileService();
    this.saveCoordinator = services.saveCoordinator;
    this.saveFailureBoundary = services.saveFailureBoundary ?? new SaveFailureNoticeBoundary();
  }

  open(file: TFile, host: HTMLElement): Promise<void> {
    markReaderPerformanceOnce('first-reader-intent');
    markReaderPerformance('reader-intent');
    return this.requestOpen(file, host, false);
  }

  private requestOpen(file: TFile, host: HTMLElement, discardCurrent: boolean): Promise<void> {
    this.lifecycleRequestGeneration += 1;
    this.activeOpen?.abort();
    const abortController = new AbortController();
    this.activeOpen = abortController;
    return this.enqueue(() => this.openOnce(file, host, abortController, discardCurrent));
  }

  close(): Promise<void> {
    this.lifecycleRequestGeneration += 1;
    this.activeOpen?.abort();
    this.activeOpen = null;
    return this.enqueue(() => this.releaseCurrent());
  }

  annotationSaveLifecycleSnapshot(): AnnotationSaveLifecycleSnapshot | null {
    const native = this.nativeSaveSession;
    const scheduler = this.autosave;
    if (native === null || scheduler === null) return null;
    const autosave = scheduler.lifecycleSnapshot();
    const performance = readerPerformanceSnapshot();
    return {
      activeSerializations: performance.activeAnnotationOperations.serializations,
      activeWrites: performance.activeAnnotationOperations.writes,
      committedRevision: native.committedRevision ?? Number.NaN,
      failures: performance.counters.annotationSaveFailures,
      inFlight: autosave.inFlight,
      isDirty: native.isDirty,
      newestGeneration: autosave.newestGeneration,
      paused: autosave.paused,
      pendingRevision: native.pendingRevision,
      recoveries: performance.counters.annotationSaveRecoveries,
      savedGeneration: autosave.savedGeneration,
      saves: performance.counters.annotationSaves,
    };
  }

  showOutline(): void {
    this.openSidebar('outline');
  }

  searchDocument(): void {
    this.openSidebar('search');
  }

  refreshReadingSettings(): void {
    const viewport = this.viewport;
    const shell = this.shell;
    const session = this.session;
    if (viewport === null || shell === null || session === null) return;
    this.annotationInteractionController?.invalidate('layout');
    this.profileService.setCustom(this.profileState.reading.custom);
    try {
      viewport.setReadingColors(
        this.profileService.resolve(this.currentProfile, shell.obsidianTheme),
      );
      const layout = this.layoutPolicyChanged()
        ? this.initialLayout(this.session?.descriptor.fingerprint ?? '')
        : { ...this.currentLayout };
      viewport.setLayout(layout);
      this.currentLayout = layout;
      shell.setLayout(layout);
      shell.toolbar.setProfile(this.currentProfile);
      this.refreshAnnotationToolbar(session, viewport, shell);
    } catch (cause) {
      console.error('[abyss-documents] Failed to refresh PDF reading settings', {
        profile: this.currentProfile,
        cause,
      });
    }
  }

  async saveDocument(): Promise<void> {
    this.manualSaveOverrideDepth += 1;
    this.wakeDeferredAutomaticSave();
    try {
      if ((await this.shell?.flushAnnotationEditor()) === false)
        throw new DOMException(
          'The annotation editor still has changes that could not be persisted.',
          'InvalidStateError',
        );
      await this.autosave?.flush();
    } finally {
      this.manualSaveOverrideDepth -= 1;
    }
  }

  setAnnotationLoadTestFault(fault: AnnotationLoadTestFault | null): void {
    this.annotationLoadTestSnapshotState = emptyAnnotationLoadTestSnapshot();
    if (fault === null) {
      this.annotationLoadTestFault = null;
      return;
    }
    const delay = fault.extractionDelayMs ?? 0;
    if (!Number.isFinite(delay) || delay < 0 || delay > 5_000)
      throw new RangeError('Annotation extraction test delay must be between 0 and 5000 ms.');
    this.annotationLoadTestFault = Object.freeze({
      ...(fault.cacheRead === undefined ? {} : { cacheRead: fault.cacheRead }),
      ...(delay === 0 ? {} : { extractionDelayMs: delay }),
      ...(fault.extractionFailure === true ? { extractionFailure: true } : {}),
    });
  }

  annotationLoadTestSnapshot(): AnnotationLoadTestSnapshot {
    return { ...this.annotationLoadTestSnapshotState };
  }

  async resolveAnnotationLink(reference: AnnotationHrefReference): Promise<boolean> {
    const shell = this.shell;
    const session = this.session;
    if (shell === null || session === null || !hasAnnotationListing(session)) return false;
    const annotations = await this.ensureAnnotationsLoaded(session, shell);
    if (this.session !== session || this.shell !== shell) return false;
    this.openSidebar('annotations');
    const resolution = resolveAnnotationHref(reference, annotations);
    if (resolution.status !== 'resolved') {
      this.reportAnnotationResolutionFailure(shell, session, reference, resolution);
      return false;
    }
    const id =
      resolution.annotation.identity.kind === 'stable'
        ? resolution.annotation.identity.id
        : resolution.annotation.identity.fingerprint;
    shell.sidebar?.annotationsPanel.selectAnnotation(id);
    this.navigateToLocation(annotationLocation(resolution.annotation));
    return true;
  }

  private reportAnnotationResolutionFailure(
    shell: ReaderShell,
    session: DocumentSession,
    reference: AnnotationHrefReference,
    resolution: Exclude<ReturnType<typeof resolveAnnotationHref>, { readonly status: 'resolved' }>,
  ): void {
    shell.sidebar?.annotationsPanel.setResolutionError(resolution.status, session.descriptor.path);
    const candidates =
      resolution.status === 'ambiguous'
        ? resolution.candidates.map(annotationDiagnosticIdentity)
        : undefined;
    console.error('[abyss-documents] Could not resolve PDF annotation link', {
      path: session.descriptor.path,
      reference,
      status: resolution.status,
      ...(candidates === undefined ? {} : { candidates }),
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async openOnce(
    file: TFile,
    host: HTMLElement,
    abortController: AbortController,
    discardCurrent: boolean,
  ): Promise<void> {
    try {
      await this.releaseCurrent(discardCurrent);
      this.throwIfCancelled(file, abortController.signal);
      await this.mountCurrent(file, host, abortController.signal);
    } finally {
      if (this.activeOpen === abortController) this.activeOpen = null;
    }
  }

  private async mountCurrent(file: TFile, host: HTMLElement, signal: AbortSignal): Promise<void> {
    const shell = this.createShell(
      host,
      (intent) => {
        this.handleToolbarIntent(intent);
      },
      { sourcePath: file.path },
    );
    this.shell = shell;
    let session: DocumentSession | null = null;
    let viewport: DocumentViewport | null = null;
    let unsubscribeViewport: (() => void) | null = null;
    try {
      const adapter = this.registry.requireFor(file);
      session = await adapter.open(file, signal);
      this.throwIfCancelled(file, signal);
      viewport = await session.createViewport();
      this.throwIfCancelled(file, signal);
      await viewport.mount(shell.documentHost);
      this.throwIfCancelled(file, signal);
      unsubscribeViewport = this.activate(session, viewport, shell);
      this.currentFile = file;
      this.currentHost = host;
      delete host.dataset['saveConflict'];
      this.saveFailureBoundary.clear(this.saveFailureOwner, file.path);
    } catch (cause) {
      const cleanupFailure = await this.cleanupFailedMount(
        shell,
        session,
        viewport,
        unsubscribeViewport,
      );
      this.reportPartialCleanupFailure(file.path, cleanupFailure);
      this.throwOpenFailure(file, signal, cause);
    }
  }

  private async cleanupFailedMount(
    shell: ReaderShell,
    session: DocumentSession | null,
    viewport: DocumentViewport | null,
    unsubscribeViewport: (() => void) | null,
  ): Promise<Error | undefined> {
    const annotationInteraction = this.annotationInteractionController;
    if (this.session === session) {
      this.session = null;
      this.viewport = null;
      this.shell = null;
      this.unsubscribeViewport = null;
      this.annotationInteractionController = null;
      this.resetReaderState();
      this.releaseSaveLifecycle();
    }
    let failure = this.tryCleanup(() => {
      this.destroyAnnotationInteraction(annotationInteraction);
    });
    failure ??= this.tryCleanup(unsubscribeViewport);
    failure ??= await this.releasePartial(viewport, session);
    try {
      shell.destroy();
    } catch (cause) {
      failure ??= this.asError(cause);
    }
    return failure;
  }

  private activate(
    session: DocumentSession,
    viewport: DocumentViewport,
    shell: ReaderShell,
  ): () => void {
    this.cancelPendingAnnotationSelectionRetry();
    this.currentPageIndex = 0;
    this.navigationPageIndex = 0;
    this.pendingNavigationPageIndex = null;
    this.navigationRequestRevision += 1;
    this.currentSearchQuery = '';
    this.resetAnnotationProjectionState();
    this.currentProfile = this.initialProfile(session.descriptor.fingerprint);
    this.currentLayout = this.initialLayout(session.descriptor.fingerprint);
    this.layoutPolicy = captureLayoutPolicy(this.profileState.layout);
    this.applyInitialReadingState(viewport, shell);
    viewport.setLayout(this.currentLayout);
    shell.toolbar.setPageCount(viewport.pageCount);
    shell.toolbar.setCurrentPage(this.currentPageIndex);
    shell.toolbar.setProfile(this.currentProfile);
    shell.setLayout(this.currentLayout);
    this.configureAnnotationToolbar(session, viewport, shell);
    shell.root.dataset['readingProfile'] = this.currentProfile;
    const unsubscribeViewport = viewport.onEvent((event) => {
      this.handleViewportEvent(viewport, shell, event);
    });
    try {
      shell.onThemeChange((theme) => {
        this.handleThemeChange(viewport, shell, theme);
      });
    } catch (cause) {
      this.reportPartialCleanupFailure(
        session.descriptor.path,
        this.tryCleanup(unsubscribeViewport),
      );
      throw cause;
    }
    this.session = session;
    this.viewport = viewport;
    this.unsubscribeViewport = unsubscribeViewport;
    this.activateAnnotationInteraction(session, viewport, shell);
    this.activateNativeSave(session);
    return unsubscribeViewport;
  }

  private resetAnnotationProjectionState(): void {
    this.cancelAnnotationProjectionBatch();
    this.annotationAbort?.abort();
    this.annotationAbort = null;
    this.verifiedAnnotationAbort?.abort();
    this.verifiedAnnotationAbort = null;
    this.verifiedAnnotationFailureCause = null;
    this.verifiedAnnotationFailedMarker = null;
    this.verifiedAnnotationInvalidation = null;
    this.verifiedAnnotationInvalidationFor = null;
    this.verifiedAnnotationMarker = null;
    this.verifiedAnnotationRefresh = null;
    this.verifiedAnnotationRefreshFor = null;
    this.annotationIntentFor = null;
    this.annotationsLoadedFor = null;
    this.annotationsLoadingFor = null;
    this.currentAnnotations = [];
    this.annotationProjection.reset();
    this.annotationLiveRevision = 0;
    this.lastAnnotationExportPreparationFailureKey = null;
  }

  private activateNativeSave(session: DocumentSession): void {
    if (this.saveCoordinator === undefined || !isNativeEditableSessionFactory(session)) return;
    let scheduler: AutosaveScheduler | null = null;
    const native = session.createNativeEditableSession((revision) => {
      scheduler?.markDirty(revision);
    });
    if (native === null) return;
    scheduler = new AutosaveScheduler(
      async (revision, reason) => this.saveNativeRevision(session, native, revision, reason),
      {
        onFailure: (cause, _generation, reason) => {
          if (cause instanceof SaveDiscardedError) return;
          this.reportSaveFailure(session.descriptor.path, cause, reason);
        },
        shouldDeferAutomaticSave: () => this.automaticSaveBlocked(),
      },
    );
    this.nativeSaveSession = native;
    this.autosave = scheduler;
    this.unregisterAnnotationEditorClose?.();
    const interaction = this.annotationInteractionController;
    this.unregisterAnnotationEditorClose =
      this.shell?.onAnnotationEditorClose(() => {
        const resume = async (): Promise<void> => {
          await interaction?.waitForNativeEditorNeutralization();
          if (this.autosave === scheduler) await scheduler.resumeAutomaticSave();
        };
        resume().catch(() => undefined);
      }) ?? null;
    this.registerNativeSaveBroadcast(session, native, scheduler);
  }

  private activateAnnotationInteraction(
    session: DocumentSession,
    viewport: DocumentViewport,
    shell: ReaderShell,
  ): void {
    const editor = annotationEditorOf(viewport);
    const interaction = annotationInteractionOf(viewport);
    if (interaction === null || annotationReadOnlyReason(session, editor) !== null) return;
    const palette = this.profileState.annotations?.palette ?? DEFAULT_SETTINGS.annotations.palette;
    this.annotationInteractionController = new AnnotationInteractionController(
      interaction,
      shell,
      palette,
      this.annotationInteractionOptions(viewport, shell),
    );
    editor?.setAnnotationProjection([]);
    editor?.setAnnotationResolver(async (stableId, signal) => {
      if (this.annotationActivationIsStale(session, shell, signal)) return null;
      if (hasAnnotationListing(session)) await this.ensureAnnotationsLoaded(session, shell);
      if (this.annotationActivationIsStale(session, shell, signal)) return null;
      return this.projectedAnnotationForStableId(stableId);
    });
  }

  private annotationInteractionOptions(
    viewport: DocumentViewport,
    shell: ReaderShell,
  ): AnnotationInteractionControllerOptions {
    return {
      color: this.annotationToolColors.highlight,
      onColorChange: (color) => {
        this.annotationToolColors.highlight = color;
      },
      onFailure: (action, cause, context) => {
        this.reportAnnotationFailure(action, cause, context);
      },
      onModeChange: (mode) => {
        if (this.viewport !== viewport || this.shell !== shell) return;
        const tool = annotationToolForMode(mode);
        this.currentAnnotationTool = tool;
        shell.annotationToolbar?.setTool(tool);
      },
      onToolColorChange: (tool, color) => {
        if (this.viewport !== viewport || this.shell !== shell) return;
        this.annotationToolColors[tool] = color;
        shell.annotationToolbar?.setColor(tool, color);
      },
      onAnnotationPreview: (update) => {
        this.projectAnnotationPreview(viewport, shell, update);
      },
      onAnnotationDelete: (annotations) => {
        this.projectAnnotationDelete(viewport, shell, annotations);
      },
      onAnnotationUpdate: (update) => {
        this.projectAnnotationUpdate(viewport, shell, update);
      },
      onSelectionCreateCommit: (creation, annotation) => {
        this.commitProjectedSelection(viewport, shell, creation, annotation);
      },
      onSelectionCreateDiscard: (creation) => {
        this.discardProjectedSelection(viewport, shell, creation);
      },
      onSelectionCreatePreview: (creation) => {
        this.projectSelectionCreation(viewport, shell, creation);
      },
      onSelectionCreateStart: (creation) => {
        this.projectSelectionCreation(viewport, shell, creation);
      },
    };
  }

  private annotationActivationIsStale(
    session: DocumentSession,
    shell: ReaderShell,
    signal: AbortSignal,
  ): boolean {
    return signal.aborted || this.session !== session || this.shell !== shell;
  }

  private projectAnnotationDelete(
    viewport: DocumentViewport,
    shell: ReaderShell,
    annotations: readonly DocumentAnnotation[],
  ): void {
    if (this.viewport !== viewport || this.shell !== shell) return;
    const revision = this.annotationMutationRevision();
    this.invalidateQueuedAnnotationObservations(annotations.map(annotationDiagnosticIdentity));
    const changed = annotations.reduce((removed, annotation) => {
      const id = annotationDiagnosticIdentity(annotation);
      return this.annotationProjection.deleteOptimistically(id, undefined, revision) || removed;
    }, false);
    if (changed) this.renderAnnotationProjection(shell);
  }

  private commitProjectedSelection(
    viewport: DocumentViewport,
    shell: ReaderShell,
    creation: AnnotationEditorCreation,
    annotation: DocumentAnnotation,
  ): void {
    if (this.viewport !== viewport || this.shell !== shell) return;
    this.invalidateQueuedAnnotationObservations([
      creation.selection.token,
      annotationDiagnosticIdentity(annotation),
    ]);
    if (
      !this.annotationProjection.bindCommittedSelection(
        creation.selection.token,
        annotation,
        this.annotationMutationRevision(),
      )
    )
      return;
    this.annotationLiveRevision += 1;
    this.renderAnnotationProjection(shell);
  }

  private discardProjectedSelection(
    viewport: DocumentViewport,
    shell: ReaderShell,
    creation: AnnotationEditorCreation,
  ): void {
    if (this.viewport !== viewport || this.shell !== shell) return;
    this.invalidateQueuedAnnotationObservations([creation.selection.token]);
    if (
      this.annotationProjection.remove(
        creation.selection.token,
        creation.selection.token,
        this.annotationMutationRevision(),
      )
    )
      this.renderAnnotationProjection(shell);
  }

  private projectAnnotationUpdate(
    viewport: DocumentViewport,
    shell: ReaderShell,
    update: AnnotationEditorUpdate,
  ): void {
    if (this.viewport !== viewport || this.shell !== shell) return;
    this.invalidateQueuedAnnotationObservations(
      update.annotations.map(annotationDiagnosticIdentity),
    );
    if (!this.annotationProjection.applyEditorUpdate(update, this.annotationMutationRevision()))
      return;
    this.annotationLiveRevision += 1;
    this.renderAnnotationProjection(shell);
  }

  private projectAnnotationPreview(
    viewport: DocumentViewport,
    shell: ReaderShell,
    update: AnnotationEditorUpdate,
  ): void {
    if (this.viewport !== viewport || this.shell !== shell) return;
    this.invalidateQueuedAnnotationObservations(
      update.annotations.map(annotationDiagnosticIdentity),
    );
    if (!this.annotationProjection.applyEditorPreview(update)) return;
    this.renderAnnotationProjection(shell);
  }

  private projectSelectionCreation(
    viewport: DocumentViewport,
    shell: ReaderShell,
    creation: AnnotationEditorCreation,
  ): void {
    if (this.viewport !== viewport || this.shell !== shell) return;
    const projector = annotationSelectionProjectionOf(viewport);
    if (projector === null) return;
    const selection = creation.selection;
    this.invalidateQueuedAnnotationObservations([selection.token]);
    const decoded = decodeAnnotationComment(creation.comment);
    if (
      !this.annotationProjection.upsert(
        {
          nativeId: selection.token,
          provisionalId: selection.token,
          pageIndex: selection.pageIndex,
          type: 'highlight',
          rects: projector.projectSelectionRects(selection),
          selectedText: selection.text,
          color: creation.color,
          comment: creation.comment,
          tags: decoded.tags,
          links: decoded.links,
          writable: true,
        },
        this.annotationMutationRevision(),
      )
    )
      return;
    this.annotationLiveRevision += 1;
    this.renderAnnotationProjection(shell);
  }

  private async saveNativeRevision(
    session: DocumentSession,
    native: NativeEditableSaveSession,
    revision: number,
    reason: SaveReason,
  ): Promise<void> {
    const finishSave = beginReaderTimedOperation('annotation-save');
    const abort = new AbortController();
    let verified = false;
    this.saveAbort = abort;
    try {
      await this.writeNativeRevision({ native, reason, revision, session }, abort.signal);
      verified = true;
      recordSuccessfulAnnotationSave();
      if (revision >= native.pendingRevision) {
        this.markAnnotationSaveRecovered();
        this.saveFailureBoundary.clear(this.saveFailureOwner, session.descriptor.path);
      }
    } finally {
      if (this.saveAbort === abort) this.saveAbort = null;
      finishSave(verified);
    }
  }

  private async writeNativeRevision(
    write: NativeRevisionWrite,
    signal: AbortSignal,
  ): Promise<void> {
    const { native, reason, revision, session } = write;
    const request: NativeDocumentSaveRequest = {
      path: session.descriptor.path,
      baseToken: native.baseToken,
      revision,
      source: native,
      ...(isAutomaticSaveReason(reason)
        ? {
            beforePrepare: () => {
              this.requireAutomaticSaveWindow();
            },
          }
        : {}),
    };
    try {
      await this.saveCoordinator?.save(request, signal);
    } catch (cause) {
      if (cause instanceof AutomaticSaveDeferredError) {
        await this.awaitAutomaticSaveWindow(signal);
        await this.writeNativeRevision(write, signal);
        return;
      }
      await this.resolveNativeSaveConflict(request, cause, signal);
    }
  }

  private requireAutomaticSaveWindow(): void {
    if (this.manualSaveOverrideDepth > 0 || !this.automaticSaveBlocked()) return;
    throw new AutomaticSaveDeferredError();
  }

  private automaticSaveBlocked(): boolean {
    return this.shell?.annotationEditorOpen === true || this.annotationActivationAbort !== null;
  }

  private async awaitAutomaticSaveWindow(signal: AbortSignal): Promise<void> {
    const shell = this.shell;
    if (shell === null) return;
    while (
      this.manualSaveOverrideDepth === 0 &&
      this.shell === shell &&
      this.automaticSaveBlocked()
    ) {
      await this.waitForAutomaticSaveWake(shell, signal);
    }
  }

  private waitForAutomaticSaveWake(shell: ReaderShell, signal: AbortSignal): Promise<void> {
    return waitForAnnotationEditorCloseOrWake(shell, signal, this.automaticSaveWakeListeners);
  }

  private wakeDeferredAutomaticSave(): void {
    for (const listener of [...this.automaticSaveWakeListeners]) listener();
  }

  private resumeAutomaticSaveAfterInteraction(): void {
    this.wakeDeferredAutomaticSave();
    const scheduler = this.autosave;
    if (scheduler === null) return;
    void scheduler.resumeAutomaticSave().catch(() => undefined);
  }

  private async resolveNativeSaveConflict(
    request: NativeDocumentSaveRequest,
    cause: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const resolver = this.optionsConflictResolver;
    if (!(cause instanceof SaveConflictError) || resolver === null) throw cause;
    const action = await resolver(request.path);
    if (action === 'overwrite') {
      await this.saveCoordinator?.save({ ...request, overwrite: true }, signal);
      return;
    }
    if (action === 'reload-discard') {
      if (!this.lifecycleFlushActive) await this.reloadCurrentAfterConflict();
      throw new SaveDiscardedError(cause);
    }
    throw cause;
  }

  private applyInitialReadingState(viewport: DocumentViewport, shell: ReaderShell): void {
    this.profileService.setCustom(this.profileState.reading.custom);
    viewport.setReadingColors(
      this.profileService.resolve(this.currentProfile, shell.obsidianTheme),
    );
  }

  private registerNativeSaveBroadcast(
    session: DocumentSession,
    native: NativeEditableSaveSession,
    scheduler: AutosaveScheduler,
  ): void {
    const coordinator = this.saveCoordinator as Partial<Pick<DocumentSaveCoordinator, 'register'>>;
    if (typeof coordinator.register !== 'function') return;
    const listener: VerifiedReloadListener = async (token, revision, source) => {
      if (
        this.session !== session ||
        this.nativeSaveSession !== native ||
        this.autosave !== scheduler
      )
        return;
      if (source !== native) {
        if (native.isDirty || this.shell?.annotationEditorPendingChanges === true) {
          scheduler.pauseForFailure(
            new SaveConflictError(session.descriptor.path, native.baseToken, token),
            native.pendingRevision,
          );
        } else {
          const lifecycleGeneration = this.lifecycleRequestGeneration;
          await this.reloadCleanPeerAfterVerifiedSave(
            session,
            native,
            scheduler,
            lifecycleGeneration,
          );
        }
      } else if (this.nativeSaveSession === native && 'acceptVerifiedReload' in native) {
        (
          native as NativeEditableSaveSession & { acceptVerifiedReload(token: unknown): void }
        ).acceptVerifiedReload(token);
        this.markVerifiedAnnotationsStale(session, token, revision, source);
      }
    };
    try {
      this.unregisterSaveBroadcast = coordinator.register(session.descriptor.path, listener);
    } catch (cause) {
      this.nativeSaveSession = null;
      this.autosave = null;
      scheduler.destroy();
      try {
        native.destroy();
      } catch (cleanupCause) {
        this.reportPartialCleanupFailure(session.descriptor.path, this.asError(cleanupCause));
      }
      throw cause;
    }
  }

  private markVerifiedAnnotationsStale(
    session: DocumentSession,
    token: BaseToken,
    revision: number,
    source: VerifiedReloadSource,
  ): void {
    const context = this.annotationContextFor(session);
    if (context === null || !hasAnnotationListing(session)) return;
    const { file, shell } = context;
    const marker: VerifiedAnnotationMarker = Object.freeze({
      file,
      projectionRevision: ++this.annotationProjectionRevision,
      revision,
      session,
      shell,
      source,
      token,
    });
    this.verifiedAnnotationMarker = marker;
    this.verifiedAnnotationFailureCause = null;
    this.verifiedAnnotationFailedMarker = null;
    this.annotationAbort?.abort(
      new DOMException('The saved PDF superseded the live annotation index.', 'AbortError'),
    );
    this.annotationAbort = null;
    this.verifiedAnnotationAbort?.abort(
      new DOMException('A newer verified PDF superseded this annotation refresh.', 'AbortError'),
    );
    this.annotationsLoadedFor = null;
    this.annotationsLoadingFor = null;
    if (this.hasAnnotationIntent(session) && this.currentAnnotations.length === 0)
      shell.sidebar?.annotationsPanel.setLoading();
    this.startVerifiedAnnotationInvalidation(marker);
  }

  private startVerifiedAnnotationInvalidation(marker: VerifiedAnnotationMarker): void {
    const path = marker.session.descriptor.path;
    const task = Promise.resolve()
      .then(async () => {
        try {
          await this.annotationCache?.invalidate(path);
        } catch (cause) {
          console.error('[abyss-documents] Annotation cache invalidation failed', { path, cause });
        }
      })
      .then(() => {
        if (!this.isCurrentAnnotationMarker(marker) || !this.hasAnnotationIntent(marker.session))
          return;
        this.verifiedAnnotationRefresh = this.scheduleVerifiedAnnotationRefresh(marker.session);
      })
      .finally(() => {
        if (this.verifiedAnnotationInvalidation !== task) return;
        this.verifiedAnnotationInvalidation = null;
        this.verifiedAnnotationInvalidationFor = null;
      });
    this.verifiedAnnotationInvalidation = task;
    this.verifiedAnnotationInvalidationFor = marker.session;
  }

  private scheduleVerifiedAnnotationRefresh(session: DocumentSession): Promise<void> {
    const existing = this.verifiedAnnotationRefresh;
    if (existing !== null && Object.is(this.verifiedAnnotationRefreshFor, session)) return existing;
    let attemptedMarker: VerifiedAnnotationMarker | null = null;
    const extraction = Promise.resolve().then(async () => {
      const marker = this.verifiedAnnotationMarker;
      if (
        marker === null ||
        !Object.is(marker.session, session) ||
        !this.isCurrentAnnotationMarker(marker)
      )
        return;
      attemptedMarker = marker;
      const abort = new AbortController();
      this.verifiedAnnotationAbort = abort;
      const refresh = { abort, marker } satisfies VerifiedAnnotationRefresh;
      try {
        const annotations = await this.reextractVerifiedAnnotations(refresh);
        if (!this.isCurrentAnnotationRefresh(refresh)) return;
        this.verifiedAnnotationMarker = null;
        this.verifiedAnnotationFailureCause = null;
        this.annotationsLoadedFor = session;
        this.annotationsLoadingFor = null;
        this.acceptVerifiedAnnotations(annotations, marker.shell, marker.revision);
      } finally {
        if (this.verifiedAnnotationAbort === abort) this.verifiedAnnotationAbort = null;
      }
    });
    const promise = extraction
      .catch((cause: unknown) => {
        if (attemptedMarker === null || this.verifiedAnnotationMarker !== attemptedMarker) return;
        this.reportVerifiedAnnotationRefreshFailure(attemptedMarker, cause);
        if (!isAbortFailure(cause)) {
          this.verifiedAnnotationFailureCause = cause;
          this.verifiedAnnotationFailedMarker = attemptedMarker;
        }
      })
      .finally(() => {
        if (this.verifiedAnnotationRefresh !== promise) return;
        this.verifiedAnnotationRefresh = null;
        this.verifiedAnnotationRefreshFor = null;
        if (
          this.hasPendingVerifiedAnnotations(session) &&
          this.hasAnnotationIntent(session) &&
          this.verifiedAnnotationFailedMarker !== this.verifiedAnnotationMarker
        )
          this.verifiedAnnotationRefresh = this.scheduleVerifiedAnnotationRefresh(session);
      });
    this.verifiedAnnotationRefresh = promise;
    this.verifiedAnnotationRefreshFor = session;
    return promise;
  }

  private async awaitVerifiedAnnotationRefresh(session: DocumentSession): Promise<void> {
    const invalidation = this.verifiedAnnotationInvalidation;
    if (invalidation !== null && Object.is(this.verifiedAnnotationInvalidationFor, session))
      await invalidation;
    while (
      this.hasPendingVerifiedAnnotations(session) &&
      this.verifiedAnnotationFailedMarker !== this.verifiedAnnotationMarker
    ) {
      try {
        await this.scheduleVerifiedAnnotationRefresh(session);
      } catch (cause) {
        if (!isAbortFailure(cause)) throw cause;
      }
    }
    this.throwIfVerifiedAnnotationRefreshFailed();
  }

  private throwIfVerifiedAnnotationRefreshFailed(): void {
    const failed = this.verifiedAnnotationFailedMarker;
    if (failed !== null && failed === this.verifiedAnnotationMarker)
      throw new AnnotationExportPreparationError(
        failed.session.descriptor.path,
        'verified-refresh',
        this.verifiedAnnotationFailureCause,
      );
  }

  private async reextractVerifiedAnnotations(
    refresh: VerifiedAnnotationRefresh,
  ): Promise<readonly DocumentAnnotation[]> {
    const { abort, marker } = refresh;
    const reopened = await this.registry.requireFor(marker.file).open(marker.file, abort.signal);
    try {
      if (!hasAnnotationListing(reopened)) return [];
      return await this.loadAnnotationData(reopened, abort.signal);
    } finally {
      await this.closeAnnotationRefreshSession(reopened, marker.session.descriptor.path);
    }
  }

  private isCurrentAnnotationMarker(marker: VerifiedAnnotationMarker): boolean {
    return (
      this.verifiedAnnotationMarker === marker &&
      marker.projectionRevision === this.annotationProjectionRevision &&
      Object.is(this.session, marker.session) &&
      Object.is(this.shell, marker.shell)
    );
  }

  private annotationContextFor(
    session: DocumentSession,
  ): { readonly file: TFile; readonly shell: ReaderShell } | null {
    if (!Object.is(this.session, session) || this.currentFile === null || this.shell === null)
      return null;
    return { file: this.currentFile, shell: this.shell };
  }

  private hasAnnotationIntent(session: DocumentSession): boolean {
    return Object.is(this.annotationIntentFor, session);
  }

  private hasPendingVerifiedAnnotations(session: DocumentSession): boolean {
    return Object.is(this.verifiedAnnotationMarker?.session, session);
  }

  private isCurrentAnnotationRefresh(refresh: VerifiedAnnotationRefresh): boolean {
    return !refresh.abort.signal.aborted && this.isCurrentAnnotationMarker(refresh.marker);
  }

  private reportVerifiedAnnotationRefreshFailure(
    marker: VerifiedAnnotationMarker,
    cause: unknown,
  ): void {
    if (isAbortFailure(cause)) return;
    marker.shell.sidebar?.annotationsPanel.setUnavailable();
    console.error('[abyss-documents] Failed to refresh verified PDF annotations', {
      path: marker.session.descriptor.path,
      revision: marker.revision,
      token: marker.token,
      cause,
    });
  }

  private async closeAnnotationRefreshSession(
    session: DocumentSession,
    path: string,
  ): Promise<void> {
    try {
      await session.close();
    } catch (cause) {
      console.error('[abyss-documents] Failed to close verified annotation refresh', {
        path,
        cause,
      });
    }
  }

  private get optionsConflictResolver(): ((path: string) => Promise<SaveConflictAction>) | null {
    return this.services.resolveSaveConflict ?? null;
  }

  private async reloadCurrentAfterConflict(): Promise<void> {
    const file = this.currentFile;
    const host = this.currentHost;
    if (file === null || host === null) return;
    await this.reloadExternalFile(file, host);
  }

  private async reloadCleanPeerAfterVerifiedSave(
    session: DocumentSession,
    native: NativeEditableSaveSession,
    scheduler: AutosaveScheduler,
    lifecycleGeneration: number,
  ): Promise<void> {
    const file = this.currentFile;
    const host = this.currentHost;
    if (file === null || host === null) return;
    const context = { file, host, lifecycleGeneration, native, scheduler, session };
    await this.enqueue(async () => {
      if (!this.isCleanPeerReloadCurrent(context)) return;
      const abortController = new AbortController();
      this.activeOpen = abortController;
      try {
        await this.openOnce(file, host, abortController, true);
      } catch (cause) {
        if (
          this.lifecycleRequestGeneration !== lifecycleGeneration ||
          abortController.signal.aborted
        )
          return;
        this.reportExternalReloadFailure(file, host, cause);
      }
    });
  }

  private isCleanPeerReloadCurrent(context: CleanPeerReloadContext): boolean {
    const { file, host, lifecycleGeneration, native, scheduler, session } = context;
    return (
      this.lifecycleRequestGeneration === lifecycleGeneration &&
      this.session === session &&
      this.nativeSaveSession === native &&
      this.autosave === scheduler &&
      this.currentFile === file &&
      this.currentHost === host &&
      !native.isDirty &&
      this.shell?.annotationEditorPendingChanges !== true
    );
  }

  private async reloadExternalFile(file: TFile, host: HTMLElement): Promise<void> {
    const reload = this.requestOpen(file, host, true);
    const expectedGeneration = this.lifecycleRequestGeneration;
    try {
      await reload;
    } catch (cause) {
      if (this.lifecycleRequestGeneration !== expectedGeneration) return;
      this.reportExternalReloadFailure(file, host, cause);
    }
  }

  private reportExternalReloadFailure(file: TFile, host: HTMLElement, cause: unknown): void {
    host.dataset['saveConflict'] = 'true';
    const reason = this.reason(cause);
    this.saveFailureBoundary.report({
      ownerId: this.saveFailureOwner,
      host,
      path: file.path,
      reason,
      retryAction: () => {
        this.reloadExternalFile(file, host).catch((retryCause: unknown) => {
          console.error('[abyss-documents] Failed to retry updated PDF reload', {
            path: file.path,
            cause: retryCause,
          });
        });
      },
      label: 'Could not reload updated PDF',
    });
    console.error('[abyss-documents] Failed to reload externally modified PDF', {
      path: file.path,
      cause,
    });
  }

  private reportSaveFailure(path: string, cause: unknown, reason: SaveReason): void {
    const failureReason = this.reason(cause);
    const key = `${path}\u0000${failureReason}`;
    if (key !== this.lastAutosaveFailureKey) {
      incrementReaderCounter('annotationSaveFailures');
      const recovery = this.recoveryFailure(cause);
      if (recovery !== null) {
        this.reportRecoveryNotice(path, failureReason, recovery);
      } else {
        this.saveFailureBoundary.report({
          ownerId: this.saveFailureOwner,
          host: this.currentHost ?? document.body,
          path,
          reason: failureReason,
          retryAction: () => {
            const retrying = this.autosave?.retry();
            if (retrying !== undefined) void retrying.catch(() => undefined);
          },
          ...(reason === 'manual' ? { label: 'Could not save PDF annotations' } : {}),
        });
      }
      this.lastAutosaveFailureKey = key;
    }
    console.error(
      reason === 'manual'
        ? '[abyss-documents] Failed to save PDF annotations'
        : '[abyss-documents] Failed to autosave PDF annotations',
      { path, cause },
    );
  }

  private markAnnotationSaveRecovered(): void {
    if (this.lastAutosaveFailureKey !== null) incrementReaderCounter('annotationSaveRecoveries');
    this.lastAutosaveFailureKey = null;
  }

  private reportRecoveryNotice(
    path: string,
    failureReason: string,
    recovery: NativeSaveRecoveryFailure,
  ): void {
    if (this.currentHost !== null) this.currentHost.dataset['saveConflict'] = 'true';
    this.saveFailureBoundary.report({
      ownerId: this.saveFailureOwner,
      host: this.currentHost ?? document.body,
      path,
      reason: failureReason,
      retryAction: () => {
        void this.restoreLastVerifiedCopy(recovery).catch(() => undefined);
      },
      label: 'PDF save could not be verified',
      actionLabel: 'Restore last verified copy',
    });
  }

  private recoveryFailure(cause: unknown): NativeSaveRecoveryFailure | null {
    const coordinator = this.saveCoordinator;
    if (
      !isNativeSaveRecoveryFailure(cause) ||
      cause.restored ||
      cause.preimage === null ||
      coordinator?.inspectRecovery === undefined ||
      coordinator.recover === undefined ||
      this.services.confirmSaveRecovery === undefined
    )
      return null;
    return cause;
  }

  private async restoreLastVerifiedCopy(failure: NativeSaveRecoveryFailure): Promise<void> {
    const coordinator = this.saveCoordinator;
    const confirm = this.services.confirmSaveRecovery;
    if (
      coordinator?.inspectRecovery === undefined ||
      coordinator.recover === undefined ||
      confirm === undefined
    )
      return;
    this.recoveryAbort?.abort(new DOMException('A newer PDF recovery started.', 'AbortError'));
    const abort = new AbortController();
    this.recoveryAbort = abort;
    try {
      const current = await coordinator.inspectRecovery(failure, abort.signal);
      if (!(await confirm(failure.path, current))) return;
      await coordinator.recover(failure, current, abort.signal);
      await this.finishRecovery(failure.path);
    } catch (cause) {
      this.reportRecoveryFailure(failure.path, cause, abort.signal);
      throw cause;
    } finally {
      if (this.recoveryAbort === abort) this.recoveryAbort = null;
    }
  }

  private async finishRecovery(path: string): Promise<void> {
    this.lastAutosaveFailureKey = null;
    this.saveFailureBoundary.clear(this.saveFailureOwner, path);
    if (this.currentHost !== null) delete this.currentHost.dataset['saveConflict'];
    await this.reloadCurrentAfterConflict();
  }

  private reportRecoveryFailure(path: string, cause: unknown, signal: AbortSignal): void {
    if (signal.aborted) return;
    console.error('[abyss-documents] Failed to restore the last verified PDF copy', {
      path,
      cause,
    });
  }

  private reportPartialCleanupFailure(path: string, cause: Error | undefined): void {
    if (cause === undefined) return;
    console.error('[abyss-documents] Failed to clean up a partial reader session', {
      path,
      cause,
    });
  }

  private throwOpenFailure(file: TFile, signal: AbortSignal, cause: unknown): never {
    if (signal.aborted) throw this.cancelled(file, cause);
    if (cause instanceof DocumentOpenError) throw cause;
    throw new DocumentOpenError(file.path, 'Could not open this document view. Try again.', cause);
  }

  private async releaseCurrent(discardCurrent = false): Promise<void> {
    if (!discardCurrent) await this.flushBeforeRelease();
    const viewport = this.viewport;
    const session = this.session;
    const shell = this.shell;
    const unsubscribeViewport = this.unsubscribeViewport;
    const annotationInteraction = this.annotationInteractionController;
    this.closeAnnotationEditorForRelease(shell);
    this.viewport = null;
    this.session = null;
    this.shell = null;
    this.unsubscribeViewport = null;
    this.annotationInteractionController = null;
    this.resetReaderState();
    this.releaseSaveLifecycle();

    let failure = this.tryCleanup(() => {
      this.destroyAnnotationInteraction(annotationInteraction);
    });
    failure ??= this.tryCleanup(unsubscribeViewport);
    const lifecycleFailure = await this.releasePartial(viewport, session);
    failure ??= lifecycleFailure;
    try {
      shell?.destroy();
    } catch (cause) {
      failure ??= this.asError(cause);
    }
    if (failure !== undefined) throw failure;
  }

  private closeAnnotationEditorForRelease(shell: ReaderShell | null): void {
    if (shell?.closeAnnotationEditor() !== false) return;
    throw new DOMException(
      'The annotation editor still has changes that could not be persisted.',
      'InvalidStateError',
    );
  }

  private destroyAnnotationInteraction(interaction: AnnotationInteractionController | null): void {
    if (interaction?.destroy() !== false) return;
    throw new DOMException(
      'The annotation editor still has changes that could not be persisted.',
      'InvalidStateError',
    );
  }

  private async flushBeforeRelease(): Promise<void> {
    this.lifecycleFlushActive = true;
    const interaction = annotationInteractionOf(this.viewport);
    const host = this.currentHost;
    const hostWasInert = host?.inert ?? false;
    try {
      await this.prepareInteractionForRelease(interaction, host);
      await this.autosave?.flush();
    } catch (cause) {
      this.handleReleaseFlushFailure(cause, interaction, host, hostWasInert);
    } finally {
      this.lifecycleFlushActive = false;
    }
  }

  private async prepareInteractionForRelease(
    interaction: PdfAnnotationInteraction | null,
    host: HTMLElement | null,
  ): Promise<void> {
    const shell = this.shell;
    if ((await shell?.flushAnnotationEditor()) === false)
      throw new DOMException(
        'The annotation editor still has changes that could not be persisted.',
        'InvalidStateError',
      );
    this.closeAnnotationEditorForRelease(shell);
    if (host !== null) host.inert = true;
    await interaction?.suspendInteractions?.();
    await this.annotationInteractionController?.waitForNativeEditorNeutralization();
  }

  private handleReleaseFlushFailure(
    cause: unknown,
    interaction: PdfAnnotationInteraction | null,
    host: HTMLElement | null,
    hostWasInert: boolean,
  ): void {
    if (cause instanceof SaveDiscardedError) return;
    interaction?.resumeInteractions?.();
    if (host !== null) host.inert = hostWasInert;
    throw cause;
  }

  private resetReaderState(): void {
    this.cancelAnnotationActivation(false);
    this.cancelPendingAnnotationSelectionRetry();
    this.outlineLoadedFor = null;
    this.outlineLoadingFor = null;
    this.resetAnnotationProjectionState();
    this.currentSearchQuery = '';
    this.navigationPageIndex = 0;
    this.pendingNavigationPageIndex = null;
    this.navigationRequestRevision += 1;
    this.annotationToolRequestRevision += 1;
    this.annotationProjectionRevision += 1;
    this.currentAnnotationTool = 'select';
    this.currentFile = null;
    this.currentHost = null;
  }

  private releaseSaveLifecycle(): void {
    this.unregisterAnnotationEditorClose?.();
    this.unregisterAnnotationEditorClose = null;
    this.autosave?.destroy();
    this.autosave = null;
    this.saveAbort?.abort(new DOMException('The PDF view was closed.', 'AbortError'));
    this.saveAbort = null;
    this.recoveryAbort?.abort(new DOMException('The PDF view was closed.', 'AbortError'));
    this.recoveryAbort = null;
    this.unregisterSaveBroadcast?.();
    this.unregisterSaveBroadcast = null;
    this.nativeSaveSession?.destroy();
    this.nativeSaveSession = null;
    this.lastAutosaveFailureKey = null;
    this.saveFailureBoundary.release(this.saveFailureOwner);
  }

  private async releasePartial(
    viewport: DocumentViewport | null,
    session: DocumentSession | null,
  ): Promise<Error | undefined> {
    let failure: Error | undefined;
    if (viewport !== null) {
      try {
        await viewport.destroy();
      } catch (cause) {
        failure = this.asError(cause);
      }
    }
    if (session !== null) {
      try {
        await session.close();
      } catch (cause) {
        failure ??= this.asError(cause);
      }
    }
    return failure;
  }

  private handleToolbarIntent(intent: ReaderShellIntent): void {
    if (intent.type === 'export-annotations') {
      this.exportAnnotations();
      return;
    }
    if (isAnnotationToolbarIntent(intent)) {
      this.handleAnnotationToolbarIntent(intent);
      return;
    }
    this.handleReaderToolbarIntent(intent);
  }

  private handleReaderToolbarIntent(
    intent: Exclude<
      ReaderShellIntent,
      AnnotationToolbarIntent | { readonly type: 'export-annotations' }
    >,
  ): void {
    switch (intent.type) {
      case 'toggle-sidebar':
        this.toggleSidebar();
        return;
      case 'open-sidebar':
        this.openSidebar(intent.tab);
        return;
      case 'go-to-page':
        this.navigateTo(intent.pageIndex);
        return;
      case 'previous-page':
        this.navigateRelative(-1);
        return;
      case 'next-page':
        this.navigateRelative(1);
        return;
      case 'set-scale':
        this.setScale(intent.scale);
        return;
      case 'zoom-step':
        this.stepScale(intent.direction);
        return;
      case 'set-layout':
        this.setLayout(intent.layout);
        return;
      case 'set-profile':
        this.setProfile(intent.profile);
        return;
    }
  }

  private exportAnnotations(): void {
    const file = this.currentFile;
    const session = this.session;
    const shell = this.shell;
    const exporter = this.services.annotationExporter;
    if (file === null || shell === null || session === null || exporter === undefined) return;
    void this.exportAnnotationsFromSession(file, session, shell, exporter).catch(
      (cause: unknown) => {
        if (isAbortFailure(cause)) return;
        if (Object.is(this.session, session) && Object.is(this.shell, shell)) {
          this.annotationsLoadingFor = null;
          shell.sidebar?.annotationsPanel.setUnavailable();
        }
        this.reportAnnotationExportPreparationFailure(file, cause);
      },
    );
  }

  private async exportAnnotationsFromSession(
    file: TFile,
    session: DocumentSession,
    shell: ReaderShell,
    exporter: NonNullable<ReaderControllerServices['annotationExporter']>,
  ): Promise<void> {
    try {
      await this.saveDocument();
    } catch (cause) {
      if (isAbortFailure(cause)) throw cause;
      throw new AnnotationExportPreparationError(file.path, 'save', cause);
    }
    if (!hasAnnotationListing(session)) return;
    let annotations: readonly DocumentAnnotation[];
    try {
      annotations = await this.ensureAnnotationsLoaded(session, shell);
    } catch (cause) {
      if (isAbortFailure(cause) || cause instanceof AnnotationExportPreparationError) throw cause;
      throw new AnnotationExportPreparationError(file.path, 'annotation-load', cause);
    }
    if (this.session !== session || this.currentFile !== file) return;
    const records: AnnotationExportRecord[] = annotations.map((annotation) => ({
      documentPath: file.path,
      documentFingerprint: session.descriptor.fingerprint,
      annotation,
    }));
    this.lastAnnotationExportPreparationFailureKey = null;
    await exporter.run(file, records);
  }

  private reportAnnotationExportPreparationFailure(file: TFile, cause: unknown): void {
    const failure =
      cause instanceof AnnotationExportPreparationError
        ? cause
        : new AnnotationExportPreparationError(file.path, 'annotation-load', cause);
    const reason = this.reason(failure.cause);
    const key = `${file.path}\u0000${failure.stage}\u0000${reason}`;
    if (failure.stage !== 'save' && key !== this.lastAnnotationExportPreparationFailureKey) {
      this.lastAnnotationExportPreparationFailureKey = key;
      new Notice(`Could not prepare annotations for export: ${reason}`);
    }
    console.error('[abyss-documents] Failed to prepare PDF annotations for export', {
      path: file.path,
      stage: failure.stage,
      cause: failure,
    });
  }

  private handleAnnotationToolbarIntent(intent: AnnotationToolbarIntent): void {
    switch (intent.type) {
      case 'set-annotation-tool':
        this.setAnnotationTool(intent.tool, 'color' in intent ? intent.color : undefined);
        return;
      case 'set-annotation-color':
        this.setAnnotationColor(intent.tool, intent.color);
        return;
      case 'undo-annotation':
        this.containAnnotationAction(this.runAnnotationHistory('undo'));
        return;
      case 'redo-annotation':
        this.containAnnotationAction(this.runAnnotationHistory('redo'));
        return;
    }
  }

  private configureAnnotationToolbar(
    session: DocumentSession,
    viewport: DocumentViewport,
    shell: ReaderShell,
  ): void {
    const annotationEditor = annotationEditorOf(viewport);
    const palette = this.profileState.annotations?.palette ?? DEFAULT_SETTINGS.annotations.palette;
    this.currentAnnotationTool = 'select';
    this.annotationToolColors = annotationToolColorDefaults(palette[0]?.color ?? '#ffd400');
    shell.configureAnnotationToolbar(palette, annotationReadOnlyReason(session, annotationEditor));
  }

  private refreshAnnotationToolbar(
    session: DocumentSession,
    viewport: DocumentViewport,
    shell: ReaderShell,
  ): void {
    const editor = annotationEditorOf(viewport);
    const palette = this.profileState.annotations?.palette ?? DEFAULT_SETTINGS.annotations.palette;
    const fallbackColor = palette[0]?.color ?? '#ffd400';
    for (const tool of writableAnnotationTools()) {
      if (
        !palette.some(
          ({ color }) =>
            color.toLocaleLowerCase() === this.annotationToolColors[tool].toLocaleLowerCase(),
        )
      )
        this.annotationToolColors[tool] = fallbackColor;
    }
    const toolbar = shell.configureAnnotationToolbar(
      palette,
      annotationReadOnlyReason(session, editor),
    );
    for (const tool of writableAnnotationTools())
      toolbar.setColor(tool, this.annotationToolColors[tool]);
    toolbar.setTool(this.currentAnnotationTool);
    const interactionController = this.annotationInteractionController;
    if (interactionController !== null) {
      interactionController.updatePalette(palette);
      this.annotationToolColors.highlight = interactionController.color;
      toolbar.setColor('highlight', interactionController.color);
    }
  }

  private setAnnotationTool(tool: PdfAnnotationTool, requestedColor?: string): void {
    const color = this.annotationToolRequestColor(tool, requestedColor);
    if (this.annotationInteractionController?.requestTool(tool, color ?? undefined) === true) {
      this.currentAnnotationTool = tool;
      return;
    }
    const editor = annotationEditorOf(this.viewport);
    const shell = this.shell;
    const viewport = this.viewport;
    if (editor === null || shell === null || viewport === null) return;
    const previous = this.currentAnnotationTool;
    const revision = ++this.annotationToolRequestRevision;
    this.commitAnnotationTool({ color, editor, previous, revision, shell, tool, viewport }).catch(
      (cause: unknown) => {
        console.error('[abyss-documents] Unexpected annotation tool transaction failure', {
          cause,
        });
      },
    );
  }

  private annotationToolRequestColor(
    tool: PdfAnnotationTool,
    requestedColor?: string,
  ): string | null {
    if (tool === 'select') return null;
    const color = requestedColor ?? this.annotationToolColors[tool];
    this.annotationToolColors[tool] = color;
    return color;
  }

  private setAnnotationColor(tool: WritableAnnotationTool, color: string): void {
    if (tool === 'highlight' && this.annotationInteractionController?.selectColor(color) === true) {
      this.annotationToolColors.highlight = color;
      this.lastAnnotationFailureKey = null;
      return;
    }
    const editor = annotationEditorOf(this.viewport);
    const toolbar = this.shell?.annotationToolbar;
    if (toolbar === undefined || toolbar === null) return;
    if (editor === null || tool !== this.currentAnnotationTool) {
      this.annotationToolColors[tool] = color;
      toolbar.setColor(tool, color);
      return;
    }
    try {
      editor.setParameter(annotationColorParameter(tool), color).then(
        () => {
          if (annotationEditorOf(this.viewport) !== editor) return;
          this.annotationToolColors[tool] = color;
          toolbar.setColor(tool, color);
          this.lastAnnotationFailureKey = null;
        },
        (cause: unknown) => {
          this.reportAnnotationFailure('change annotation color', cause, { color, tool });
        },
      );
    } catch (cause) {
      this.reportAnnotationFailure('change annotation color', cause, { color, tool });
    }
  }

  private async commitAnnotationTool(request: AnnotationToolRequest): Promise<void> {
    const { editor, tool } = request;
    let nativeModeChanged = false;
    try {
      await editor.setTool(tool);
      nativeModeChanged = true;
      await this.finishAnnotationTool(request);
    } catch (cause) {
      await this.rejectAnnotationTool(request, cause, nativeModeChanged);
    }
  }

  private async finishAnnotationTool(request: AnnotationToolRequest): Promise<void> {
    const { color, editor, revision, shell, tool, viewport } = request;
    if (!this.isCurrentAnnotationRequest(viewport, revision)) return;
    if (tool !== 'select' && color !== null)
      await editor.setParameter(annotationColorParameter(tool), color);
    if (!this.isCurrentAnnotationRequest(viewport, revision)) return;
    this.currentAnnotationTool = tool;
    shell.annotationToolbar?.setTool(tool);
    this.lastAnnotationFailureKey = null;
  }

  private async rejectAnnotationTool(
    request: AnnotationToolRequest,
    cause: unknown,
    nativeModeChanged: boolean,
  ): Promise<void> {
    const { editor, previous, revision, shell, tool, viewport } = request;
    if (isAbortFailure(cause) || !this.isCurrentAnnotationRequest(viewport, revision)) return;
    if (nativeModeChanged) await this.rollbackAnnotationTool(editor, previous);
    if (!this.isCurrentAnnotationRequest(viewport, revision)) return;
    shell.annotationToolbar?.setTool(previous);
    this.reportAnnotationFailure('change annotation tool', cause, { tool });
  }

  private async rollbackAnnotationTool(
    editor: PdfAnnotationEditor,
    previous: PdfAnnotationTool,
  ): Promise<void> {
    try {
      await editor.setTool(previous);
    } catch (rollbackCause) {
      console.error('[abyss-documents] Failed to roll back PDF annotation tool', {
        previous,
        rollbackCause,
      });
    }
  }

  private isCurrentAnnotationRequest(viewport: DocumentViewport, revision: number): boolean {
    return this.viewport === viewport && this.annotationToolRequestRevision === revision;
  }

  private async runAnnotationHistory(action: 'redo' | 'undo'): Promise<void> {
    const editor = annotationEditorOf(this.viewport);
    if (editor === null) return;
    try {
      await editor[action]();
      if (annotationEditorOf(this.viewport) === editor) this.lastAnnotationFailureKey = null;
    } catch (cause) {
      this.reportAnnotationFailure(`${action} PDF annotation`, cause, { action });
    }
  }

  private containAnnotationAction(operation: Promise<void>): void {
    operation.catch(console.error);
  }

  private reportAnnotationFailure(
    action: string,
    cause: unknown,
    context: Readonly<Record<string, unknown>>,
  ): void {
    const path = this.session?.descriptor.path ?? '';
    const reason = this.reason(cause);
    const key = `${path}\u0000${action}\u0000${reason}`;
    if (key !== this.lastAnnotationFailureKey) {
      new Notice(`Could not ${action}: ${reason}`);
      this.lastAnnotationFailureKey = key;
    }
    console.error('[abyss-documents] Failed to edit PDF annotation', {
      action,
      path,
      ...context,
      cause,
    });
  }

  private toggleSidebar(): void {
    const shell = this.shell;
    if (shell === null) return;
    if (shell.sidebar?.isOpen === true) shell.closeSidebar();
    else this.openSidebar(shell.sidebar?.activeTab ?? 'outline');
  }

  private openSidebar(tab: ReaderSidebarTab): void {
    const shell = this.shell;
    const session = this.session;
    const viewport = this.viewport;
    if (shell === null || session === null || viewport === null) return;
    const transfer = this.services.annotationTransfer;
    const file = this.currentFile;
    const transferCallbacks: Partial<ReaderSidebarCallbacks> =
      transfer === undefined || file === null
        ? {}
        : {
            onAnnotationTransfer: (annotation, dataTransfer) => {
              applyAnnotationTransfer(dataTransfer, transfer.build(annotation, file));
            },
            onAnnotationTransferFailure: (annotation, cause) => {
              this.reportAnnotationFailure('drag PDF annotation', cause, {
                annotation: annotationDiagnosticIdentity(annotation),
              });
            },
          };
    const callbacks: ReaderSidebarCallbacks = {
      ...annotationColorLabels(this.profileState.annotations?.palette ?? []),
      onClose: () => undefined,
      onAnnotationNavigate: (location) => {
        this.navigateToLocation(location);
      },
      onAnnotationSelect: (activation) => {
        const interactionController = this.annotationInteractionController;
        const selected = interactionController?.selectAnnotation(activation.nativeId) ?? false;
        this.navigateToLocation(
          activation.location,
          selected ? {} : { annotationSelectionRetry: { nativeId: activation.nativeId } },
        );
      },
      onAnnotationActivate: (activation) => {
        this.activateAnnotation(viewport, activation);
      },
      ...transferCallbacks,
      onTabChange: (nextTab) => {
        if (nextTab === 'outline' && this.session === session && this.shell === shell)
          this.loadOutline(session, shell);
        if (nextTab === 'annotations' && this.session === session && this.shell === shell)
          this.loadAnnotations(session, shell);
      },
      onOutlineNavigate: (location) => {
        this.navigateToLocation(location);
      },
      onSearchNavigate: (hit) => {
        this.navigateSearchResult(hit);
      },
      onSearchQuery: (query) => {
        if (this.viewport !== viewport) return;
        this.currentSearchQuery = query.trim();
        viewport.search(this.currentSearchQuery);
      },
    };
    const sidebar = shell.openSidebar(tab, callbacks);
    sidebar.outlinePanel.setCurrentPage(this.currentPageIndex);
    if (tab === 'outline') this.loadOutline(session, shell);
    if (tab === 'annotations') this.loadAnnotations(session, shell);
  }

  private loadAnnotations(session: DocumentSession, shell: ReaderShell): void {
    if (!hasAnnotationListing(session)) {
      shell.sidebar?.annotationsPanel.setUnavailable();
      return;
    }
    this.annotationIntentFor = session;
    if (this.annotationProjection.snapshot().length > 0) this.renderAnnotationProjection(shell);
    if (this.requestPendingVerifiedAnnotations(session, shell)) return;
    if (this.hydrateLoadedAnnotations(session, shell)) return;
    if (Object.is(this.annotationsLoadingFor, session)) return;
    this.annotationAbort?.abort();
    const abort = new AbortController();
    this.annotationAbort = abort;
    this.annotationsLoadingFor = session;
    if (this.annotationProjection.snapshot().length === 0)
      shell.sidebar?.annotationsPanel.setLoading();
    const confirmedRevision = this.confirmedAnnotationRevision();
    void this.loadAnnotationData(session, abort.signal)
      .then((annotations) => {
        if (this.session !== session || this.shell !== shell || abort.signal.aborted) return;
        this.annotationsLoadingFor = null;
        this.annotationsLoadedFor = session;
        this.acceptVerifiedAnnotations(annotations, shell, confirmedRevision);
      })
      .catch((cause: unknown) => {
        if (
          abort.signal.aborted ||
          isAbortFailure(cause) ||
          this.session !== session ||
          this.shell !== shell
        )
          return;
        this.annotationsLoadingFor = null;
        shell.sidebar?.annotationsPanel.setUnavailable();
        console.error('[abyss-documents] Failed to extract PDF annotations', {
          path: session.descriptor.path,
          page: annotationFailurePage(cause) ?? this.currentPageIndex + 1,
          cause,
        });
      });
  }

  private async ensureAnnotationsLoaded(
    session: DocumentSession & AnnotationListingSession,
    shell: ReaderShell,
  ): Promise<readonly DocumentAnnotation[]> {
    this.annotationIntentFor = session;
    const refreshed = await this.waitForPendingVerifiedAnnotations(session, shell);
    if (refreshed !== null) return refreshed;
    if (Object.is(this.annotationsLoadedFor, session)) return this.currentAnnotations;
    return this.loadCurrentAnnotationData(session, shell);
  }

  private async loadCurrentAnnotationData(
    session: DocumentSession & AnnotationListingSession,
    shell: ReaderShell,
  ): Promise<readonly DocumentAnnotation[]> {
    this.annotationAbort?.abort();
    const abort = new AbortController();
    this.annotationAbort = abort;
    this.annotationsLoadingFor = session;
    if (this.annotationProjection.snapshot().length === 0)
      shell.sidebar?.annotationsPanel.setLoading();
    const confirmedRevision = this.confirmedAnnotationRevision();
    const annotations = await this.loadAnnotationData(session, abort.signal);
    if (this.session !== session || this.shell !== shell || abort.signal.aborted)
      throw new DOMException('Annotation link resolution was superseded.', 'AbortError');
    this.annotationsLoadingFor = null;
    this.annotationsLoadedFor = session;
    return this.acceptVerifiedAnnotations(annotations, shell, confirmedRevision);
  }

  private requestPendingVerifiedAnnotations(session: DocumentSession, shell: ReaderShell): boolean {
    if (!this.hasPendingVerifiedAnnotations(session)) return false;
    this.verifiedAnnotationFailureCause = null;
    this.verifiedAnnotationFailedMarker = null;
    if (this.annotationProjection.snapshot().length === 0)
      shell.sidebar?.annotationsPanel.setLoading();
    void this.awaitVerifiedAnnotationRefresh(session).catch((cause: unknown) => {
      const marker = this.verifiedAnnotationMarker;
      if (marker !== null) this.reportVerifiedAnnotationRefreshFailure(marker, cause);
    });
    return true;
  }

  private hydrateLoadedAnnotations(session: DocumentSession, shell: ReaderShell): boolean {
    if (!Object.is(this.annotationsLoadedFor, session)) return false;
    shell.sidebar?.annotationsPanel.setProjectedAnnotations(this.annotationProjection.snapshot());
    shell.sidebar?.annotationsPanel.setCurrentPage(this.currentPageIndex);
    return true;
  }

  private async waitForPendingVerifiedAnnotations(
    session: DocumentSession,
    shell: ReaderShell,
  ): Promise<readonly DocumentAnnotation[] | null> {
    if (!this.hasPendingVerifiedAnnotations(session)) return null;
    this.verifiedAnnotationFailureCause = null;
    this.verifiedAnnotationFailedMarker = null;
    if (this.annotationProjection.snapshot().length === 0)
      shell.sidebar?.annotationsPanel.setLoading();
    await this.awaitVerifiedAnnotationRefresh(session);
    if (!Object.is(this.session, session) || !Object.is(this.shell, shell))
      throw new DOMException('Annotation link resolution was superseded.', 'AbortError');
    return this.currentAnnotations;
  }

  private async loadAnnotationData(
    session: DocumentSession & AnnotationListingSession,
    signal: AbortSignal,
  ): Promise<readonly DocumentAnnotation[]> {
    const trackingTestFault = this.annotationLoadTestFault !== null;
    if (trackingTestFault) this.annotationLoadTestSnapshotState.loadsStarted += 1;
    try {
      const path = session.descriptor.path;
      const { annotations: cached, generation: cacheGeneration } = await this.readAnnotationCache(
        path,
        session.descriptor.fingerprint,
        signal,
      );
      this.throwIfAnnotationCancelled(signal);
      if (cached !== null && cached !== undefined) return cached;
      await this.applyAnnotationExtractionTestFault(signal);
      const annotations: DocumentAnnotation[] = [];
      await session.listAnnotations(signal, (batch) => {
        annotations.push(...batch);
      });
      this.throwIfAnnotationCancelled(signal);
      try {
        await this.annotationCache?.write(
          {
            version: 1,
            documentPath: path,
            fingerprint: session.descriptor.fingerprint,
            annotations,
          },
          cacheGeneration,
        );
      } catch (cause) {
        console.error('[abyss-documents] Annotation cache write failed', { path, cause });
      }
      return annotations;
    } catch (cause) {
      if (trackingTestFault) this.annotationLoadTestSnapshotState.loadsFailed += 1;
      throw cause;
    } finally {
      if (trackingTestFault) this.annotationLoadTestSnapshotState.loadsSettled += 1;
    }
  }

  private async readAnnotationCache(
    path: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<{
    readonly annotations: readonly DocumentAnnotation[] | null | undefined;
    readonly generation: number | undefined;
  }> {
    let generation = this.annotationCache?.generation(path);
    try {
      if (this.annotationLoadTestFault?.cacheRead === 'fail') {
        this.annotationLoadTestSnapshotState.cacheReadFaults += 1;
        throw new Error('Injected annotation cache read failure.');
      }
      return {
        annotations: await this.annotationCache?.read(path, fingerprint, generation),
        generation,
      };
    } catch (cause) {
      if (cause instanceof StaleAnnotationCacheReadError) {
        this.throwIfAnnotationCancelled(signal);
        generation = this.annotationCache?.generation(path);
      } else console.error('[abyss-documents] Annotation cache read failed', { path, cause });
      return { annotations: null, generation };
    }
  }

  private throwIfAnnotationCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Annotation loading was cancelled.', 'AbortError');
  }

  private async applyAnnotationExtractionTestFault(signal: AbortSignal): Promise<void> {
    const fault = this.annotationLoadTestFault;
    if (fault === null) return;
    const delay = fault.extractionDelayMs ?? 0;
    if (delay > 0) await abortableDelay(delay, signal);
    this.throwIfAnnotationCancelled(signal);
    if (fault.extractionFailure === true) {
      this.annotationLoadTestSnapshotState.extractionFaults += 1;
      throw new Error('Injected annotation extraction failure.');
    }
  }

  private loadOutline(session: DocumentSession, shell: ReaderShell): void {
    if (this.outlineLoadedFor === session || this.outlineLoadingFor === session) return;
    this.outlineLoadingFor = session;
    void session
      .getOutline()
      .then((items) => {
        if (this.session !== session || this.shell !== shell) return;
        this.outlineLoadingFor = null;
        this.outlineLoadedFor = session;
        shell.sidebar?.outlinePanel.render(items);
        shell.sidebar?.outlinePanel.setCurrentPage(this.currentPageIndex);
      })
      .catch((cause: unknown) => {
        if (this.session !== session || this.shell !== shell) return;
        this.outlineLoadingFor = null;
        shell.sidebar?.outlinePanel.render([]);
        new Notice(`Could not load document outline: ${this.reason(cause)}`);
        console.error('[abyss-documents] Failed to load PDF outline', {
          path: session.descriptor.path,
          cause,
        });
      });
  }

  private navigateSearchResult(hit: SearchHit): void {
    const viewport = this.viewport;
    if (viewport === null) return;
    this.selectSearchResult(viewport, hit).catch((cause: unknown) => {
      console.error('[abyss-documents] Failed to contain PDF search selection', { cause });
    });
  }

  private async selectSearchResult(viewport: DocumentViewport, hit: SearchHit): Promise<void> {
    try {
      await viewport.selectSearchHit(hit, this.currentSearchQuery);
    } catch (cause) {
      if (this.viewport !== viewport || (cause instanceof Error && cause.name === 'AbortError'))
        return;
      new Notice(`Could not select search result: ${this.reason(cause)}`);
      console.error('[abyss-documents] Failed to select PDF search result', {
        hitId: hit.id,
        cause,
      });
    }
  }

  private navigateTo(pageIndex: number): void {
    this.navigateToLocation({ pageIndex });
  }

  private navigateRelative(direction: -1 | 1): void {
    if (this.currentLayout.pages === 'single') {
      this.navigateTo(this.navigationPageIndex + direction);
      return;
    }
    const spreadStart = Math.floor(this.navigationPageIndex / 2) * 2;
    this.navigateTo(spreadStart + direction * 2);
  }

  private activateAnnotation(
    viewport: DocumentViewport,
    activation: AnnotationPanelActivation,
  ): void {
    const shell = this.shell;
    if (shell === null) return;
    this.cancelAnnotationActivation();
    const abort = new AbortController();
    this.annotationActivationAbort = abort;
    this.navigateToLocation(activation.location, {
      onArrive: () => {
        const interactionController =
          this.viewport === viewport && this.shell === shell
            ? this.annotationInteractionController
            : null;
        if (abort.signal.aborted) {
          this.finishAnnotationActivation(abort);
          return;
        }
        if (interactionController === null) {
          this.openReadOnlyAnnotationActivation(shell, activation, abort);
          return;
        }
        const resolved = shell.resolveAnnotationActivation(activation.rowId);
        void interactionController
          .activateAnnotation(activation.nativeId, {
            clientPosition: resolved?.clientPosition,
            kind: 'sidebar',
            signal: abort.signal,
          })
          .catch((cause: unknown) => {
            if (!abort.signal.aborted && !isAbortFailure(cause))
              this.reportAnnotationFailure('open PDF annotation', cause, {
                annotation: annotationDiagnosticIdentity(activation.annotation),
              });
            return 'cancelled' as const;
          })
          .finally(() => {
            this.finishAnnotationActivation(abort);
          });
      },
      onFailure: () => {
        this.finishAnnotationActivation(abort);
      },
      retainAnnotationActivation: true,
    });
  }

  private openReadOnlyAnnotationActivation(
    shell: ReaderShell,
    activation: AnnotationPanelActivation,
    abort: AbortController,
  ): void {
    if (abort.signal.aborted || this.shell !== shell) {
      this.finishAnnotationActivation(abort);
      return;
    }
    const resolved = shell.resolveAnnotationActivation(activation.rowId);
    if (resolved === null) {
      this.finishAnnotationActivation(abort);
      return;
    }
    if (!sameDocumentLocation(activation.location, resolved.location)) {
      this.finishAnnotationActivation(abort);
      return;
    }
    const { annotation, clientPosition: position } = resolved;
    shell.openAnnotationEditor(
      {
        target: { kind: 'readonly', annotation },
        palette: this.profileState.annotations?.palette ?? DEFAULT_SETTINGS.annotations.palette,
        color: annotation.color ?? undefined,
        position,
        onCreate: () => 'dismissed',
        onUpdate: () => false,
        onDelete: () => false,
        onClose: () => undefined,
      },
      { preserveResolvedRow: true },
    );
    this.finishAnnotationActivation(abort);
  }

  private cancelAnnotationActivation(resumeAutomaticSave = true): void {
    this.annotationActivationAbort?.abort();
    this.annotationActivationAbort = null;
    if (resumeAutomaticSave) this.resumeAutomaticSaveAfterInteraction();
  }

  private finishAnnotationActivation(abort: AbortController): void {
    if (this.annotationActivationAbort !== abort) return;
    this.annotationActivationAbort = null;
    this.resumeAutomaticSaveAfterInteraction();
  }

  private navigateToLocation(location: DocumentLocation, options: NavigationOptions = {}): void {
    const { annotationSelectionRetry, onArrive, onFailure } = options;
    this.cancelPendingAnnotationSelectionRetry();
    if (options.retainAnnotationActivation !== true) {
      this.cancelAnnotationActivation();
      this.annotationInteractionController?.invalidate('navigation');
    }
    const viewport = this.viewport;
    const shell = this.shell;
    if (viewport === null || shell === null || viewport.pageCount === 0) {
      onFailure?.();
      return;
    }
    const target = Math.min(viewport.pageCount - 1, Math.max(0, Math.floor(location.pageIndex)));
    const destination: DocumentLocation = { ...location, pageIndex: target };
    this.navigationPageIndex = target;
    this.pendingNavigationPageIndex = target;
    const revision = ++this.navigationRequestRevision;
    if (annotationSelectionRetry !== undefined) {
      this.startPendingAnnotationSelectionRetry(
        viewport,
        shell,
        target,
        annotationSelectionRetry.nativeId,
      );
    }
    void viewport
      .goTo(destination)
      .then(() => {
        if (this.viewport === viewport && revision === this.navigationRequestRevision) onArrive?.();
      })
      .catch((cause: unknown) => {
        this.handleNavigationFailure({
          cause,
          onFailure,
          revision,
          shell,
          target,
          viewport,
        });
      });
  }

  private handleNavigationFailure(context: NavigationFailureContext): void {
    const { cause, onFailure, revision, shell, target, viewport } = context;
    const isCurrentRequest =
      this.viewport === viewport && revision === this.navigationRequestRevision;
    if (!isCurrentRequest || isAbortFailure(cause)) {
      if (isCurrentRequest && this.pendingNavigationPageIndex === target) {
        this.navigationPageIndex = this.currentPageIndex;
        this.pendingNavigationPageIndex = null;
        shell.toolbar.setCurrentPage(this.currentPageIndex);
      }
      if (isCurrentRequest) this.cancelPendingAnnotationSelectionRetry();
      onFailure?.();
      return;
    }
    if (this.pendingNavigationPageIndex === target) {
      this.navigationPageIndex = this.currentPageIndex;
      this.pendingNavigationPageIndex = null;
    }
    shell.toolbar.setCurrentPage(this.currentPageIndex);
    const reason = this.reason(cause);
    new Notice(`Could not go to page ${target + 1}: ${reason}`);
    console.error('[abyss-documents] Failed to navigate PDF page', {
      pageIndex: target,
      cause,
    });
    this.cancelPendingAnnotationSelectionRetry();
    onFailure?.();
  }

  private startPendingAnnotationSelectionRetry(
    viewport: DocumentViewport,
    shell: ReaderShell,
    pageIndex: number,
    nativeId: string,
  ): void {
    const pending: PendingAnnotationSelectionRetry = {
      attempts: 0,
      nativeId,
      pageIndex,
      shell,
      timeoutId: 0,
      viewport,
    };
    pending.timeoutId = shell.root.win.setTimeout(() => {
      if (this.pendingAnnotationSelectionRetry === pending)
        this.pendingAnnotationSelectionRetry = null;
    }, ANNOTATION_SELECTION_RETRY_TIMEOUT_MS);
    this.pendingAnnotationSelectionRetry = pending;
  }

  private retryPendingAnnotationSelection(
    viewport: DocumentViewport,
    shell: ReaderShell,
    pageIndex: number,
  ): void {
    const pending = this.pendingAnnotationSelectionRetry;
    if (!this.isCurrentAnnotationSelectionRetry(pending, viewport, shell, pageIndex)) return;
    pending.attempts += 1;
    const selected =
      this.annotationInteractionController?.selectAnnotation(pending.nativeId) ?? false;
    if (selected || pending.attempts >= ANNOTATION_SELECTION_RETRY_LIMIT)
      this.cancelPendingAnnotationSelectionRetry();
  }

  private isCurrentAnnotationSelectionRetry(
    pending: PendingAnnotationSelectionRetry | null,
    viewport: DocumentViewport,
    shell: ReaderShell,
    pageIndex: number,
  ): pending is PendingAnnotationSelectionRetry {
    return (
      pending?.viewport === viewport &&
      pending.shell === shell &&
      pending.pageIndex === pageIndex &&
      this.viewport === viewport &&
      this.shell === shell
    );
  }

  private cancelPendingAnnotationSelectionRetry(): void {
    const pending = this.pendingAnnotationSelectionRetry;
    this.pendingAnnotationSelectionRetry = null;
    if (pending !== null) pending.shell.root.win.clearTimeout(pending.timeoutId);
  }

  private setScale(scale: ReaderScale): void {
    const viewport = this.viewport;
    const shell = this.shell;
    if (viewport === null || shell === null) return;
    this.annotationInteractionController?.invalidate('zoom');
    try {
      viewport.setScale(scale);
      shell.toolbar.setScale(scale);
    } catch (cause) {
      new Notice(`Could not change zoom: ${this.reason(cause)}`);
      console.error('[abyss-documents] Failed to change PDF scale', { scale, cause });
    }
  }

  private stepScale(direction: -1 | 1): void {
    const viewport = this.viewport;
    if (viewport === null) return;
    this.annotationInteractionController?.invalidate('zoom');
    try {
      viewport.stepScale(direction);
    } catch (cause) {
      new Notice(`Could not change zoom: ${this.reason(cause)}`);
      console.error('[abyss-documents] Failed to step PDF scale', { direction, cause });
    }
  }

  private setLayout(layout: ReaderLayout): void {
    const viewport = this.viewport;
    const session = this.session;
    const shell = this.shell;
    if (viewport === null || session === null || shell === null) return;
    this.annotationInteractionController?.invalidate('layout');
    try {
      viewport.setLayout(layout);
      this.currentLayout = { ...layout };
      shell.setLayout(layout);
    } catch (cause) {
      new Notice(`Could not change page layout: ${this.reason(cause)}`);
      console.error('[abyss-documents] Failed to change PDF layout', { layout, cause });
      return;
    }

    const fingerprint = session.descriptor.fingerprint;
    if (!this.profileState.layout.rememberPerDocument || fingerprint.length === 0) return;
    try {
      void Promise.resolve(this.profileState.updateLayoutForFingerprint(fingerprint, layout)).catch(
        (cause: unknown) => {
          this.layoutPersistenceFailure(fingerprint, layout, cause);
        },
      );
    } catch (cause) {
      this.layoutPersistenceFailure(fingerprint, layout, cause);
    }
  }

  private setProfile(profile: ReadingProfileId): void {
    const viewport = this.viewport;
    const session = this.session;
    const shell = this.shell;
    if (viewport === null || session === null || shell === null) return;
    this.profileService.setCustom(this.profileState.reading.custom);
    try {
      viewport.setReadingColors(this.profileService.resolve(profile, shell.obsidianTheme));
      this.currentProfile = profile;
      shell.toolbar.setProfile(profile);
      shell.root.dataset['readingProfile'] = profile;
    } catch (cause) {
      new Notice(`Could not apply ${profile} profile: ${this.reason(cause)}`);
      console.error('[abyss-documents] Failed to apply PDF reading profile', {
        profile,
        cause,
      });
      return;
    }

    const fingerprint = session.descriptor.fingerprint;
    if (!this.profileState.reading.rememberPerDocument || fingerprint.length === 0) return;
    try {
      void Promise.resolve(
        this.profileState.updateProfileForFingerprint(fingerprint, profile),
      ).catch((cause: unknown) => {
        this.profilePersistenceFailure(fingerprint, profile, cause);
      });
    } catch (cause) {
      this.profilePersistenceFailure(fingerprint, profile, cause);
    }
  }

  private handleViewportEvent(
    viewport: DocumentViewport,
    shell: ReaderShell,
    event: ViewportEvent,
  ): void {
    if (this.viewport !== viewport || this.shell !== shell) return;
    if (isContextViewportEvent(event)) {
      this.handleContextViewportEvent(viewport, shell, event);
      return;
    }
    if (isAnnotationProjectionEvent(event)) {
      this.queueAnnotationProjectionEvent(viewport, shell, event);
      return;
    }
    switch (event.type) {
      case 'page-change':
        this.handlePageChange(viewport, shell, event.pageIndex);
        return;
      case 'scale-change':
        shell.toolbar.setScale(event.scale);
        return;
      case 'search-results':
        this.handleSearchResults(shell, event.results);
        return;
      case 'annotation-mutation-error':
        this.reportAnnotationFailure(annotationMutationAction(event.action), event.cause, {
          mutation: event.action,
        });
        return;
      case 'render-error':
        return;
    }
  }

  private handleContextViewportEvent(
    viewport: DocumentViewport,
    shell: ReaderShell,
    event: ContextViewportEvent,
  ): void {
    switch (event.type) {
      case 'annotation-layer-rendered':
        this.retryPendingAnnotationSelection(viewport, shell, event.pageIndex);
        return;
      case 'annotation-select':
        this.handleAnnotationSelection(shell, event.nativeId);
        return;
      case 'geometry-change':
        shell.invalidateAnnotationEditorGeometry();
    }
  }

  private handleAnnotationSelection(shell: ReaderShell, nativeId: string | null): void {
    shell.closeAnnotationEditor();
    if (nativeId === null) shell.sidebar?.annotationsPanel.clearSelection();
    else shell.sidebar?.annotationsPanel.selectAnnotation(nativeId, false);
  }

  private queueAnnotationProjectionEvent(
    viewport: DocumentViewport,
    shell: ReaderShell,
    event: AnnotationProjectionViewportEvent,
  ): void {
    this.annotationProjectionEvents.push(
      Object.freeze({ event, revision: this.annotationMutationRevision() }),
    );
    if (this.annotationProjectionFrame !== null) return;
    const owner = shell.root.win;
    this.annotationProjectionFrameWindow = owner;
    this.annotationProjectionFrame = owner.requestAnimationFrame(() => {
      this.annotationProjectionFrame = null;
      this.annotationProjectionFrameWindow = null;
      const events = this.annotationProjectionEvents;
      this.annotationProjectionEvents = [];
      if (this.viewport !== viewport || this.shell !== shell || events.length === 0) return;
      if (!this.annotationProjection.applyViewportBatch(events)) return;
      this.annotationLiveRevision += events.length;
      this.renderAnnotationProjection(shell);
    });
  }

  private cancelAnnotationProjectionBatch(): void {
    if (this.annotationProjectionFrame !== null && this.annotationProjectionFrameWindow !== null)
      this.annotationProjectionFrameWindow.cancelAnimationFrame(this.annotationProjectionFrame);
    this.annotationProjectionFrame = null;
    this.annotationProjectionFrameWindow = null;
    this.annotationProjectionEvents = [];
  }

  private invalidateQueuedAnnotationObservations(identities: Iterable<string>): void {
    if (this.annotationProjectionEvents.length === 0) return;
    const closure = this.annotationProjection.identityClosure(identities);
    this.annotationProjectionEvents = this.annotationProjectionEvents.flatMap((observation) => {
      const retained = withoutViewportObservationIdentities(observation, closure);
      return retained === null ? [] : [retained];
    });
    if (this.annotationProjectionEvents.length === 0) this.cancelAnnotationProjectionBatch();
  }

  private fenceConfirmedAnnotationObservations(confirmedRevision: number): void {
    if (this.annotationProjectionEvents.length === 0) return;
    this.annotationProjectionEvents = this.annotationProjectionEvents.filter(
      (observation) => observation.revision > confirmedRevision,
    );
    if (this.annotationProjectionEvents.length === 0) this.cancelAnnotationProjectionBatch();
  }

  private handlePageChange(
    viewport: DocumentViewport,
    shell: ReaderShell,
    pageIndex: number,
  ): void {
    this.currentPageIndex = Math.min(
      Math.max(0, viewport.pageCount - 1),
      Math.max(0, Math.floor(pageIndex)),
    );
    if (
      this.pendingNavigationPageIndex === null ||
      this.currentPageIndex === this.pendingNavigationPageIndex
    ) {
      this.navigationPageIndex = this.currentPageIndex;
      this.pendingNavigationPageIndex = null;
    }
    shell.toolbar.setCurrentPage(this.currentPageIndex);
    shell.sidebar?.outlinePanel.setCurrentPage(this.currentPageIndex);
    shell.sidebar?.annotationsPanel.setCurrentPage(this.currentPageIndex);
    shell.announce(`Page ${this.currentPageIndex + 1} of ${viewport.pageCount}`);
  }

  private renderAnnotationProjection(shell: ReaderShell): void {
    this.currentAnnotations = this.annotationProjection.annotations();
    annotationEditorOf(this.viewport)?.setAnnotationProjection(
      this.annotationProjection.snapshot().map((row) => ({
        aliases: [row.provisionalId, ...(row.aliases ?? [])].filter(
          (alias): alias is string => alias !== undefined,
        ),
        annotation: annotationForActivation(row.annotation, row.writable),
        ...(row.runtimeId === undefined ? {} : { editorUid: row.runtimeId }),
        stableId: row.nativeId,
      })),
    );
    shell.sidebar?.annotationsPanel.setProjectedAnnotations(this.annotationProjection.snapshot());
    shell.sidebar?.annotationsPanel.setCurrentPage(this.currentPageIndex);
  }

  private projectedAnnotationForStableId(stableId: string): DocumentAnnotation | null {
    const id = stableId.trim();
    if (id.length === 0) return null;
    const rows = this.annotationProjection.snapshot();
    const row =
      uniqueProjectedRow(rows, (candidate) => candidate.nativeId === id) ??
      uniqueProjectedRow(rows, (candidate) => candidate.runtimeId === id) ??
      uniqueProjectedRow(rows, (candidate) => candidate.provisionalId === id) ??
      uniqueProjectedRow(rows, (candidate) => projectedAnnotationIdentity(candidate) === id) ??
      uniqueProjectedRow(rows, (candidate) => candidate.aliases?.includes(id) === true);
    return row === undefined ? null : annotationForActivation(row.annotation, row.writable);
  }

  private acceptVerifiedAnnotations(
    annotations: readonly DocumentAnnotation[],
    shell: ReaderShell,
    confirmedRevision: number,
  ): readonly DocumentAnnotation[] {
    const confirmedDeletionIdentities =
      this.annotationProjection.deletionIdentityClosureConfirmedBy(confirmedRevision);
    if (confirmedDeletionIdentities.size > 0)
      this.invalidateQueuedAnnotationObservations(confirmedDeletionIdentities);
    this.fenceConfirmedAnnotationObservations(confirmedRevision);
    this.annotationProjection.reconcile(annotations, confirmedRevision);
    this.renderAnnotationProjection(shell);
    return this.currentAnnotations;
  }

  private annotationMutationRevision(): number {
    return this.nativeSaveSession?.pendingRevision ?? 0;
  }

  private confirmedAnnotationRevision(): number {
    return this.nativeSaveSession?.committedRevision ?? 0;
  }

  private handleSearchResults(
    shell: ReaderShell,
    results: Extract<ViewportEvent, { readonly type: 'search-results' }>['results'],
  ): void {
    shell.sidebar?.searchPanel.setResults(results);
  }

  private handleThemeChange(
    viewport: DocumentViewport,
    shell: ReaderShell,
    theme: ObsidianTheme,
  ): void {
    if (
      this.viewport !== viewport ||
      this.shell !== shell ||
      this.currentProfile !== 'follow-obsidian'
    )
      return;
    this.profileService.setCustom(this.profileState.reading.custom);
    try {
      viewport.setReadingColors(this.profileService.resolve('follow-obsidian', theme));
    } catch (cause) {
      console.error('[abyss-documents] Failed to update automatic PDF reading profile', {
        theme,
        cause,
      });
    }
  }

  private initialProfile(fingerprint: string): ReadingProfileId {
    const saved = this.profileState.reading.rememberPerDocument
      ? this.profileState.profileByFingerprint[fingerprint]
      : undefined;
    if (isReadingProfileId(saved)) return saved;
    const fallback = this.profileState.reading.defaultProfile;
    return isReadingProfileId(fallback) ? fallback : 'default';
  }

  private initialLayout(fingerprint: string): ReaderLayout {
    const saved = this.profileState.layout.rememberPerDocument
      ? this.profileState.layoutByFingerprint[fingerprint]
      : undefined;
    if (isReaderLayout(saved)) return { ...saved };
    const fallback = this.profileState.layout.default;
    return isReaderLayout(fallback) ? { ...fallback } : { ...DEFAULT_READER_LAYOUT };
  }

  private layoutPolicyChanged(): boolean {
    const next = captureLayoutPolicy(this.profileState.layout);
    const changed =
      next.rememberPerDocument !== this.layoutPolicy.rememberPerDocument ||
      next.default.pages !== this.layoutPolicy.default.pages ||
      next.default.scrolling !== this.layoutPolicy.default.scrolling;
    this.layoutPolicy = next;
    return changed;
  }

  private layoutPersistenceFailure(
    fingerprint: string,
    layout: ReaderLayout,
    cause: unknown,
  ): void {
    new Notice(`Could not remember page layout: ${this.reason(cause)}`);
    console.error('[abyss-documents] Failed to remember PDF page layout', {
      fingerprint,
      layout,
      cause,
    });
  }

  private profilePersistenceFailure(
    fingerprint: string,
    profile: ReadingProfileId,
    cause: unknown,
  ): void {
    new Notice(`Could not remember reading profile: ${this.reason(cause)}`);
    console.error('[abyss-documents] Failed to remember PDF reading profile', {
      fingerprint,
      profile,
      cause,
    });
  }

  private tryCleanup(cleanup: (() => void) | null): Error | undefined {
    if (cleanup === null) return undefined;
    try {
      cleanup();
      return undefined;
    } catch (cause) {
      return this.asError(cause);
    }
  }

  private throwIfCancelled(file: TFile, signal: AbortSignal): void {
    if (signal.aborted) throw this.cancelled(file, signal.reason);
  }

  private cancelled(file: TFile, cause?: unknown): DocumentCancelledError {
    return new DocumentCancelledError(file.path, 'Opening this PDF was cancelled.', cause);
  }

  private asError(cause: unknown): Error {
    return cause instanceof Error
      ? cause
      : new Error(`Unknown reader cleanup failure: ${String(cause)}`);
  }

  private reason(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'object' && cause !== null && 'message' in cause) {
      const message = (cause as { readonly message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return String(cause);
  }
}

function isNativeEditableSessionFactory(
  session: DocumentSession,
): session is NativeEditableSessionFactory {
  return (
    'createNativeEditableSession' in session &&
    typeof session.createNativeEditableSession === 'function'
  );
}

interface AnnotationListingSession {
  listAnnotations(signal: AbortSignal, sink: AnnotationSink): Promise<void>;
}

function hasAnnotationListing(
  session: DocumentSession,
): session is DocumentSession & AnnotationListingSession {
  return 'listAnnotations' in session && typeof session.listAnnotations === 'function';
}

function isAbortFailure(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    (cause as { readonly name?: unknown }).name === 'AbortError'
  );
}

function annotationFailurePage(cause: unknown): number | null {
  const seen = new Set<unknown>();
  let current = cause;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('pageNumber' in current) {
      const pageNumber = current.pageNumber;
      if (typeof pageNumber === 'number' && Number.isInteger(pageNumber) && pageNumber >= 1)
        return pageNumber;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

function annotationDiagnosticIdentity(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function sameDocumentLocation(left: DocumentLocation, right: DocumentLocation): boolean {
  return (
    left.pageIndex === right.pageIndex &&
    left.coordinateSpace === right.coordinateSpace &&
    left.x === right.x &&
    left.y === right.y
  );
}

function annotationMutationAction(
  action: Extract<ViewportEvent, { readonly type: 'annotation-mutation-error' }>['action'],
): string {
  if (action === 'open-annotation') return 'open PDF annotation';
  if (action === 'save-comment') return 'save PDF annotation comment';
  if (action === 'delete-comment') return 'delete PDF annotation comment';
  if (action === 'change-color') return 'change PDF annotation color';
  return 'delete PDF annotation';
}

function isAnnotationProjectionEvent(
  event: ViewportEvent,
): event is Extract<ViewportEvent, { readonly type: 'annotation-change' | 'annotation-snapshot' }> {
  return event.type === 'annotation-change' || event.type === 'annotation-snapshot';
}

function isContextViewportEvent(event: ViewportEvent): event is ContextViewportEvent {
  return (
    event.type === 'annotation-layer-rendered' ||
    event.type === 'annotation-select' ||
    event.type === 'geometry-change'
  );
}

function isReadingProfileId(value: unknown): value is ReadingProfileId {
  return (
    value === 'default' ||
    value === 'follow-obsidian' ||
    value === 'light' ||
    value === 'sepia' ||
    value === 'dark' ||
    value === 'custom'
  );
}

function isReaderLayout(value: unknown): value is ReaderLayout {
  if (typeof value !== 'object' || value === null) return false;
  const layout = value as Partial<ReaderLayout>;
  return (
    (layout.pages === 'single' || layout.pages === 'facing') &&
    (layout.scrolling === 'continuous' || layout.scrolling === 'page-by-page')
  );
}

function captureLayoutPolicy(layout: PluginSettings['layout']): LayoutPolicySnapshot {
  return {
    default: { ...layout.default },
    rememberPerDocument: layout.rememberPerDocument,
  };
}

function annotationEditorOf(viewport: DocumentViewport | null): PdfAnnotationEditor | null {
  if (viewport === null || !('annotationEditor' in viewport)) return null;
  return (viewport as AnnotationEditorViewport).annotationEditor;
}

function annotationInteractionOf(
  viewport: DocumentViewport | null,
): PdfAnnotationInteraction | null {
  if (viewport === null || !('annotationInteraction' in viewport)) return null;
  return (viewport as AnnotationInteractionViewport).annotationInteraction;
}

function isAutomaticSaveReason(reason: SaveReason): boolean {
  return reason === 'autosave' || reason === 'maximum-latency';
}

function waitForAnnotationEditorCloseOrWake(
  shell: ReaderShell,
  signal: AbortSignal,
  wakeListeners: Set<() => void>,
): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new DOMException('Saving PDF annotations was cancelled.', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    let unregister = (): void => undefined;
    const cleanup = (): void => {
      unregister();
      signal.removeEventListener('abort', onAbort);
      wakeListeners.delete(onWake);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Saving PDF annotations was cancelled.', 'AbortError'));
    };
    const onWake = (): void => {
      cleanup();
      resolve();
    };
    unregister = shell.onAnnotationEditorClose(onWake);
    wakeListeners.add(onWake);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function annotationSelectionProjectionOf(
  viewport: DocumentViewport,
): AnnotationSelectionProjectionViewport | null {
  return 'projectSelectionRects' in viewport && typeof viewport.projectSelectionRects === 'function'
    ? (viewport as AnnotationSelectionProjectionViewport)
    : null;
}

function annotationForActivation(
  annotation: DocumentAnnotation,
  writable: boolean,
): DocumentAnnotation {
  if (writable) return annotation;
  const reason = {
    code: 'document-read-only' as const,
    message: 'This annotation is read-only.',
  };
  const unavailable = { available: false as const, reason };
  return {
    ...annotation,
    capabilities: {
      color: unavailable,
      comment: unavailable,
      conversions: { highlight: unavailable, underline: unavailable },
      deletion: unavailable,
      geometry: unavailable,
      metadata: unavailable,
    },
  };
}

function annotationToolForMode(mode: PdfAnnotationLogicalMode): PdfAnnotationTool {
  if (mode === 'quick-highlight') return 'highlight';
  if (mode === 'ink') return 'ink';
  if (mode === 'freetext') return 'freetext';
  return 'select';
}

function uniqueProjectedRow(
  rows: readonly AnnotationProjectionRow[],
  matches: (row: AnnotationProjectionRow) => boolean,
): AnnotationProjectionRow | undefined {
  const candidates = rows.filter(matches);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function projectedAnnotationIdentity(row: AnnotationProjectionRow): string {
  return row.annotation.identity.kind === 'stable'
    ? row.annotation.identity.id
    : row.annotation.identity.fingerprint;
}

function annotationReadOnlyReason(
  session: DocumentSession,
  editor: PdfAnnotationEditor | null,
): string | null {
  if ('annotationCapabilities' in session) {
    const capabilities = session.annotationCapabilities as {
      readonly readOnlyReason?: { readonly message?: unknown } | null;
    };
    const message = capabilities.readOnlyReason?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return editor === null ? 'PDF annotation editing is not available for this document.' : null;
}

function annotationColorParameter(
  tool: Exclude<PdfAnnotationTool, 'select'>,
): 'freetext-color' | 'highlight-color' | 'ink-color' {
  if (tool === 'highlight') return 'highlight-color';
  if (tool === 'ink') return 'ink-color';
  return 'freetext-color';
}

function annotationToolColorDefaults(color: string): Record<WritableAnnotationTool, string> {
  return { freetext: color, highlight: color, ink: color };
}

function writableAnnotationTools(): readonly WritableAnnotationTool[] {
  return ['highlight', 'ink', 'freetext'];
}

function annotationColorLabels(
  palette: PluginSettings['annotations']['palette'],
): Pick<ReaderSidebarCallbacks, 'annotationColorMeanings' | 'annotationColorNames'> {
  return {
    annotationColorMeanings: Object.fromEntries(
      palette.flatMap((entry) => {
        const meaning = entry.meaning.trim();
        return meaning.length > 0 ? [[entry.color.toLocaleLowerCase(), meaning]] : [];
      }),
    ),
    annotationColorNames: Object.fromEntries(
      palette.map((entry) => [entry.color.toLocaleLowerCase(), entry.name]),
    ),
  };
}

function isAnnotationToolbarIntent(intent: ReaderShellIntent): intent is AnnotationToolbarIntent {
  return (
    intent.type === 'set-annotation-tool' ||
    intent.type === 'set-annotation-color' ||
    intent.type === 'undo-annotation' ||
    intent.type === 'redo-annotation'
  );
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new DOMException('Annotation loading was cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Annotation loading was cancelled.', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
