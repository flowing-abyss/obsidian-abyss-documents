import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AnnotationIdentity,
  AnnotationMutation,
  AnnotationResolution,
  AnnotationSink,
  StableAnnotationIdentity,
} from './annotations.js';
import type { DocumentSession } from './document.js';
import type {
  CapturedGeneration,
  DocumentSaveService,
  EditableDocumentSession,
  MutationReceipt,
  VerifiedSaveResult,
} from './editable-document.js';
import { DocumentOperationCancelledError } from './errors.js';

describe('EditableDocumentSession contract', () => {
  it('extends reading without owning vault persistence', () => {
    expectTypeOf<EditableDocumentSession>().toExtend<DocumentSession>();
    expectTypeOf<EditableDocumentSession['listAnnotations']>().toEqualTypeOf<
      (signal: AbortSignal, sink: AnnotationSink) => Promise<void>
    >();
    expectTypeOf<EditableDocumentSession['applyMutation']>().toEqualTypeOf<
      (mutation: AnnotationMutation) => Promise<MutationReceipt>
    >();
    expectTypeOf<EditableDocumentSession['captureGeneration']>().toEqualTypeOf<
      () => CapturedGeneration
    >();
    expectTypeOf<EditableDocumentSession['resolveAnnotation']>().toEqualTypeOf<
      (reference: AnnotationIdentity) => AnnotationResolution
    >();
    expectTypeOf<EditableDocumentSession>().not.toHaveProperty('save');
  });

  it('keeps saving in a separate service that requires a captured generation and cancellation', () => {
    expectTypeOf<DocumentSaveService['save']>().toEqualTypeOf<
      (
        session: EditableDocumentSession,
        captured: CapturedGeneration,
        signal: AbortSignal,
      ) => Promise<VerifiedSaveResult>
    >();
  });

  it('acknowledges the stable identity produced by durable journaling', () => {
    expectTypeOf<MutationReceipt>().toHaveProperty('resultingIdentity');
    expectTypeOf<
      MutationReceipt['resultingIdentity']
    >().toEqualTypeOf<StableAnnotationIdentity | null>();
  });

  it('uses a structured cancellation error for non-open document operations', () => {
    const cause = new DOMException('Stopped', 'AbortError');
    const error = new DocumentOperationCancelledError(
      'list-annotations',
      'Research/paper.pdf',
      cause,
    );

    expect(error).toMatchObject({
      name: 'DocumentOperationCancelledError',
      operation: 'list-annotations',
      path: 'Research/paper.pdf',
      cause,
    });
    expect(error.message).toContain('list annotations');
  });
});
