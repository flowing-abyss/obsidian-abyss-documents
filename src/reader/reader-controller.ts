import { Notice, type TFile } from 'obsidian';
import type {
  PdfAnnotationEditor,
  PdfAnnotationTool,
} from '../adapters/pdf/pdf-annotation-editor.js';
import { StaleAnnotationCacheReadError, type AnnotationCache } from '../annotation-cache.js';
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
  type NativeEditableSaveSession,
  type NativeSaveRecoveryFailure,
  type VerifiedReloadListener,
  type VerifiedReloadSource,
} from '../document-core/save-coordinator.js';
import { markReaderPerformance, markReaderPerformanceOnce } from '../reader-performance.js';
import { DEFAULT_SETTINGS, type PluginSettings } from '../settings.js';
import type { AnnotationToolbarIntent } from './annotation-toolbar.js';
import {
  applyAnnotationTransfer,
  resolveAnnotationHref,
  type AnnotationHrefReference,
  type AnnotationTransferService,
} from './annotation-transfer.js';
import { ReaderShell, type ReaderShellIntent } from './reader-shell.js';
import { ReadingProfileService, type ObsidianTheme } from './reading-profiles.js';
import type { SaveConflictAction } from './save-conflict-modal.js';
import { SaveFailureNoticeBoundary } from './save-failure-boundary.js';
import type { ReaderSidebarCallbacks, ReaderSidebarTab } from './sidebar.js';

export type ShellFactory = (
  host: HTMLElement,
  onIntent: (intent: ReaderShellIntent) => void,
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

interface AnnotationEditorViewport extends DocumentViewport {
  readonly annotationEditor: PdfAnnotationEditor | null;
}

interface AnnotationToolRequest {
  readonly editor: PdfAnnotationEditor;
  readonly previous: PdfAnnotationTool;
  readonly revision: number;
  readonly shell: ReaderShell;
  readonly tool: PdfAnnotationTool;
  readonly viewport: DocumentViewport;
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

export class ReaderController {
  private queue: Promise<void> = Promise.resolve();
  private activeOpen: AbortController | null = null;
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
  private lastAutosaveFailureKey: string | null = null;
  private lastAnnotationFailureKey: string | null = null;
  private lastAnnotationExportPreparationFailureKey: string | null = null;
  private annotationToolRequestRevision = 0;
  private currentAnnotationTool: PdfAnnotationTool = 'select';
  private currentAnnotationColor = DEFAULT_SETTINGS.annotations.palette[0]?.color ?? '#ffd400';
  private readonly saveFailureOwner = {};
  private currentFile: TFile | null = null;
  private currentHost: HTMLElement | null = null;

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
    this.activeOpen?.abort();
    const abortController = new AbortController();
    this.activeOpen = abortController;
    return this.enqueue(() => this.openOnce(file, host, abortController));
  }

  close(): Promise<void> {
    this.activeOpen?.abort();
    this.activeOpen = null;
    return this.enqueue(() => this.releaseCurrent());
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
      shell.toolbar.setLayout(layout);
      shell.toolbar.setProfile(this.currentProfile);
      this.refreshAnnotationToolbar(session, viewport, shell);
    } catch (cause) {
      console.error('[abyss-documents] Failed to refresh PDF reading settings', {
        profile: this.currentProfile,
        cause,
      });
    }
  }

  saveDocument(): Promise<void> {
    return this.autosave?.flush() ?? Promise.resolve();
  }

  async resolveAnnotationLink(reference: AnnotationHrefReference): Promise<void> {
    const shell = this.shell;
    const session = this.session;
    if (shell === null || session === null || !hasAnnotationListing(session)) return;
    const annotations = await this.ensureAnnotationsLoaded(session, shell);
    if (this.session !== session || this.shell !== shell) return;
    this.openSidebar('annotations');
    const resolution = resolveAnnotationHref(reference, annotations);
    if (resolution.status !== 'resolved') {
      this.reportAnnotationResolutionFailure(shell, session, reference, resolution);
      return;
    }
    const id =
      resolution.annotation.identity.kind === 'stable'
        ? resolution.annotation.identity.id
        : resolution.annotation.identity.fingerprint;
    shell.sidebar?.annotationsPanel.selectAnnotation(id);
    this.navigateToLocation(annotationLocation(resolution.annotation));
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
  ): Promise<void> {
    try {
      await this.releaseCurrent();
      this.throwIfCancelled(file, abortController.signal);
      await this.mountCurrent(file, host, abortController.signal);
    } finally {
      if (this.activeOpen === abortController) this.activeOpen = null;
    }
  }

  private async mountCurrent(file: TFile, host: HTMLElement, signal: AbortSignal): Promise<void> {
    const shell = this.createShell(host, (intent) => {
      this.handleToolbarIntent(intent);
    });
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
    if (this.session === session) {
      this.session = null;
      this.viewport = null;
      this.shell = null;
      this.unsubscribeViewport = null;
      this.resetReaderState();
      this.releaseSaveLifecycle();
    }
    let failure = this.tryCleanup(unsubscribeViewport);
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
    shell.toolbar.setLayout(this.currentLayout);
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
    this.activateNativeSave(session);
    return unsubscribeViewport;
  }

  private resetAnnotationProjectionState(): void {
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
      async (revision, _reason) => {
        const abort = new AbortController();
        this.saveAbort = abort;
        try {
          const request = {
            path: session.descriptor.path,
            baseToken: native.baseToken,
            revision,
            source: native,
          } as const;
          try {
            await this.saveCoordinator?.save(request, abort.signal);
          } catch (cause) {
            if (!(cause instanceof SaveConflictError) || this.optionsConflictResolver === null) {
              throw cause;
            }
            const action = await this.optionsConflictResolver(session.descriptor.path);
            if (action === 'overwrite') {
              await this.saveCoordinator?.save({ ...request, overwrite: true }, abort.signal);
            } else {
              if (action === 'reload-discard') {
                this.reloadCurrentAfterConflict();
                throw new SaveDiscardedError(cause);
              }
              throw cause;
            }
          }
          this.lastAutosaveFailureKey = null;
          this.saveFailureBoundary.clear(this.saveFailureOwner, session.descriptor.path);
        } finally {
          if (this.saveAbort === abort) this.saveAbort = null;
        }
      },
      {
        onFailure: (cause, _generation, reason) => {
          if (cause instanceof SaveDiscardedError) return;
          this.reportSaveFailure(session.descriptor.path, cause, reason);
        },
      },
    );
    this.nativeSaveSession = native;
    this.autosave = scheduler;
    this.registerNativeSaveBroadcast(session, native, scheduler);
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
    const listener: VerifiedReloadListener = (token, revision, source) => {
      if (source !== native) {
        if (native.isDirty) {
          scheduler.pauseForFailure(
            new SaveConflictError(session.descriptor.path, native.baseToken, token),
            native.pendingRevision,
          );
        } else {
          this.reloadCurrentAfterConflict();
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
    this.currentAnnotations = [];
    if (this.hasAnnotationIntent(session)) shell.sidebar?.annotationsPanel.setLoading();
    this.startVerifiedAnnotationInvalidation(marker);
  }

  private startVerifiedAnnotationInvalidation(marker: VerifiedAnnotationMarker): void {
    const task = Promise.resolve(this.annotationCache?.invalidate(marker.session.descriptor.path))
      .then(() => {
        if (!this.isCurrentAnnotationMarker(marker) || !this.hasAnnotationIntent(marker.session))
          return;
        this.verifiedAnnotationRefresh = this.scheduleVerifiedAnnotationRefresh(marker.session);
      })
      .catch((cause: unknown) => {
        if (!this.isCurrentAnnotationMarker(marker)) return;
        this.verifiedAnnotationFailureCause = cause;
        this.verifiedAnnotationFailedMarker = marker;
        this.reportVerifiedAnnotationRefreshFailure(marker, cause);
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
        this.currentAnnotations = annotations;
        marker.shell.sidebar?.annotationsPanel.setAnnotations(annotations);
        marker.shell.sidebar?.annotationsPanel.setCurrentPage(this.currentPageIndex);
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
    marker.shell.sidebar?.annotationsPanel.setError(
      'Could not refresh saved annotations. Reopen the PDF to retry.',
    );
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

  private reloadCurrentAfterConflict(): void {
    const file = this.currentFile;
    const host = this.currentHost;
    if (file === null || host === null) return;
    this.reloadExternalFile(file, host);
  }

  private reloadExternalFile(file: TFile, host: HTMLElement): void {
    queueMicrotask(() => {
      void this.open(file, host).catch((cause: unknown) => {
        host.dataset['saveConflict'] = 'true';
        const reason = this.reason(cause);
        this.saveFailureBoundary.report({
          ownerId: this.saveFailureOwner,
          host,
          path: file.path,
          reason,
          retryAction: () => {
            this.reloadExternalFile(file, host);
          },
          label: 'Could not reload updated PDF',
        });
        console.error('[abyss-documents] Failed to reload externally modified PDF', {
          path: file.path,
          cause,
        });
      });
    });
  }

  private reportSaveFailure(path: string, cause: unknown, reason: SaveReason): void {
    const failureReason = this.reason(cause);
    const key = `${path}\u0000${failureReason}`;
    if (key !== this.lastAutosaveFailureKey) {
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
      this.finishRecovery(failure.path);
    } catch (cause) {
      this.reportRecoveryFailure(failure.path, cause, abort.signal);
      throw cause;
    } finally {
      if (this.recoveryAbort === abort) this.recoveryAbort = null;
    }
  }

  private finishRecovery(path: string): void {
    this.lastAutosaveFailureKey = null;
    this.saveFailureBoundary.clear(this.saveFailureOwner, path);
    if (this.currentHost !== null) delete this.currentHost.dataset['saveConflict'];
    this.reloadCurrentAfterConflict();
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

  private async releaseCurrent(): Promise<void> {
    const viewport = this.viewport;
    const session = this.session;
    const shell = this.shell;
    const unsubscribeViewport = this.unsubscribeViewport;
    this.viewport = null;
    this.session = null;
    this.shell = null;
    this.unsubscribeViewport = null;
    this.resetReaderState();
    this.releaseSaveLifecycle();

    let failure = this.tryCleanup(unsubscribeViewport);
    const lifecycleFailure = await this.releasePartial(viewport, session);
    failure ??= lifecycleFailure;
    try {
      shell?.destroy();
    } catch (cause) {
      failure ??= this.asError(cause);
    }
    if (failure !== undefined) throw failure;
  }

  private resetReaderState(): void {
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
          shell.sidebar?.annotationsPanel.setError(
            'Could not prepare annotations for export. Try again.',
          );
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
        this.setAnnotationTool(intent.tool);
        return;
      case 'set-annotation-color':
        this.setAnnotationColor(intent.color);
        return;
      case 'undo-annotation':
        this.runAnnotationHistory('undo');
        return;
      case 'redo-annotation':
        this.runAnnotationHistory('redo');
        return;
      case 'delete-annotation':
        this.deleteSelectedAnnotation();
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
    this.currentAnnotationColor = palette[0]?.color ?? '#ffd400';
    shell.configureAnnotationToolbar(palette, annotationReadOnlyReason(session, annotationEditor));
  }

  private refreshAnnotationToolbar(
    session: DocumentSession,
    viewport: DocumentViewport,
    shell: ReaderShell,
  ): void {
    const editor = annotationEditorOf(viewport);
    const palette = this.profileState.annotations?.palette ?? DEFAULT_SETTINGS.annotations.palette;
    shell.configureAnnotationToolbar(palette, annotationReadOnlyReason(session, editor));
    shell.annotationToolbar?.setTool(this.currentAnnotationTool);
    const selectedColor = palette.some(
      ({ color }) => color.toLocaleLowerCase() === this.currentAnnotationColor.toLocaleLowerCase(),
    )
      ? this.currentAnnotationColor
      : (palette[0]?.color ?? '#ffd400');
    this.setAnnotationColor(selectedColor);
  }

  private setAnnotationTool(tool: PdfAnnotationTool): void {
    const editor = annotationEditorOf(this.viewport);
    const shell = this.shell;
    const viewport = this.viewport;
    if (editor === null || shell === null || viewport === null) return;
    const previous = this.currentAnnotationTool;
    const revision = ++this.annotationToolRequestRevision;
    this.commitAnnotationTool({ editor, previous, revision, shell, tool, viewport }).catch(
      (cause: unknown) => {
        console.error('[abyss-documents] Unexpected annotation tool transaction failure', {
          cause,
        });
      },
    );
  }

  private setAnnotationColor(color: string): void {
    const editor = annotationEditorOf(this.viewport);
    const toolbar = this.shell?.annotationToolbar;
    const tool = this.currentAnnotationTool;
    if (editor === null || toolbar === undefined || toolbar === null) return;
    if (tool === 'select') {
      this.currentAnnotationColor = color;
      toolbar.setColor(color);
      return;
    }
    try {
      editor.setParameter(annotationColorParameter(tool), color);
      this.currentAnnotationColor = color;
      toolbar.setColor(color);
      this.lastAnnotationFailureKey = null;
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
      this.finishAnnotationTool(request);
    } catch (cause) {
      await this.rejectAnnotationTool(request, cause, nativeModeChanged);
    }
  }

  private finishAnnotationTool(request: AnnotationToolRequest): void {
    const { editor, revision, shell, tool, viewport } = request;
    if (!this.isCurrentAnnotationRequest(viewport, revision)) return;
    if (tool !== 'select') {
      editor.setParameter(annotationColorParameter(tool), this.currentAnnotationColor);
    }
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

  private runAnnotationHistory(action: 'redo' | 'undo'): void {
    const editor = annotationEditorOf(this.viewport);
    if (editor === null) return;
    try {
      editor[action]();
      this.lastAnnotationFailureKey = null;
    } catch (cause) {
      this.reportAnnotationFailure(`${action} PDF annotation`, cause, { action });
    }
  }

  private deleteSelectedAnnotation(): void {
    const editor = annotationEditorOf(this.viewport);
    if (editor === null) return;
    try {
      editor.deleteSelection();
      this.lastAnnotationFailureKey = null;
    } catch (cause) {
      this.reportAnnotationFailure('delete selected annotation', cause, {});
    }
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
            onAnnotationCopy: (annotation) => {
              transfer.copyAnnotationLink(annotation, file).catch((cause: unknown) => {
                console.error('[abyss-documents] Failed to contain annotation copy', { cause });
              });
            },
            onAnnotationInsert: (annotation) => {
              transfer.insertAnnotationIntoActiveMarkdown(annotation, file);
            },
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
      annotationColorMeanings: Object.fromEntries(
        (this.profileState.annotations?.palette ?? []).map((entry) => [
          entry.color.toLocaleLowerCase(),
          entry.meaning.trim().length > 0 ? entry.meaning.trim() : entry.name,
        ]),
      ),
      onClose: () => undefined,
      onAnnotationNavigate: (location) => {
        this.navigateToLocation(location);
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
    if (!hasAnnotationListing(session)) return;
    this.annotationIntentFor = session;
    if (this.requestPendingVerifiedAnnotations(session, shell)) return;
    if (this.hydrateLoadedAnnotations(session, shell)) return;
    if (Object.is(this.annotationsLoadingFor, session)) return;
    this.annotationAbort?.abort();
    const abort = new AbortController();
    this.annotationAbort = abort;
    this.annotationsLoadingFor = session;
    shell.sidebar?.annotationsPanel.setLoading();
    void this.loadAnnotationData(session, abort.signal)
      .then((annotations) => {
        if (this.session !== session || this.shell !== shell || abort.signal.aborted) return;
        this.annotationsLoadingFor = null;
        this.annotationsLoadedFor = session;
        this.currentAnnotations = annotations;
        shell.sidebar?.annotationsPanel.setAnnotations(annotations);
        shell.sidebar?.annotationsPanel.setCurrentPage(this.currentPageIndex);
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
        shell.sidebar?.annotationsPanel.setError(
          'Could not index annotations. Reopen the PDF to retry.',
        );
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
    this.annotationAbort?.abort();
    const abort = new AbortController();
    this.annotationAbort = abort;
    this.annotationsLoadingFor = session;
    shell.sidebar?.annotationsPanel.setLoading();
    const annotations = await this.loadAnnotationData(session, abort.signal);
    if (this.session !== session || this.shell !== shell || abort.signal.aborted)
      throw new DOMException('Annotation link resolution was superseded.', 'AbortError');
    this.annotationsLoadingFor = null;
    this.annotationsLoadedFor = session;
    this.currentAnnotations = annotations;
    shell.sidebar?.annotationsPanel.setAnnotations(annotations);
    shell.sidebar?.annotationsPanel.setCurrentPage(this.currentPageIndex);
    return annotations;
  }

  private requestPendingVerifiedAnnotations(session: DocumentSession, shell: ReaderShell): boolean {
    if (!this.hasPendingVerifiedAnnotations(session)) return false;
    this.verifiedAnnotationFailureCause = null;
    this.verifiedAnnotationFailedMarker = null;
    shell.sidebar?.annotationsPanel.setLoading();
    void this.awaitVerifiedAnnotationRefresh(session).catch((cause: unknown) => {
      const marker = this.verifiedAnnotationMarker;
      if (marker !== null) this.reportVerifiedAnnotationRefreshFailure(marker, cause);
    });
    return true;
  }

  private hydrateLoadedAnnotations(session: DocumentSession, shell: ReaderShell): boolean {
    if (!Object.is(this.annotationsLoadedFor, session)) return false;
    shell.sidebar?.annotationsPanel.setAnnotations(this.currentAnnotations);
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
    const path = session.descriptor.path;
    let cacheGeneration = this.annotationCache?.generation(path);
    let cached: readonly DocumentAnnotation[] | null | undefined;
    try {
      cached = await this.annotationCache?.read(
        path,
        session.descriptor.fingerprint,
        cacheGeneration,
      );
    } catch (cause) {
      if (!(cause instanceof StaleAnnotationCacheReadError)) throw cause;
      this.throwIfAnnotationCancelled(signal);
      cacheGeneration = this.annotationCache?.generation(path);
      cached = null;
    }
    this.throwIfAnnotationCancelled(signal);
    if (cached !== null && cached !== undefined) return cached;
    const annotations: DocumentAnnotation[] = [];
    await session.listAnnotations(signal, (batch) => {
      annotations.push(...batch);
    });
    this.throwIfAnnotationCancelled(signal);
    const stored = await this.annotationCache?.write(
      {
        version: 1,
        documentPath: path,
        fingerprint: session.descriptor.fingerprint,
        annotations,
      },
      cacheGeneration,
    );
    if (stored === false)
      throw new DOMException('Annotation extraction became stale.', 'AbortError');
    return annotations;
  }

  private throwIfAnnotationCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Annotation loading was cancelled.', 'AbortError');
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

  private navigateToLocation(location: DocumentLocation): void {
    const viewport = this.viewport;
    const shell = this.shell;
    if (viewport === null || shell === null || viewport.pageCount === 0) return;
    const target = Math.min(viewport.pageCount - 1, Math.max(0, Math.floor(location.pageIndex)));
    const destination: DocumentLocation = { ...location, pageIndex: target };
    this.navigationPageIndex = target;
    this.pendingNavigationPageIndex = target;
    const revision = ++this.navigationRequestRevision;
    void viewport.goTo(destination).catch((cause: unknown) => {
      if (this.viewport !== viewport) return;
      if (
        revision === this.navigationRequestRevision &&
        this.pendingNavigationPageIndex === target
      ) {
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
    });
  }

  private setScale(scale: ReaderScale): void {
    const viewport = this.viewport;
    const shell = this.shell;
    if (viewport === null || shell === null) return;
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
    try {
      viewport.setLayout(layout);
      this.currentLayout = { ...layout };
      shell.toolbar.setLayout(layout);
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

function annotationLocation(annotation: DocumentAnnotation): DocumentLocation {
  if (annotation.anchor.kind !== 'fixed-page') return { pageIndex: 0 };
  const { geometry } = annotation.anchor;
  if (geometry.kind === 'point')
    return { pageIndex: annotation.anchor.pageIndex, ...geometry.point };
  if (geometry.kind === 'rectangle')
    return {
      pageIndex: annotation.anchor.pageIndex,
      x: geometry.rectangle.x,
      y: geometry.rectangle.y,
    };
  if (geometry.kind === 'quadrilaterals')
    return { pageIndex: annotation.anchor.pageIndex, ...geometry.quadrilaterals[0]?.topLeft };
  return { pageIndex: annotation.anchor.pageIndex, ...geometry.paths[0]?.[0] };
}

function annotationDiagnosticIdentity(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function annotationMutationAction(
  action: Extract<ViewportEvent, { readonly type: 'annotation-mutation-error' }>['action'],
): string {
  if (action === 'save-comment') return 'save PDF annotation comment';
  if (action === 'delete-comment') return 'delete PDF annotation comment';
  if (action === 'change-color') return 'change PDF annotation color';
  return 'delete PDF annotation';
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

function isAnnotationToolbarIntent(intent: ReaderShellIntent): intent is AnnotationToolbarIntent {
  return (
    intent.type === 'set-annotation-tool' ||
    intent.type === 'set-annotation-color' ||
    intent.type === 'undo-annotation' ||
    intent.type === 'redo-annotation' ||
    intent.type === 'delete-annotation'
  );
}
