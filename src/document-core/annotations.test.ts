import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  asAnnotationId,
  asGeneratedAnnotationId,
  asUtcTimestamp,
  canConvertAnnotation,
  resolveAnnotationReference,
  type AnnotationAnchor,
  type AnnotationCapabilities,
  type AnnotationExportRecord,
  type AnnotationFilter,
  type AnnotationGeometry,
  type AnnotationId,
  type AnnotationMetadataPatch,
  type AnnotationMutation,
  type AnnotationPoint,
  type AnnotationQuadrilateral,
  type AnnotationRectangle,
  type AnnotationType,
  type AnnotationUnavailableCode,
  type AnnotationUnavailableReason,
  type ConvertibleAnnotationType,
  type DocumentAnnotation,
  type GeneratedAnnotationId,
  type LegacyAnnotationIdentity,
  type WritableAnnotationType,
} from './annotations.js';

const editable: AnnotationCapabilities = {
  geometry: { available: true },
  comment: { available: true },
  color: { available: true },
  deletion: { available: true },
  metadata: { available: true },
  conversions: {
    highlight: {
      available: false,
      reason: { code: 'lossy-conversion', message: 'The annotation is already a highlight.' },
    },
    underline: { available: true },
  },
};

const fixedAnchor: AnnotationAnchor = {
  kind: 'fixed-page',
  pageIndex: 2,
  coordinateSpace: 'page-points-top-left',
  geometry: {
    kind: 'quadrilaterals',
    quadrilaterals: [
      {
        bottomLeft: { x: 10, y: 40 },
        bottomRight: { x: 30, y: 40 },
        topLeft: { x: 10, y: 20 },
        topRight: { x: 30, y: 20 },
      },
    ],
  },
};

function annotation(
  id: string,
  identity: DocumentAnnotation['identity'] = { kind: 'stable', id: asAnnotationId(id) },
): DocumentAnnotation {
  return {
    identity,
    type: 'highlight',
    anchor: fixedAnchor,
    color: '#ffd400',
    selectedText: 'Key idea',
    author: '',
    createdAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
    modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
    comment: 'See [[Concept]] #important',
    tags: ['important'],
    links: ['Concept'],
    capabilities: editable,
  };
}

describe('annotation identity', () => {
  it('accepts existing non-empty standard ids but requires UUIDs for generated ids', () => {
    expect(asAnnotationId('foreign-viewer-id')).toBe('foreign-viewer-id');
    expect(asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08')).toBe(
      '01918f62-5c0b-7cc3-98ad-6f126f164f08',
    );
    expect(() => asGeneratedAnnotationId('foreign-viewer-id')).toThrow(/UUID/u);
    expect(() => asAnnotationId('   ')).toThrow(/empty/u);
  });

  it('rejects coercible objects before identity or timestamp normalization', () => {
    const uuidObject = {
      toString: () => '01918f62-5c0b-7cc3-98ad-6f126f164f08',
    } as unknown as string;
    const stableObject = { trim: () => 'foreign-viewer-id' } as unknown as string;
    const timestampObject = {
      toString: () => '2026-08-11T10:00:00.000Z',
    } as unknown as string;

    expect(() => asAnnotationId(stableObject)).toThrow(/string/u);
    expect(() => asGeneratedAnnotationId(uuidObject)).toThrow(/string/u);
    expect(() => asUtcTimestamp(timestampObject)).toThrow(/string/u);
  });

  it('keeps generated ids stricter than foreign standard ids', () => {
    const foreign = asAnnotationId('foreign-viewer-id');
    const generated = asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08');

    expectTypeOf(generated).toExtend<AnnotationId>();
    expectTypeOf(foreign).not.toExtend<GeneratedAnnotationId>();
  });

  it('constrains new annotations to generated ids and writable types', () => {
    type CreateMutation = Extract<AnnotationMutation, { readonly kind: 'create' }>;

    expectTypeOf<CreateMutation['id']>().toEqualTypeOf<GeneratedAnnotationId>();
    expectTypeOf<CreateMutation['type']>().toEqualTypeOf<WritableAnnotationType>();
    expectTypeOf<WritableAnnotationType>().toEqualTypeOf<'highlight' | 'ink' | 'free-text'>();
  });

  it('requires explicit normalized UTC timestamps', () => {
    expect(asUtcTimestamp('2026-08-11T10:00:00.000Z')).toBe('2026-08-11T10:00:00.000Z');
    expect(() => asUtcTimestamp('2026-08-11T17:00:00+07:00')).toThrow(/UTC/u);
    expect(() => asUtcTimestamp('not-a-date')).toThrow(/UTC/u);
  });

  it('resolves a unique standard id without choosing between external duplicates', () => {
    const first = annotation('shared-id');
    const duplicate = annotation('shared-id');

    expect(
      resolveAnnotationReference({ kind: 'stable', id: asAnnotationId('shared-id') }, [first]),
    ).toEqual({ status: 'resolved', annotation: first });
    expect(
      resolveAnnotationReference({ kind: 'stable', id: asAnnotationId('shared-id') }, [
        first,
        duplicate,
      ]),
    ).toEqual({
      status: 'conflict',
      reason: 'duplicate-identity',
      candidates: [first, duplicate],
    });
  });

  it('reports an externally deleted standard id as unresolved', () => {
    expect(
      resolveAnnotationReference({ kind: 'stable', id: asAnnotationId('removed-id') }, []),
    ).toEqual({
      status: 'unresolved',
      reason: 'external-delete',
      reference: { kind: 'stable', id: 'removed-id' },
    });
  });

  it('uses a deterministic legacy fingerprint only as a fallback lookup key', () => {
    const legacy = annotation('legacy:page-2:quad-10-20', {
      kind: 'legacy',
      fingerprint: 'page-2:quad-10-20',
    });

    expect(
      resolveAnnotationReference({ kind: 'legacy', fingerprint: 'page-2:quad-10-20' }, [legacy]),
    ).toEqual({ status: 'resolved', annotation: legacy });
  });
});

describe('annotation capabilities', () => {
  it('offers only explicitly lossless conversions', () => {
    expect(canConvertAnnotation(editable, 'underline')).toEqual({ available: true });
    expect(canConvertAnnotation(editable, 'ink')).toEqual({
      available: false,
      reason: {
        code: 'lossy-conversion',
        message: 'Converting this annotation to ink would lose information.',
      },
    });
  });

  it('preserves a structured document-level unavailable reason', () => {
    const signed: AnnotationCapabilities = {
      geometry: {
        available: false,
        reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
      },
      comment: {
        available: false,
        reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
      },
      color: {
        available: false,
        reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
      },
      deletion: {
        available: false,
        reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
      },
      metadata: {
        available: false,
        reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
      },
      conversions: {
        highlight: {
          available: false,
          reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
        },
        underline: {
          available: false,
          reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
        },
      },
    };

    expect(signed.comment).toEqual({
      available: false,
      reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
    });
    expect(canConvertAnnotation(signed, 'underline')).toEqual({
      available: false,
      reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
    });
  });

  it('returns a deeply frozen conversion result isolated from adapter-owned capability data', () => {
    const reason = {
      code: 'signed-document' as const,
      message: 'Editing would invalidate a signature.',
    };
    const capabilities: AnnotationCapabilities = {
      ...editable,
      conversions: {
        ...editable.conversions,
        underline: { available: false, reason },
      },
    };

    const result = canConvertAnnotation(capabilities, 'underline');
    reason.message = 'Changed by the adapter';

    expect(result).toEqual({
      available: false,
      reason: { code: 'signed-document', message: 'Editing would invalidate a signature.' },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.available) {
      expect(Object.isFrozen(result.reason)).toBe(true);
    }
  });
});

describe('format-neutral anchors', () => {
  it('makes fixed-page coordinate semantics explicit', () => {
    expect(fixedAnchor).toMatchObject({
      kind: 'fixed-page',
      pageIndex: 2,
      coordinateSpace: 'page-points-top-left',
    });
  });

  it('represents a reflowable selection without page coordinates', () => {
    const anchor: AnnotationAnchor = {
      kind: 'reflowable-text',
      selector: {
        exact: 'A text range that survives font changes',
        prefix: 'Before ',
        suffix: ' after',
      },
      progression: 0.42,
    };

    expect(anchor).toEqual({
      kind: 'reflowable-text',
      selector: {
        exact: 'A text range that survives font changes',
        prefix: 'Before ',
        suffix: ' after',
      },
      progression: 0.42,
    });
  });
});

describe('public annotation contracts', () => {
  it('keeps fixed-page geometry primitives adapter-neutral', () => {
    expectTypeOf<AnnotationPoint>().toEqualTypeOf<{
      readonly x: number;
      readonly y: number;
    }>();
    expectTypeOf<AnnotationRectangle>().toExtend<AnnotationPoint>();
    expectTypeOf<AnnotationQuadrilateral['topLeft']>().toEqualTypeOf<AnnotationPoint>();
    expectTypeOf<Extract<AnnotationGeometry, { kind: 'ink' }>>().toHaveProperty('paths');
  });

  it('exposes structured capability, metadata, filter, and export values to adapters', () => {
    expectTypeOf<'signed-document'>().toExtend<AnnotationUnavailableCode>();
    expectTypeOf<AnnotationUnavailableReason['code']>().toEqualTypeOf<AnnotationUnavailableCode>();
    expectTypeOf<'underline'>().toExtend<ConvertibleAnnotationType>();
    expectTypeOf<LegacyAnnotationIdentity['fingerprint']>().toEqualTypeOf<string>();
    expectTypeOf<AnnotationMetadataPatch['modifiedAt']>().toEqualTypeOf<
      ReturnType<typeof asUtcTimestamp>
    >();
    expectTypeOf<AnnotationFilter['types']>().toEqualTypeOf<readonly AnnotationType[]>();
    expectTypeOf<AnnotationExportRecord['annotation']>().toEqualTypeOf<DocumentAnnotation>();
  });
});
