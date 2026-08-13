import type { TFile, Vault } from 'obsidian';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type { DocumentAdapter, DocumentSession } from '../../document-core/document.js';
import { incrementReaderCounter, markReaderPerformance } from '../../reader-performance.js';
import {
  loadPdfAnnotationCapabilities,
  type PdfAnnotationCapabilities,
} from './pdf-annotation-capabilities.js';
import { mapPdfOpenFailure } from './pdf-mappers.js';
import type { PdfRuntimeLoader } from './pdf-runtime.js';
import { PdfDocumentSession, type PdfViewportFactory } from './pdf-session.js';

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
      const pdf = await waitForDocument(loadingTask, signal);
      if (signal.aborted) throw abortReason(signal);
      const annotationCapabilities = await waitForAnnotationCapabilities(
        pdf,
        runtime.pdfjsLib.PermissionFlag,
        signal,
      );
      signal.throwIfAborted();
      const session = new PdfDocumentSession(file, pdf, runtime.pdfjsViewer, {
        annotationCapabilities,
        viewportFactory: this.viewportFactory,
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
}
