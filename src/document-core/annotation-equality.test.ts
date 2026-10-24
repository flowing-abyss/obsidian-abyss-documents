import { describe, expect, it, vi } from 'vitest';
import { annotationsEqual } from './annotation-equality.js';
import {
  asAnnotationId,
  asUtcTimestamp,
  type AnnotationAnchor,
  type AnnotationCapabilities,
  type AnnotationCapability,
  type AnnotationGeometry,
  type AnnotationPoint,
  type AnnotationQuadrilateral,
  type DocumentAnnotation,
} from './annotations.js';

function capabilities(): AnnotationCapabilities {
  return {
    geometry: { available: true },
    comment: { available: true },
    color: { available: true },
    deletion: { available: true },
    metadata: { available: true },
    conversions: {
      highlight: { available: true },
      underline: { available: true },
    },
  };
}

function annotation(overrides: Partial<DocumentAnnotation> = {}): DocumentAnnotation {
  return {
    identity: { kind: 'stable', id: asAnnotationId('29R') },
    type: 'highlight',
    anchor: {
      kind: 'fixed-page',
      pageIndex: 2,
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 10, y: 20 } },
    },
    color: '#ffd400',
    selectedText: 'Selected passage',
    author: 'Reader',
    createdAt: asUtcTimestamp('2026-10-24T12:00:00.000Z'),
    modifiedAt: asUtcTimestamp('2026-10-24T13:00:00.000Z'),
    comment: 'Review #topic [[Source]]',
    tags: ['topic', 'review'],
    links: ['Source', 'Other note'],
    capabilities: capabilities(),
    ...overrides,
  };
}

function withGeometry(geometry: AnnotationGeometry): DocumentAnnotation {
  return annotation({
    anchor: { kind: 'fixed-page', pageIndex: 2, coordinateSpace: 'page-points-top-left', geometry },
  });
}

function quad(offset = 0): AnnotationQuadrilateral {
  return {
    topLeft: { x: 10 + offset, y: 20 },
    topRight: { x: 30 + offset, y: 20 },
    bottomLeft: { x: 10 + offset, y: 40 },
    bottomRight: { x: 30 + offset, y: 40 },
  };
}

function reflowable(): Extract<AnnotationAnchor, { kind: 'reflowable-text' }> {
  return {
    kind: 'reflowable-text',
    selector: { exact: 'Selected passage', prefix: 'Before ', suffix: ' after' },
    progression: 0.25,
  };
}

function expectDifferent(original: DocumentAnnotation, changed: DocumentAnnotation): void {
  expect(annotationsEqual(original, changed)).toBe(false);
  expect(annotationsEqual(changed, original)).toBe(false);
}

const fieldChanges = {
  identity: { identity: { kind: 'stable', id: asAnnotationId('30R') } },
  type: { type: 'ink' },
  externalType: { externalType: 'Stamp' },
  anchor: { anchor: { ...reflowable() } },
  color: { color: '#5fb236' },
  selectedText: { selectedText: 'Different passage' },
  author: { author: 'Another reader' },
  createdAt: { createdAt: asUtcTimestamp('2026-10-23T12:00:00.000Z') },
  modifiedAt: { modifiedAt: asUtcTimestamp('2026-10-25T13:00:00.000Z') },
  comment: { comment: 'Changed comment' },
  tags: { tags: ['topic', 'changed'] },
  links: { links: ['Source', 'Changed note'] },
  capabilities: {
    capabilities: {
      ...capabilities(),
      deletion: {
        available: false,
        reason: { code: 'document-read-only', message: 'The document is read-only.' },
      },
    },
  },
} satisfies Record<keyof DocumentAnnotation, Partial<DocumentAnnotation>>;

type CapabilitySlot =
  Exclude<keyof AnnotationCapabilities, 'conversions'> | 'highlight' | 'underline';

function withCapability(slot: CapabilitySlot, value: AnnotationCapability): DocumentAnnotation {
  const current = capabilities();
  return annotation({
    capabilities:
      slot === 'highlight' || slot === 'underline'
        ? { ...current, conversions: { ...current.conversions, [slot]: value } }
        : { ...current, [slot]: value },
  });
}

const capabilitySlots = {
  geometry: true,
  comment: true,
  color: true,
  deletion: true,
  metadata: true,
  highlight: true,
  underline: true,
} satisfies Record<CapabilitySlot, true>;

const geometries = {
  point: (): AnnotationGeometry => ({ kind: 'point', point: { x: 10, y: 20 } }),
  rectangle: (): AnnotationGeometry => ({
    kind: 'rectangle',
    rectangle: { x: 10, y: 20, width: 30, height: 40 },
  }),
  quadrilaterals: (): AnnotationGeometry => ({
    kind: 'quadrilaterals',
    quadrilaterals: [quad(), quad(50)],
  }),
  ink: (): AnnotationGeometry => ({
    kind: 'ink',
    paths: [
      [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
      [{ x: 50, y: 60 }],
    ],
  }),
} satisfies Record<AnnotationGeometry['kind'], () => AnnotationGeometry>;

describe('annotationsEqual', () => {
  it('accepts the same annotation reference', () => {
    const value = annotation();
    expect(annotationsEqual(value, value)).toBe(true);
  });

  it('accepts independently allocated equivalent annotations', () => {
    expect(annotationsEqual(annotation(), annotation())).toBe(true);
  });

  it.each(Object.entries(fieldChanges))('compares the %s field', (_field, change) => {
    expectDifferent(annotation(), annotation(change));
  });

  it('does not depend on object property insertion order', () => {
    const expected = annotation();
    const reordered: DocumentAnnotation = {
      capabilities: {
        conversions: { underline: { available: true }, highlight: { available: true } },
        metadata: { available: true },
        deletion: { available: true },
        color: { available: true },
        comment: { available: true },
        geometry: { available: true },
      },
      links: ['Source', 'Other note'],
      tags: ['topic', 'review'],
      comment: 'Review #topic [[Source]]',
      modifiedAt: asUtcTimestamp('2026-10-24T13:00:00.000Z'),
      createdAt: asUtcTimestamp('2026-10-24T12:00:00.000Z'),
      author: 'Reader',
      selectedText: 'Selected passage',
      color: '#ffd400',
      anchor: {
        geometry: { point: { y: 20, x: 10 }, kind: 'point' },
        coordinateSpace: 'page-points-top-left',
        pageIndex: 2,
        kind: 'fixed-page',
      },
      type: 'highlight',
      identity: { id: asAnnotationId('29R'), kind: 'stable' },
    };
    expect(annotationsEqual(expected, reordered)).toBe(true);
  });

  it('treats an absent optional external type like an explicit undefined value', () => {
    const explicit = annotation();
    Object.defineProperty(explicit, 'externalType', { enumerable: true, value: undefined });
    expect(annotationsEqual(annotation(), explicit)).toBe(true);
  });

  it('accepts equal present external types and rejects an empty present value', () => {
    expect(
      annotationsEqual(
        annotation({ externalType: 'Stamp' }),
        annotation({ externalType: 'Stamp' }),
      ),
    ).toBe(true);
    expectDifferent(annotation(), annotation({ externalType: '' }));
  });

  it.each(['color', 'selectedText', 'createdAt', 'modifiedAt'] as const)(
    'compares nullable %s values',
    (field) => {
      expect(annotationsEqual(annotation({ [field]: null }), annotation({ [field]: null }))).toBe(
        true,
      );
      expectDifferent(annotation(), annotation({ [field]: null }));
    },
  );

  it('does not normalize text, colors, tag case, or link case', () => {
    expectDifferent(annotation(), annotation({ comment: 'Review #topic [[Source]] ' }));
    expectDifferent(annotation(), annotation({ color: '#FFD400' }));
    expectDifferent(annotation(), annotation({ tags: ['Topic', 'review'] }));
    expectDifferent(annotation(), annotation({ links: ['source', 'Other note'] }));
  });

  it('compares legacy identity fingerprints and identity kinds', () => {
    const left = annotation({ identity: { kind: 'legacy', fingerprint: 'page:2:quad' } });
    expect(
      annotationsEqual(
        left,
        annotation({ identity: { kind: 'legacy', fingerprint: 'page:2:quad' } }),
      ),
    ).toBe(true);
    expectDifferent(
      left,
      annotation({ identity: { kind: 'legacy', fingerprint: 'page:2:other' } }),
    );
    expectDifferent(annotation(), annotation({ identity: { kind: 'legacy', fingerprint: '29R' } }));
  });

  it('compares the fixed page index and coordinate space', () => {
    const left = withGeometry(geometries.point());
    expectDifferent(
      left,
      annotation({
        anchor: {
          kind: 'fixed-page',
          pageIndex: 3,
          coordinateSpace: 'page-points-top-left',
          geometry: geometries.point(),
        },
      }),
    );
    const invalidSpace = {
      kind: 'fixed-page',
      pageIndex: 2,
      coordinateSpace: 'page-points-bottom-left',
      geometry: geometries.point(),
    } as unknown as AnnotationAnchor;
    expectDifferent(left, annotation({ anchor: invalidSpace }));
  });

  it('accepts independently allocated equivalent reflowable anchors', () => {
    expect(
      annotationsEqual(annotation({ anchor: reflowable() }), annotation({ anchor: reflowable() })),
    ).toBe(true);
  });

  it.each(['exact', 'prefix', 'suffix'] as const)(
    'compares the reflowable selector %s',
    (field) => {
      const left = reflowable();
      expectDifferent(
        annotation({ anchor: left }),
        annotation({ anchor: { ...left, selector: { ...left.selector, [field]: 'Different' } } }),
      );
    },
  );

  it('compares reflowable progression including null and zero', () => {
    expectDifferent(
      annotation({ anchor: reflowable() }),
      annotation({ anchor: { ...reflowable(), progression: 0.5 } }),
    );
    expectDifferent(
      annotation({ anchor: reflowable() }),
      annotation({ anchor: { ...reflowable(), progression: null } }),
    );
    expect(
      annotationsEqual(
        annotation({ anchor: { ...reflowable(), progression: null } }),
        annotation({ anchor: { ...reflowable(), progression: null } }),
      ),
    ).toBe(true);
    expect(
      annotationsEqual(
        annotation({ anchor: { ...reflowable(), progression: 0 } }),
        annotation({ anchor: { ...reflowable(), progression: 0 } }),
      ),
    ).toBe(true);
  });

  it.each(Object.entries(geometries))(
    'accepts independently allocated equivalent %s geometry',
    (_kind, make) => {
      expect(annotationsEqual(withGeometry(make()), withGeometry(make()))).toBe(true);
    },
  );

  it('rejects each pair of different geometry kinds', () => {
    const values = Object.values(geometries);
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        const makeLeft = values[left];
        const makeRight = values[right];
        if (makeLeft === undefined || makeRight === undefined)
          throw new Error('Expected geometry fixture.');
        expectDifferent(withGeometry(makeLeft()), withGeometry(makeRight()));
      }
    }
  });

  it.each(['x', 'y'] as const)('compares point %s without rounding', (coordinate) => {
    expectDifferent(
      withGeometry(geometries.point()),
      withGeometry({ kind: 'point', point: { x: 10, y: 20, [coordinate]: 10.00001 } }),
    );
  });

  it.each(['x', 'y', 'width', 'height'] as const)('compares rectangle %s', (coordinate) => {
    expectDifferent(
      withGeometry(geometries.rectangle()),
      withGeometry({
        kind: 'rectangle',
        rectangle: { x: 10, y: 20, width: 30, height: 40, [coordinate]: 99 },
      }),
    );
  });

  it.each(['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const)(
    'compares both coordinates of quadrilateral %s',
    (corner) => {
      for (const axis of ['x', 'y'] as const) {
        const original = quad();
        const changed = { ...original, [corner]: { ...original[corner], [axis]: 99 } };
        expectDifferent(
          withGeometry({ kind: 'quadrilaterals', quadrilaterals: [original] }),
          withGeometry({ kind: 'quadrilaterals', quadrilaterals: [changed] }),
        );
      }
    },
  );

  it('compares quadrilateral array lengths and order', () => {
    const left = withGeometry({ kind: 'quadrilaterals', quadrilaterals: [quad(), quad(50)] });
    expectDifferent(left, withGeometry({ kind: 'quadrilaterals', quadrilaterals: [quad()] }));
    expectDifferent(
      left,
      withGeometry({ kind: 'quadrilaterals', quadrilaterals: [quad(50), quad()] }),
    );
    expect(
      annotationsEqual(
        withGeometry({ kind: 'quadrilaterals', quadrilaterals: [] }),
        withGeometry({ kind: 'quadrilaterals', quadrilaterals: [] }),
      ),
    ).toBe(true);
  });

  it.each(['x', 'y'] as const)('compares every ink path point %s', (axis) => {
    const original: readonly AnnotationPoint[] = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ];
    for (const index of [0, 1]) {
      const changed = original.map((point, current) =>
        current === index ? { ...point, [axis]: 99 } : point,
      );
      expectDifferent(
        withGeometry({ kind: 'ink', paths: [original] }),
        withGeometry({ kind: 'ink', paths: [changed] }),
      );
    }
  });

  it('compares ink path lengths, point order, and path order', () => {
    const first = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ];
    const second = [{ x: 50, y: 60 }];
    const left = withGeometry({ kind: 'ink', paths: [first, second] });
    expectDifferent(left, withGeometry({ kind: 'ink', paths: [first] }));
    expectDifferent(left, withGeometry({ kind: 'ink', paths: [second, first] }));
    expectDifferent(
      left,
      withGeometry({ kind: 'ink', paths: [[first[0] as AnnotationPoint], second] }),
    );
    expectDifferent(left, withGeometry({ kind: 'ink', paths: [[...first].reverse(), second] }));
    expect(
      annotationsEqual(
        withGeometry({ kind: 'ink', paths: [[], []] }),
        withGeometry({ kind: 'ink', paths: [[], []] }),
      ),
    ).toBe(true);
  });

  it.each(['tags', 'links'] as const)('compares ordered %s values and lengths', (field) => {
    const values = annotation()[field];
    expectDifferent(annotation(), annotation({ [field]: [...values].reverse() }));
    expectDifferent(annotation(), annotation({ [field]: [...values, 'extra'] }));
    expectDifferent(annotation(), annotation({ [field]: [] }));
    expect(annotationsEqual(annotation({ [field]: [] }), annotation({ [field]: [] }))).toBe(true);
  });

  it.each(Object.keys(capabilitySlots) as CapabilitySlot[])(
    'compares %s capability availability and full reasons',
    (slot) => {
      const denied: AnnotationCapability = {
        available: false,
        reason: { code: 'permission-restricted', message: 'Editing is forbidden.' },
      };
      const left = withCapability(slot, denied);
      expect(
        annotationsEqual(
          left,
          withCapability(slot, {
            reason: { message: 'Editing is forbidden.', code: 'permission-restricted' },
            available: false,
          }),
        ),
      ).toBe(true);
      expectDifferent(annotation(), left);
      expectDifferent(
        left,
        withCapability(slot, {
          available: false,
          reason: { code: 'signed-document', message: 'Editing is forbidden.' },
        }),
      );
      expectDifferent(
        left,
        withCapability(slot, {
          available: false,
          reason: { code: 'permission-restricted', message: 'Different reason.' },
        }),
      );
    },
  );

  it('accepts shared nested references while comparing independent surrounding values', () => {
    const left = annotation();
    const right = {
      ...annotation(),
      identity: left.identity,
      anchor: left.anchor,
      tags: left.tags,
      links: left.links,
      capabilities: left.capabilities,
    };
    expect(annotationsEqual(left, right)).toBe(true);
    expectDifferent(left, { ...right, comment: 'Different comment' });
  });

  it('accepts shared geometry, points, rectangles, selectors, and capability members', () => {
    const geometry = geometries.point();
    expect(annotationsEqual(withGeometry(geometry), withGeometry(geometry))).toBe(true);
    const point = { x: 10, y: 20 };
    expect(
      annotationsEqual(
        withGeometry({ kind: 'point', point }),
        withGeometry({ kind: 'point', point }),
      ),
    ).toBe(true);
    const rectangle = { x: 10, y: 20, width: 30, height: 40 };
    expect(
      annotationsEqual(
        withGeometry({ kind: 'rectangle', rectangle }),
        withGeometry({ kind: 'rectangle', rectangle }),
      ),
    ).toBe(true);
    const anchor = reflowable();
    expect(annotationsEqual(annotation({ anchor }), annotation({ anchor: { ...anchor } }))).toBe(
      true,
    );
    const members = capabilities();
    expect(
      annotationsEqual(
        annotation({ capabilities: members }),
        annotation({ capabilities: { ...members } }),
      ),
    ).toBe(true);
  });

  it('does not serialize annotations or invoke JSON hooks', () => {
    const left = annotation();
    const right = annotation();
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('Equality must not serialize.');
    });
    let result: boolean;
    try {
      result = annotationsEqual(left, right);
    } finally {
      stringify.mockRestore();
    }
    expect(result).toBe(true);
  });
});
