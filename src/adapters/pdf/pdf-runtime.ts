import type * as PdfjsLibModule from 'pdfjs-dist/build/pdf.mjs';
import type * as PdfjsViewerModule from 'pdfjs-dist/web/pdf_viewer.mjs';
import {
  incrementReaderCounter,
  markReaderPerformance,
  setReaderCounter,
  setReaderPdfjsVersion,
} from '../../reader-performance.js';

const PDFJS_VERSION = '6.2.108';

type PdfjsLib = typeof PdfjsLibModule;
type PdfjsViewer = typeof PdfjsViewerModule;

export interface PdfRuntime {
  pdfjsLib: PdfjsLib;
  pdfjsViewer: PdfjsViewer;
  version: string;
}

interface RuntimeDependencies {
  gunzipSync: (data: Uint8Array) => Uint8Array;
  workerPayload: { default: string };
  pdfjsLib: {
    GlobalWorkerOptions: { workerSrc: string };
    version: string;
  };
  pdfjsViewer: unknown;
}

type ImportRuntime = () => Promise<RuntimeDependencies>;

async function importRuntime(): Promise<RuntimeDependencies> {
  const [{ gunzipSync }, workerPayload, pdfjsLib, pdfjsViewer] = await Promise.all([
    import('fflate'),
    import('pdfjs-dist/build/pdf.worker.mjs?gzip-base64'),
    import('pdfjs-dist/build/pdf.mjs'),
    import('pdfjs-dist/web/pdf_viewer.mjs'),
  ]);

  return { gunzipSync, workerPayload, pdfjsLib, pdfjsViewer };
}

export class PdfRuntimeLoader {
  private loadPromise: Promise<PdfRuntime> | null = null;
  private workerUrl: string | null = null;
  private generation = 0;

  constructor(private readonly importDependencies: ImportRuntime = importRuntime) {}

  load(): Promise<PdfRuntime> {
    if (this.loadPromise !== null) return this.loadPromise;
    incrementReaderCounter('pdfRuntimeLoads');

    const generation = this.generation;
    const pending = this.loadOnce();
    const guarded = pending.then(
      (runtime) => {
        if (generation !== this.generation) throw new DOMException('Disposed', 'AbortError');
        return runtime;
      },
      (error: unknown) => {
        if (this.loadPromise === guarded) this.loadPromise = null;
        throw error;
      },
    );
    this.loadPromise = guarded;
    return guarded;
  }

  dispose(): void {
    this.generation += 1;
    if (this.workerUrl !== null) this.revokeWorkerUrl(this.workerUrl);
    this.loadPromise = null;
  }

  private async loadOnce(): Promise<PdfRuntime> {
    const generation = this.generation;
    incrementReaderCounter('pdfImports');
    markReaderPerformance('pdf-imports-start');
    const { gunzipSync, workerPayload, pdfjsLib, pdfjsViewer } = await this.importDependencies();
    markReaderPerformance('pdf-imports-end');
    const compressed = Uint8Array.from(atob(workerPayload.default), (character) =>
      character.charCodeAt(0),
    );
    incrementReaderCounter('gzipDecodes');
    markReaderPerformance('gzip-decode-start');
    const workerSource = gunzipSync(compressed);
    markReaderPerformance('gzip-decode-end');
    const workerBytes = workerSource.slice().buffer;
    const workerUrl = URL.createObjectURL(new Blob([workerBytes], { type: 'text/javascript' }));
    incrementReaderCounter('blobsCreated');
    markReaderPerformance('blob-created');

    try {
      if (generation !== this.generation) throw new DOMException('Disposed', 'AbortError');
      if (pdfjsLib.version !== PDFJS_VERSION) {
        throw new Error(`Unexpected PDF.js ${pdfjsLib.version}`);
      }
      this.workerUrl = workerUrl;
      setReaderCounter('workerUrlsActive', 1);
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      setReaderPdfjsVersion(pdfjsLib.version);
      return {
        pdfjsLib: pdfjsLib as PdfjsLib,
        pdfjsViewer: pdfjsViewer as PdfjsViewer,
        version: pdfjsLib.version,
      };
    } catch (error) {
      this.revokeWorkerUrl(workerUrl);
      throw error;
    }
  }

  private revokeWorkerUrl(workerUrl: string): void {
    URL.revokeObjectURL(workerUrl);
    markReaderPerformance('worker-revoked');
    if (this.workerUrl === workerUrl) {
      this.workerUrl = null;
      setReaderCounter('workerUrlsActive', 0);
    }
  }
}
