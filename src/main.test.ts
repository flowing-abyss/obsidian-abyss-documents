import type { PluginManifest, TFile } from 'obsidian';
import { App, Menu, TFile as MockTFile, WorkspaceLeaf } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { PdfDocumentAdapter } from './adapters/pdf/pdf-adapter.js';
import { PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import type { DocumentSession, DocumentViewport } from './document-core/document.js';
import AbyssDocumentsPlugin from './main.js';
import { DEFAULT_DATA, type PluginDataV1 } from './plugin-data.js';
import { AbyssDocumentView, DOCUMENT_VIEW_TYPE } from './reader/document-view.js';
import { BUILTIN_PROFILES } from './reader/reading-profiles.js';

const manifest: PluginManifest = {
  id: 'abyss-documents',
  name: 'Abyss Documents',
  author: 'test',
  version: '0.0.0-test',
  minAppVersion: '1.7.2',
  description: 'Test manifest',
};

function createPlugin(): AbyssDocumentsPlugin {
  const app = App.createConfigured__();
  return new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
}

function pdfFile(app: App, path = 'Books/Guide.pdf'): TFile {
  const source = app.vault.getAbstractFileByPath(path);
  if (!(source instanceof MockTFile)) throw new Error(`Expected a test file at ${path}.`);
  return source.asOriginalType2__();
}

function documentSession(fingerprint: string) {
  const setReadingColors = vi.fn();
  const viewport: DocumentViewport = {
    pageCount: 3,
    mount: vi.fn(async () => undefined),
    goTo: vi.fn(async () => undefined),
    setScale: vi.fn(),
    setReadingColors,
    search: vi.fn(),
    searchAgain: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    focus: vi.fn(),
    destroy: vi.fn(async () => undefined),
  };
  const session: DocumentSession = {
    descriptor: {
      path: 'Books/Guide.pdf',
      name: 'Guide.pdf',
      fingerprint,
      pageCount: 3,
    },
    capabilities: new Set(['outline', 'text-search']),
    getOutline: vi.fn(async () => []),
    createViewport: vi.fn(async () => viewport),
    close: vi.fn(async () => undefined),
  };
  return { session, setReadingColors };
}

function capturedMenuItems() {
  const entries: Array<{ click: () => void; title: string }> = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
    this: Menu,
    callback: Parameters<Menu['addItem']>[0],
  ) {
    const entry: { click: () => void; title: string } = {
      click: () => undefined,
      title: '',
    };
    const item = {
      onClick(handler: () => void) {
        entry.click = handler;
        return item;
      },
      setChecked() {
        return item;
      },
      setTitle(title: string) {
        entry.title = title;
        return item;
      },
    };
    callback(item as never);
    entries.push(entry);
    return this;
  });
  return entries;
}

async function loadedReader(
  data: PluginDataV1,
  createdSession: ReturnType<typeof documentSession>,
) {
  const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
  const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
  vi.spyOn(plugin, 'loadData').mockResolvedValue(data);
  const saveData = vi.spyOn(plugin, 'saveData');
  vi.spyOn(PdfDocumentAdapter.prototype, 'open').mockResolvedValue(createdSession.session);
  const registerView = vi.spyOn(plugin, 'registerView');
  await plugin.onload();
  const creator = registerView.mock.calls.find(([type]) => type === DOCUMENT_VIEW_TYPE)?.[1];
  if (creator === undefined) throw new Error('Expected the document view creator.');
  const view = creator(WorkspaceLeaf.create2__(app).asOriginalType3__());
  if (!(view instanceof AbyssDocumentView)) throw new Error('Expected an Abyss document view.');
  await view.onLoadFile(pdfFile(app));
  return { plugin, saveData, view };
}

describe('AbyssDocumentsPlugin', () => {
  it('loads version 1 data with a PDF-only view default', async () => {
    const loadRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'load');
    const createObjectURL = vi.fn();
    const createWorker = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal('Worker', createWorker);
    const plugin = createPlugin();
    await plugin.onload();

    expect(plugin.data.settings.reading.defaultProfile).toBe('auto');
    expect(plugin.data.view.sidebar.open).toBe(false);
    expect(plugin).toHaveProperty('runtimeLoader', expect.any(PdfRuntimeLoader));
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();

    plugin.onunload();
  });

  it('registers the deferred PDF FileView and runtime cleanup without loading PDF.js', async () => {
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const registerView = vi.spyOn(plugin, 'registerView');
    const registerExtensions = vi.spyOn(plugin, 'registerExtensions');
    const register = vi.spyOn(plugin, 'register');
    const loadRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'load');
    const disposeRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'dispose');

    await plugin.onload();

    expect(registerExtensions).toHaveBeenCalledWith(['pdf'], DOCUMENT_VIEW_TYPE);
    const registration = registerView.mock.calls.find(([type]) => type === DOCUMENT_VIEW_TYPE);
    expect(registration).toBeDefined();
    const creator = registration?.[1];
    if (creator === undefined) throw new Error('Expected the document view creator.');
    const leaf = WorkspaceLeaf.create2__(app);
    expect(creator(leaf.asOriginalType3__())).toBeInstanceOf(AbyssDocumentView);
    expect(loadRuntime).not.toHaveBeenCalled();

    const cleanup = register.mock.calls[register.mock.calls.length - 1]?.[0];
    if (cleanup === undefined) throw new Error('Expected runtime cleanup registration.');
    cleanup();
    expect(disposeRuntime).toHaveBeenCalledOnce();
  });

  it('restores and saves per-document profiles through the loaded plugin data store', async () => {
    const fingerprint = 'stable-fingerprint';
    const data: PluginDataV1 = {
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        reading: { ...DEFAULT_DATA.settings.reading, rememberPerDocument: true },
      },
      view: {
        ...DEFAULT_DATA.view,
        profileByFingerprint: { [fingerprint]: 'dark' },
      },
    };
    const session = documentSession(fingerprint);
    const entries = capturedMenuItems();
    const reader = await loadedReader(data, session);

    expect(session.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.dark);
    const profile = reader.view.contentEl.querySelector<HTMLButtonElement>(
      '[data-control="profile"]',
    );
    if (profile === null) throw new Error('Expected the profile button.');
    profile.click();
    entries.find((entry) => entry.title === 'Light')?.click();
    await vi.waitFor(() => {
      expect(reader.saveData).toHaveBeenCalledOnce();
    });

    expect(reader.plugin.data.view.profileByFingerprint).toEqual({ [fingerprint]: 'light' });
    expect(reader.saveData.mock.calls[0]?.[0]).toMatchObject({
      view: { profileByFingerprint: { [fingerprint]: 'light' } },
    });
    if (reader.view.file !== null) await reader.view.onUnloadFile(reader.view.file);
  });

  it('uses the global profile and does not save when per-document memory is disabled', async () => {
    const fingerprint = 'stable-fingerprint';
    const data: PluginDataV1 = {
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        reading: {
          ...DEFAULT_DATA.settings.reading,
          defaultProfile: 'sepia',
          rememberPerDocument: false,
        },
      },
      view: {
        ...DEFAULT_DATA.view,
        profileByFingerprint: { [fingerprint]: 'dark' },
      },
    };
    const session = documentSession(fingerprint);
    const entries = capturedMenuItems();
    const reader = await loadedReader(data, session);

    expect(session.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.sepia);
    const profile = reader.view.contentEl.querySelector<HTMLButtonElement>(
      '[data-control="profile"]',
    );
    if (profile === null) throw new Error('Expected the profile button.');
    profile.click();
    entries.find((entry) => entry.title === 'Light')?.click();
    await Promise.resolve();

    expect(reader.saveData).not.toHaveBeenCalled();
    expect(reader.plugin.data.view.profileByFingerprint).toEqual({ [fingerprint]: 'dark' });
    if (reader.view.file !== null) await reader.view.onUnloadFile(reader.view.file);
  });
});
