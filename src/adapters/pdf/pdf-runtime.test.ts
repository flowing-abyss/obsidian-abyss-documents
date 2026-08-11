import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../../reader-performance.js';
import { PdfRuntimeLoader } from './pdf-runtime.js';

const PDFJS_VERSION = '6.2.108';
const WORKER_PAYLOAD = btoa('compressed worker');
const WORKER_BYTES = new TextEncoder().encode('worker source');

vi.mock('fflate', () => ({ gunzipSync: () => WORKER_BYTES }));
vi.mock('pdfjs-dist/build/pdf.worker.mjs?gzip-base64', () => ({ default: WORKER_PAYLOAD }));
vi.mock('pdfjs-dist/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  version: PDFJS_VERSION,
}));
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({ PDFViewer: class PDFViewer {} }));

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function runtimeDependencies(version = PDFJS_VERSION) {
  return {
    gunzipSync: () => WORKER_BYTES,
    workerPayload: { default: WORKER_PAYLOAD },
    pdfjsLib: {
      GlobalWorkerOptions: { workerSrc: '' },
      version,
    },
    pdfjsViewer: { PDFViewer: class PDFViewer {} },
  };
}

function stubWorkerUrls(): {
  activeUrls: Set<string>;
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  const activeUrls = new Set<string>();
  let sequence = 0;
  const createObjectURL = vi.fn(() => {
    const url = sequence === 0 ? 'blob:pdf-worker' : `blob:pdf-worker-${sequence}`;
    sequence += 1;
    activeUrls.add(url);
    return url;
  });
  const revokeObjectURL = vi.fn((url: string) => activeUrls.delete(url));
  vi.stubGlobal('URL', {
    createObjectURL,
    revokeObjectURL,
  });
  return { activeUrls, createObjectURL, revokeObjectURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PdfRuntimeLoader', () => {
  it('loads the packaged runtime through the default import boundary', async () => {
    const { createObjectURL } = stubWorkerUrls();
    const loader = new PdfRuntimeLoader();

    await expect(loader.load()).resolves.toMatchObject({ version: PDFJS_VERSION });

    expect(createObjectURL).toHaveBeenCalledOnce();
    loader.dispose();
  });

  it('creates one worker URL only on first load and revokes it on dispose', async () => {
    beginPluginActivation();
    endPluginActivation();
    const { createObjectURL, revokeObjectURL } = stubWorkerUrls();
    const importRuntime = vi.fn(async () => runtimeDependencies());
    const loader = new PdfRuntimeLoader(importRuntime);

    expect(createObjectURL).not.toHaveBeenCalled();

    const [left, right] = await Promise.all([loader.load(), loader.load()]);

    expect(left).toBe(right);
    expect(left.version).toBe(PDFJS_VERSION);
    expect(importRuntime).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(readerPerformanceSnapshot().counters).toMatchObject({
      blobsCreated: 1,
      gzipDecodes: 1,
      pdfImports: 1,
      pdfRuntimeLoads: 1,
      workerUrlsActive: 1,
    });

    loader.dispose();
    loader.dispose();

    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-worker');
    expect(readerPerformanceSnapshot().counters.workerUrlsActive).toBe(0);
  });

  it('clears a failed single-flight load so retry can load again', async () => {
    stubWorkerUrls();
    const importRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error('import failed'))
      .mockResolvedValueOnce(runtimeDependencies());
    const loader = new PdfRuntimeLoader(importRuntime);

    await expect(loader.load()).rejects.toThrow('import failed');
    await expect(loader.load()).resolves.toMatchObject({ version: PDFJS_VERSION });

    expect(importRuntime).toHaveBeenCalledTimes(2);
    loader.dispose();
  });

  it('revokes a worker URL created after dispose wins an in-flight race', async () => {
    const { revokeObjectURL } = stubWorkerUrls();
    const imports = deferred<ReturnType<typeof runtimeDependencies>>();
    const loader = new PdfRuntimeLoader(() => imports.promise);

    const loading = loader.load();
    loader.dispose();
    imports.resolve(runtimeDependencies());

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-worker');
  });

  it('rejects when dispose wins after the worker URL is installed but before load settles', async () => {
    const activeUrls = new Set<string>();
    const revokeObjectURL = vi.fn((url: string) => activeUrls.delete(url));
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        activeUrls.add('blob:pdf-worker');
        queueMicrotask(() => {
          loader.dispose();
        });
        return 'blob:pdf-worker';
      }),
      revokeObjectURL,
    });
    const loader = new PdfRuntimeLoader(async () => runtimeDependencies());

    await expect(loader.load()).rejects.toMatchObject({ name: 'AbortError' });

    expect(activeUrls).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-worker');
  });

  it('settles through one guarded stage while preserving an immediate next generation', async () => {
    const catchPromise = vi.spyOn(Promise.prototype, 'catch');
    const activeUrls = new Set<string>();
    const firstImports = deferred<ReturnType<typeof runtimeDependencies>>();
    const secondImports = deferred<ReturnType<typeof runtimeDependencies>>();
    const importRuntime = vi
      .fn()
      .mockReturnValueOnce(firstImports.promise)
      .mockReturnValueOnce(secondImports.promise);
    let sequence = 0;
    const state: { currentLoad?: Promise<unknown> } = {};
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        const workerUrl = `blob:pdf-worker-${sequence}`;
        sequence += 1;
        activeUrls.add(workerUrl);
        if (sequence === 1) {
          queueMicrotask(() => {
            loader.dispose();
            state.currentLoad = loader.load();
          });
        }
        return workerUrl;
      }),
      revokeObjectURL: vi.fn((url: string) => activeUrls.delete(url)),
    });
    const loader = new PdfRuntimeLoader(importRuntime);

    const staleLoad = loader.load();
    expect(catchPromise).not.toHaveBeenCalled();
    firstImports.resolve(runtimeDependencies());

    await expect(staleLoad).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader.load()).toBe(state.currentLoad);
    expect(activeUrls).toHaveLength(0);

    secondImports.resolve(runtimeDependencies());
    await expect(state.currentLoad).resolves.toMatchObject({ version: PDFJS_VERSION });
    expect(activeUrls).toHaveLength(1);
    loader.dispose();
    expect(activeUrls).toHaveLength(0);
  });

  it('does not let a stale failed load erase an immediate reload', async () => {
    const { activeUrls } = stubWorkerUrls();
    const firstImports = deferred<ReturnType<typeof runtimeDependencies>>();
    const secondImports = deferred<ReturnType<typeof runtimeDependencies>>();
    const importRuntime = vi
      .fn()
      .mockReturnValueOnce(firstImports.promise)
      .mockReturnValueOnce(secondImports.promise);
    const loader = new PdfRuntimeLoader(importRuntime);

    const staleLoad = loader.load();
    loader.dispose();
    const currentLoad = loader.load();
    firstImports.reject(new Error('stale import failed'));

    await expect(staleLoad).rejects.toThrow('stale import failed');
    expect(loader.load()).toBe(currentLoad);

    secondImports.resolve(runtimeDependencies());
    await expect(currentLoad).resolves.toMatchObject({ version: PDFJS_VERSION });
    expect(activeUrls).toHaveLength(1);

    loader.dispose();
    expect(activeUrls).toHaveLength(0);
  });

  it('revokes a worker URL when the imported PDF.js version does not match', async () => {
    const { activeUrls, revokeObjectURL } = stubWorkerUrls();
    const loader = new PdfRuntimeLoader(async () => runtimeDependencies('6.2.109'));

    await expect(loader.load()).rejects.toThrow('Unexpected PDF.js 6.2.109');

    expect(activeUrls).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-worker');
  });
});
