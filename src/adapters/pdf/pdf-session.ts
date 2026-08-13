import type { TFile } from 'obsidian';
import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type {
  DocumentCapability,
  DocumentDescriptor,
  DocumentSession,
  DocumentViewport,
  OutlineItem,
} from '../../document-core/document.js';
import type { DocumentEditingCapabilities } from '../../document-core/editable-document.js';
import { DocumentCancelledError, DocumentOpenError } from '../../document-core/errors.js';
import type { PdfAnnotationCapabilities } from './pdf-annotation-capabilities.js';
import { isPdfAbortFailure, mapPdfOutline } from './pdf-mappers.js';
import type { PdfRuntime } from './pdf-runtime.js';
import { PdfTextSearch } from './pdf-text-search.js';

const PDF_READ_CAPABILITIES: readonly DocumentCapability[] = [
  'outline',
  'text-search',
  'existing-annotations',
];

export type PdfViewportFactory = (
  pdf: PDFDocumentProxy,
  pdfjsViewer: PdfRuntime['pdfjsViewer'],
  textSearch: PdfTextSearch,
  annotationCapabilities: PdfAnnotationCapabilities,
) => DocumentViewport | Promise<DocumentViewport>;

interface PdfSessionAnnotationAccess {
  readonly annotationCapabilities: PdfAnnotationCapabilities;
  readonly viewportFactory: PdfViewportFactory;
}

export class PdfDocumentSession implements DocumentSession {
  readonly descriptor: DocumentDescriptor;
  readonly capabilities: ReadonlySet<DocumentCapability>;
  readonly annotationCapabilities: PdfAnnotationCapabilities;
  readonly editingCapabilities: DocumentEditingCapabilities;

  private closePromise: Promise<void> | null = null;
  private search: PdfTextSearch | null = null;

  constructor(
    private readonly file: TFile,
    private readonly pdf: PDFDocumentProxy,
    private readonly pdfjsViewer: PdfRuntime['pdfjsViewer'],
    private readonly annotationAccess: PdfSessionAnnotationAccess,
  ) {
    this.descriptor = Object.freeze({
      path: file.path,
      name: file.name,
      fingerprint: pdf.fingerprints[0] ?? file.path,
      pageCount: pdf.numPages,
    });
    this.capabilities = new Set([
      ...PDF_READ_CAPABILITIES,
      ...(annotationAccess.annotationCapabilities.readOnlyReason === null
        ? (['annotation-write'] as const)
        : []),
    ]);
    this.annotationCapabilities = annotationAccess.annotationCapabilities;
    this.editingCapabilities = annotationAccess.annotationCapabilities.editing;
  }

  async getOutline(): Promise<readonly OutlineItem[]> {
    this.assertOpen();
    try {
      const outline = await this.pdf.getOutline();
      this.assertOpen();
      const mapped = await mapPdfOutline(this.pdf, outline);
      this.assertOpen();
      return mapped;
    } catch (cause) {
      if (cause instanceof DocumentOpenError) throw cause;
      if (isPdfAbortFailure(cause)) {
        throw new DocumentCancelledError(
          this.file.path,
          'Reading this PDF outline was cancelled.',
          cause,
        );
      }
      throw new DocumentOpenError(
        this.file.path,
        'Could not read this PDF outline. Try again.',
        cause,
      );
    }
  }

  async createViewport(): Promise<DocumentViewport> {
    this.assertOpen();
    this.search ??= new PdfTextSearch(this.pdf);
    let viewport: DocumentViewport;
    try {
      viewport = await this.annotationAccess.viewportFactory(
        this.pdf,
        this.pdfjsViewer,
        this.search,
        this.annotationCapabilities,
      );
    } catch (cause) {
      if (this.closePromise !== null) throw this.cancelled(cause);
      if (cause instanceof DocumentOpenError) throw cause;
      if (isPdfAbortFailure(cause)) {
        throw new DocumentCancelledError(
          this.file.path,
          'Creating this PDF view was cancelled.',
          cause,
        );
      }
      throw new DocumentOpenError(
        this.file.path,
        'Could not create this PDF view. Try reopening the document.',
        cause,
      );
    }
    if (this.closePromise !== null) {
      let destroyFailure: unknown;
      try {
        await viewport.destroy();
      } catch (cause) {
        destroyFailure = cause;
      }
      throw this.cancelled(destroyFailure);
    }
    return viewport;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.search?.dispose();
    this.search = null;

    let failure: unknown;
    try {
      await this.pdf.cleanup();
    } catch (cause) {
      failure = cause;
    }
    try {
      await this.pdf.loadingTask.destroy();
    } catch (cause) {
      failure ??= cause;
    }
    if (failure !== undefined) {
      throw new DocumentOpenError(
        this.file.path,
        'Could not close this PDF cleanly. Restart Obsidian before reopening it.',
        failure,
      );
    }
  }

  private assertOpen(): void {
    if (this.closePromise !== null) throw this.cancelled();
  }

  private cancelled(cause?: unknown): DocumentCancelledError {
    return new DocumentCancelledError(
      this.file.path,
      'This PDF session is already closed. Open the document again.',
      cause,
    );
  }
}
