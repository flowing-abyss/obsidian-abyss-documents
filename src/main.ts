import { Plugin } from 'obsidian';
import { PdfDocumentAdapter } from './adapters/pdf/pdf-adapter.js';
import { PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import { createPdfDocumentViewport } from './adapters/pdf/pdf-viewport.js';
import { DocumentAdapterRegistry } from './document-core/document-adapter.js';
import { PluginDataStore, type PluginDataV1 } from './plugin-data.js';
import { AbyssDocumentView, DOCUMENT_VIEW_TYPE } from './reader/document-view.js';
import { ReaderController, type ReaderProfileState } from './reader/reader-controller.js';

export const PLUGIN_ID = 'abyss-documents';

export default class AbyssDocumentsPlugin extends Plugin {
  data!: PluginDataV1;
  protected readonly runtimeLoader = new PdfRuntimeLoader();

  override async onload(): Promise<void> {
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
      createController: () => new ReaderController(registry, undefined, profileState),
    };
    this.registerView(DOCUMENT_VIEW_TYPE, (leaf) => new AbyssDocumentView(leaf, services));
    this.registerExtensions(['pdf'], DOCUMENT_VIEW_TYPE);
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
