import type { TFile, Vault } from 'obsidian';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type { DocumentAdapter, DocumentSession } from '../../document-core/document.js';
import { mapPdfOpenFailure } from './pdf-mappers.js';
import type { PdfRuntimeLoader } from './pdf-runtime.js';
import { PdfDocumentSession, type PdfViewportFactory } from './pdf-session.js';

class PdfLoadingRejection extends Error {
  constructor(readonly original: unknown) {
    super('PDF.js rejected the loading task.');
  }
}

function waitForDocument(
  loadingTask: PDFDocumentLoadingTask,
  signal: AbortSignal,
): Promise<PDFDocumentProxy> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<PDFDocumentProxy>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      void loadingTask.destroy().catch(() => undefined);
      reject(abortReason(signal));
    };
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
    try {
      signal.throwIfAborted();
      const runtime = await this.runtimeLoader.load();
      signal.throwIfAborted();
      const bytes = await this.vault.readBinary(file);
      signal.throwIfAborted();
      const loadingTask = runtime.pdfjsLib.getDocument({ data: bytes });
      const pdf = await waitForDocument(loadingTask, signal);
      if (signal.aborted) {
        void loadingTask.destroy().catch(() => undefined);
        throw abortReason(signal);
      }
      return new PdfDocumentSession(file, pdf, runtime.pdfjsViewer, this.viewportFactory);
    } catch (cause) {
      const originalCause = cause instanceof PdfLoadingRejection ? cause.original : cause;
      throw mapPdfOpenFailure(file.path, originalCause, signal);
    }
  }
}
