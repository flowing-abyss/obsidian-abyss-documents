import { Notice, type TFile } from 'obsidian';
import type { AnnotationCache } from '../annotation-cache.js';
import type { AnnotationSink, DocumentAnnotation } from '../document-core/annotations.js';
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
import { markReaderPerformance, markReaderPerformanceOnce } from '../reader-performance.js';
import { DEFAULT_SETTINGS, type PluginSettings } from '../settings.js';
import { ReaderShell, type ReaderShellIntent } from './reader-shell.js';
import { ReadingProfileService, type ObsidianTheme } from './reading-profiles.js';
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
  private annotationsLoadedFor: DocumentSession | null = null;
  private annotationsLoadingFor: DocumentSession | null = null;
  private readonly annotationCache: AnnotationCache | null;
  private readonly profileService: ReadingProfileService;

  constructor(
    private readonly registry: DocumentAdapterRegistry,
    private readonly createShell: ShellFactory = (host, onIntent) =>
      new ReaderShell(host, onIntent),
    private readonly profileState: ReaderProfileState = DEFAULT_PROFILE_STATE,
    services: ReaderControllerServices = {},
  ) {
    this.annotationCache = services.annotationCache ?? null;
    this.profileService = services.profileService ?? new ReadingProfileService();
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
    if (viewport === null || shell === null) return;
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
    } catch (cause) {
      console.error('[abyss-documents] Failed to refresh PDF reading settings', {
        profile: this.currentProfile,
        cause,
      });
    }
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
    } catch (cause) {
      let cleanupFailure = this.tryCleanup(unsubscribeViewport);
      const lifecycleFailure = await this.releasePartial(viewport, session);
      cleanupFailure ??= lifecycleFailure;
      this.reportPartialCleanupFailure(file.path, cleanupFailure);
      this.throwOpenFailure(file, signal, cause);
    }
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
    this.annotationAbort?.abort();
    this.annotationAbort = null;
    this.annotationsLoadedFor = null;
    this.annotationsLoadingFor = null;
    this.currentProfile = this.initialProfile(session.descriptor.fingerprint);
    this.currentLayout = this.initialLayout(session.descriptor.fingerprint);
    this.layoutPolicy = captureLayoutPolicy(this.profileState.layout);
    this.profileService.setCustom(this.profileState.reading.custom);
    viewport.setLayout(this.currentLayout);
    viewport.setReadingColors(
      this.profileService.resolve(this.currentProfile, shell.obsidianTheme),
    );
    shell.toolbar.setPageCount(viewport.pageCount);
    shell.toolbar.setCurrentPage(this.currentPageIndex);
    shell.toolbar.setProfile(this.currentProfile);
    shell.toolbar.setLayout(this.currentLayout);
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
    return unsubscribeViewport;
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
    this.outlineLoadedFor = null;
    this.outlineLoadingFor = null;
    this.annotationAbort?.abort();
    this.annotationAbort = null;
    this.annotationsLoadedFor = null;
    this.annotationsLoadingFor = null;
    this.currentSearchQuery = '';
    this.navigationPageIndex = 0;
    this.pendingNavigationPageIndex = null;
    this.navigationRequestRevision += 1;

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
    }
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
    if (
      this.annotationsLoadedFor === session ||
      this.annotationsLoadingFor === session ||
      !hasAnnotationListing(session)
    )
      return;
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
          page: this.currentPageIndex + 1,
          cause,
        });
      });
  }

  private async loadAnnotationData(
    session: DocumentSession & AnnotationListingSession,
    signal: AbortSignal,
  ): Promise<readonly DocumentAnnotation[]> {
    const cached = await this.annotationCache?.read(
      session.descriptor.path,
      session.descriptor.fingerprint,
    );
    this.throwIfAnnotationCancelled(signal);
    if (cached !== null && cached !== undefined) return cached;
    const cacheGeneration = this.annotationCache?.generation(session.descriptor.path);
    const annotations: DocumentAnnotation[] = [];
    await session.listAnnotations(signal, (batch) => {
      annotations.push(...batch);
    });
    this.throwIfAnnotationCancelled(signal);
    const stored = await this.annotationCache?.write(
      {
        version: 1,
        documentPath: session.descriptor.path,
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
