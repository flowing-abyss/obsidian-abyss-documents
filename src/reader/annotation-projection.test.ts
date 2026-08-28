import { describe, expect, it } from 'vitest';
import type {
  AnnotationId,
  DocumentAnnotation,
  UtcTimestamp,
} from '../document-core/annotations.js';
import type { ViewportAnnotationSnapshot } from '../document-core/document.js';
import { AnnotationProjection } from './annotation-projection.js';

function viewportAnnotation(nativeId: string, provisionalId?: string): ViewportAnnotationSnapshot {
  return {
    nativeId,
    ...(provisionalId === undefined ? {} : { provisionalId }),
    pageIndex: 1,
    type: 'highlight',
    rects: [{ x: 10, y: 20, width: 30, height: 8 }],
    selectedText: 'Projected text',
    color: '#ffd400',
    comment: '',
    tags: [],
    links: [],
    writable: true,
  };
}

function verifiedAnnotation(id: string): DocumentAnnotation {
  return {
    identity: { kind: 'stable', id: id as AnnotationId },
    type: 'highlight',
    anchor: {
      kind: 'fixed-page',
      pageIndex: 1,
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'rectangle', rectangle: { x: 10, y: 20, width: 30, height: 8 } },
    },
    color: '#ffd400',
    selectedText: 'Projected text',
    author: 'Tester',
    createdAt: '2026-08-27T00:00:00.000Z' as UtcTimestamp,
    modifiedAt: '2026-08-27T00:00:00.000Z' as UtcTimestamp,
    comment: '',
    tags: [],
    links: [],
    capabilities: {
      geometry: { available: true },
      comment: { available: true },
      color: { available: true },
      deletion: { available: true },
      metadata: { available: true },
      conversions: { highlight: { available: true }, underline: { available: true } },
    },
  };
}

describe('AnnotationProjection', () => {
  it('adds a provisional annotation immediately', () => {
    const projection = new AnnotationProjection();

    projection.upsert(viewportAnnotation('native-1', 'selection-1'));

    expect(projection.snapshot()).toHaveLength(1);
  });

  it('keeps independently created annotations', () => {
    const projection = new AnnotationProjection();

    projection.upsert(viewportAnnotation('native-1', 'selection-1'));
    projection.upsert(viewportAnnotation('native-2', 'selection-2'));

    expect(projection.snapshot().map((row) => row.nativeId)).toEqual(['native-1', 'native-2']);
  });

  it('updates an existing native annotation without duplicating its row', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('native-1', 'selection-1'));

    projection.upsert({
      ...viewportAnnotation('native-1', 'selection-1'),
      comment: 'Updated comment',
    });

    expect(
      projection.snapshot().map((row) => ({ key: row.key, comment: row.annotation.comment })),
    ).toEqual([{ key: 'annotation-row-0', comment: 'Updated comment' }]);
  });

  it('keeps a successful editor metadata update over stale viewport snapshots until verification', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('native-1', 'selection-1'));
    const row = projection.snapshot()[0];
    const annotation = verifiedAnnotation('native-1');

    expect(
      projection.applyEditorUpdate({
        annotations: [annotation],
        comment: 'Résumé — проверка #review [[Linked note]]',
      }),
    ).toBe(true);
    expect(projection.snapshot()[0]).toMatchObject({
      key: row?.key,
      annotation: {
        comment: 'Résumé — проверка #review [[Linked note]]',
        links: ['Linked note'],
        tags: ['review'],
      },
    });

    projection.upsert(viewportAnnotation('native-1', 'selection-1'));
    expect(projection.snapshot()[0]).toMatchObject({
      key: row?.key,
      annotation: {
        comment: 'Résumé — проверка #review [[Linked note]]',
        links: ['Linked note'],
        tags: ['review'],
      },
    });

    projection.reconcile([{ ...annotation, comment: 'Verified', links: [], tags: [] }]);
    expect(projection.snapshot()[0]).toMatchObject({
      key: row?.key,
      annotation: { comment: 'Verified', links: [], tags: [] },
    });
  });

  it('releases an optimistic editor overlay when its row is removed', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('native-1', 'selection-1'));
    projection.applyEditorUpdate({
      annotations: [verifiedAnnotation('native-1')],
      comment: 'Temporary #review',
    });
    const removed = projection.snapshot()[0];

    projection.remove('native-1', 'selection-1');
    projection.upsert(viewportAnnotation('native-1', 'selection-1'));

    expect(projection.snapshot()[0]).toMatchObject({
      annotation: { comment: '', links: [], tags: [] },
    });
    expect(projection.snapshot()[0]).not.toBe(removed);
  });

  it('preserves row object identity when a duplicate viewport snapshot changes nothing', () => {
    const projection = new AnnotationProjection();
    const annotation = viewportAnnotation('native-1', 'selection-1');
    projection.upsert(annotation);
    const firstRow = projection.snapshot()[0];

    projection.upsert(annotation);

    expect(projection.snapshot()[0]).toBe(firstRow);
  });

  it('removes a provisional annotation by either of its identities', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('native-1', 'selection-1'));
    projection.upsert(viewportAnnotation('native-2', 'selection-2'));

    projection.remove('missing-native-id', 'selection-1');

    expect(projection.snapshot().map((row) => row.nativeId)).toEqual(['native-2']);
  });

  it('resets every row and starts a fresh stable-key scope', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('native-1'));

    projection.reset();
    projection.upsert(viewportAnnotation('native-2'));

    expect(projection.snapshot().map((row) => row.key)).toEqual(['annotation-row-0']);
  });

  it('reconciles a provisional row to a verified stable annotation without changing its key', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('temporary-native', 'selection-1'));

    projection.reconcile([verifiedAnnotation('stable-id')]);

    expect(projection.snapshot().map((row) => ({ key: row.key, nativeId: row.nativeId }))).toEqual([
      { key: 'annotation-row-0', nativeId: 'stable-id' },
    ]);
  });

  it('reconciles one unique provisional row when saved PDF geometry is normalized', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('pdfjs_internal_editor_0', 'selection-1'));
    const verified = {
      ...verifiedAnnotation('29R'),
      anchor: {
        ...verifiedAnnotation('29R').anchor,
        geometry: { kind: 'point' as const, point: { x: 12, y: 24 } },
      },
      selectedText: null,
    };

    projection.reconcile([verified]);

    expect(projection.snapshot()).toHaveLength(1);
    expect(projection.snapshot()[0]).toMatchObject({
      key: 'annotation-row-0',
      nativeId: '29R',
      provisionalId: 'pdfjs_internal_editor_0',
    });
  });

  it('binds a committed stable identity before a viewport snapshot drops the selection token', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('selection-1', 'selection-1'));
    const provisional = projection.snapshot()[0];

    expect(projection.bindCommittedSelection('selection-1', verifiedAnnotation('stable-1'))).toBe(
      true,
    );
    projection.upsert(viewportAnnotation('stable-1'));

    expect(projection.snapshot()).toHaveLength(1);
    expect(projection.snapshot()[0]).toMatchObject({
      key: provisional?.key,
      nativeId: 'stable-1',
      provisionalId: 'selection-1',
    });
  });

  it('keeps the same snapshot when verified reconciliation changes nothing', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([verifiedAnnotation('stable-id')]);
    const snapshot = projection.snapshot();

    projection.reconcile([verifiedAnnotation('stable-id')]);

    expect(projection.snapshot()).toBe(snapshot);
  });

  it('does not let a metadata-empty mounted snapshot degrade verified annotation metadata', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([
      {
        ...verifiedAnnotation('stable-id'),
        comment: 'Résumé #review [[Linked note]]',
        links: ['Linked note'],
        tags: ['review'],
      },
    ]);

    projection.upsert({
      nativeId: 'stable-id',
      pageIndex: 1,
      type: 'highlight',
      rects: [{ x: 10, y: 20, width: 30, height: 8 }],
      tags: [],
      links: [],
    });

    expect(projection.snapshot()[0]?.annotation).toMatchObject({
      comment: 'Résumé #review [[Linked note]]',
      links: ['Linked note'],
      tags: ['review'],
    });
  });

  it('preserves every verified fact when a mounted snapshot omits unknown values', () => {
    const projection = new AnnotationProjection();
    const verified = {
      ...verifiedAnnotation('stable-id'),
      color: '#ff6666',
      selectedText: 'Verified text',
      comment: 'Verified #review [[Linked note]]',
      tags: ['review'],
      links: ['Linked note'],
    };
    projection.reconcile([verified]);

    projection.upsert({
      nativeId: 'stable-id',
      pageIndex: 1,
      type: 'highlight',
      rects: [{ x: 10, y: 20, width: 30, height: 8 }],
      tags: [],
      links: [],
    });

    expect(projection.snapshot()[0]).toMatchObject({
      annotation: {
        color: '#ff6666',
        selectedText: 'Verified text',
        comment: 'Verified #review [[Linked note]]',
        tags: ['review'],
        links: ['Linked note'],
        capabilities: { deletion: { available: true } },
      },
      writable: true,
    });
  });

  it('applies every mounted fact when an editor-layer snapshot provides it', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([
      {
        ...verifiedAnnotation('stable-id'),
        comment: 'Verified #review [[Verified note]]',
        tags: ['review'],
        links: ['Verified note'],
      },
    ]);

    projection.upsert({
      nativeId: 'stable-id',
      pageIndex: 1,
      type: 'highlight',
      rects: [{ x: 10, y: 20, width: 30, height: 8 }],
      color: '#ff6666',
      selectedText: 'Editor text',
      comment: 'Editor comment',
      tags: [],
      links: [],
      writable: false,
    });

    expect(projection.snapshot()[0]).toMatchObject({
      annotation: {
        color: '#ff6666',
        selectedText: 'Editor text',
        comment: 'Editor comment',
        tags: [],
        links: [],
        capabilities: { deletion: { available: false } },
      },
      writable: false,
    });
  });

  it('binds exact native identities before geometry fallback candidates', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('temporary-native', 'selection-1'));
    projection.upsert(viewportAnnotation('stable-b'));

    projection.reconcile([verifiedAnnotation('stable-b'), verifiedAnnotation('stable-a')]);

    expect(projection.snapshot().map((row) => ({ key: row.key, nativeId: row.nativeId }))).toEqual([
      { key: 'annotation-row-1', nativeId: 'stable-b' },
      { key: 'annotation-row-0', nativeId: 'stable-a' },
    ]);
  });

  it('preserves exact duplicate overlap multiplicity as independently addressable rows', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('temporary-a', 'selection-a'));
    projection.upsert(viewportAnnotation('temporary-b', 'selection-b'));

    projection.reconcile([verifiedAnnotation('stable-a'), verifiedAnnotation('stable-b')]);
    const beforeRemoval = projection
      .snapshot()
      .map((row) => ({ key: row.key, nativeId: row.nativeId }));
    projection.remove('stable-a');

    expect({ beforeRemoval, afterRemoval: projection.snapshot().map((row) => row.key) }).toEqual({
      beforeRemoval: [
        { key: 'annotation-row-0', nativeId: 'stable-a' },
        { key: 'annotation-row-1', nativeId: 'stable-b' },
      ],
      afterRemoval: ['annotation-row-1'],
    });
  });

  it('coalesces native and provisional aliases without collapsing geometric duplicates', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('temporary-a', 'selection-a'));
    projection.upsert(viewportAnnotation('stable-b', 'selection-b'));

    projection.upsert(viewportAnnotation('stable-b', 'selection-a'));

    expect(projection.snapshot().map((row) => ({ key: row.key, nativeId: row.nativeId }))).toEqual([
      { key: 'annotation-row-0', nativeId: 'stable-b' },
    ]);
  });

  it('coalesces one uniquely matching live editor with its verified provisional row', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('pdfjs_internal_editor_0', 'selection-1'));
    projection.reconcile([verifiedAnnotation('stable-id')]);
    const initial = projection.snapshot()[0];

    projection.upsert(viewportAnnotation('pdfjs_internal_editor_0'));

    expect(projection.snapshot()).toHaveLength(1);
    expect(projection.snapshot()[0]).toMatchObject({
      key: initial?.key,
      nativeId: 'pdfjs_internal_editor_0',
      provisionalId: 'pdfjs_internal_editor_0',
      annotation: { identity: { id: 'stable-id', kind: 'stable' } },
    });
    expect(projection.remove('pdfjs_internal_editor_0')).toBe(true);
    expect(projection.snapshot()).toHaveLength(0);
  });

  it('removes a verified row through its retained live editor alias', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('pdfjs_internal_editor_0', 'selection-1'));
    projection.reconcile([verifiedAnnotation('stable-id')]);

    expect(projection.remove('pdfjs_internal_editor_0')).toBe(true);
    expect(projection.snapshot()).toHaveLength(0);
  });

  it('keeps every converted selection rectangle in provisional annotation geometry', () => {
    const projection = new AnnotationProjection();
    projection.upsert({
      ...viewportAnnotation('native-multiline', 'selection-multiline'),
      rects: [
        { x: 10, y: 20, width: 30, height: 8 },
        { x: 12, y: 32, width: 24, height: 7 },
      ],
    });

    expect(projection.snapshot()[0]?.annotation.anchor).toEqual({
      kind: 'fixed-page',
      pageIndex: 1,
      coordinateSpace: 'page-points-top-left',
      geometry: {
        kind: 'quadrilaterals',
        quadrilaterals: [
          {
            topLeft: { x: 10, y: 20 },
            topRight: { x: 40, y: 20 },
            bottomLeft: { x: 10, y: 28 },
            bottomRight: { x: 40, y: 28 },
          },
          {
            topLeft: { x: 12, y: 32 },
            topRight: { x: 36, y: 32 },
            bottomLeft: { x: 12, y: 39 },
            bottomRight: { x: 36, y: 39 },
          },
        ],
      },
    });
  });
});
