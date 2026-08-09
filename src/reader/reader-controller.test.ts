import type { TFile } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DocumentAdapterRegistry } from '../document-core/document-adapter.js';
import type {
  DocumentAdapter,
  DocumentSession,
  DocumentViewport,
} from '../document-core/document.js';
import { DocumentOpenError } from '../document-core/errors.js';
import { ReaderController } from './reader-controller.js';

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
  const value: DocumentViewport = {
    pageCount,
    mount,
    goTo: vi.fn(async () => undefined),
    setScale: vi.fn(),
    setReadingColors: vi.fn(),
    search: vi.fn(),
    searchAgain: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    focus: vi.fn(),
    destroy,
  };
  return { destroy, mount, value };
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
});
