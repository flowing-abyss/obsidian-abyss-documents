import { Notice, type TFile } from 'obsidian';
import type { DocumentAdapterRegistry } from '../document-core/document-adapter.js';
import type {
  DocumentLocation,
  DocumentSession,
  DocumentViewport,
  SearchHit,
  ViewportEvent,
} from '../document-core/document.js';
import { DocumentCancelledError, DocumentOpenError } from '../document-core/errors.js';
import type { ReadingProfileId } from '../document-core/reading.js';
import { DEFAULT_SETTINGS, type PluginSettings } from '../settings.js';
import { ReaderShell, type ReaderShellIntent } from './reader-shell.js';
import { ReadingProfileService, type ObsidianTheme } from './reading-profiles.js';
import type { SearchNavigationKind } from './search-panel.js';
import type { ReaderSidebarCallbacks, ReaderSidebarTab } from './sidebar.js';

export type ShellFactory = (
  host: HTMLElement,
  onIntent: (intent: ReaderShellIntent) => void,
) => ReaderShell;

export interface ReaderProfileState {
  readonly reading: PluginSettings['reading'];
  readonly profileByFingerprint: Readonly<Record<string, ReadingProfileId>>;
  updateProfileForFingerprint(fingerprint: string, profile: ReadingProfileId): void | Promise<void>;
}

const DEFAULT_PROFILE_STATE: ReaderProfileState = {
  reading: DEFAULT_SETTINGS.reading,
  profileByFingerprint: {},
  updateProfileForFingerprint: () => undefined,
};

export class ReaderController {
  private queue: Promise<void> = Promise.resolve();
  private activeOpen: AbortController | null = null;
  private session: DocumentSession | null = null;
  private viewport: DocumentViewport | null = null;
  private shell: ReaderShell | null = null;
  private unsubscribeViewport: (() => void) | null = null;
  private currentPageIndex = 0;
  private currentProfile: ReadingProfileId = 'auto';
  private outlineLoadedFor: DocumentSession | null = null;
  private outlineLoadingFor: DocumentSession | null = null;
  private selectedSearchIndex = -1;

  constructor(
    private readonly registry: DocumentAdapterRegistry,
    private readonly createShell: ShellFactory = (host, onIntent) =>
      new ReaderShell(host, onIntent),
    private readonly profileState: ReaderProfileState = DEFAULT_PROFILE_STATE,
    private readonly profileService = new ReadingProfileService(),
  ) {}

  open(file: TFile, host: HTMLElement): Promise<void> {
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
    this.selectedSearchIndex = -1;
    this.currentProfile = this.initialProfile(session.descriptor.fingerprint);
    this.profileService.setCustom(this.profileState.reading.custom);
    viewport.setReadingColors(
      this.profileService.resolve(this.currentProfile, shell.obsidianTheme),
    );
    shell.toolbar.setPageCount(viewport.pageCount);
    shell.toolbar.setCurrentPage(this.currentPageIndex);
    shell.toolbar.setProfile(this.currentProfile);
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
    this.selectedSearchIndex = -1;

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
        this.navigateTo(this.currentPageIndex - 1);
        return;
      case 'next-page':
        this.navigateTo(this.currentPageIndex + 1);
        return;
      case 'set-scale':
        this.setScale(intent.scale);
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
      onClose: () => {
        if (this.shell === shell && this.viewport === viewport) viewport.focus();
      },
      onOutlineNavigate: (location) => {
        this.navigateToLocation(location);
      },
      onSearchNavigate: (hit, index, kind) => {
        this.navigateSearchResult(hit, index, kind);
      },
      onSearchQuery: (query) => {
        if (this.viewport !== viewport) return;
        this.selectedSearchIndex = -1;
        viewport.search(query);
      },
    };
    const sidebar = shell.openSidebar(tab, callbacks);
    sidebar.outlinePanel.setCurrentPage(this.currentPageIndex);
    if (tab === 'outline') this.loadOutline(session, shell);
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

  private navigateSearchResult(hit: SearchHit, index: number, kind: SearchNavigationKind): void {
    const viewport = this.viewport;
    if (viewport === null) return;
    if (kind === 'direct') {
      const current = this.selectedSearchIndex < 0 ? 0 : this.selectedSearchIndex;
      const direction = index >= current ? 'next' : 'previous';
      for (let offset = 0; offset < Math.abs(index - current); offset += 1)
        viewport.searchAgain(direction);
    } else viewport.searchAgain(kind);
    this.selectedSearchIndex = index;
    this.navigateToLocation({ pageIndex: hit.pageIndex });
  }

  private navigateTo(pageIndex: number): void {
    this.navigateToLocation({ pageIndex });
  }

  private navigateToLocation(location: DocumentLocation): void {
    const viewport = this.viewport;
    const shell = this.shell;
    if (viewport === null || shell === null || viewport.pageCount === 0) return;
    const target = Math.min(viewport.pageCount - 1, Math.max(0, Math.floor(location.pageIndex)));
    const destination: DocumentLocation = { ...location, pageIndex: target };
    void viewport.goTo(destination).catch((cause: unknown) => {
      if (this.viewport !== viewport) return;
      shell.toolbar.setCurrentPage(this.currentPageIndex);
      const reason = this.reason(cause);
      new Notice(`Could not go to page ${target + 1}: ${reason}`);
      console.error('[abyss-documents] Failed to navigate PDF page', {
        pageIndex: target,
        cause,
      });
    });
  }

  private setScale(scale: number | 'page-width' | 'page-fit'): void {
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
    shell.toolbar.setCurrentPage(this.currentPageIndex);
    shell.sidebar?.outlinePanel.setCurrentPage(this.currentPageIndex);
  }

  private handleSearchResults(
    shell: ReaderShell,
    results: Extract<ViewportEvent, { readonly type: 'search-results' }>['results'],
  ): void {
    if (results.query.length > 0 && results.hits.length > 0 && this.selectedSearchIndex < 0)
      this.selectedSearchIndex = 0;
    shell.sidebar?.searchPanel.setResults(results);
  }

  private handleThemeChange(
    viewport: DocumentViewport,
    shell: ReaderShell,
    theme: ObsidianTheme,
  ): void {
    if (this.viewport !== viewport || this.shell !== shell || this.currentProfile !== 'auto')
      return;
    this.profileService.setCustom(this.profileState.reading.custom);
    try {
      viewport.setReadingColors(this.profileService.resolve('auto', theme));
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
    return isReadingProfileId(fallback) ? fallback : 'auto';
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
    return cause instanceof Error ? cause.message : String(cause);
  }
}

function isReadingProfileId(value: unknown): value is ReadingProfileId {
  return (
    value === 'auto' ||
    value === 'light' ||
    value === 'sepia' ||
    value === 'dark' ||
    value === 'custom'
  );
}
