import type { TFile } from 'obsidian';
import { App, TFile as MockTFile, Notice } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DocumentAdapterRegistry } from '../document-core/document-adapter.js';
import type {
  DocumentAdapter,
  DocumentSession,
  DocumentViewport,
} from '../document-core/document.js';
import { DocumentOpenError } from '../document-core/errors.js';
import type { ReadingProfileId } from '../document-core/reading.js';
import {
  ReaderController,
  type ReaderProfileState,
  type ShellFactory,
} from './reader-controller.js';
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

function viewport(pageCount = 3) {
  const mount = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const goTo = vi.fn(async () => undefined);
  const setScale = vi.fn();
  const setReadingColors = vi.fn();
  let listener: Parameters<DocumentViewport['onEvent']>[0] | null = null;
  const unsubscribe = vi.fn();
  const value: DocumentViewport = {
    pageCount,
    mount,
    goTo,
    setScale,
    setReadingColors,
    search: vi.fn(),
    searchAgain: vi.fn(),
    onEvent: vi.fn((nextListener: Parameters<DocumentViewport['onEvent']>[0]) => {
      listener = nextListener;
      return unsubscribe;
    }),
    focus: vi.fn(),
    destroy,
  };
  return {
    destroy,
    emit(event: Parameters<NonNullable<typeof listener>>[0]) {
      listener?.(event);
    },
    goTo,
    mount,
    setReadingColors,
    setScale,
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
  defaultProfile?: ReadingProfileId;
  profiles?: Record<string, ReadingProfileId>;
  rememberPerDocument?: boolean;
}) {
  const profiles = { ...options?.profiles };
  const updateProfile = vi.fn((fingerprint: string, profile: ReadingProfileId) => {
    profiles[fingerprint] = profile;
  });
  const value: ReaderProfileState = {
    reading: {
      defaultProfile: options?.defaultProfile ?? 'auto',
      rememberPerDocument: options?.rememberPerDocument ?? false,
      custom: {
        background: '#101820',
        foreground: '#f2f2f2',
        brightness: 1,
        contrast: 1,
        imageDim: 0,
      },
    },
    profileByFingerprint: profiles,
    updateProfileForFingerprint: updateProfile,
  };
  return { profiles, updateProfile, value };
}

function capturingShellFactory() {
  let sendIntent: ((intent: ReaderToolbarIntent) => void) | null = null;
  const createShell: ShellFactory = (host, onIntent) => {
    sendIntent = onIntent;
    return new ReaderShell(host, onIntent);
  };
  return {
    createShell,
    send(intent: ReaderToolbarIntent) {
      if (sendIntent === null) throw new Error('Expected the reader shell to be created.');
      sendIntent(intent);
    },
  };
}

describe('ReaderController', () => {
  it('mounts a session viewport into the shell document region', async () => {
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

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.dark);
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
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.light);
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
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.sepia);
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

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.sepia);
  });

  it('updates Auto for owner-document theme changes without rewriting stored profile state', async () => {
    const [pdf] = files('Books/First.pdf');
    if (pdf === undefined) throw new Error('Expected a PDF fixture.');
    const host = createDiv();
    host.doc.body.removeClass('theme-light');
    host.doc.body.addClass('theme-dark');
    const createdViewport = viewport();
    const createdSession = session(pdf.path, createdViewport);
    const adapter = adapterFor(pdf.path, createdSession);
    const profiles = profileState({
      profiles: { [pdf.path]: 'auto' },
      rememberPerDocument: true,
    });
    const controller = new ReaderController(
      new DocumentAdapterRegistry([adapter.value]),
      undefined,
      profiles.value,
    );
    await controller.open(pdf, host);
    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.dark);

    host.doc.body.removeClass('theme-dark');
    host.doc.body.addClass('theme-light');
    await vi.waitFor(() => {
      expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.light);
    });

    expect(profiles.profiles[pdf.path]).toBe('auto');
    expect(profiles.updateProfile).not.toHaveBeenCalled();
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
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(2, { pageIndex: 2 });
    expect(createdViewport.goTo).toHaveBeenNthCalledWith(3, { pageIndex: 2 });
    expect(createdViewport.setScale).toHaveBeenCalledWith('page-fit');
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

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.dark);
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to remember PDF reading profile', {
      fingerprint: pdf.path,
      profile: 'dark',
      cause,
    });
  });

  it('recovers to Auto when persisted settings contain an unknown profile id', async () => {
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

    expect(createdViewport.setReadingColors).toHaveBeenLastCalledWith(BUILTIN_PROFILES.light);
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
});
