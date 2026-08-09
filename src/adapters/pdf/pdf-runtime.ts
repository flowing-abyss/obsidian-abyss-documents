import type * as PdfjsLibModule from 'pdfjs-dist/build/pdf.mjs';
import type * as PdfjsViewerModule from 'pdfjs-dist/web/pdf_viewer.mjs';

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

    const pending = this.loadOnce();
    const guarded = pending.catch((error: unknown) => {
      if (this.loadPromise === guarded) this.loadPromise = null;
      throw error;
    });
    this.loadPromise = guarded;
    return guarded;
  }

  dispose(): void {
    this.generation += 1;
    if (this.workerUrl !== null) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    this.loadPromise = null;
  }

  private async loadOnce(): Promise<PdfRuntime> {
    const generation = this.generation;
    const { gunzipSync, workerPayload, pdfjsLib, pdfjsViewer } = await this.importDependencies();
    const compressed = Uint8Array.from(atob(workerPayload.default), (character) =>
      character.charCodeAt(0),
    );
    const workerSource = gunzipSync(compressed);
    const workerBytes = workerSource.slice().buffer;
    const workerUrl = URL.createObjectURL(new Blob([workerBytes], { type: 'text/javascript' }));

    try {
      if (generation !== this.generation) throw new DOMException('Disposed', 'AbortError');
      if (pdfjsLib.version !== PDFJS_VERSION) {
        throw new Error(`Unexpected PDF.js ${pdfjsLib.version}`);
      }
      this.workerUrl = workerUrl;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return {
        pdfjsLib: pdfjsLib as PdfjsLib,
        pdfjsViewer: pdfjsViewer as PdfjsViewer,
        version: pdfjsLib.version,
      };
    } catch (error) {
      URL.revokeObjectURL(workerUrl);
      throw error;
    }
  }
}
