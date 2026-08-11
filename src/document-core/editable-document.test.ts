import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AnnotationCapability,
  AnnotationIdentity,
  AnnotationMutation,
  AnnotationResolution,
  AnnotationSink,
  StableAnnotationIdentity,
  WritableAnnotationType,
} from './annotations.js';
import type { DocumentSession } from './document.js';
import type {
  ActiveDocumentSaveAttempt,
  CapturedGeneration,
  DocumentEditingCapabilities,
  DocumentSaveAttempt,
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
    expectTypeOf<EditableDocumentSession['prepareSave']>().toEqualTypeOf<
      (captured: CapturedGeneration) => DocumentSaveAttempt<EditableDocumentSession>
    >();
    expectTypeOf<EditableDocumentSession['resolveAnnotation']>().toEqualTypeOf<
      (reference: AnnotationIdentity) => AnnotationResolution
    >();
    expectTypeOf<EditableDocumentSession>().not.toHaveProperty('save');
  });

  it('keeps saving in a separate service that accepts only a validated attempt', () => {
    expectTypeOf<DocumentSaveService['save']>().toEqualTypeOf<
      (
        attempt: ActiveDocumentSaveAttempt<EditableDocumentSession>,
        signal: AbortSignal,
      ) => Promise<VerifiedSaveResult>
    >();
    expectTypeOf<
      ActiveDocumentSaveAttempt<EditableDocumentSession>['session']
    >().toEqualTypeOf<EditableDocumentSession>();
    expectTypeOf<
      ActiveDocumentSaveAttempt<EditableDocumentSession>['path']
    >().toEqualTypeOf<string>();
    expectTypeOf<DocumentSaveAttempt<EditableDocumentSession>>().toHaveProperty('run');
    expectTypeOf<ActiveDocumentSaveAttempt<EditableDocumentSession>>().toHaveProperty(
      'markWriting',
    );
    expectTypeOf<ActiveDocumentSaveAttempt<EditableDocumentSession>>().toHaveProperty(
      'markVerifying',
    );
    expectTypeOf<ActiveDocumentSaveAttempt<EditableDocumentSession>>().toHaveProperty('commit');
    expectTypeOf<ActiveDocumentSaveAttempt<EditableDocumentSession>>().toHaveProperty('fail');
    expectTypeOf<{
      readonly session: EditableDocumentSession;
      readonly path: string;
      readonly captured: CapturedGeneration;
      run(service: DocumentSaveService, signal: AbortSignal): Promise<VerifiedSaveResult>;
    }>().not.toExtend<DocumentSaveAttempt<EditableDocumentSession>>();
  });

  it('exposes structured document and per-type create capabilities before annotations exist', () => {
    const unavailable: AnnotationCapability = {
      available: false,
      reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
    };
    const create: Record<WritableAnnotationType, AnnotationCapability> = {
      highlight: unavailable,
      underline: unavailable,
      ink: unavailable,
      'text-note': unavailable,
      'free-text': unavailable,
    };
    const capabilities: DocumentEditingCapabilities = { mutation: unavailable, create };

    expect(capabilities.mutation).toEqual(unavailable);
    expect(Object.values(capabilities.create)).toEqual([
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      unavailable,
    ]);
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
