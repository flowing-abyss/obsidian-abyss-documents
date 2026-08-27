import type { Command, PluginManifest, TFile } from 'obsidian';
import {
  App,
  Menu,
  MarkdownView as MockMarkdownView,
  TFile as MockTFile,
  Notice,
  WorkspaceLeaf,
} from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { PdfDocumentAdapter } from './adapters/pdf/pdf-adapter.js';
import { PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import { PdfWriteBoundary } from './adapters/pdf/pdf-write-boundary.js';
import { AnnotationCache } from './annotation-cache.js';
import type { AnnotationSink, DocumentAnnotation } from './document-core/annotations.js';
import type { DocumentSession, DocumentViewport } from './document-core/document.js';
import { DocumentSaveCoordinator } from './document-core/save-coordinator.js';
import AbyssDocumentsPlugin from './main.js';
import { DEFAULT_DATA, type PluginDataV1, type PluginDataV2 } from './plugin-data.js';
import { readerPerformanceSnapshot } from './reader-performance.js';
import { AnnotationEditorPopover } from './reader/annotation-editor-popover.js';
import {
  AbyssDocumentView,
  DOCUMENT_VIEW_TYPE,
  type ReaderViewController,
} from './reader/document-view.js';
import { LinkSuggestionService } from './reader/link-suggestions.js';
import { BUILTIN_PROFILES } from './reader/reading-profiles.js';
import { SaveConflictModal, type SaveConflictAction } from './reader/save-conflict-modal.js';
import { SaveRecoveryModal } from './reader/save-recovery-modal.js';
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

function resolvingViewController(): ReaderViewController {
  return {
    close: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    refreshReadingSettings: vi.fn(),
    resolveAnnotationLink: vi.fn(async () => true),
    saveDocument: vi.fn(async () => undefined),
    searchDocument: vi.fn(),
    showOutline: vi.fn(),
  };
}

function documentSession(fingerprint: string) {
  const setLayout = vi.fn();
  const setReadingColors = vi.fn();
  const viewport: DocumentViewport = {
    pageCount: 3,
    mount: vi.fn(async () => undefined),
    goTo: vi.fn(async () => undefined),
    setScale: vi.fn(),
    stepScale: vi.fn(),
    setLayout,
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
  return { session, setLayout, setReadingColors };
}

function resolved(colors: (typeof BUILTIN_PROFILES)[keyof typeof BUILTIN_PROFILES]) {
  return {
    pageColors: { background: colors.background, foreground: colors.foreground },
    brightness: colors.brightness,
    contrast: colors.contrast,
    imageDim: colors.imageDim,
  };
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
      setDisabled() {
        return item;
      },
      setChecked() {
        return item;
      },
      setIcon() {
        return item;
      },
      setIsLabel() {
        return item;
      },
      setSection() {
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
  data: PluginDataV1 | PluginDataV2,
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
  it('contains clipboard transfer failure with one annotation/file Notice and diagnostic', async () => {
    const created = documentSession('transfer');
    const item = {
      ...({} as DocumentAnnotation),
      identity: { kind: 'stable' as const, id: 'committed-one' as never },
      type: 'highlight' as const,
      anchor: {
        kind: 'fixed-page' as const,
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left' as const,
        geometry: { kind: 'point' as const, point: { x: 0, y: 0 } },
      },
      color: null,
      selectedText: 'Quote',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: '',
      tags: [],
      links: [],
    };
    Object.assign(created.session, {
      listAnnotations: async (_signal: AbortSignal, sink: AnnotationSink) => {
        sink([item]);
      },
    });
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader = await loadedReader(DEFAULT_DATA, created);
    reader.view.contentEl.querySelector<HTMLButtonElement>('[data-control="sidebar"]')?.click();
    reader.view.contentEl
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(
        reader.view.contentEl.querySelector('[data-action="copy-annotation-link"]'),
      ).not.toBeNull();
    });
    reader.view.contentEl
      .querySelector<HTMLButtonElement>('[data-action="copy-annotation-link"]')
      ?.click();
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not copy annotation committed-one from Books/Guide.pdf.',
        undefined,
      );
    });
    expect(log).toHaveBeenCalledWith(
      '[abyss-documents] Failed to transfer PDF annotation',
      expect.objectContaining({
        action: 'copy',
        annotation: 'committed-one',
        file: 'Books/Guide.pdf',
      }),
    );
  });
  it('wires metadata-cache-only wiki suggestions to the reader PDF source path', async () => {
    const plugin = createPlugin();
    const suggest = vi
      .spyOn(LinkSuggestionService.prototype, 'suggest')
      .mockReturnValue([
        { display: 'Concept', path: 'Notes/Concept.md', insertion: '[[Concept]]' },
      ]);
    await plugin.onload();
    const host = createDiv();
    const provider = (plugin as unknown as { linkSuggestions: LinkSuggestionService })
      .linkSuggestions;
    const popover = new AnnotationEditorPopover(host, provider, 'Books/Guide.pdf');
    const annotation = {
      ...({} as DocumentAnnotation),
      color: '#ffd400',
      comment: '',
      identity: { id: 'suggestion-test' as never, kind: 'stable' as const },
      links: [],
      tags: [],
    };
    popover.open({
      onCreate: vi.fn(),
      onClose: vi.fn(),
      onDelete: vi.fn(),
      onUpdate: vi.fn(),
      palette: DEFAULT_DATA.settings.annotations.palette,
      position: { x: 0, y: 0 },
      target: { annotation, kind: 'annotation' },
    });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Links"]');
    if (input === null) throw new Error('Expected links input.');
    input.value = '[[con';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(suggest).toHaveBeenCalledWith('con', 'Books/Guide.pdf');
    expect(host.querySelector('[role="listbox"]')?.textContent).toContain('Concept');

    popover.destroy();
  });
  it('invalidates the wiki suggestion index for public vault and metadata events', async () => {
    const app = App.createConfigured__({ files: { 'Notes/Concept.md': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const invalidate = vi.spyOn(LinkSuggestionService.prototype, 'invalidate');
    await plugin.onload();
    invalidate.mockClear();
    const markdown = app.vault.getAbstractFileByPath('Notes/Concept.md');
    if (markdown === null) throw new Error('Expected Markdown fixture.');

    app.vault.trigger('create', markdown);
    app.vault.trigger('delete', markdown);
    app.vault.trigger('rename', markdown, 'Notes/Old.md');
    app.metadataCache.trigger('changed', markdown, '', {});
    app.metadataCache.trigger('resolved');

    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
  it('invalidates only PDF cache partitions for public modify, delete, and rename events', async () => {
    const app = App.createConfigured__({
      files: { 'Books/Guide.pdf': '', 'Books/Renamed.pdf': '', 'Notes/Guide.md': '' },
    });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const invalidate = vi.spyOn(AnnotationCache.prototype, 'invalidate').mockResolvedValue();
    await plugin.onload();
    const pdf = pdfFile(app);
    const renamed = pdfFile(app, 'Books/Renamed.pdf');
    const markdown = app.vault.getAbstractFileByPath('Notes/Guide.md');
    if (markdown === null) throw new Error('Expected markdown fixture.');

    app.vault.trigger('modify', markdown);
    app.vault.trigger('modify', pdf);
    app.vault.trigger('delete', pdf);
    app.vault.trigger('rename', renamed, 'Books/Guide.pdf');

    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledTimes(4);
    });
    expect(invalidate.mock.calls.map(([path]) => path)).toEqual([
      'Books/Guide.pdf',
      'Books/Guide.pdf',
      'Books/Guide.pdf',
      'Books/Renamed.pdf',
    ]);
  });
  it('loads version 1 data with a PDF-only view default', async () => {
    const loadRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'load');
    const createObjectURL = vi.fn();
    const createWorker = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal('Worker', createWorker);
    const plugin = createPlugin();
    await plugin.onload();

    expect(plugin.data.settings.reading.defaultProfile).toBe('default');
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

  it('preserves a public annotation subpath across the core PDF handoff', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    const ephemeral = {
      subpath: '#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4',
    };
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    Object.defineProperty(leaf, 'view', {
      configurable: true,
      value: { getEphemeralState: () => ephemeral },
      writable: true,
    });
    const applyViewState = leaf.setViewState.bind(leaf);
    const setEphemeralState = vi.fn();
    vi.spyOn(leaf, 'setViewState').mockImplementation(async (state) => {
      await applyViewState(state);
      if (state.type !== DOCUMENT_VIEW_TYPE) return;
      Object.defineProperty(leaf, 'view', {
        configurable: true,
        value: { setEphemeralState },
        writable: true,
      });
    });

    await plugin.onload();
    app.workspace.trigger('file-open', pdfFile(app));

    await vi.waitFor(() => {
      expect(leaf.getViewState().type).toBe(DOCUMENT_VIEW_TYPE);
    });
    expect(setEphemeralState).toHaveBeenCalledWith(ephemeral);
  });

  it('carries a canonical internal annotation-link click into the matching PDF handoff', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const setViewState = vi.spyOn(leaf, 'setViewState');
    const subpath = '#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4';
    const sourceContainer = document.body.createDiv();
    const link = sourceContainer.createEl('a');
    link.className = 'internal-link';
    link.dataset['href'] = `Books/Guide.pdf${subpath}`;
    Object.defineProperty(leaf, 'view', {
      configurable: true,
      value: {
        containerEl: sourceContainer,
        getEphemeralState: () => ({}),
        setEphemeralState: vi.fn(),
      },
      writable: true,
    });

    await plugin.onload();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    app.workspace.trigger('file-open', pdfFile(app));

    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledWith({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf', subpath },
      });
    });
    sourceContainer.remove();
  });

  it('consumes an exact annotation-link intent after the document view resolves it', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const setViewState = vi.spyOn(leaf, 'setViewState');
    const subpath = '#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4';
    const sourceContainer = document.body.createDiv();
    const link = sourceContainer.createEl('a');
    link.className = 'internal-link';
    link.dataset['href'] = `Books/Guide.pdf${subpath}`;
    Object.defineProperty(leaf, 'view', {
      configurable: true,
      value: {
        containerEl: sourceContainer,
        getEphemeralState: () => ({}),
        setEphemeralState: vi.fn(),
      },
      writable: true,
    });

    await plugin.onload();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledWith({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf', subpath },
      });
    });

    sourceContainer.dispatchEvent(
      new CustomEvent('abyss-documents:annotation-link-resolved', {
        bubbles: true,
        detail: { path: 'Books/Guide.pdf', subpath: `${subpath}-stale` },
      }),
    );
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      const handoffs = setViewState.mock.calls.filter(
        ([state]) => state.type === DOCUMENT_VIEW_TYPE,
      );
      expect(handoffs).toHaveLength(2);
      expect(handoffs[1]?.[0]).toEqual({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf', subpath },
      });
    });

    const foreignLeaf = WorkspaceLeaf.create2__(app).asOriginalType3__();
    const foreignView = new AbyssDocumentView(foreignLeaf, {
      createController: resolvingViewController,
    });
    Object.defineProperty(foreignLeaf, 'view', {
      configurable: true,
      value: foreignView,
      writable: true,
    });
    document.body.append(foreignView.containerEl);
    await foreignView.setState({ file: 'Books/Guide.pdf', subpath }, { history: false });
    await foreignView.onLoadFile(pdfFile(app));

    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      const handoffs = setViewState.mock.calls.filter(
        ([state]) => state.type === DOCUMENT_VIEW_TYPE,
      );
      expect(handoffs).toHaveLength(3);
      expect(handoffs[2]?.[0]).toEqual({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf', subpath },
      });
    });

    const intendedView = new AbyssDocumentView(leaf.asOriginalType3__(), {
      createController: resolvingViewController,
    });
    Object.defineProperty(leaf, 'view', {
      configurable: true,
      value: intendedView,
      writable: true,
    });
    document.body.append(intendedView.containerEl);
    await intendedView.setState({ file: 'Books/Guide.pdf', subpath }, { history: false });
    await intendedView.onLoadFile(pdfFile(app));
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      const handoffs = setViewState.mock.calls.filter(
        ([state]) => state.type === DOCUMENT_VIEW_TYPE,
      );
      expect(handoffs).toHaveLength(4);
      expect(handoffs[3]?.[0]).toEqual({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf' },
      });
    });
    foreignView.containerEl.remove();
    intendedView.containerEl.remove();
    sourceContainer.remove();
  });

  it('ignores non-primary, malformed, and non-PDF internal-link clicks', async () => {
    const app = App.createConfigured__({
      files: { 'Books/Guide.pdf': '', 'Notes/Guide.md': '' },
    });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const setViewState = vi.spyOn(leaf, 'setViewState');
    const link = document.body.createEl('a');
    link.className = 'internal-link';

    await plugin.onload();
    link.dataset['href'] =
      'Books/Guide.pdf#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4';
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 1 }));
    document.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    link.dataset['href'] = 'Books/Guide.pdf#annotation=&page=2&fingerprint=x';
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    link.dataset['href'] = 'Notes/Guide.md#annotation=12R&page=2&fingerprint=x';
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    app.workspace.trigger('file-open', pdfFile(app));

    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledWith({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf' },
      });
    });
    link.remove();
  });

  it('resolves a relative annotation link from its containing Markdown leaf, not the active file', async () => {
    const app = App.createConfigured__({
      files: {
        'Books/Guide.pdf': '',
        'Notes/Active.md': '',
        'Notes/Source.md': '',
      },
    });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const sourceLeaf = app.workspace.getLeaf(false);
    const sourceView = MockMarkdownView.create2__(sourceLeaf);
    const sourceFile = app.vault.getAbstractFileByPath('Notes/Source.md');
    if (!(sourceFile instanceof MockTFile)) throw new Error('Expected source note fixture.');
    sourceView.file = sourceFile;
    Object.defineProperty(sourceLeaf, 'view', { configurable: true, value: sourceView });
    document.body.append(sourceView.containerEl);
    const link = sourceView.containerEl.createEl('a');
    link.className = 'internal-link';
    link.dataset['href'] =
      '../Books/Guide.pdf#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4';
    const resolve = vi.spyOn(app.metadataCache, 'getFirstLinkpathDest');
    await app.workspace.getLeaf(true).setViewState({
      type: 'markdown',
      state: { file: 'Notes/Active.md' },
    });

    await plugin.onload();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

    expect(resolve).toHaveBeenCalledWith('../Books/Guide.pdf', 'Notes/Source.md');
    sourceView.containerEl.remove();
  });

  it.each([
    ['foreign fragment', 'Books/Guide.pdf#heading', false],
    [
      'missing target',
      'Books/Missing.pdf#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4',
      false,
    ],
    [
      'stale intent',
      'Books/Guide.pdf#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4',
      true,
    ],
  ])('does not carry a %s into a later PDF handoff', async (_case, href, stale) => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const setViewState = vi.spyOn(leaf, 'setViewState');
    const link = document.body.createEl('a');
    link.className = 'internal-link';
    link.dataset['href'] = href;

    await plugin.onload();
    let nowMs = 0;
    const now = stale ? vi.spyOn(Date, 'now').mockImplementation(() => nowMs) : null;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    nowMs = 5_001;
    app.workspace.trigger('file-open', pdfFile(app));

    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledWith({
        type: DOCUMENT_VIEW_TYPE,
        state: { file: 'Books/Guide.pdf' },
      });
    });
    now?.mockRestore();
    link.remove();
  });

  it('unregisters annotation-link capture during plugin cleanup', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const resolve = vi.spyOn(app.metadataCache, 'getFirstLinkpathDest');
    const link = document.body.createEl('a');
    link.className = 'internal-link';
    link.dataset['href'] =
      'Books/Guide.pdf#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4';

    await plugin.onload();
    const cleanups = (plugin as unknown as { cleanups__: Array<() => unknown> }).cleanups__;
    for (const cleanup of [...cleanups].reverse()) cleanup();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

    expect(resolve).not.toHaveBeenCalled();
    link.remove();
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

  it('ignores an in-flight core PDF handoff that settles after plugin cleanup', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    let rejectHandoff: ((cause: Error) => void) | undefined;
    const pendingHandoff = new Promise<void>((_resolve, reject) => {
      rejectHandoff = reject;
    });
    const setViewState = vi.spyOn(leaf, 'setViewState').mockReturnValue(pendingHandoff);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await plugin.onload();
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledOnce();
    });
    const cleanups = (plugin as unknown as { cleanups__: Array<() => unknown> }).cleanups__;
    for (const cleanup of [...cleanups].reverse()) cleanup();
    rejectHandoff?.(new Error('leaf destroyed during unload'));
    await expect(pendingHandoff).rejects.toThrow('leaf destroyed during unload');
    await Promise.resolve();

    expect(log).not.toHaveBeenCalled();
  });

  it('restores the original core PDF state when an in-flight handoff fulfills after cleanup', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf', page: 4 } });
    const applyViewState = leaf.setViewState.bind(leaf);
    let settleHandoff: (() => void) | undefined;
    const pendingHandoff = new Promise<void>((resolve) => {
      settleHandoff = resolve;
    });
    const setViewState = vi.spyOn(leaf, 'setViewState').mockImplementation(async (state) => {
      if (state.type === DOCUMENT_VIEW_TYPE) await pendingHandoff;
      await applyViewState(state);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await plugin.onload();
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledOnce();
    });
    const cleanups = (plugin as unknown as { cleanups__: Array<() => unknown> }).cleanups__;
    for (const cleanup of [...cleanups].reverse()) cleanup();
    settleHandoff?.();

    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledTimes(2);
    });
    expect(leaf.getViewState()).toEqual({
      type: 'pdf',
      state: { file: 'Books/Guide.pdf', page: 4 },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('does not replace a newer leaf state when a stale handoff fulfills after cleanup', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '', 'Notes/Newer.md': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const applyViewState = leaf.setViewState.bind(leaf);
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
    const cleanups = (plugin as unknown as { cleanups__: Array<() => unknown> }).cleanups__;
    for (const cleanup of [...cleanups].reverse()) cleanup();
    await applyViewState({ type: 'markdown', state: { file: 'Notes/Newer.md' } });
    settleHandoff?.();
    await pendingHandoff;
    await Promise.resolve();

    expect(leaf.getViewState()).toEqual({
      type: 'markdown',
      state: { file: 'Notes/Newer.md' },
    });
    expect(setViewState).toHaveBeenCalledOnce();
  });

  it('contains a failed stale-state restore without logging after cleanup', async () => {
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Guide.pdf' } });
    const applyViewState = leaf.setViewState.bind(leaf);
    let settleHandoff: (() => void) | undefined;
    const pendingHandoff = new Promise<void>((resolve) => {
      settleHandoff = resolve;
    });
    const setViewState = vi
      .spyOn(leaf, 'setViewState')
      .mockImplementationOnce(async (state) => {
        await pendingHandoff;
        await applyViewState(state);
      })
      .mockRejectedValueOnce(new Error('leaf unavailable during restore'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await plugin.onload();
    app.workspace.trigger('file-open', pdfFile(app));
    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledOnce();
    });
    const cleanups = (plugin as unknown as { cleanups__: Array<() => unknown> }).cleanups__;
    for (const cleanup of [...cleanups].reverse()) cleanup();
    settleHandoff?.();
    await vi.waitFor(() => {
      expect(setViewState).toHaveBeenCalledTimes(2);
    });
    await Promise.resolve();

    expect(log).not.toHaveBeenCalled();
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

  it('creates one plugin-wide verified PDF save coordinator without loading PDF.js', async () => {
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const loadRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'load');

    await plugin.onload();

    expect(plugin).toHaveProperty('saveBoundary', expect.any(PdfWriteBoundary));
    expect(plugin).toHaveProperty('saveCoordinator', expect.any(DocumentSaveCoordinator));
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it('wires conflict and destructive recovery confirmations through native modals', async () => {
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const registerView = vi.spyOn(plugin, 'registerView');
    const openConflict = vi.spyOn(SaveConflictModal.prototype, 'open').mockImplementation(() => {});
    vi.spyOn(SaveConflictModal.prototype, 'waitForChoice').mockResolvedValue('cancel');
    const openRecovery = vi.spyOn(SaveRecoveryModal.prototype, 'open').mockImplementation(() => {});
    vi.spyOn(SaveRecoveryModal.prototype, 'waitForChoice').mockResolvedValue(false);
    await plugin.onload();
    const creator = registerView.mock.calls.find(([type]) => type === DOCUMENT_VIEW_TYPE)?.[1];
    if (creator === undefined) throw new Error('Expected the document view creator.');
    const view = creator(WorkspaceLeaf.create2__(app).asOriginalType3__());
    const controller = (
      view as unknown as {
        controller: {
          services: {
            resolveSaveConflict(path: string): Promise<SaveConflictAction>;
            confirmSaveRecovery(path: string): Promise<boolean>;
          };
        };
      }
    ).controller;

    await expect(controller.services.resolveSaveConflict('Books/Guide.pdf')).resolves.toBe(
      'cancel',
    );
    await expect(controller.services.confirmSaveRecovery('Guide.pdf')).resolves.toBe(false);
    expect(openConflict).toHaveBeenCalledOnce();
    expect(openRecovery).toHaveBeenCalledOnce();
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
        onSettingsChanged(settings: PluginDataV2['settings']): void | Promise<void>;
      }
    ).onSettingsChanged.bind(settingTabs[0]);

    await onSettingsChanged(plugin.data.settings);

    expect(refresh).toHaveBeenCalledOnce();
    expect(plugin.data).toBe(DEFAULT_DATA);
  });

  it('reports malformed recognized settings once while retaining valid V1 fields', async () => {
    const plugin = createPlugin();
    vi.spyOn(plugin, 'loadData').mockResolvedValue({
      schemaVersion: 1,
      settings: {
        reading: { defaultProfile: 'bad', rememberPerDocument: false, custom: null },
        debugLogging: false,
      },
      view: {
        sidebar: { open: false },
        selectedTab: 'outline',
        sidebarWidth: 320,
        profileByFingerprint: { valid: 'dark', invalid: 'bad' },
      },
    });
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await plugin.onload();

    expect(plugin.data.view.profileByFingerprint).toEqual({ valid: 'dark' });
    expect(notice).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toBe('[abyss-documents] Failed to migrate some plugin settings');
    const details = log.mock.calls[0]?.[1] as { readonly paths?: readonly string[] } | undefined;
    expect(details?.paths).toContain('settings.reading.defaultProfile');
  });

  it('loads absent data silently with V2 defaults', async () => {
    const plugin = createPlugin();
    vi.spyOn(plugin, 'loadData').mockResolvedValue(null);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await plugin.onload();

    expect(plugin.data).toBe(DEFAULT_DATA);
    expect(notice).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
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
    const data: PluginDataV2 = {
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

    expect(session.setReadingColors).toHaveBeenLastCalledWith(resolved(BUILTIN_PROFILES.dark));
    const profile = reader.view.contentEl.querySelector<HTMLButtonElement>(
      '[data-control="overflow"]',
    );
    if (profile === null) throw new Error('Expected More options.');
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
    const data: PluginDataV2 = {
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

    expect(session.setReadingColors).toHaveBeenLastCalledWith(resolved(BUILTIN_PROFILES.sepia));
    const profile = reader.view.contentEl.querySelector<HTMLButtonElement>(
      '[data-control="overflow"]',
    );
    if (profile === null) throw new Error('Expected More options.');
    profile.click();
    entries.find((entry) => entry.title === 'Light')?.click();
    await Promise.resolve();

    expect(reader.saveData).not.toHaveBeenCalled();
    expect(reader.plugin.data.view.profileByFingerprint).toEqual({ [fingerprint]: 'dark' });
    if (reader.view.file !== null) await reader.view.onUnloadFile(reader.view.file);
  });

  it('restores and saves per-document layouts through the loaded plugin data store', async () => {
    const fingerprint = 'layout-fingerprint';
    const remembered = { pages: 'facing', scrolling: 'page-by-page' } as const;
    const data: PluginDataV2 = {
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        layout: { ...DEFAULT_DATA.settings.layout, rememberPerDocument: true },
      },
      view: {
        ...DEFAULT_DATA.view,
        layoutByFingerprint: { [fingerprint]: remembered },
      },
    };
    const session = documentSession(fingerprint);
    const entries = capturedMenuItems();
    const reader = await loadedReader(data, session);

    expect(session.setLayout).toHaveBeenCalledWith(remembered);
    const layout = reader.view.contentEl.querySelector<HTMLButtonElement>(
      '[data-control="overflow"]',
    );
    if (layout === null) throw new Error('Expected More options.');
    layout.click();
    entries.find((entry) => entry.title === 'Single page · Paged')?.click();
    await vi.waitFor(() => {
      expect(reader.saveData).toHaveBeenCalledOnce();
    });

    expect(reader.plugin.data.view.layoutByFingerprint[fingerprint]).toEqual({
      pages: 'single',
      scrolling: 'page-by-page',
    });
    expect(reader.saveData.mock.calls[0]?.[0]).toMatchObject({
      view: {
        layoutByFingerprint: {
          [fingerprint]: { pages: 'single', scrolling: 'page-by-page' },
        },
      },
    });
    if (reader.view.file !== null) await reader.view.onUnloadFile(reader.view.file);
  });
});
