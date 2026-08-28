import {
  FileView,
  MarkdownView,
  Notice,
  Plugin,
  type Workspace,
  type WorkspaceLeaf,
} from 'obsidian';
import { PdfDocumentAdapter } from './adapters/pdf/pdf-adapter.js';
import { installPdfEditorDocumentMetrics, PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import { createPdfDocumentViewport } from './adapters/pdf/pdf-viewport.js';
import { PdfWriteBoundary } from './adapters/pdf/pdf-write-boundary.js';
import { AnnotationCache } from './annotation-cache.js';
import { AnnotationExportFlow } from './annotation-export.js';
import { DocumentAdapterRegistry } from './document-core/document-adapter.js';
import { DocumentSaveCoordinator } from './document-core/save-coordinator.js';
import { PluginDataStore, type MigrationDiagnostic, type PluginDataV2 } from './plugin-data.js';
import {
  beginPluginActivation,
  endPluginActivation,
  markReaderPerformance,
} from './reader-performance.js';
import { AnnotationTransferService, parseAnnotationHref } from './reader/annotation-transfer.js';
import {
  AbyssDocumentView,
  ANNOTATION_LINK_RESOLVED_EVENT,
  DOCUMENT_VIEW_TYPE,
} from './reader/document-view.js';
import { LinkSuggestionService } from './reader/link-suggestions.js';
import { ownerWindow, type ReaderOwnerWindow } from './reader/owner-dom.js';
import { ReaderController, type ReaderProfileState } from './reader/reader-controller.js';
import { ReaderShell } from './reader/reader-shell.js';
import { SaveConflictModal } from './reader/save-conflict-modal.js';
import { SaveFailureNoticeBoundary } from './reader/save-failure-boundary.js';
import { SaveRecoveryModal } from './reader/save-recovery-modal.js';
import { AbyssDocumentsSettingTab } from './settings-tab.js';

export const PLUGIN_ID = 'abyss-documents';

class CorePdfLeafHandoff {
  private active = true;
  private lifecycleGeneration = 0;
  private readonly handoffsInFlight = new Set<WorkspaceLeaf>();
  private timer: number | null = null;
  private pendingAnnotationLink: {
    path: string;
    subpath: string;
    capturedAt: number;
    sourceLeaf: WorkspaceLeaf | null;
    targetLeaf: WorkspaceLeaf | null;
  } | null = null;
  private pendingAnnotationLinkTimer: number | null = null;

  constructor(private readonly plugin: AbyssDocumentsPlugin) {}

  register(): void {
    const workspace = this.plugin.app.workspace;
    this.registerAnnotationLinkCapture(workspace.containerEl.ownerDocument);
    this.registerAnnotationLinkResolution(workspace.containerEl.ownerDocument);
    this.plugin.registerEvent(
      workspace.on('window-open', (_workspaceWindow, ownerWindow) => {
        this.registerAnnotationLinkCapture(ownerWindow.document);
        this.registerAnnotationLinkResolution(ownerWindow.document);
      }),
    );
    this.plugin.registerEvent(workspace.on('active-leaf-change', this.schedule));
    this.plugin.registerEvent(workspace.on('file-open', this.schedule));
    this.plugin.registerEvent(workspace.on('layout-change', this.schedule));
    markReaderPerformance('pdf-handoff-ready');
    workspace.onLayoutReady(this.schedule);
    this.plugin.register(this.dispose);
  }

  private readonly dispose = (): void => {
    markReaderPerformance('pdf-handoff-cleanup');
    this.active = false;
    this.lifecycleGeneration += 1;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.pendingAnnotationLinkTimer !== null)
      window.clearTimeout(this.pendingAnnotationLinkTimer);
    this.timer = null;
    this.pendingAnnotationLinkTimer = null;
    this.handoffsInFlight.clear();
    this.pendingAnnotationLink = null;
  };

  private registerAnnotationLinkCapture(ownerDocument: Document): void {
    this.plugin.registerDomEvent(ownerDocument, 'click', this.captureAnnotationLink, {
      capture: true,
    });
  }

  private registerAnnotationLinkResolution(ownerDocument: Document): void {
    this.plugin.registerDomEvent(
      ownerDocument,
      ANNOTATION_LINK_RESOLVED_EVENT,
      (event) => {
        this.acknowledgeAnnotationLink(event, ownerDocument);
      },
      { capture: true },
    );
  }

  private readonly captureAnnotationLink = (event: MouseEvent): void => {
    const target = canonicalAnnotationLink(event);
    if (target === null) return;
    const sourceLeaf = findContainingLeaf(this.plugin.app.workspace, target.link);
    const containingView = sourceLeaf === null ? null : nullableLeafView(sourceLeaf);
    const sourcePath =
      containingView instanceof MarkdownView && containingView.file !== null
        ? containingView.file.path
        : (this.plugin.app.workspace.getActiveFile()?.path ?? '');
    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(target.linkpath, sourcePath);
    if (file?.extension.toLocaleLowerCase() !== 'pdf') return;
    const pending = {
      path: file.path,
      subpath: target.subpath,
      capturedAt: Date.now(),
      sourceLeaf,
      targetLeaf: null,
    };
    this.pendingAnnotationLink = pending;
    if (this.pendingAnnotationLinkTimer !== null)
      window.clearTimeout(this.pendingAnnotationLinkTimer);
    this.pendingAnnotationLinkTimer = window.setTimeout(() => {
      if (this.pendingAnnotationLink === pending) this.pendingAnnotationLink = null;
      this.pendingAnnotationLinkTimer = null;
    }, 5_000);
  };

  private acknowledgeAnnotationLink(event: Event, ownerDocument: Document): void {
    const pending = this.pendingAnnotationLink;
    if (pending === null) return;
    const acknowledgement = annotationLinkAcknowledgement(event, ownerWindow(ownerDocument.body));
    if (acknowledgement?.path !== pending.path || acknowledgement.subpath !== pending.subpath)
      return;
    const leaf = findContainingLeaf(this.plugin.app.workspace, acknowledgement.target);
    if (leaf === null || leaf !== pending.targetLeaf) return;
    this.pendingAnnotationLink = null;
    if (this.pendingAnnotationLinkTimer !== null)
      window.clearTimeout(this.pendingAnnotationLinkTimer);
    this.pendingAnnotationLinkTimer = null;
  }

  private annotationLinkFor(path: string, leaf: WorkspaceLeaf): string | undefined {
    const pending = this.pendingAnnotationLink;
    if (pending === null) return undefined;
    if (Date.now() - pending.capturedAt > 5_000) {
      this.pendingAnnotationLink = null;
      return undefined;
    }
    if (pending.path !== path || (pending.sourceLeaf !== null && pending.sourceLeaf !== leaf))
      return undefined;
    pending.targetLeaf = leaf;
    return pending.subpath;
  }

  private readonly schedule = (): void => {
    if (!this.active || this.timer !== null) return;
    markReaderPerformance('pdf-handoff-scheduled');
    this.timer = window.setTimeout(this.scan, 0);
  };

  private readonly scan = (): void => {
    this.timer = null;
    if (!this.active) return;
    markReaderPerformance('pdf-handoff-scan');
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('pdf')) this.handoff(leaf);
  };

  private handoff(leaf: WorkspaceLeaf): void {
    if (this.handoffsInFlight.has(leaf)) return;
    const viewState = leaf.getViewState();
    const filePath = corePdfPath(leaf);
    if (viewState.type !== 'pdf' || filePath === undefined) return;
    const originalView = nullableLeafView(leaf);
    const originalEphemeralState = originalView?.getEphemeralState();
    const annotationSubpath = this.annotationLinkFor(filePath, leaf);
    const originalViewState = { ...viewState, state: { ...viewState.state } };
    const handoffViewState = {
      ...viewState,
      state: {
        ...viewState.state,
        file: filePath,
        ...(annotationSubpath === undefined ? {} : { subpath: annotationSubpath }),
      },
      type: DOCUMENT_VIEW_TYPE,
    };
    markReaderPerformance('pdf-handoff-start');
    this.handoffsInFlight.add(leaf);
    const lifecycleGeneration = this.lifecycleGeneration;
    void leaf
      .setViewState(handoffViewState)
      .then(async () => {
        if (lifecycleGeneration === this.lifecycleGeneration) {
          if (originalView !== null) setLeafEphemeralState(leaf, originalEphemeralState);
          return;
        }
        if (!isCompletedHandoffState(leaf.getViewState(), filePath)) return;
        await leaf.setViewState(originalViewState);
        if (originalView !== null) setLeafEphemeralState(leaf, originalEphemeralState);
      })
      .catch((error: unknown) => {
        if (!this.active || lifecycleGeneration !== this.lifecycleGeneration) return;
        console.error(`[${PLUGIN_ID}] Could not open PDF in the document reader`, {
          cause: error,
          path: filePath,
        });
      })
      .finally(() => {
        if (lifecycleGeneration === this.lifecycleGeneration) this.handoffsInFlight.delete(leaf);
      });
  }
}

function annotationLinkAcknowledgement(
  event: Event,
  owner: ReaderOwnerWindow,
): { path: string; subpath: string; target: Element } | null {
  const detail = (event as CustomEvent<unknown>).detail as {
    path?: unknown;
    subpath?: unknown;
  } | null;
  if (
    typeof detail?.path !== 'string' ||
    typeof detail.subpath !== 'string' ||
    !(event.target instanceof owner.Element)
  )
    return null;
  return { path: detail.path, subpath: detail.subpath, target: event.target };
}

function canonicalAnnotationLink(
  event: MouseEvent,
): { link: HTMLAnchorElement; linkpath: string; subpath: string } | null {
  if (event.button !== 0) return null;
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  const link = target?.closest?.('a.internal-link[data-href]');
  if (link?.tagName !== 'A') return null;
  const anchor = link as HTMLAnchorElement;
  const href = anchor.dataset['href'];
  if (href === undefined) return null;
  const hashOffset = href.indexOf('#annotation=');
  if (hashOffset <= 0) return null;
  const subpath = href.slice(hashOffset);
  if (parseAnnotationHref(subpath) === null) return null;
  return { link: anchor, linkpath: href.slice(0, hashOffset), subpath };
}

function setLeafEphemeralState(leaf: WorkspaceLeaf, state: unknown): void {
  const view = nullableLeafView(leaf);
  view?.setEphemeralState(state);
}

function nullableLeafView(leaf: WorkspaceLeaf): WorkspaceLeaf['view'] | null {
  return (leaf as unknown as { view: WorkspaceLeaf['view'] | null }).view;
}

function leafContains(leaf: WorkspaceLeaf, element: Element): boolean {
  const view = (leaf as unknown as { view: { containerEl?: HTMLElement } | null }).view;
  return view?.containerEl?.contains(element) === true;
}

function findContainingLeaf(
  workspace: Pick<Workspace, 'iterateAllLeaves'>,
  element: Element,
): WorkspaceLeaf | null {
  let result: WorkspaceLeaf | null = null;
  workspace.iterateAllLeaves((leaf) => {
    if (leafContains(leaf, element)) result = leaf;
  });
  return result;
}

function isCompletedHandoffState(
  viewState: ReturnType<WorkspaceLeaf['getViewState']>,
  expectedFile: string,
): boolean {
  return viewState.type === DOCUMENT_VIEW_TYPE && viewState.state?.['file'] === expectedFile;
}

function corePdfPath(leaf: WorkspaceLeaf): string | undefined {
  const viewState = leaf.getViewState();
  const stateFile =
    typeof viewState.state?.['file'] === 'string' ? viewState.state['file'] : undefined;
  const filePath = leaf.view instanceof FileView ? (leaf.view.file?.path ?? stateFile) : stateFile;
  return filePath?.toLocaleLowerCase().endsWith('.pdf') === true ? filePath : undefined;
}

export default class AbyssDocumentsPlugin extends Plugin {
  data!: PluginDataV2;
  protected readonly runtimeLoader = new PdfRuntimeLoader();
  protected saveBoundary!: PdfWriteBoundary;
  protected saveCoordinator!: DocumentSaveCoordinator;
  protected linkSuggestions!: LinkSuggestionService;

  override async onload(): Promise<void> {
    beginPluginActivation(this.manifest.version);
    try {
      await this.loadPlugin();
    } finally {
      endPluginActivation();
    }
  }

  private async loadPlugin(): Promise<void> {
    this.register(installPdfEditorDocumentMetrics(document));
    const store = new PluginDataStore(this);
    this.data = await store.load();
    this.reportMigrationDiagnostics(store.migrationResult.diagnostics);
    const linkSuggestions = new LinkSuggestionService(
      this.app.vault,
      this.app.metadataCache,
      this.app.fileManager,
    );
    this.linkSuggestions = linkSuggestions;
    this.registerLinkSuggestionInvalidation(linkSuggestions);
    const pdfAdapter = new PdfDocumentAdapter(
      this.app.vault,
      this.runtimeLoader,
      createPdfDocumentViewport,
    );
    const registry = new DocumentAdapterRegistry([pdfAdapter]);
    this.saveBoundary = new PdfWriteBoundary(this.app.vault);
    this.saveCoordinator = new DocumentSaveCoordinator(this.saveBoundary, (bytes, signal) =>
      pdfAdapter.verifySavedBytes(bytes, signal),
    );
    const annotationCache = new AnnotationCache(this.app.vault.adapter, this.app.vault.configDir);
    this.registerAnnotationCacheInvalidation(annotationCache);
    const annotationTransfer = this.createAnnotationIntegration(store);
    const annotationExporter = new AnnotationExportFlow({
      app: this.app,
      vault: this.app.vault,
      fileManager: this.app.fileManager,
      template: () => store.snapshot.settings.annotations.markdownTemplate,
    });
    const profileState = this.createReaderState(store);
    const saveFailureBoundary = new SaveFailureNoticeBoundary();
    const services = {
      createController: () =>
        new ReaderController(
          registry,
          (host, onIntent, shellContext) =>
            new ReaderShell(host, onIntent, {
              annotationSuggestions: linkSuggestions,
              sidebarWidth: store.snapshot.view.sidebarWidth,
              sourcePath: shellContext.sourcePath,
            }),
          profileState,
          {
            annotationCache,
            annotationExporter,
            annotationTransfer,
            saveFailureBoundary,
            saveCoordinator: this.saveCoordinator,
            resolveSaveConflict: (path) => {
              const modal = new SaveConflictModal(this.app, path.split('/').pop() ?? path);
              const choice = modal.waitForChoice();
              modal.open();
              return choice;
            },
            confirmSaveRecovery: (path) => {
              const modal = new SaveRecoveryModal(this.app, path.split('/').pop() ?? path);
              const choice = modal.waitForChoice();
              modal.open();
              return choice;
            },
          },
        ),
    };
    this.addSettingTab(
      new AbyssDocumentsSettingTab(this.app, this, store, () => {
        this.data = store.snapshot;
        for (const leaf of this.app.workspace.getLeavesOfType(DOCUMENT_VIEW_TYPE)) {
          if (leaf.view instanceof AbyssDocumentView) leaf.view.refreshReadingSettings();
        }
      }),
    );
    this.registerView(DOCUMENT_VIEW_TYPE, (leaf) => new AbyssDocumentView(leaf, services));
    // Obsidian's built-in PDF view already owns the `pdf` extension and rejects
    // a second extension registration. The public workspace handoff below runs
    // after core view state settles and replaces only real PDF leaves.
    new CorePdfLeafHandoff(this).register();
    this.registerReaderCommands();
    this.register(() => {
      this.runtimeLoader.dispose();
    });
  }

  private registerReaderCommands(): void {
    const commands = [
      {
        id: 'show-outline',
        name: 'Show document outline',
        run: (view: AbyssDocumentView) => {
          view.showOutline();
        },
      },
      {
        id: 'search-document',
        name: 'Search document',
        run: (view: AbyssDocumentView) => {
          view.searchDocument();
        },
      },
    ] as const;
    for (const command of commands) {
      this.addCommand({
        id: command.id,
        name: command.name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(AbyssDocumentView);
          if (view === null) return false;
          if (!checking) command.run(view);
          return true;
        },
      });
    }
  }

  private createAnnotationIntegration(store: PluginDataStore): AnnotationTransferService {
    return new AnnotationTransferService({
      fileManager: this.app.fileManager,
      workspace: this.app.workspace,
      clipboard: { writeText: async (value) => navigator.clipboard.writeText(value) },
      template: () => store.snapshot.settings.annotations.markdownTemplate,
      onFailure: (failure) => {
        const verb = failure.action === 'copy' ? 'copy' : 'insert';
        new Notice(`Could not ${verb} annotation ${failure.annotation} from ${failure.file}.`);
        console.error('[abyss-documents] Failed to transfer PDF annotation', failure);
      },
    });
  }

  private registerAnnotationCacheInvalidation(cache: AnnotationCache): void {
    const invalidate = (path: string): void => {
      if (!path.toLocaleLowerCase().endsWith('.pdf')) return;
      void cache.invalidate(path).catch((cause: unknown) => {
        console.error('[abyss-documents] Failed to invalidate PDF annotation cache', {
          path,
          cause,
        });
      });
    };
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        invalidate(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        invalidate(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        invalidate(oldPath);
        invalidate(file.path);
      }),
    );
  }

  private registerLinkSuggestionInvalidation(suggestions: LinkSuggestionService): void {
    const invalidate = (): void => {
      suggestions.invalidate();
    };
    this.registerEvent(this.app.vault.on('create', invalidate));
    this.registerEvent(this.app.vault.on('delete', invalidate));
    this.registerEvent(this.app.vault.on('rename', invalidate));
    this.registerEvent(this.app.metadataCache.on('changed', invalidate));
    this.registerEvent(this.app.metadataCache.on('resolved', invalidate));
  }

  private createReaderState(store: PluginDataStore): ReaderProfileState {
    return {
      get reading() {
        return store.snapshot.settings.reading;
      },
      get layout() {
        return store.snapshot.settings.layout;
      },
      get annotations() {
        return store.snapshot.settings.annotations;
      },
      get profileByFingerprint() {
        return store.snapshot.view.profileByFingerprint;
      },
      get layoutByFingerprint() {
        return store.snapshot.view.layoutByFingerprint;
      },
      updateLayoutForFingerprint: async (fingerprint, layout) => {
        await store.update((data) => ({
          ...data,
          view: {
            ...data.view,
            layoutByFingerprint: {
              ...data.view.layoutByFingerprint,
              [fingerprint]: layout,
            },
          },
        }));
        this.data = store.snapshot;
      },
      updateProfileForFingerprint: async (fingerprint, profile) => {
        await store.update((data) => ({
          ...data,
          view: {
            ...data.view,
            profileByFingerprint: {
              ...data.view.profileByFingerprint,
              [fingerprint]: profile,
            },
          },
        }));
        this.data = store.snapshot;
      },
    };
  }

  private reportMigrationDiagnostics(diagnostics: readonly MigrationDiagnostic[]): void {
    if (diagnostics.length === 0) return;
    const paths = diagnostics.map(({ path }) => path);
    console.error('[abyss-documents] Failed to migrate some plugin settings', {
      paths,
      diagnostics,
    });
    new Notice('Some abyss documents settings were reset to their defaults.');
  }

  override onunload(): void {}
}
