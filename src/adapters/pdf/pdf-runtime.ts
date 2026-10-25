import type * as PdfjsLibModule from 'pdfjs-dist/legacy/build/pdf.mjs';
import type * as PdfjsViewerModule from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import {
  incrementReaderCounter,
  markReaderPerformance,
  setReaderCounter,
  setReaderPdfjsVersion,
} from '../../reader-performance.js';
import {
  assertPdfRuntimeCompatibility,
  readPdfChromiumVersion,
} from './pdf-runtime-compatibility.js';

const PDFJS_VERSION = '6.4.299';
const PDF_EDITOR_DOCUMENT_METRICS = {
  '--freetext-padding': '2px',
  '--outline-width': '2px',
} as const;

export function installPdfEditorDocumentMetrics(ownerDocument: Document): () => void {
  const root = ownerDocument.documentElement;
  const previous = Object.entries(PDF_EDITOR_DOCUMENT_METRICS).map(([name]) => ({
    name,
    priority: root.style.getPropertyPriority(name),
    value: root.style.getPropertyValue(name),
  }));
  for (const [name, value] of Object.entries(PDF_EDITOR_DOCUMENT_METRICS)) {
    root.style.setProperty(name, value);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const property of previous) {
      if (property.value.length === 0) root.style.removeProperty(property.name);
      else root.style.setProperty(property.name, property.value, property.priority);
    }
  };
}

export const PDFJS_ANNOTATION_EDITOR_TYPE = Object.freeze({
  DISABLE: -1,
  NONE: 0,
  FREETEXT: 3,
  HIGHLIGHT: 9,
  INK: 15,
});

export const PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE = Object.freeze({
  FREETEXT_SIZE: 11,
  FREETEXT_COLOR: 12,
  FREETEXT_OPACITY: 13,
  INK_COLOR: 21,
  INK_THICKNESS: 22,
  INK_OPACITY: 23,
  HIGHLIGHT_COLOR: 31,
  HIGHLIGHT_THICKNESS: 32,
  HIGHLIGHT_FREE: 33,
});

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
  // The legacy core, viewer and worker supply APIs missing from older Electron
  // installers and Android WebViews, even when the Obsidian app is up to date.
  const [{ gunzipSync }, workerPayload, pdfjsLib, pdfjsViewer] = await Promise.all([
    import('fflate'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs?gzip-base64'),
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/web/pdf_viewer.mjs'),
  ]);

  return { gunzipSync, workerPayload, pdfjsLib, pdfjsViewer };
}

export class PdfRuntimeLoader {
  private loadPromise: Promise<PdfRuntime> | null = null;
  private workerUrl: string | null = null;
  private generation = 0;

  constructor(
    private readonly importDependencies: ImportRuntime = importRuntime,
    private readonly readChromiumVersion: () => string | undefined = () =>
      readPdfChromiumVersion(window),
  ) {}

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
    assertPdfRuntimeCompatibility(this.readChromiumVersion());
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
