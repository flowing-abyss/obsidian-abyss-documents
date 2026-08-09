import type { TFile, Vault } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { DocumentOpenError } from '../../document-core/errors.js';
import { PdfDocumentAdapter } from './pdf-adapter.js';
import type { PdfRuntime, PdfRuntimeLoader } from './pdf-runtime.js';
import type { PdfViewportFactory } from './pdf-session.js';

function file(path: string): TFile {
  const app = App.createConfigured__({ files: { [path]: '' } });
  const source = app.vault.getAbstractFileByPath(path);
  if (!(source instanceof MockTFile)) throw new Error(`Expected a test file at ${path}.`);
  return source.asOriginalType2__();
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function rejectedWith<T>(reason: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    Reflect.apply(reject, undefined, [reason]);
  });
}

function pdf(overrides: Partial<PDFDocumentProxy> = {}): PDFDocumentProxy {
  return {
    fingerprints: ['fingerprint', null],
    numPages: 3,
    getOutline: vi.fn(async () => []),
    getDestination: vi.fn(async () => null),
    getPageIndex: vi.fn(async () => 0),
    getPage: vi.fn(),
    cleanup: vi.fn(async () => undefined),
    loadingTask: { destroy: vi.fn(async () => undefined) },
    ...overrides,
  } as unknown as PDFDocumentProxy;
}

function adapterFixture(options: {
  pdf?: PDFDocumentProxy;
  loadFailure?: unknown;
  loadingPromise?: Promise<PDFDocumentProxy>;
}) {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const vault = { readBinary: vi.fn(async () => bytes) } as unknown as Pick<Vault, 'readBinary'>;
  const destroy = vi.fn(async () => undefined);
  let defaultLoadingPromise: Promise<PDFDocumentProxy>;
  if (options.loadFailure === undefined) {
    defaultLoadingPromise = Promise.resolve(options.pdf ?? pdf());
  } else {
    defaultLoadingPromise = rejectedWith(options.loadFailure);
  }
  const loadingPromise = options.loadingPromise ?? defaultLoadingPromise;
  const getDocument = vi.fn(() => ({ promise: loadingPromise, destroy }));
  const runtime = {
    pdfjsLib: { getDocument },
    pdfjsViewer: {},
    version: '6.2.108',
  } as unknown as PdfRuntime;
  const runtimeLoader = {
    load: vi.fn(async () => runtime),
  } as unknown as Pick<PdfRuntimeLoader, 'load'>;
  const viewportFactory = vi.fn() as unknown as PdfViewportFactory;
  return {
    adapter: new PdfDocumentAdapter(vault, runtimeLoader, viewportFactory),
    bytes,
    destroy,
    getDocument,
    vault,
  };
}

describe('PdfDocumentAdapter', () => {
  it('supports PDF extensions case-insensitively', () => {
    const { adapter } = adapterFixture({});

    expect(adapter.supports(file('Books/Guide.PDF'))).toBe(true);
    expect(adapter.supports(file('Books/Guide.epub'))).toBe(false);
  });

  it('loads PDF bytes through Vault.readBinary and passes them to PDF.js', async () => {
    const fixture = adapterFixture({});
    const source = file('Books/Guide.pdf');

    await fixture.adapter.open(source, AbortSignal.timeout(1_000));

    expect(fixture.vault.readBinary).toHaveBeenCalledWith(source);
    expect(fixture.getDocument).toHaveBeenCalledWith({ data: fixture.bytes });
  });

  it.each([
    [Object.assign(new Error('cancelled'), { name: 'AbortError' }), 'DocumentCancelledError'],
    [
      Object.assign(new Error('password needed'), { name: 'PasswordException', code: 1 }),
      'DocumentPasswordError',
    ],
    [
      Object.assign(new Error('password wrong'), { name: 'PasswordException', code: 2 }),
      'DocumentPasswordError',
    ],
    [
      Object.assign(new Error('bad bytes'), { name: 'InvalidPDFException' }),
      'InvalidDocumentError',
    ],
    [new Error('worker failed'), 'DocumentOpenError'],
  ])('maps %s without collapsing the typed cause', async (cause, expectedName) => {
    const { adapter } = adapterFixture({ loadFailure: cause });

    const opening = adapter.open(file('Guide.pdf'), AbortSignal.timeout(1_000));

    await expect(opening).rejects.toMatchObject({
      name: expectedName,
      path: 'Guide.pdf',
      cause,
    });
  });

  it('maps vault failures to a typed document open error', async () => {
    const fixture = adapterFixture({});
    const cause = new Error('disk read failed');
    fixture.vault.readBinary = vi.fn(async () => {
      throw cause;
    });

    await expect(
      fixture.adapter.open(file('Guide.pdf'), AbortSignal.timeout(1_000)),
    ).rejects.toEqual(expect.objectContaining({ name: 'DocumentOpenError', cause }));
  });

  it('aborts promptly during PDF.js loading and destroys the loading task', async () => {
    const pending = deferred<PDFDocumentProxy>();
    const fixture = adapterFixture({ loadingPromise: pending.promise });
    const controller = new AbortController();

    const opening = fixture.adapter.open(file('Guide.pdf'), controller.signal);
    await vi.waitFor(() => {
      expect(fixture.getDocument).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(opening).rejects.toMatchObject({ name: 'DocumentCancelledError' });
    expect(fixture.destroy).toHaveBeenCalledOnce();
    pending.resolve(pdf());
  });

  it('preserves a non-Error PDF.js loading rejection as the typed cause', async () => {
    const { adapter } = adapterFixture({ loadFailure: 'raw loading rejection' });

    await expect(adapter.open(file('Guide.pdf'), AbortSignal.timeout(1_000))).rejects.toMatchObject(
      { name: 'DocumentOpenError', cause: 'raw loading rejection' },
    );
  });

  it('keeps cancellation primary when destroying an aborted loading task also fails', async () => {
    const pending = deferred<PDFDocumentProxy>();
    const fixture = adapterFixture({ loadingPromise: pending.promise });
    fixture.destroy.mockRejectedValueOnce(new Error('destroy failed'));
    const controller = new AbortController();

    const opening = fixture.adapter.open(file('Guide.pdf'), controller.signal);
    await vi.waitFor(() => {
      expect(fixture.getDocument).toHaveBeenCalledOnce();
    });
    controller.abort('non-error abort reason');

    await expect(opening).rejects.toMatchObject({ name: 'DocumentCancelledError' });
    pending.resolve(pdf());
  });

  it('cancels and destroys loading when abort wins the settlement window', async () => {
    const pending = deferred<PDFDocumentProxy>();
    const fixture = adapterFixture({ loadingPromise: pending.promise });
    const controller = new AbortController();

    const opening = fixture.adapter.open(file('Guide.pdf'), controller.signal);
    await vi.waitFor(() => {
      expect(fixture.getDocument).toHaveBeenCalledOnce();
    });
    pending.resolve(pdf());
    queueMicrotask(() => {
      controller.abort();
    });

    await expect(opening).rejects.toMatchObject({ name: 'DocumentCancelledError' });
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });

  it('rejects an already-aborted open as a typed cancellation', async () => {
    const fixture = adapterFixture({});
    const signal = AbortSignal.abort();

    await expect(fixture.adapter.open(file('Guide.pdf'), signal)).rejects.toMatchObject({
      name: 'DocumentCancelledError',
    });
    expect(fixture.vault.readBinary).not.toHaveBeenCalled();
  });

  it('uses concise retry guidance without exposing the upstream error message', async () => {
    const secret = new Error('secret PDF bytes appeared here');
    const { adapter } = adapterFixture({ loadFailure: secret });

    const opening = adapter.open(file('Guide.pdf'), AbortSignal.timeout(1_000));

    await expect(opening).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof DocumentOpenError &&
        error.message === 'Could not open this PDF. Try again.' &&
        !error.message.includes(secret.message)
      );
    });
  });
});
