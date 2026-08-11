import { FileView, Plugin, type WorkspaceLeaf } from 'obsidian';
import { PdfDocumentAdapter } from './adapters/pdf/pdf-adapter.js';
import { PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import { createPdfDocumentViewport } from './adapters/pdf/pdf-viewport.js';
import { DocumentAdapterRegistry } from './document-core/document-adapter.js';
import { PluginDataStore, type PluginDataV1 } from './plugin-data.js';
import {
  beginPluginActivation,
  endPluginActivation,
  markReaderPerformance,
} from './reader-performance.js';
import { AbyssDocumentView, DOCUMENT_VIEW_TYPE } from './reader/document-view.js';
import { ReaderController, type ReaderProfileState } from './reader/reader-controller.js';
import { ReaderShell } from './reader/reader-shell.js';
import { AbyssDocumentsSettingTab } from './settings-tab.js';

export const PLUGIN_ID = 'abyss-documents';

class CorePdfLeafHandoff {
  private active = true;
  private lifecycleGeneration = 0;
  private readonly handoffsInFlight = new Set<WorkspaceLeaf>();
  private timer: number | null = null;

  constructor(private readonly plugin: AbyssDocumentsPlugin) {}

  register(): void {
    const workspace = this.plugin.app.workspace;
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
    this.timer = null;
    this.handoffsInFlight.clear();
  };

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
    const originalViewState = { ...viewState, state: { ...viewState.state } };
    const handoffViewState = {
      ...viewState,
      state: { ...viewState.state, file: filePath },
      type: DOCUMENT_VIEW_TYPE,
    };
    markReaderPerformance('pdf-handoff-start');
    this.handoffsInFlight.add(leaf);
    const lifecycleGeneration = this.lifecycleGeneration;
    void leaf
      .setViewState(handoffViewState)
      .then(async () => {
        if (lifecycleGeneration === this.lifecycleGeneration) return;
        if (!isCompletedHandoffState(leaf.getViewState(), filePath)) return;
        await leaf.setViewState(originalViewState);
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
  data!: PluginDataV1;
  protected readonly runtimeLoader = new PdfRuntimeLoader();

  override async onload(): Promise<void> {
    beginPluginActivation(this.manifest.version);
    try {
      await this.loadPlugin();
    } finally {
      endPluginActivation();
    }
  }

  private async loadPlugin(): Promise<void> {
    const store = new PluginDataStore(this);
    this.data = await store.load();
    const registry = new DocumentAdapterRegistry([
      new PdfDocumentAdapter(this.app.vault, this.runtimeLoader, createPdfDocumentViewport),
    ]);
    const profileState: ReaderProfileState = {
      get reading() {
        return store.snapshot.settings.reading;
      },
      get profileByFingerprint() {
        return store.snapshot.view.profileByFingerprint;
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
    const services = {
      createController: () =>
        new ReaderController(
          registry,
          (host, onIntent) =>
            new ReaderShell(host, onIntent, {
              sidebarWidth: store.snapshot.view.sidebarWidth,
            }),
          profileState,
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
    this.addCommand({
      id: 'show-outline',
      name: 'Show document outline',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(AbyssDocumentView);
        if (view === null) return false;
        if (!checking) view.showOutline();
        return true;
      },
    });
    this.addCommand({
      id: 'search-document',
      name: 'Search document',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(AbyssDocumentView);
        if (view === null) return false;
        if (!checking) view.searchDocument();
        return true;
      },
    });
    this.register(() => {
      this.runtimeLoader.dispose();
    });
  }

  override onunload(): void {}
}
