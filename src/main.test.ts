import type { Command, PluginManifest, TFile } from 'obsidian';
import { App, Menu, TFile as MockTFile, WorkspaceLeaf } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { PdfDocumentAdapter } from './adapters/pdf/pdf-adapter.js';
import { PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import type { DocumentSession, DocumentViewport } from './document-core/document.js';
import AbyssDocumentsPlugin from './main.js';
import { DEFAULT_DATA, type PluginDataV1 } from './plugin-data.js';
import { readerPerformanceSnapshot } from './reader-performance.js';
import { AbyssDocumentView, DOCUMENT_VIEW_TYPE } from './reader/document-view.js';
import { BUILTIN_PROFILES } from './reader/reading-profiles.js';
import { AbyssDocumentsSettingTab } from './settings-tab.js';

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

function registeredCommands(plugin: AbyssDocumentsPlugin): Map<string, Command> {
  return (plugin as unknown as { commands__: Map<string, Command> }).commands__;
}

function commandCheck(
  commands: Map<string, Command>,
  id: string,
): NonNullable<Command['checkCallback']> {
  const callback = commands.get(id)?.checkCallback;
  if (callback === undefined) throw new Error(`Expected the ${id} command.`);
  return callback;
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
    selectSearchHit: vi.fn(async () => undefined),
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
    expect(readerPerformanceSnapshot()).toMatchObject({
      counters: { pdfRuntimeLoads: 0, pdfWorkDuringPluginOnload: 0 },
    });

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

    expect(registerExtensions).not.toHaveBeenCalled();
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

  it('hands a PDF opened by the core view to the registered document view', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const setViewState = vi.spyOn(leaf, 'setViewState');

    await plugin.onload();
    app.workspace.trigger('file-open', pdfFile(app));

    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledWith({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf' },
      });
    });
    app.workspace.trigger('file-open', pdfFile(app));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(setViewState).toHaveBeenCalledOnce();
  });

  it('hands an already-open core PDF over after the workspace layout becomes ready', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const setViewState = vi.spyOn(leaf, 'setViewState');

    await plugin.onload();
    app.workspace.setLayoutReady__();

    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledWith({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf' },
      });
    });
  });

  it('coalesces active-leaf, file-open, and layout-change ordering into one PDF handoff', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const setViewState = vi.spyOn(leaf, 'setViewState');

    await plugin.onload();
    app.workspace.trigger('active-leaf-change', leaf.asOriginalType3__());
    app.workspace.trigger('file-open', pdfFile(app));
    app.workspace.trigger('layout-change');

    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledOnce();
    });
  });

  it('logs a local diagnostic and releases the leaf when the core PDF handoff fails', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const cause = new Error('view rejected');
    const setViewState = vi.spyOn(leaf, 'setViewState').mockRejectedValueOnce(cause);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await plugin.onload();
    app.workspace.trigger('file-open', pdfFile(app));

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        '[abyss-documents] Could not open PDF in the document reader',
        { cause, path: 'Books/Guide.pdf' },
      );
    });
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledTimes(2);
    });
  });

  it('cancels a scheduled handoff during plugin cleanup and ignores later workspace events', async () => {
    vi.useFakeTimers();
    try {
      const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
      const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
      const leaf = app.workspace.getLeaf(false);
      await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
      const setViewState = vi.spyOn(leaf, 'setViewState');

      await plugin.onload();
      app.workspace.trigger('file-open', pdfFile(app));
      const cleanups = (plugin as unknown as { cleanups__: Array<() => unknown> }).cleanups__;
      for (const cleanup of [...cleanups].reverse()) cleanup();
      for (const cleanup of [...cleanups].reverse()) cleanup();
      app.workspace.trigger('layout-change');
      await vi.runAllTimersAsync();

      expect(setViewState).not.toHaveBeenCalled();
      expect(readerPerformanceSnapshot().marks).toContainEqual(
        expect.objectContaining({ name: 'pdf-handoff-cleanup' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a second handoff while the same leaf is still in flight', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    let settleHandoff: (() => void) | undefined;
    const pendingHandoff = new Promise<void>((resolve) => {
      settleHandoff = resolve;
    });
    const setViewState = vi.spyOn(leaf, 'setViewState').mockReturnValue(pendingHandoff);

    await plugin.onload();
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledOnce();
    });
    app.workspace.trigger('layout-change');
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(setViewState).toHaveBeenCalledOnce();
    settleHandoff?.();
    await pendingHandoff;
  });

  it('ignores non-PDF view states and missing or non-PDF file paths', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    const getLeaves = vi.spyOn(app.workspace, 'getLeavesOfType').mockReturnValue([leaf]);
    const setViewState = vi.spyOn(leaf, 'setViewState');
    const getViewState = vi.spyOn(leaf, 'getViewState');
    await plugin.onload();

    for (const state of [
      { type: 'markdown', state: { file: 'Books/Guide.pdf' } },
      { type: 'pdf', state: {} },
      { type: 'pdf', state: { file: 'Books/Guide.md' } },
    ] as const) {
      setViewState.mockClear();
      getViewState.mockReturnValueOnce(state);
      app.workspace.trigger('layout-change');
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(setViewState).not.toHaveBeenCalled();
    }
    expect(getLeaves).toHaveBeenCalled();
  });

  it('registers outline and document-search commands without default hotkeys or name prefixes', async () => {
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    await plugin.onload();
    const commands = registeredCommands(plugin);

    expect([...commands.keys()]).toEqual(['show-outline', 'search-document']);
    expect([...commands.values()].map(({ name }) => name)).toEqual([
      'Show document outline',
      'Search document',
    ]);
    for (const command of commands.values()) {
      expect(command).not.toHaveProperty('hotkeys');
      expect(command.name).not.toContain('Abyss Documents');
    }
  });

  it('registers one native settings tab', async () => {
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const registerView = vi.spyOn(plugin, 'registerView');

    await plugin.onload();

    const settingTabs = (plugin as unknown as { settingTabs__: unknown[] }).settingTabs__;
    expect(settingTabs).toHaveLength(1);
    expect(settingTabs[0]).toBeInstanceOf(AbyssDocumentsSettingTab);
    const creator = registerView.mock.calls.find(([type]) => type === DOCUMENT_VIEW_TYPE)?.[1];
    if (creator === undefined) throw new Error('Expected the document view creator.');
    const view = creator(WorkspaceLeaf.create2__(app).asOriginalType3__());
    if (!(view instanceof AbyssDocumentView)) throw new Error('Expected an Abyss document view.');
    const refresh = vi.spyOn(view, 'refreshReadingSettings').mockImplementation(() => undefined);
    vi.spyOn(app.workspace, 'getLeavesOfType').mockReturnValue([
      { view: {} },
      { view },
    ] as unknown as WorkspaceLeaf[]);
    const onSettingsChanged = (
      settingTabs[0] as {
        onSettingsChanged(settings: PluginDataV1['settings']): void | Promise<void>;
      }
    ).onSettingsChanged.bind(settingTabs[0]);

    await onSettingsChanged(plugin.data.settings);

    expect(refresh).toHaveBeenCalledOnce();
    expect(plugin.data).toBe(DEFAULT_DATA);
  });

  it('routes commands only to the active document view', async () => {
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const showOutline = vi.fn();
    const searchDocument = vi.fn();
    const activeView = { searchDocument, showOutline } as unknown as AbyssDocumentView;
    const active = vi.spyOn(app.workspace, 'getActiveViewOfType').mockReturnValue(activeView);
    await plugin.onload();
    const commands = registeredCommands(plugin);
    const outline = commandCheck(commands, 'show-outline');
    const search = commandCheck(commands, 'search-document');

    expect(outline(true)).toBe(true);
    expect(search(true)).toBe(true);
    expect(showOutline).not.toHaveBeenCalled();
    expect(searchDocument).not.toHaveBeenCalled();

    expect(outline(false)).toBe(true);
    expect(search(false)).toBe(true);
    expect(showOutline).toHaveBeenCalledOnce();
    expect(searchDocument).toHaveBeenCalledOnce();

    active.mockReturnValue(null);
    expect(outline(false)).toBe(false);
    expect(search(false)).toBe(false);
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
