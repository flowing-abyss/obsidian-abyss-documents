import type {
  AnnotationCapability,
  AnnotationIdentity,
  AnnotationMutation,
  AnnotationResolution,
  AnnotationSink,
  StableAnnotationIdentity,
  UtcTimestamp,
  WritableAnnotationType,
} from './annotations.js';
import type { DocumentSession } from './document.js';
import type {
  CapturedGeneration,
  DocumentSaveService as CoreDocumentSaveService,
  DocumentSaveAttempt,
} from './mutation-ledger.js';

export type {
  ActiveDocumentSaveAttempt,
  CapturedGeneration,
  DocumentSaveAttempt,
  VerifiedSaveResult,
} from './mutation-ledger.js';

export interface MutationReceipt {
  readonly generation: number;
  readonly mutation: AnnotationMutation;
  readonly resultingIdentity: StableAnnotationIdentity | null;
  readonly journaledAt: UtcTimestamp;
}

export interface DocumentEditingCapabilities {
  readonly mutation: AnnotationCapability;
  readonly create: Readonly<Record<WritableAnnotationType, AnnotationCapability>>;
}

export interface EditableDocumentSession extends DocumentSession {
  readonly editingCapabilities: DocumentEditingCapabilities;
  listAnnotations(signal: AbortSignal, sink: AnnotationSink): Promise<void>;
  applyMutation(mutation: AnnotationMutation): Promise<MutationReceipt>;
  captureGeneration(): CapturedGeneration;
  prepareSave(captured: CapturedGeneration): DocumentSaveAttempt<EditableDocumentSession>;
  resolveAnnotation(reference: AnnotationIdentity): AnnotationResolution;
}

export type DocumentSaveService = CoreDocumentSaveService<EditableDocumentSession>;
