import type {
  AnnotationIdentity,
  AnnotationMutation,
  AnnotationResolution,
  AnnotationSink,
  StableAnnotationIdentity,
  UtcTimestamp,
} from './annotations.js';
import type { DocumentSession } from './document.js';

export interface CapturedGeneration {
  readonly captureId: number;
  readonly generation: number;
  readonly mutations: readonly AnnotationMutation[];
}

export interface MutationReceipt {
  readonly generation: number;
  readonly mutation: AnnotationMutation;
  readonly resultingIdentity: StableAnnotationIdentity | null;
  readonly journaledAt: UtcTimestamp;
}

export interface VerifiedSaveResult {
  readonly verified: true;
  readonly generation: number;
  readonly sha256: string;
  readonly byteSize: number;
  readonly committedAt: UtcTimestamp;
}

export interface EditableDocumentSession extends DocumentSession {
  listAnnotations(signal: AbortSignal, sink: AnnotationSink): Promise<void>;
  applyMutation(mutation: AnnotationMutation): Promise<MutationReceipt>;
  captureGeneration(): CapturedGeneration;
  resolveAnnotation(reference: AnnotationIdentity): AnnotationResolution;
}

export interface DocumentSaveService {
  save(
    session: EditableDocumentSession,
    captured: CapturedGeneration,
    signal: AbortSignal,
  ): Promise<VerifiedSaveResult>;
}
