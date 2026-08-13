import type { TFile } from 'obsidian';
import { App, TFile as MockTFile, Notice } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { StaleAnnotationCacheReadError, type AnnotationCache } from '../annotation-cache.js';
import type { AnnotationSink, DocumentAnnotation } from '../document-core/annotations.js';
import { DocumentAdapterRegistry } from '../document-core/document-adapter.js';
import type {
  DocumentAdapter,
  DocumentSession,
  DocumentViewport,
} from '../document-core/document.js';
import { DocumentOpenError } from '../document-core/errors.js';
import type { ReaderLayout, ReadingProfileId } from '../document-core/reading.js';
import {
  NATIVE_RECOVERY_SOURCE,
  SaveConflictError,
  type BaseToken,
  type NativeDocumentSaveRequest,
  type NativeEditableSaveSession,
  type VerifiedReloadListener,
} from '../document-core/save-coordinator.js';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../reader-performance.js';
import {
  ReaderController,
  type ReaderProfileState,
  type ShellFactory,
} from './reader-controller.js';
import type { ReaderShellIntent } from './reader-shell.js';
import { ReaderShell } from './reader-shell.js';
import { BUILTIN_PROFILES } from './reading-profiles.js';
import type { ReaderToolbarIntent } from './toolbar.js';

function files(...paths: string[]): TFile[] {
  const app = App.createConfigured__({
    files: Object.fromEntries(paths.map((path) => [path, ''])),
  });
  return paths.map((path) => {
    const source = app.vault.getAbstractFileByPath(path);
    if (!(source instanceof MockTFile)) throw new Error(`Expected a test file at ${path}.`);
    return source.asOriginalType2__();
  });
}

function resolved(colors: (typeof BUILTIN_PROFILES)[keyof typeof BUILTIN_PROFILES]) {
  return {
    pageColors: { background: colors.background, foreground: colors.foreground },
    brightness: colors.brightness,
    contrast: colors.contrast,
    imageDim: colors.imageDim,
  };
}

function viewport(pageCount = 3) {
  const mount = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const goTo = vi.fn(async () => undefined);
  const focus = vi.fn();
  const search = vi.fn();
  const searchAgain = vi.fn();
  const selectSearchHit = vi.fn(async () => undefined);
  const setScale = vi.fn();
  const stepScale = vi.fn();
  const setLayout = vi.fn();
  const setReadingColors = vi.fn();
  let listener: Parameters<DocumentViewport['onEvent']>[0] | null = null;
  const unsubscribe = vi.fn();
  const value: DocumentViewport = {
    pageCount,
    mount,
    goTo,
    setScale,
    stepScale,
    setLayout,
    setReadingColors,
    search,
    searchAgain,
    selectSearchHit,
    onEvent: vi.fn((nextListener: Parameters<DocumentViewport['onEvent']>[0]) => {
      listener = nextListener;
      return unsubscribe;
    }),
    focus,
    destroy,
  };
  return {
    destroy,
    emit(event: Parameters<NonNullable<typeof listener>>[0]) {
      listener?.(event);
    },
    focus,
    goTo,
    mount,
    search,
    searchAgain,
    selectSearchHit,
    setReadingColors,
    setLayout,
    setScale,
    stepScale,
    unsubscribe,
    value,
  };
}

function session(path: string, createdViewport = viewport()) {
  const createViewport = vi.fn(async () => createdViewport.value);
  const close = vi.fn(async () => undefined);
  const value: DocumentSession = {
    descriptor: {
      path,
      name: path.split('/').slice(-1)[0] ?? path,
      fingerprint: path,
      pageCount: 3,
    },
    capabilities: new Set(['outline', 'text-search', 'existing-annotations']),
    getOutline: vi.fn(async () => []),
    createViewport,
    close,
  };
  return { close, createViewport, value };
}

function adapterFor(path: string, createdSession: ReturnType<typeof session>) {
  const open = vi.fn(async () => createdSession.value);
  const value: DocumentAdapter = {
    id: `adapter:${path}`,
    supports: (file) => file.path === path,
    open,
  };
  return { open, value };
}

function profileState(options?: {
  defaultLayout?: ReaderLayout;
  defaultProfile?: ReadingProfileId;
  layouts?: Record<string, ReaderLayout>;
  profiles?: Record<string, ReadingProfileId>;
  rememberLayoutPerDocument?: boolean;
  rememberPerDocument?: boolean;
}) {
  const layouts = { ...options?.layouts };
  const profiles = { ...options?.profiles };
  const updateLayout = vi.fn((fingerprint: string, layout: ReaderLayout) => {
    layouts[fingerprint] = layout;
  });
  const updateProfile = vi.fn((fingerprint: string, profile: ReadingProfileId) => {
    profiles[fingerprint] = profile;
  });
  const value: ReaderProfileState = {
    reading: {
      defaultProfile: options?.defaultProfile ?? 'default',
      rememberPerDocument: options?.rememberPerDocument ?? false,
      custom: {
        background: '#101820',
        foreground: '#f2f2f2',
        brightness: 1,
        contrast: 1,
        imageDim: 0,
      },
    },
    layout: {
      default: options?.defaultLayout ?? { pages: 'single', scrolling: 'continuous' },
      rememberPerDocument: options?.rememberLayoutPerDocument ?? false,
    },
    layoutByFingerprint: layouts,
    profileByFingerprint: profiles,
    updateLayoutForFingerprint: updateLayout,
    updateProfileForFingerprint: updateProfile,
  };
  return { layouts, profiles, updateLayout, updateProfile, value };
}

function capturingShellFactory() {
  let sendIntent: ((intent: ReaderShellIntent) => void) | null = null;
  let createdShell: ReaderShell | null = null;
  const createShell: ShellFactory = (host, onIntent) => {
    sendIntent = onIntent;
    createdShell = new ReaderShell(host, onIntent);
    return createdShell;
  };
  return {
    createShell,
    get created(): ReaderShell {
      if (createdShell === null) throw new Error('Expected the reader shell to be created.');
      return createdShell;
    },
    send(intent: ReaderToolbarIntent) {
      if (sendIntent === null) throw new Error('Expected the reader shell to be created.');
      sendIntent(intent);
    },
  };
}

describe('ReaderController', () => {
  it('does zero annotation work until Annotations is explicitly requested and cancels stale work', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(
      async (_signal: AbortSignal, sink: (items: readonly never[]) => void) => {
        sink([]);
      },
    );
    Object.assign(createdSession.value, { listAnnotations });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    expect(listAnnotations).not.toHaveBeenCalled();

    shell.send({ type: 'toggle-sidebar' });
    expect(listAnnotations).not.toHaveBeenCalled();
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledOnce();
    });
    const signal = listAnnotations.mock.calls[0]?.[0];
    await controller.close();
    expect(signal?.aborted).toBe(true);
  });
  it('loads a matching derived cache without extracting and reports a background extraction failure once', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const cause = new Error('annotation read failed');
    const listAnnotations = vi.fn(async () => {
      throw cause;
    });
    Object.assign(createdSession.value, { listAnnotations });
    const cacheRead = vi.fn(async (): Promise<readonly DocumentAnnotation[] | null> => []);
    const cacheWrite = vi.fn(async () => true);
    const cache = {
      generation: vi.fn(() => 0),
      read: cacheRead,
      write: cacheWrite,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(cacheRead).toHaveBeenCalledOnce();
    });
    expect(listAnnotations).not.toHaveBeenCalled();

    cacheRead.mockResolvedValueOnce(null);
    await controller.close();
    const secondSession = session(pdf.path);
    Object.assign(secondSession.value, { listAnnotations });
    const secondShell = capturingShellFactory();
    const failed = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, secondSession).value]),
      secondShell.createShell,
      undefined,
      { annotationCache: cache },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await failed.open(pdf, createDiv());
    secondShell.send({ type: 'toggle-sidebar' });
    secondShell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(
        secondShell.created.sidebar?.annotationsPanel.root.querySelector('[role="alert"]'),
      ).not.toBeNull();
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to extract PDF annotations', {
      path: pdf.path,
      page: 1,
      cause,
    });
  });
  it('logs the exact extraction page carried through the session error boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const pageFailure = Object.assign(new Error('page failed'), {
      name: 'PdfAnnotationExtractionError',
      pageNumber: 3,
    });
    const cause = new DocumentOpenError(pdf.path, 'Could not read annotations.', pageFailure);
    Object.assign(createdSession.value, {
      listAnnotations: vi.fn(async () => {
        throw cause;
      }),
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalled();
    });

    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to extract PDF annotations', {
      path: pdf.path,
      page: 3,
      cause,
    });
  });
  it('silently discards an extraction invalidated before its cache write', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(
      async (_signal: AbortSignal, sink: (items: readonly never[]) => void) => {
        sink([]);
      },
    );
    Object.assign(createdSession.value, { listAnnotations });
    const cacheWrite = vi.fn(async () => false);
    const cache = {
      generation: vi.fn(() => 0),
      read: vi.fn(async () => null),
      write: cacheWrite,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();
    await vi.waitFor(() => {
      expect(cacheWrite).toHaveBeenCalledOnce();
    });
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).toContain(
      'Loading annotations',
    );
    expect(log).not.toHaveBeenCalledWith(
      '[abyss-documents] Failed to extract PDF annotations',
      expect.anything(),
    );
  });
  it('retries extraction after a cache read is invalidated and never renders stale data', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listAnnotations = vi.fn(async (_signal: AbortSignal, sink: AnnotationSink) => {
      sink([]);
    });
    Object.assign(createdSession.value, { listAnnotations });
    const generation = vi.fn(() => 1);
    const cacheRead = vi.fn(async () => {
      throw new StaleAnnotationCacheReadError();
    });
    const cacheWrite = vi.fn(async () => true);
    const cache = {
      generation,
      read: cacheRead,
      write: cacheWrite,
    } as unknown as AnnotationCache;
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      shell.createShell,
      undefined,
      { annotationCache: cache },
    );
    await controller.open(pdf, createDiv());
    shell.send({ type: 'toggle-sidebar' });
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')
      ?.click();

    await vi.waitFor(() => {
      expect(listAnnotations).toHaveBeenCalledOnce();
    });
    expect(cacheRead).toHaveBeenCalledWith(pdf.path, pdf.path, 1);
    expect(cacheWrite).toHaveBeenCalledWith(expect.objectContaining({ annotations: [] }), 1);
    expect(shell.created.sidebar?.annotationsPanel.root.textContent).toContain('0 annotations');
  });
  it('mounts a session viewport into the shell document region', async () => {
    beginPluginActivation();
    endPluginActivation();
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    const host = createDiv();

    await controller.open(pdf, host);

    const documentHost = host.querySelector<HTMLElement>('[data-region="document"]');
    expect(documentHost).not.toBeNull();
    expect(createdViewport.mount).toHaveBeenCalledWith(documentHost);
    expect(host.querySelector('[data-region="sidebar"]')).toBeNull();
    expect(
      readerPerformanceSnapshot().marks.filter(({ name }) => name === 'reader-intent'),
    ).toHaveLength(1);
  });

  it('closes the previous viewport and session before loading another file', async () => {
    const [firstPdf, secondPdf] = files('Books/First.pdf', 'Books/Second.pdf');
    if (firstPdf === undefined || secondPdf === undefined)
      throw new Error('Expected PDF fixtures.');
    const firstViewport = viewport();
    const firstSession = session(firstPdf.path, firstViewport);
    const secondSession = session(secondPdf.path);
    const secondAdapter = adapterFor(secondPdf.path, secondSession);
    const firstAdapter = adapterFor(firstPdf.path, firstSession);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([firstAdapter.value, secondAdapter.value]),
    );
    const host = createDiv();

    await controller.open(firstPdf, host);
    await controller.open(secondPdf, host);

    expect(firstViewport.destroy).toHaveBeenCalledOnce();
    expect(firstSession.close).toHaveBeenCalledOnce();
    expect(firstSession.close.mock.invocationCallOrder[0]).toBeLessThan(
      secondAdapter.open.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('propagates an owned open failure after closing the partial session', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const cause = new DocumentOpenError(pdf.path, 'Could not create this PDF view.');
    const createdSession = session(pdf.path);
    createdSession.createViewport.mockRejectedValue(cause);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toBe(cause);

    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('destroys the active viewport and closes its session exactly once', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await Promise.all([controller.close(), controller.close()]);
    await controller.close();

    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('cancels a queued file before its adapter starts when a newer file wins', async () => {
    const [firstPdf, secondPdf] = files('Books/First.pdf', 'Books/Second.pdf');
    if (firstPdf === undefined || secondPdf === undefined)
      throw new Error('Expected PDF fixtures.');
    const firstSession = session(firstPdf.path);
    const secondSession = session(secondPdf.path);
    const firstAdapter = adapterFor(firstPdf.path, firstSession);
    const secondAdapter = adapterFor(secondPdf.path, secondSession);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([firstAdapter.value, secondAdapter.value]),
    );
    const host = createDiv();

    const firstOpen = controller.open(firstPdf, host);
    const secondOpen = controller.open(secondPdf, host);

    await expect(firstOpen).rejects.toMatchObject({ name: 'DocumentCancelledError' });
    await expect(secondOpen).resolves.toBeUndefined();
    expect(firstAdapter.open).not.toHaveBeenCalled();
    expect(secondAdapter.open).toHaveBeenCalledOnce();
  });

  it('maps an unowned adapter failure to a typed open error', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const adapter = adapterFor(pdf.path, createdSession);
    const cause = new Error('vault bridge failed');
    adapter.open.mockRejectedValue(cause);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toMatchObject({
      name: 'DocumentOpenError',
      path: pdf.path,
      cause,
    });
  });

  it('destroys and closes partial state when viewport mounting fails', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const cause = new Error('viewer mount failed');
    createdViewport.mount.mockRejectedValue(cause);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toMatchObject({
      name: 'DocumentOpenError',
      cause,
    });
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('preserves the primary open failure while logging partial cleanup failure', async () => {
    const [pdf] = files('Books/Broken.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const cause = new DocumentOpenError(pdf.path, 'Could not create this PDF view.');
    const createdSession = session(pdf.path);
    createdSession.createViewport.mockRejectedValue(cause);
    createdSession.close.mockRejectedValue(new Error('partial close failed'));
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(controller.open(pdf, createDiv())).rejects.toBe(cause);

    expect(log).toHaveBeenCalledOnce();
  });

  it('attempts both active cleanup operations and keeps the first error', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const firstCause = new Error('viewport cleanup failed');
    createdViewport.destroy.mockRejectedValue(firstCause);
    const createdSession = session(pdf.path, createdViewport);
    createdSession.close.mockRejectedValue(new Error('session cleanup failed'));
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await expect(controller.close()).rejects.toBe(firstCause);

    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
    await expect(controller.close()).resolves.toBeUndefined();
  });

  it('normalizes a non-error cleanup rejection', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    createdSession.close.mockRejectedValue('worker vanished');
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await expect(controller.close()).rejects.toThrow('Unknown reader cleanup failure');
  });

  it('restores a remembered reading profile after the fingerprint is known', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      defaultProfile: 'sepia',
      profiles: { [pdf.path]: 'dark' },
      rememberPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );

    await controller.open(pdf, createDiv());

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.dark),
    );
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  it('updates the fingerprint profile when the current profile changes', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ rememberPerDocument: true });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      profiles.value,
    );
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-profile', profile: 'light' });

    expect(profiles.profiles[pdf.path]).toBe('light');
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.light),
    );
    expect(shell.created.root.getAttribute('data-reading-profile')).toBe('light');
  });

  it('keeps the chosen layout reflected in the toolbar without creating a second reader setting surface', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const layout: ReaderLayout = { pages: 'facing', scrolling: 'page-by-page' };
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-layout', layout });

    expect(createdSession.createViewport).toHaveBeenCalledOnce();
    const layoutButton = shell.created.root.querySelector('[data-control="layout"]');
    expect(layoutButton?.getAttribute('aria-label')).toBe('Layout: Facing, page by page');
  });

  it('applies the global layout and remembers later choices by fingerprint when enabled', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const state = profileState({
      defaultLayout: { pages: 'facing', scrolling: 'continuous' },
      rememberLayoutPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());

    expect(createdViewport.setLayout).toHaveBeenCalledWith({
      pages: 'facing',
      scrolling: 'continuous',
    });
    shell.send({
      type: 'set-layout',
      layout: { pages: 'single', scrolling: 'page-by-page' },
    });

    expect(createdViewport.setLayout).toHaveBeenLastCalledWith({
      pages: 'single',
      scrolling: 'page-by-page',
    });
    expect(state.layouts[pdf.path]).toEqual({ pages: 'single', scrolling: 'page-by-page' });
  });

  it('restores a fingerprint layout only when layout memory is enabled', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const remembered = { pages: 'facing', scrolling: 'page-by-page' } as const;
    for (const rememberLayoutPerDocument of [true, false]) {
      const createdViewport = viewport(8);
      const createdSession = session(pdf.path, createdViewport);
      const adapter = adapterFor(pdf.path, createdSession);
      const state = profileState({
        defaultLayout: { pages: 'single', scrolling: 'continuous' },
        layouts: { [pdf.path]: remembered },
        rememberLayoutPerDocument,
      });
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapter.value]),
        undefined,
        state.value,
      );

      await controller.open(pdf, createDiv());

      expect(createdViewport.setLayout).toHaveBeenCalledWith(
        rememberLayoutPerDocument ? remembered : { pages: 'single', scrolling: 'continuous' },
      );
      await controller.close();
    }
  });

  it('steps between facing spreads while direct even-page entry stays exact', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const state = profileState({
      defaultLayout: { pages: 'facing', scrolling: 'page-by-page' },
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());
    createdViewport.emit({ type: 'page-change', pageIndex: 3 });

    shell.send({ type: 'previous-page' });
    shell.send({ type: 'next-page' });
    shell.send({ type: 'go-to-page', pageIndex: 5 });
    shell.send({ type: 'zoom-step', direction: 1 });

    expect(createdViewport.goTo).toHaveBeenNthCalledWith(1, { pageIndex: 0 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(2, { pageIndex: 2 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 5 });
    expect(createdViewport.stepScale).toHaveBeenCalledWith(1);
  });

  it('does not let an older navigation failure roll back a newer request to the same page', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const navigationCause = new Error('first request failed');
    createdViewport.goTo.mockRejectedValueOnce(navigationCause).mockResolvedValue(undefined);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    createdViewport.emit({ type: 'page-change', pageIndex: 1 });

    shell.send({ type: 'previous-page' });
    shell.send({ type: 'previous-page' });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to navigate PDF page', {
        pageIndex: 0,
        cause: navigationCause,
      });
    });
    shell.send({ type: 'next-page' });

    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 1 });
  });

  it('keeps an active layout when unrelated reading settings refresh', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(8);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const state = profileState({
      defaultLayout: { pages: 'single', scrolling: 'continuous' },
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      state.value,
    );
    await controller.open(pdf, createDiv());
    shell.send({
      type: 'set-layout',
      layout: { pages: 'facing', scrolling: 'page-by-page' },
    });
    (state.value.reading.custom as { brightness: number }).brightness = 1.25;

    controller.refreshReadingSettings();

    expect(createdViewport.setLayout).toHaveBeenLastCalledWith({
      pages: 'facing',
      scrolling: 'page-by-page',
    });

    Object.assign(state.value.layout.default, {
      pages: 'single',
      scrolling: 'page-by-page',
    });
    controller.refreshReadingSettings();

    expect(createdViewport.setLayout).toHaveBeenLastCalledWith({
      pages: 'single',
      scrolling: 'page-by-page',
    });
  });

  it('contains synchronous scale, step, and layout failures at the reader boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notices = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    createdViewport.setScale.mockImplementationOnce(() => {
      throw new Error('scale failed');
    });
    createdViewport.stepScale.mockImplementationOnce(() => {
      throw new Error('step failed');
    });
    createdViewport.setLayout.mockImplementationOnce(() => {
      throw new Error('layout failed');
    });

    shell.send({ type: 'set-scale', scale: 1.25 });
    shell.send({ type: 'zoom-step', direction: 1 });
    shell.send({
      type: 'set-layout',
      layout: { pages: 'facing', scrolling: 'continuous' },
    });

    expect(notices).toHaveBeenCalledWith('Could not change zoom: scale failed', undefined);
    expect(notices).toHaveBeenCalledWith('Could not change zoom: step failed', undefined);
    expect(notices).toHaveBeenCalledWith('Could not change page layout: layout failed', undefined);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('uses the global default and leaves the fingerprint map untouched when remembering is off', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      defaultProfile: 'sepia',
      profiles: { [pdf.path]: 'dark' },
      rememberPerDocument: false,
    });
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      profiles.value,
    );

    await controller.open(pdf, createDiv());
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.sepia),
    );
    shell.send({ type: 'set-profile', profile: 'light' });

    expect(profiles.profiles).toEqual({ [pdf.path]: 'dark' });
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  it('falls back to the global default for an unknown fingerprint', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      defaultProfile: 'sepia',
      profiles: { 'another-fingerprint': 'dark' },
      rememberPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );

    await controller.open(pdf, createDiv());

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.sepia),
    );
  });

  it('updates Follow Obsidian for owner-document theme changes without rewriting stored profile state', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const host = createDiv();
    host.doc.body.removeClass('theme-light');
    host.doc.body.addClass('theme-dark');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      profiles: { [pdf.path]: 'follow-obsidian' },
      rememberPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );
    await controller.open(pdf, host);
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith({
      pageColors: {
        background: BUILTIN_PROFILES.dark.background,
        foreground: BUILTIN_PROFILES.dark.foreground,
      },
      brightness: BUILTIN_PROFILES.dark.brightness,
      contrast: BUILTIN_PROFILES.dark.contrast,
      imageDim: BUILTIN_PROFILES.dark.imageDim,
    });

    host.doc.body.removeClass('theme-dark');
    host.doc.body.addClass('theme-light');
    await vi.waitFor(() => {
      expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith({
        pageColors: {
          background: BUILTIN_PROFILES.light.background,
          foreground: BUILTIN_PROFILES.light.foreground,
        },
        brightness: BUILTIN_PROFILES.light.brightness,
        contrast: BUILTIN_PROFILES.light.contrast,
        imageDim: BUILTIN_PROFILES.light.imageDim,
      });
    });

    expect(profiles.profiles[pdf.path]).toBe('follow-obsidian');
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  it('reapplies bounded custom appearance settings to an active custom profile', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ defaultProfile: 'custom' });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );
    await controller.open(pdf, createDiv());
    (profiles.value.reading.custom as { brightness: number }).brightness = 9;

    controller.refreshReadingSettings();

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      expect.objectContaining({ brightness: 1.5 }),
    );
  });

  it('routes navigation and scale intents and follows viewport page events', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());

    createdViewport.emit({ type: 'page-change', pageIndex: 1 });
    shell.send({ type: 'previous-page' });
    shell.send({ type: 'next-page' });
    shell.send({ type: 'go-to-page', pageIndex: 99 });
    shell.send({ type: 'set-scale', scale: 'page-fit' });
    createdViewport.emit({ type: 'scale-change', scale: 1.25 });
    shell.send({ type: 'toggle-sidebar' });

    expect(createdViewport.goTo).toHaveBeenNthCalledWith(1, { pageIndex: 0 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(2, { pageIndex: 1 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 2 });
    expect(createdViewport.setScale).toHaveBeenCalledWith('page-fit');
  });

  it('opens the lazy outline from the toolbar but never for deep navigation', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    createdSession.value.getOutline = vi.fn(async () => [
      { id: 'chapter', label: 'Chapter', target: { pageIndex: 1 }, children: [] },
    ]);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());

    shell.send({ type: 'go-to-page', pageIndex: 1 });
    expect(shell.created.sidebar).toBeNull();

    shell.send({ type: 'toggle-sidebar' });
    await vi.waitFor(() => {
      expect(shell.created.sidebar?.outlinePanel.root.textContent).toContain('Chapter');
    });
    expect(shell.created.sidebar?.activeTab).toBe('outline');
    shell.created.sidebar?.outlinePanel.root
      .querySelector<HTMLElement>('[data-outline-id="chapter"]')
      ?.click();
    expect(createdViewport.goTo).toHaveBeenLastCalledWith({ pageIndex: 1 });
    shell.send({ type: 'toggle-sidebar' });
    expect(shell.created.sidebar?.isOpen).toBe(false);
  });

  it('contains an outline-loading failure at one visible and diagnostic boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const cause = new Error('destination table is damaged');
    createdSession.value.getOutline = vi.fn(async () => {
      throw cause;
    });
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    controller.showOutline();

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not load document outline: destination table is damaged',
        undefined,
      );
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to load PDF outline', {
      path: pdf.path,
      cause,
    });
    expect(shell.created.sidebar?.outlinePanel.root.textContent).toContain('No outline available.');
  });

  it('keeps document search query, selected PDF match, and target page synchronized', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport(3);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const host = createDiv();
    host.doc.body.append(host);
    await controller.open(pdf, host);
    const OwnerKeyboardEvent = (
      shell.created.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    const OwnerEvent = (shell.created.root.win as Window & { Event: typeof Event }).Event;
    shell.created.documentHost.dispatchEvent(
      new OwnerKeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        metaKey: true,
        key: 'f',
      }),
    );
    const input = shell.created.sidebar?.searchPanel.input;
    if (input === undefined) throw new Error('Expected document search input.');
    input.value = 'needle';
    input.dispatchEvent(new OwnerEvent('input', { bubbles: true }));
    createdViewport.emit({
      type: 'search-results',
      results: {
        query: 'needle',
        complete: true,
        hits: [
          { id: 'first', pageIndex: 0, matchIndex: 0, preview: 'First needle' },
          { id: 'second', pageIndex: 2, matchIndex: 0, preview: 'Second needle' },
        ],
      },
    });
    shell.created.sidebar?.searchPanel.root
      .querySelectorAll<HTMLButtonElement>('[data-search-result]')[1]
      ?.click();

    expect(createdViewport.search).toHaveBeenCalledWith('needle');
    await vi.waitFor(() => {
      expect(createdViewport.selectSearchHit).toHaveBeenCalledWith(
        { id: 'second', pageIndex: 2, matchIndex: 0, preview: 'Second needle' },
        'needle',
      );
    });
    expect(createdViewport.goTo).not.toHaveBeenCalled();

    shell.created.sidebar?.searchPanel.root
      .querySelector<HTMLButtonElement>('[data-action="previous-result"]')
      ?.click();
    await vi.waitFor(() => {
      expect(createdViewport.selectSearchHit).toHaveBeenLastCalledWith(
        { id: 'first', pageIndex: 0, matchIndex: 0, preview: 'First needle' },
        'needle',
      );
    });

    input.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(createdViewport.search).toHaveBeenLastCalledWith('');
    const restoreFocus = vi.spyOn(shell.created.toolbar.sidebarButton, 'focus');
    input.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(shell.created.sidebar?.isOpen).toBe(false);
    expect(createdViewport.focus).not.toHaveBeenCalled();
    expect(restoreFocus).toHaveBeenCalledOnce();
    await controller.close();
    host.remove();
  });

  it('loads the outline once when its tab is selected after Search opened first', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const getOutline = vi.fn(async () => [
      { id: 'chapter', label: 'Late outline', target: { pageIndex: 1 }, children: [] },
    ]);
    createdSession.value.getOutline = getOutline;
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    await controller.open(pdf, createDiv());
    controller.searchDocument();

    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="outline"]')
      ?.click();

    await vi.waitFor(() => {
      expect(shell.created.sidebar?.outlinePanel.root.textContent).toContain('Late outline');
    });
    expect(getOutline).toHaveBeenCalledOnce();
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="search"]')
      ?.click();
    shell.created.sidebar?.root
      .querySelector<HTMLButtonElement>('[data-sidebar-tab="outline"]')
      ?.click();
    expect(getOutline).toHaveBeenCalledOnce();
  });

  it('contains a timed-out search selection at the active reader boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const cause = new DOMException('PDF search selection timed out.', 'TimeoutError');
    createdViewport.selectSearchHit.mockRejectedValueOnce(cause);
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());
    controller.searchDocument();
    const input = shell.created.sidebar?.searchPanel.input;
    if (input === undefined) throw new Error('Expected search input.');
    const OwnerEvent = (input.win as Window & { Event: typeof Event }).Event;
    input.value = 'needle';
    input.dispatchEvent(new OwnerEvent('input', { bubbles: true }));
    createdViewport.emit({
      type: 'search-results',
      results: {
        query: 'needle',
        complete: true,
        hits: [{ id: 'hit', pageIndex: 1, matchIndex: 0, preview: 'Needle' }],
      },
    });
    shell.created.sidebar?.searchPanel.root
      .querySelector<HTMLButtonElement>('[data-search-result]')
      ?.click();

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not select search result: PDF search selection timed out.',
        undefined,
      );
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to select PDF search result', {
      hitId: 'hit',
      cause,
    });
  });

  it('ignores reader commands and render errors when no interactive action is needed', async () => {
    const controller = new ReaderController(new DocumentAdapterRegistry([]));
    controller.showOutline();
    controller.searchDocument();

    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const activeController = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    const host = createDiv();
    await activeController.open(pdf, host);
    createdViewport.emit({ type: 'render-error', pageIndex: 0, cause: new Error('render') });
    activeController.searchDocument();
    expect(host.querySelector('[data-sidebar-panel="search"]')).not.toBeNull();
    await activeController.close();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
  });

  it('reports a failed remembered-profile write without changing the active rendering', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ rememberPerDocument: true });
    const cause = new Error('settings write failed');
    profiles.updateProfile.mockRejectedValueOnce(cause);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
      profiles.value,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'set-profile', profile: 'dark' });
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not remember reading profile: settings write failed',
        undefined,
      );
    });

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(
      resolved(BUILTIN_PROFILES.dark),
    );
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to remember PDF reading profile', {
      fingerprint: pdf.path,
      profile: 'dark',
      cause,
    });
  });

  it('falls back to Default when persisted settings contain an unknown profile id', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({ defaultProfile: 'unknown' as ReadingProfileId });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );

    await controller.open(pdf, createDiv());

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith({
      pageColors: null,
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    });
  });

  it('cleans the viewport event subscription with the active reader', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await controller.close();

    expect(createdViewport.unsubscribe).toHaveBeenCalledOnce();
  });

  it('still closes the viewport and session when event unsubscription fails', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const cause = new Error('subscription cleanup failed');
    createdViewport.unsubscribe.mockImplementation(() => {
      throw cause;
    });
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));
    await controller.open(pdf, createDiv());

    await expect(controller.close()).rejects.toBe(cause);

    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('unsubscribes once and tears down resources when theme observation setup fails', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const cause = new Error('theme observation failed');
    vi.spyOn(ReaderShell.prototype, 'onThemeChange').mockImplementationOnce(() => {
      throw cause;
    });
    const controller = new ReaderController(new DocumentAdapterRegistry([adapter.value]));

    await expect(controller.open(pdf, createDiv())).rejects.toMatchObject({ cause });

    expect(createdViewport.unsubscribe).toHaveBeenCalledOnce();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });

  it('shows one actionable failure when page navigation rejects', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const navigationCause = new Error('destination is unavailable');
    createdViewport.goTo.mockImplementation(async () => {
      throw navigationCause;
    });
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const shell = capturingShellFactory();
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      shell.createShell,
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await controller.open(pdf, createDiv());

    shell.send({ type: 'go-to-page', pageIndex: 1 });
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not go to page 2: destination is unavailable',
        undefined,
      );
    });

    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to navigate PDF page', {
      pageIndex: 1,
      cause: navigationCause,
    });
  });

  it('connects native dirty revisions to invisible autosave and force-save verification', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdViewport = viewport();
      const createdSession = session(pdf.path, createdViewport);
      const baseToken: BaseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
      const dirtyListeners: Array<(revision: number) => void> = [];
      const source: NativeEditableSaveSession = {
        baseToken,
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(async () => ({ revision: 1, baseToken, bytes: new Uint8Array([1]) })),
        commit: vi.fn(),
        destroy: vi.fn(),
      };
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          dirtyListeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn(async (request: NativeDocumentSaveRequest) => ({
        verified: true as const,
        generation: request.revision,
        sha256: 'b'.repeat(64),
        byteSize: 5,
        committedAt: '2026-08-13T00:00:00.000Z' as never,
      }));
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());

      dirtyListeners[0]?.(1);
      await vi.advanceTimersByTimeAsync(749);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0]).toMatchObject({ path: pdf.path, revision: 1, source });

      dirtyListeners[0]?.(2);
      await controller.saveDocument();
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1]?.[0]).toMatchObject({ revision: 2 });
      expect(document.querySelector('[data-autosave]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending autosave on close without promising an unload write', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const dirtyListeners: Array<(revision: number) => void> = [];
      const source = {
        baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          dirtyListeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn();
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());
      dirtyListeners[0]?.(1);

      await controller.close();
      await vi.runAllTimersAsync();

      expect(save).not.toHaveBeenCalled();
      expect(source.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an own-view token but never destroys pending edits after another view saves', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const baseToken: BaseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
    const acceptVerifiedReload = vi.fn();
    const source = {
      baseToken,
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
      acceptVerifiedReload,
    } satisfies NativeEditableSaveSession & { acceptVerifiedReload(token: BaseToken): void };
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    let broadcast: VerifiedReloadListener | undefined;
    const unregister = vi.fn();
    const register = vi.fn((_path: string, listener: VerifiedReloadListener) => {
      broadcast = listener;
      return unregister;
    });
    const createdAdapter = adapterFor(pdf.path, createdSession);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([createdAdapter.value]),
      undefined,
      undefined,
      { saveCoordinator: { save: vi.fn(), register } },
    );
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected a verified-save listener.');
    const verifiedToken: BaseToken = { sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 };

    await broadcast(verifiedToken, 1, source);
    expect(acceptVerifiedReload).toHaveBeenCalledWith(verifiedToken);

    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    await broadcast(verifiedToken, 2, {
      prepare: vi.fn(),
      commit: vi.fn(),
    });
    await Promise.resolve();
    expect(createdAdapter.open).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('keeps dirty edits conflicted and reloads a clean peer after explicit recovery broadcasts', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    let broadcast: VerifiedReloadListener | undefined;
    const createdAdapter = adapterFor(pdf.path, createdSession);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const controller = new ReaderController(
      new DocumentAdapterRegistry([createdAdapter.value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, createDiv());
    if (broadcast === undefined) throw new Error('Expected a verified-save listener.');
    const recovered = { sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 };

    await broadcast(recovered, 0, NATIVE_RECOVERY_SOURCE);
    expect(createdAdapter.open).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();

    Object.defineProperty(source, 'isDirty', { value: false });
    await broadcast(recovered, 0, NATIVE_RECOVERY_SOURCE);
    await vi.waitFor(() => {
      expect(createdAdapter.open).toHaveBeenCalledTimes(2);
    });
  });

  it('shows actionable conflict state when clean-peer automatic reload fails', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 0,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    let broadcast: VerifiedReloadListener | undefined;
    const createdAdapter = adapterFor(pdf.path, createdSession);
    createdAdapter.open
      .mockResolvedValueOnce(createdSession.value)
      .mockRejectedValueOnce(new Error('reload parser failed'))
      .mockResolvedValueOnce(createdSession.value);
    const host = createDiv();
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([createdAdapter.value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn((_path: string, listener: VerifiedReloadListener) => {
            broadcast = listener;
            return vi.fn();
          }),
        },
      },
    );
    await controller.open(pdf, host);
    if (broadcast === undefined) throw new Error('Expected a verified-save listener.');

    await broadcast({ sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 }, 1, {
      prepare: vi.fn(),
      commit: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(createdAdapter.open).toHaveBeenCalledTimes(2);
    });

    expect(host.dataset['saveConflict']).toBe('true');
    const message = notice.mock.calls[0]?.[0];
    expect(message).toBeInstanceOf(DocumentFragment);
    const retry = (message as DocumentFragment).querySelector<HTMLButtonElement>('button');
    expect(retry?.textContent).toBe('Retry');
    retry?.click();
    await vi.waitFor(() => {
      expect(createdAdapter.open).toHaveBeenCalledTimes(3);
    });
    expect(host.dataset['saveConflict']).toBeUndefined();
  });

  it('requires explicit conflict action before overwrite and forwards the destructive flag', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
    const source = {
      baseToken,
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const conflict = new SaveConflictError(pdf.path, baseToken, {
      sha256: 'c'.repeat(64),
      byteSize: 9,
      mtime: 30,
    });
    const save = vi
      .fn<(request: NativeDocumentSaveRequest) => Promise<never>>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({} as never);
    const resolveSaveConflict = vi.fn(async () => 'overwrite' as const);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      { saveCoordinator: { save }, resolveSaveConflict },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);

    await controller.saveDocument();

    expect(resolveSaveConflict).toHaveBeenCalledWith(pdf.path);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[0].overwrite).not.toBe(true);
    expect(save.mock.calls[1]?.[0].overwrite).toBe(true);
  });

  it('pauses failed background autosave with one deduplicated Notice and diagnostic', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const listeners: Array<(revision: number) => void> = [];
      const source = {
        baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          listeners.push(onRevision);
          return source;
        },
      });
      const cause = new Error('disk full');
      const save = vi.fn(async () => Promise.reject(cause));
      const notice = vi.spyOn(Notice.prototype, 'constructor__');
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());
      listeners[0]?.(1);
      await vi.advanceTimersByTimeAsync(750);

      const message = notice.mock.calls[0]?.[0];
      expect(message).toBeInstanceOf(DocumentFragment);
      expect((message as DocumentFragment).textContent).toContain(
        'Could not autosave PDF annotations: disk full',
      );
      expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to autosave PDF annotations', {
        path: pdf.path,
        cause,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(notice).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a real Retry action that resumes the paused scheduler snapshot', async () => {
    vi.useFakeTimers();
    try {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const listeners: Array<(revision: number) => void> = [];
      const source = {
        baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          listeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({});
      const notice = vi.spyOn(Notice.prototype, 'constructor__');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save } },
      );
      await controller.open(pdf, createDiv());
      listeners[0]?.(1);
      await vi.advanceTimersByTimeAsync(750);
      const message = notice.mock.calls[0]?.[0];
      expect(message).toBeInstanceOf(DocumentFragment);
      const retry = (message as DocumentFragment).querySelector<HTMLButtonElement>('button');
      expect(retry?.textContent).toBe('Retry');

      retry?.click();
      await vi.waitFor(() => {
        expect(save).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes a manual save failure through the shared actionable Retry boundary', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const save = vi.fn(async () => Promise.reject(new Error('manual disk failure')));
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      { saveCoordinator: { save } },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);

    await expect(controller.saveDocument()).rejects.toThrow('manual disk failure');

    const message = notice.mock.calls[0]?.[0];
    expect(message).toBeInstanceOf(DocumentFragment);
    expect((message as DocumentFragment).querySelector('button')?.textContent).toBe('Retry');
  });

  it('offers explicitly confirmed last-verified recovery for an ambiguous write', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const failure = Object.assign(new Error('ambiguous write'), {
      path: pdf.path,
      preimage: new Uint8Array([1, 2, 3, 4]),
      preparedBytes: new Uint8Array([5, 6, 7]),
      restored: false,
    });
    const current = { sha256: 'c'.repeat(64), byteSize: 2, mtime: 30 };
    const inspectRecovery = vi.fn(async () => current);
    const recover = vi.fn(async () => source.baseToken);
    const confirmSaveRecovery = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(async () => Promise.reject(failure)),
          inspectRecovery,
          recover,
        },
        confirmSaveRecovery,
      },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);
    await expect(controller.saveDocument()).rejects.toBe(failure);
    const message = notice.mock.calls[0]?.[0] as DocumentFragment;
    const restore = message.querySelector<HTMLButtonElement>('button');
    expect(restore?.textContent).toBe('Restore last verified copy');

    restore?.click();
    await vi.waitFor(() => {
      expect(confirmSaveRecovery).toHaveBeenCalledOnce();
    });
    expect(recover).not.toHaveBeenCalled();
    restore?.click();
    await vi.waitFor(() => {
      expect(confirmSaveRecovery).toHaveBeenCalledTimes(2);
      expect(confirmSaveRecovery).toHaveBeenLastCalledWith(pdf.path, current);
      expect(recover).toHaveBeenCalledWith(failure, current, expect.any(AbortSignal));
    });
  });

  it.each(['cancel', 'reload-discard'] as const)(
    'does not overwrite after a %s conflict action',
    async (action) => {
      const [pdf] = files('Books/First.pdf');
      if (pdf === undefined) throw new Error('Expected a PDF fixture.');
      const createdSession = session(pdf.path);
      const listeners: Array<(revision: number) => void> = [];
      const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
      const source = {
        baseToken,
        pendingRevision: 1,
        isDirty: true,
        prepare: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn(),
      } satisfies NativeEditableSaveSession;
      Object.assign(createdSession.value, {
        createNativeEditableSession(onRevision: (revision: number) => void) {
          listeners.push(onRevision);
          return source;
        },
      });
      const save = vi.fn(async () =>
        Promise.reject(
          new SaveConflictError(pdf.path, baseToken, {
            sha256: 'c'.repeat(64),
            byteSize: 9,
            mtime: 30,
          }),
        ),
      );
      const controller = new ReaderController(
        new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
        undefined,
        undefined,
        { saveCoordinator: { save }, resolveSaveConflict: vi.fn(async () => action) },
      );
      await controller.open(pdf, createDiv());
      listeners[0]?.(1);

      await expect(controller.saveDocument()).rejects.toBeInstanceOf(SaveConflictError);
      expect(save).toHaveBeenCalledOnce();
      await Promise.resolve();
    },
  );

  it('does not present Retry after an explicitly confirmed reload-discard', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdSession = session(pdf.path);
    const listeners: Array<(revision: number) => void> = [];
    const baseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
    const source = {
      baseToken,
      pendingRevision: 1,
      isDirty: true,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession(onRevision: (revision: number) => void) {
        listeners.push(onRevision);
        return source;
      },
    });
    const save = vi.fn(async () =>
      Promise.reject(
        new SaveConflictError(pdf.path, baseToken, {
          sha256: 'b'.repeat(64),
          byteSize: 5,
          mtime: 20,
        }),
      ),
    );
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      {
        saveCoordinator: { save },
        resolveSaveConflict: vi.fn(async () => 'reload-discard' as const),
      },
    );
    await controller.open(pdf, createDiv());
    listeners[0]?.(1);

    await expect(controller.saveDocument()).rejects.toBeInstanceOf(SaveConflictError);
    expect(notice).not.toHaveBeenCalled();
  });

  it('cleans a partially activated native save lifecycle when broadcast registration throws', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const source = {
      baseToken: { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 },
      pendingRevision: 0,
      isDirty: false,
      prepare: vi.fn(),
      commit: vi.fn(),
      destroy: vi.fn(),
    } satisfies NativeEditableSaveSession;
    Object.assign(createdSession.value, {
      createNativeEditableSession() {
        return source;
      },
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapterFor(pdf.path, createdSession).value]),
      undefined,
      undefined,
      {
        saveCoordinator: {
          save: vi.fn(),
          register: vi.fn(() => {
            throw new Error('register rejected');
          }),
        },
      },
    );

    const failure = await controller.open(pdf, createDiv()).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(DocumentOpenError);
    const activationCause = (failure as DocumentOpenError).cause;
    expect(activationCause).toBeInstanceOf(Error);
    expect((activationCause as Error).message).toBe('register rejected');
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
    await controller.close();
    expect(createdViewport.destroy).toHaveBeenCalledOnce();
    expect(createdSession.close).toHaveBeenCalledOnce();
  });
});
