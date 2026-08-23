import type { TFile, Vault } from 'obsidian';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type { DocumentAdapter, DocumentSession } from '../../document-core/document.js';
import { incrementReaderCounter, markReaderPerformance } from '../../reader-performance.js';
import type { AnnotationLinkSuggestionProvider } from '../../reader/link-suggestions.js';
import {
  loadPdfAnnotationCapabilities,
  type PdfAnnotationCapabilities,
} from './pdf-annotation-capabilities.js';
import { mapPdfOpenFailure } from './pdf-mappers.js';
import type { PdfRuntimeLoader } from './pdf-runtime.js';
import { PdfDocumentSession, type PdfViewportFactory } from './pdf-session.js';
import { baseTokenFor } from './pdf-write-boundary.js';

class PdfLoadingRejection extends Error {
  constructor(readonly original: unknown) {
    super('PDF.js rejected the loading task.');
  }
}

class PdfCapabilityRejection extends Error {
  constructor(readonly original: unknown) {
    super('PDF.js rejected annotation capability resolution.');
  }
}

function loadingTaskAbort(signal: AbortSignal, reject: (reason: Error) => void): () => void {
  return () => {
    reject(abortReason(signal));
  };
}

function waitForDocument(
  loadingTask: PDFDocumentLoadingTask,
  signal: AbortSignal,
): Promise<PDFDocumentProxy> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<PDFDocumentProxy>((resolve, reject) => {
    const abort = loadingTaskAbort(signal, reject);
    signal.addEventListener('abort', abort, { once: true });
    loadingTask.promise.then(
      (pdf) => {
        signal.removeEventListener('abort', abort);
        resolve(pdf);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(cause instanceof Error ? cause : new PdfLoadingRejection(cause));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Opening this PDF was cancelled.', 'AbortError');
}

function waitForAnnotationCapabilities(
  pdf: PDFDocumentProxy,
  permissionFlags: Parameters<typeof loadPdfAnnotationCapabilities>[1],
  signal: AbortSignal,
): Promise<PdfAnnotationCapabilities> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const loading = loadPdfAnnotationCapabilities(pdf, permissionFlags);
  return new Promise<PdfAnnotationCapabilities>((resolve, reject) => {
    const abort = loadingTaskAbort(signal, reject);
    signal.addEventListener('abort', abort, { once: true });
    loading.then(
      (capabilities) => {
        signal.removeEventListener('abort', abort);
        resolve(capabilities);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(cause instanceof Error ? cause : new PdfCapabilityRejection(cause));
      },
    );
  });
}

export class PdfDocumentAdapter implements DocumentAdapter {
  readonly id = 'pdf';

  constructor(
    private readonly vault: Pick<Vault, 'readBinary'>,
    private readonly runtimeLoader: Pick<PdfRuntimeLoader, 'load'>,
    private readonly viewportFactory: PdfViewportFactory,
    private readonly linkSuggestions?: AnnotationLinkSuggestionProvider,
  ) {}

  supports(file: TFile): boolean {
    return file.extension.toLocaleLowerCase() === 'pdf';
  }

  async open(file: TFile, signal: AbortSignal): Promise<DocumentSession> {
    let ownedLoadingTask: PDFDocumentLoadingTask | null = null;
    try {
      signal.throwIfAborted();
      const runtime = await this.runtimeLoader.load();
      signal.throwIfAborted();
      const bytes = await this.vault.readBinary(file);
      signal.throwIfAborted();
      incrementReaderCounter('workersStarted');
      markReaderPerformance('worker-start');
      const loadingTask = runtime.pdfjsLib.getDocument({ data: bytes });
      ownedLoadingTask = loadingTask;
      const [baseToken, pdf] = await Promise.all([
        baseTokenFor(new Uint8Array(bytes), file.stat.mtime),
        waitForDocument(loadingTask, signal),
      ]);
      if (signal.aborted) throw abortReason(signal);
      const annotationCapabilities = await waitForAnnotationCapabilities(
        pdf,
        runtime.pdfjsLib.PermissionFlag,
        signal,
      );
      signal.throwIfAborted();
      const session = new PdfDocumentSession(file, pdf, runtime.pdfjsViewer, {
        annotationCapabilities,
        openedBaseToken: baseToken,
        viewportFactory: this.viewportFactory,
        ...(this.linkSuggestions === undefined ? {} : { linkSuggestions: this.linkSuggestions }),
      });
      signal.throwIfAborted();
      ownedLoadingTask = null;
      return session;
    } catch (cause) {
      if (ownedLoadingTask !== null) {
        try {
          await ownedLoadingTask.destroy();
        } catch {
          // The open/cancellation failure remains primary at this boundary.
        }
      }
      const originalCause =
        cause instanceof PdfLoadingRejection || cause instanceof PdfCapabilityRejection
          ? cause.original
          : cause;
      throw mapPdfOpenFailure(file.path, originalCause, signal);
    }
  }

  async verifySavedBytes(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const runtime = await this.runtimeLoader.load();
    signal.throwIfAborted();
    const loadingTask = runtime.pdfjsLib.getDocument({ data: bytes });
    let pdf: PDFDocumentProxy | null = null;
    let primaryFailure: unknown;
    try {
      pdf = await waitForDocument(loadingTask, signal);
      signal.throwIfAborted();
      await pdf.getDownloadInfo();
      signal.throwIfAborted();
    } catch (cause) {
      primaryFailure = cause;
    }
    let cleanupFailure: unknown;
    if (pdf !== null) {
      try {
        await pdf.cleanup();
      } catch (cause) {
        cleanupFailure = cause;
      }
    }
    let destroyFailure: unknown;
    try {
      await loadingTask.destroy();
    } catch (cause) {
      destroyFailure = cause;
    }
    if (primaryFailure !== undefined) throw asError(primaryFailure, 'PDF verification failed.');
    if (cleanupFailure !== undefined) throw asError(cleanupFailure, 'PDF cleanup failed.');
    if (destroyFailure !== undefined)
      throw asError(destroyFailure, 'PDF loading task cleanup failed.');
  }
}

function asError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error) return cause;
  const error = new Error(fallback);
  Object.defineProperty(error, 'cause', { value: cause });
  return error;
}
