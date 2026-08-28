import type { TFile } from 'obsidian';
import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type { AnnotationSink } from '../../document-core/annotations.js';
import type {
  DocumentCapability,
  DocumentDescriptor,
  DocumentSession,
  DocumentViewport,
  OutlineItem,
} from '../../document-core/document.js';
import type { DocumentEditingCapabilities } from '../../document-core/editable-document.js';
import { DocumentCancelledError, DocumentOpenError } from '../../document-core/errors.js';
import type { BaseToken, NativeEditableSaveSession } from '../../document-core/save-coordinator.js';
import type { PdfAnnotationCapabilities } from './pdf-annotation-capabilities.js';
import type { PdfAnnotationEditor } from './pdf-annotation-editor.js';
import { extractAnnotations } from './pdf-annotations.js';
import { PdfEditableSession } from './pdf-editable-session.js';
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
  context: PdfViewportContext,
) => DocumentViewport | Promise<DocumentViewport>;

export interface PdfViewportContext {
  readonly annotationCapabilities: PdfAnnotationCapabilities;
  readonly sourcePath: string;
}

interface PdfSessionAnnotationAccess {
  readonly annotationCapabilities: PdfAnnotationCapabilities;
  readonly viewportFactory: PdfViewportFactory;
  readonly openedBaseToken?: BaseToken | null;
}

export class PdfDocumentSession implements DocumentSession {
  readonly descriptor: DocumentDescriptor;
  readonly capabilities: ReadonlySet<DocumentCapability>;
  readonly annotationCapabilities: PdfAnnotationCapabilities;
  readonly editingCapabilities: DocumentEditingCapabilities;

  private closePromise: Promise<void> | null = null;
  private search: PdfTextSearch | null = null;
  private editableSession: PdfEditableSession | null = null;
  private createdViewport: DocumentViewport | null = null;

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

  async listAnnotations(signal: AbortSignal, sink: AnnotationSink): Promise<void> {
    this.assertOpen();
    try {
      await extractAnnotations(this.pdf, signal, sink, (pageNumber, cause) => {
        console.error('[abyss-documents] Could not read PDF annotations', { pageNumber, cause });
      });
      this.assertOpen();
    } catch (cause) {
      if (signal.aborted || isPdfAbortFailure(cause)) {
        throw new DocumentCancelledError(
          this.file.path,
          'Reading PDF annotations was cancelled.',
          cause,
        );
      }
      if (cause instanceof DocumentOpenError) throw cause;
      throw new DocumentOpenError(
        this.file.path,
        'Could not read annotations from this PDF. Try reopening it.',
        cause,
      );
    }
  }

  async createViewport(): Promise<DocumentViewport> {
    this.assertOpen();
    this.search ??= new PdfTextSearch(this.pdf);
    let viewport: DocumentViewport;
    try {
      const context = this.viewportContext();
      viewport = await this.annotationAccess.viewportFactory(
        this.pdf,
        this.pdfjsViewer,
        this.search,
        context,
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
    this.createdViewport = viewport;
    return viewport;
  }

  private viewportContext(): PdfViewportContext {
    return {
      annotationCapabilities: this.annotationCapabilities,
      sourcePath: this.descriptor.path,
    };
  }

  createNativeEditableSession(
    onRevision: (revision: number) => void,
  ): NativeEditableSaveSession | null {
    if (this.editableSession !== null) return this.editableSession;
    const openedBaseToken = this.annotationAccess.openedBaseToken ?? null;
    if (openedBaseToken === null || this.createdViewport === null) return null;
    const editor = annotationEditorOf(this.createdViewport);
    if (editor === null) return null;
    this.editableSession = new PdfEditableSession(
      this.descriptor.path,
      openedBaseToken,
      editor,
      onRevision,
    );
    return this.editableSession;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.editableSession?.destroy();
    this.editableSession = null;
    this.createdViewport = null;
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

function annotationEditorOf(viewport: DocumentViewport): PdfAnnotationEditor | null {
  const candidate = viewport as DocumentViewport & { readonly annotationEditor?: unknown };
  const editor = candidate.annotationEditor as Partial<PdfAnnotationEditor> | null | undefined;
  return typeof editor?.save === 'function' && typeof editor.onDirty === 'function'
    ? (editor as PdfAnnotationEditor)
    : null;
}
