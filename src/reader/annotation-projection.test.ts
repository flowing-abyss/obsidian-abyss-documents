import { describe, expect, it, vi } from 'vitest';
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

function renumberedOverlapProjection(): AnnotationProjection {
  const projection = new AnnotationProjection();
  const first = { ...verifiedAnnotation('internal-a'), comment: 'First' };
  const second = { ...verifiedAnnotation('internal-b'), comment: 'Second' };
  projection.upsert({ ...viewportAnnotation('internal-a', 'selection-a'), comment: 'First' }, 1);
  projection.bindCommittedSelection('selection-a', first, 1);
  projection.upsert({ ...viewportAnnotation('internal-b', 'selection-b'), comment: 'Second' }, 2);
  projection.bindCommittedSelection('selection-b', second, 2);
  projection.reconcile(
    [
      { ...first, identity: { kind: 'stable', id: '29R' as AnnotationId } },
      { ...second, identity: { kind: 'stable', id: '30R' as AnnotationId } },
    ],
    2,
  );
  projection.reconcile(
    [
      { ...first, identity: { kind: 'stable', id: '30R' as AnnotationId } },
      { ...second, identity: { kind: 'stable', id: '31R' as AnnotationId } },
    ],
    3,
  );
  return projection;
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

  it('replays an explicit comment clear over verification of an older revision', () => {
    const projection = new AnnotationProjection();
    const annotation = {
      ...verifiedAnnotation('stable-id'),
      comment: 'Old comment #review [[Old note]]',
      links: ['Old note'],
      tags: ['review'],
    };
    projection.reconcile([annotation], 1);

    projection.applyEditorUpdate({ annotations: [annotation], comment: '' }, 2);
    projection.reconcile([annotation], 1);

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        links: row.annotation.links,
        tags: row.annotation.tags,
      })),
    ).toEqual([{ comment: '', links: [], tags: [] }]);
  });

  it('releases confirmed overlay fields while retaining newer fields', () => {
    const projection = new AnnotationProjection();
    const original = verifiedAnnotation('stable-id');
    projection.reconcile([original], 0);
    projection.applyEditorUpdate({ annotations: [original], comment: 'Revision one' }, 1);
    projection.applyEditorUpdate({ annotations: [original], color: '#2f80ed' }, 2);

    projection.reconcile(
      [{ ...original, color: '#ff6666', comment: 'Revision one normalized' }],
      1,
    );

    expect(
      projection.snapshot().map((row) => ({
        color: row.annotation.color,
        comment: row.annotation.comment,
      })),
    ).toEqual([{ color: '#2f80ed', comment: 'Revision one normalized' }]);
  });

  it('replays a deletion tombstone over verification of an older revision', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([verifiedAnnotation('deleted-id')], 1);

    projection.remove('deleted-id', undefined, 2);
    projection.reconcile([verifiedAnnotation('deleted-id')], 1);

    expect(projection.snapshot().map((row) => row.nativeId)).toEqual([]);
  });

  it('suppresses stale mounted aliases only after an explicit optimistic delete', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('runtime-id', 'selection-id'), 1);
    projection.bindCommittedSelection('selection-id', verifiedAnnotation('runtime-id'), 1);
    projection.reconcile([verifiedAnnotation('stable-id')], 1);

    expect(projection.snapshot()).toMatchObject([
      {
        aliases: ['selection-id'],
        nativeId: 'stable-id',
        provisionalId: 'runtime-id',
        runtimeId: 'runtime-id',
      },
    ]);
    expect(projection.deleteOptimistically('stable-id', undefined, 2)).toBe(true);

    for (const [nativeId, provisionalId, revision] of [
      ['stable-id', undefined, 2],
      ['runtime-id', undefined, 2],
      ['selection-id', undefined, 3],
      ['unrelated-native', 'selection-id', 3],
    ] as const) {
      projection.upsert(viewportAnnotation(nativeId, provisionalId), revision);
    }

    expect(projection.snapshot()).toEqual([]);
  });

  it('keeps an explicit delete pending through older verification and failed-save observations', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([verifiedAnnotation('stable-id')], 1);
    projection.deleteOptimistically('stable-id', undefined, 2);

    projection.reconcile([verifiedAnnotation('stable-id')], 1);
    projection.upsert(viewportAnnotation('stable-id'), 4);

    expect(projection.snapshot()).toEqual([]);
  });

  it('releases an explicit delete when a confirming revision proves the row absent', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([verifiedAnnotation('stable-id')], 1);
    projection.deleteOptimistically('stable-id', undefined, 2);

    projection.reconcile([], 2);
    projection.upsert(viewportAnnotation('stable-id'), 3);

    expect(projection.snapshot().map((row) => row.nativeId)).toEqual(['stable-id']);
  });

  it('restores an explicit delete when a confirming revision authoritatively contains it', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([verifiedAnnotation('stable-id')], 1);
    projection.deleteOptimistically('stable-id', undefined, 2);

    projection.reconcile(
      [{ ...verifiedAnnotation('stable-id'), comment: 'Authoritatively present' }],
      2,
    );

    expect(projection.snapshot()).toMatchObject([
      { annotation: { comment: 'Authoritatively present' }, nativeId: 'stable-id' },
    ]);
  });

  it('does not tombstone observational viewport removal', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('stable-id'), 2);

    projection.remove('stable-id', undefined, 2);
    projection.upsert({ ...viewportAnnotation('stable-id'), comment: 'Remounted' }, 2);

    expect(projection.snapshot()).toMatchObject([
      { annotation: { comment: 'Remounted' }, nativeId: 'stable-id' },
    ]);
  });

  it('clears explicit deletion state on reset', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([verifiedAnnotation('stable-id')], 1);
    projection.deleteOptimistically('stable-id', undefined, 2);

    projection.reset();
    projection.upsert(viewportAnnotation('stable-id'), 2);

    expect(projection.snapshot().map((row) => row.nativeId)).toEqual(['stable-id']);
  });

  it('applies a viewport burst with one temporary identity index and final-state deduplication', () => {
    const projection = new AnnotationProjection();
    for (let index = 0; index < 2_000; index += 1)
      projection.upsert(viewportAnnotation(`stable-${String(index)}`));
    const buildIndex = vi.spyOn(
      projection as unknown as { buildViewportIdentityIndex(): unknown },
      'buildViewportIdentityIndex',
    );

    expect(
      projection.applyViewportBatch([
        {
          revision: 3,
          event: {
            type: 'annotation-change',
            change: {
              operation: 'upsert',
              annotation: { ...viewportAnnotation('stable-1'), comment: 'Changed' },
            },
          },
        },
        {
          revision: 3,
          event: {
            type: 'annotation-change',
            change: { operation: 'remove', nativeId: 'stable-2' },
          },
        },
        {
          revision: 3,
          event: {
            type: 'annotation-snapshot',
            annotations: [
              { ...viewportAnnotation('stable-1'), comment: 'Changed' },
              viewportAnnotation('stable-2000'),
            ],
          },
        },
      ]),
    ).toBe(true);

    expect(buildIndex).toHaveBeenCalledOnce();
    expect(projection.snapshot()).toHaveLength(2_000);
    expect(projection.snapshot().filter((row) => row.nativeId === 'stable-1')).toMatchObject([
      { annotation: { comment: 'Changed' } },
    ]);
    expect(projection.snapshot().some((row) => row.nativeId === 'stable-2')).toBe(false);
    expect(projection.snapshot().some((row) => row.nativeId === 'stable-2000')).toBe(true);
  });

  it('preserves viewport upsert-remove-upsert order inside one indexed batch', () => {
    const projection = new AnnotationProjection();

    projection.applyViewportBatch([
      {
        revision: 2,
        event: {
          type: 'annotation-change',
          change: { operation: 'upsert', annotation: viewportAnnotation('stable-id') },
        },
      },
      {
        revision: 2,
        event: {
          type: 'annotation-change',
          change: { operation: 'remove', nativeId: 'stable-id' },
        },
      },
      {
        revision: 2,
        event: {
          type: 'annotation-change',
          change: {
            operation: 'upsert',
            annotation: { ...viewportAnnotation('stable-id'), comment: 'Final' },
          },
        },
      },
    ]);

    expect(projection.snapshot()).toMatchObject([
      { annotation: { comment: 'Final' }, nativeId: 'stable-id' },
    ]);
  });

  it('preserves each viewport observation revision inside one batch', () => {
    const projection = new AnnotationProjection();
    projection.reconcile(
      [verifiedAnnotation('revision-one'), verifiedAnnotation('revision-two')],
      0,
    );

    projection.applyViewportBatch([
      {
        revision: 1,
        event: {
          type: 'annotation-change',
          change: { operation: 'remove', nativeId: 'revision-one' },
        },
      },
      {
        revision: 2,
        event: {
          type: 'annotation-change',
          change: {
            operation: 'upsert',
            annotation: {
              ...viewportAnnotation('revision-two'),
              comment: 'Pending revision two',
            },
          },
        },
      },
    ]);
    projection.reconcile(
      [verifiedAnnotation('revision-one'), verifiedAnnotation('revision-two')],
      1,
    );

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        nativeId: row.nativeId,
      })),
    ).toEqual([
      { comment: '', nativeId: 'revision-one' },
      { comment: 'Pending revision two', nativeId: 'revision-two' },
    ]);
  });

  it('retains a newer identical snapshot across verification of its older creation revision', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([], 0);
    const annotation = viewportAnnotation('same-snapshot');

    projection.applyViewportBatch([
      {
        revision: 1,
        event: {
          type: 'annotation-change',
          change: { operation: 'upsert', annotation },
        },
      },
      {
        revision: 2,
        event: { type: 'annotation-snapshot', annotations: [annotation] },
      },
    ]);
    projection.reconcile([], 1);

    expect(projection.snapshot().map((row) => row.nativeId)).toEqual(['same-snapshot']);
  });

  it('uses indexed tombstone creation and lookup for many independent identities', () => {
    const projection = new AnnotationProjection();
    const count = 500;
    for (let index = 0; index < count; index += 1)
      projection.upsert(viewportAnnotation(`deleted-${String(index)}`));
    const indexTombstone = vi.spyOn(
      projection as unknown as { indexExplicitDeletionTombstone(): void },
      'indexExplicitDeletionTombstone',
    );
    const lookupTombstone = vi.spyOn(
      projection as unknown as { explicitDeletionTombstoneForSnapshot(): unknown },
      'explicitDeletionTombstoneForSnapshot',
    );
    for (let index = 0; index < count; index += 1)
      projection.deleteOptimistically(`deleted-${String(index)}`, undefined, 1);

    projection.applyViewportBatch(
      Array.from({ length: count }, (_, index) => ({
        revision: 1,
        event: {
          type: 'annotation-change' as const,
          change: {
            operation: 'upsert' as const,
            annotation: viewportAnnotation(`unrelated-${String(index)}`),
          },
        },
      })),
    );

    expect(indexTombstone).toHaveBeenCalledTimes(count);
    expect(lookupTombstone).toHaveBeenCalledTimes(count);
    expect(projection.snapshot()).toHaveLength(count);
  });

  it('ignores an older verified revision after a newer revision was accepted', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([{ ...verifiedAnnotation('stable-id'), comment: 'Revision 2' }], 2);

    projection.reconcile([{ ...verifiedAnnotation('stable-id'), comment: 'Revision 1' }], 1);

    expect(projection.snapshot().map((row) => row.annotation.comment)).toEqual(['Revision 2']);
  });

  it('keeps a failed save unconfirmed and releases its overlay after retry verification', () => {
    const projection = new AnnotationProjection();
    const original = { ...verifiedAnnotation('stable-id'), comment: 'Original' };
    projection.reconcile([original], 0);
    projection.applyEditorUpdate({ annotations: [original], comment: 'Pending retry' }, 1);

    expect(projection.snapshot().map((row) => row.annotation.comment)).toEqual(['Pending retry']);

    projection.reconcile([{ ...original, comment: 'Confirmed retry' }], 1);
    expect(projection.snapshot().map((row) => row.annotation.comment)).toEqual(['Confirmed retry']);

    projection.reconcile([original], 0);
    expect(projection.snapshot().map((row) => row.annotation.comment)).toEqual(['Confirmed retry']);
  });

  it('bounds replay work for alternating snapshots at one pending revision', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([verifiedAnnotation('stable-id')], 1);
    for (let index = 0; index < 50_000; index += 1) {
      projection.upsert(
        {
          ...viewportAnnotation('stable-id'),
          comment: index % 2 === 0 ? 'Even snapshot' : 'Odd snapshot',
        },
        2,
      );
    }

    const startedAt = performance.now();
    projection.reconcile([verifiedAnnotation('stable-id')], 1);
    const elapsed = performance.now() - startedAt;

    expect({
      elapsedUnder50Ms: elapsed < 50,
      rows: projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        nativeId: row.nativeId,
      })),
    }).toEqual({
      elapsedUnder50Ms: true,
      rows: [{ comment: 'Odd snapshot', nativeId: 'stable-id' }],
    });
  });

  it('preserves cross-kind transition order while coalescing one revision', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([], 1);
    projection.upsert(viewportAnnotation('stable-id'), 2);
    projection.remove('stable-id', undefined, 2);
    projection.upsert({ ...viewportAnnotation('stable-id'), comment: 'Final upsert' }, 2);

    projection.reconcile([], 1);

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        nativeId: row.nativeId,
      })),
    ).toEqual([{ comment: 'Final upsert', nativeId: 'stable-id' }]);
  });

  it('reconciles a large initial verified set with indexed fallback work', () => {
    const projection = new AnnotationProjection();
    const annotations = Array.from({ length: 2_000 }, (_, index) => ({
      ...verifiedAnnotation(`stable-${String(index)}`),
      anchor: {
        ...verifiedAnnotation(`stable-${String(index)}`).anchor,
        geometry: { kind: 'point' as const, point: { x: index, y: index } },
      },
    }));

    const startedAt = performance.now();
    projection.reconcile(annotations, 1);
    const elapsed = performance.now() - startedAt;

    expect({ elapsedUnder250Ms: elapsed < 250, rows: projection.snapshot().length }).toEqual({
      elapsedUnder250Ms: true,
      rows: 2_000,
    });
  });

  it('keeps comment and color previews through same-revision extraction until commit or revert', () => {
    const projection = new AnnotationProjection();
    const verified = { ...verifiedAnnotation('stable-id'), comment: 'Original' };
    projection.reconcile([verified], 1);

    projection.applyEditorPreview({
      annotations: [verified],
      color: '#2f80ed',
      comment: 'Draft comment',
    });
    projection.reconcile([verified], 1);
    expect(
      projection.snapshot().map((row) => ({
        color: row.annotation.color,
        comment: row.annotation.comment,
      })),
    ).toEqual([{ color: '#2f80ed', comment: 'Draft comment' }]);

    projection.applyEditorPreview({
      annotations: [verified],
      color: verified.color ?? '#ffd400',
      comment: verified.comment,
    });
    expect(
      projection.snapshot().map((row) => ({
        color: row.annotation.color,
        comment: row.annotation.comment,
      })),
    ).toEqual([{ color: '#ffd400', comment: 'Original' }]);

    projection.applyEditorPreview({ annotations: [verified], comment: 'Committed draft' });
    projection.applyEditorUpdate({ annotations: [verified], comment: 'Committed draft' }, 2);
    projection.reconcile([{ ...verified, comment: 'Committed draft' }], 2);
    expect(projection.snapshot().map((row) => row.annotation.comment)).toEqual(['Committed draft']);
  });

  it('keeps one card optimistic across restored native editor aliases without waiting for extraction', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('pdfjs-editor-0', 'selection-1'));
    projection.bindCommittedSelection('selection-1', verifiedAnnotation('pdfjs-editor-0'), 1);
    const originalKey = projection.snapshot()[0]?.key;

    projection.reconcile([verifiedAnnotation('30R')], 1);
    projection.reconcile([verifiedAnnotation('31R')], 1);

    expect(
      projection.applyEditorPreview({
        annotations: [verifiedAnnotation('pdfjs-editor-0')],
        comment: 'Visible on the first frame',
      }),
    ).toBe(true);
    expect(
      projection.applyEditorPreview({
        annotations: [verifiedAnnotation('pdfjs-editor-0')],
        comment: 'Visible on the second frame',
      }),
    ).toBe(true);

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
      })),
    ).toEqual([
      {
        comment: 'Visible on the second frame',
        key: originalKey,
        nativeId: '31R',
      },
    ]);
  });

  it('records every writable mounted snapshot as a live runtime target', () => {
    const projection = new AnnotationProjection();

    projection.upsert(viewportAnnotation('pdfjs_internal_editor_0'));

    expect(projection.snapshot()[0]).toMatchObject({
      nativeId: 'pdfjs_internal_editor_0',
      runtimeId: 'pdfjs_internal_editor_0',
    });
  });

  it('keeps the verified PDF id canonical when its live runtime snapshot refreshes', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('pdfjs_internal_editor_0', 'selection-1'));
    projection.bindCommittedSelection(
      'selection-1',
      verifiedAnnotation('pdfjs_internal_editor_0'),
      1,
    );
    projection.reconcile([verifiedAnnotation('29R')], 1);

    projection.upsert(viewportAnnotation('pdfjs_internal_editor_0'));

    expect(projection.snapshot()).toMatchObject([
      {
        nativeId: '29R',
        runtimeId: 'pdfjs_internal_editor_0',
      },
    ]);

    projection.upsert({
      ...viewportAnnotation('29R'),
      runtimeId: '29R',
    });

    expect(projection.snapshot()).toMatchObject([
      {
        nativeId: '29R',
        runtimeId: '29R',
      },
    ]);
  });

  it('replays a live create made during extraction of an older revision', () => {
    const projection = new AnnotationProjection();
    projection.reconcile([], 1);

    projection.upsert(viewportAnnotation('created-at-revision-2'), 2);
    projection.reconcile([], 1);

    expect(projection.snapshot().map((row) => row.nativeId)).toEqual(['created-at-revision-2']);
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

  it('does not infer provisional identity when saved PDF geometry is normalized', () => {
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
      key: 'annotation-row-1',
      nativeId: '29R',
    });
    expect(projection.snapshot()[0]).not.toHaveProperty('provisionalId');
  });

  it('keeps a causally bound selection row when the saved geometry is normalized', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('selection-token', 'selection-token'), 2);
    const originalKey = projection.snapshot()[0]?.key;
    projection.bindCommittedSelection(
      'selection-token',
      verifiedAnnotation('pdfjs_internal_editor_0'),
      2,
    );
    const verified = {
      ...verifiedAnnotation('29R'),
      anchor: {
        ...verifiedAnnotation('29R').anchor,
        geometry: { kind: 'point' as const, point: { x: 12, y: 24 } },
      },
    };

    projection.reconcile([verified], 2);

    expect(projection.snapshot()).toMatchObject([
      {
        key: originalKey,
        nativeId: '29R',
        provisionalId: 'pdfjs_internal_editor_0',
      },
    ]);
  });

  it('does not apply a causal bind from a revision newer than the verified snapshot', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('selection-token', 'selection-token'), 3);
    projection.bindCommittedSelection(
      'selection-token',
      verifiedAnnotation('pdfjs_internal_editor_0'),
      3,
    );
    const verified = {
      ...verifiedAnnotation('29R'),
      anchor: {
        ...verifiedAnnotation('29R').anchor,
        geometry: { kind: 'point' as const, point: { x: 12, y: 24 } },
      },
    };

    projection.reconcile([verified], 2);

    expect(projection.snapshot()).toMatchObject([
      { key: 'annotation-row-1', nativeId: '29R' },
      { key: 'annotation-row-0', nativeId: 'pdfjs_internal_editor_0' },
    ]);
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
        capabilities: { deletion: { available: true } },
      },
      writable: false,
    });
  });

  it('does not let live writability escalate a verified capability matrix', () => {
    const projection = new AnnotationProjection();
    const unavailableConversion = {
      available: false as const,
      reason: {
        code: 'lossy-conversion' as const,
        message: 'Annotation browsing never converts PDF annotations.',
      },
    };
    const verified = {
      ...verifiedAnnotation('stable-id'),
      capabilities: {
        geometry: { available: true as const },
        comment: { available: true as const },
        color: { available: true as const },
        deletion: { available: true as const },
        metadata: { available: true as const },
        conversions: {
          highlight: unavailableConversion,
          underline: unavailableConversion,
        },
      },
    };
    projection.reconcile([verified]);

    projection.upsert({
      ...viewportAnnotation('stable-id'),
      writable: true,
    });

    expect(projection.snapshot()[0]).toMatchObject({
      annotation: { capabilities: verified.capabilities },
      writable: true,
    });
    expect(projection.snapshot()[0]?.annotation.capabilities).toBe(verified.capabilities);
  });

  it('replaces provisional writability with verified capabilities', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('stable-id'));
    const annotation = verifiedAnnotation('stable-id');
    const verified = {
      ...annotation,
      capabilities: {
        ...annotation.capabilities,
        deletion: {
          available: false as const,
          reason: {
            code: 'unsupported-annotation' as const,
            message: 'This annotation cannot be deleted.',
          },
        },
      },
    };

    projection.reconcile([verified]);

    expect(projection.snapshot().map((row) => row.writable)).toEqual([false]);
  });

  it('refreshes live writability from unchanged verified annotation data', () => {
    const projection = new AnnotationProjection();
    const verified = verifiedAnnotation('stable-id');
    projection.reconcile([verified], 0);
    projection.upsert({ ...viewportAnnotation('stable-id'), writable: false }, 1);

    projection.reconcile([verified], 1);

    expect(projection.snapshot().map((row) => row.writable)).toEqual([true]);
  });

  it('retains a selection preview until its native mutation commits or discards', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('selection-token', 'selection-token'), 1);
    const initialKey = projection.snapshot()[0]?.key;

    projection.reconcile([], 1);
    const committed = verifiedAnnotation('stable-id');
    expect(projection.bindCommittedSelection('selection-token', committed, 2)).toBe(true);

    expect(projection.snapshot()).toMatchObject([
      { key: initialKey, nativeId: 'stable-id', provisionalId: 'selection-token' },
    ]);
  });

  it('replays a committed bind over stale extraction with its original key and payload', () => {
    const projection = new AnnotationProjection();
    projection.upsert(
      {
        ...viewportAnnotation('selection-token', 'selection-token'),
        selectedText: 'Original quote',
      },
      0,
    );
    const originalKey = projection.snapshot()[0]?.key;
    const committed = {
      ...verifiedAnnotation('pdfjs_internal_editor_4'),
      selectedText: 'Original quote',
    };

    expect(projection.bindCommittedSelection('selection-token', committed, 1)).toBe(true);
    projection.reconcile([], 0);
    projection.upsert(
      {
        nativeId: 'pdfjs_internal_editor_4',
        pageIndex: 1,
        type: 'highlight',
        rects: [{ x: 10, y: 20, width: 30, height: 8 }],
        selectedText: 'Original quote',
        tags: [],
        links: [],
        writable: true,
      },
      1,
    );

    expect(projection.snapshot()).toMatchObject([
      {
        key: originalKey,
        nativeId: 'pdfjs_internal_editor_4',
        provisionalId: 'selection-token',
        annotation: {
          color: '#ffd400',
          selectedText: 'Original quote',
          capabilities: { deletion: { available: true } },
        },
        writable: true,
      },
    ]);
  });

  it('does not bind an older same-page annotation to a newer selection preview', () => {
    const projection = new AnnotationProjection();
    projection.upsert(
      {
        ...viewportAnnotation('selection-token', 'selection-token'),
        comment: 'New selection',
        rects: [{ x: 100, y: 200, width: 30, height: 8 }],
      },
      2,
    );
    const previewKey = projection.snapshot()[0]?.key;
    const older = {
      ...verifiedAnnotation('older-id'),
      comment: 'Older annotation',
      anchor: {
        ...verifiedAnnotation('older-id').anchor,
        geometry: { kind: 'point' as const, point: { x: 1, y: 2 } },
      },
    };

    projection.reconcile([older], 1);
    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
        provisionalId: row.provisionalId,
      })),
    ).toEqual([
      {
        comment: 'Older annotation',
        key: 'annotation-row-1',
        nativeId: 'older-id',
        provisionalId: undefined,
      },
      {
        comment: 'New selection',
        key: previewKey,
        nativeId: 'selection-token',
        provisionalId: 'selection-token',
      },
    ]);

    projection.bindCommittedSelection('selection-token', verifiedAnnotation('new-id'), 2);
    expect(projection.snapshot().map((row) => ({ key: row.key, nativeId: row.nativeId }))).toEqual([
      { key: 'annotation-row-1', nativeId: 'older-id' },
      { key: previewKey, nativeId: 'new-id' },
    ]);
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

  it('remaps a renumbered persisted identity through one unique native style and geometry', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('363R', 'selection-renumbered'));
    projection.bindCommittedSelection('selection-renumbered', verifiedAnnotation('363R'), 1);
    const originalKey = projection.snapshot()[0]?.key;

    projection.reconcile([verifiedAnnotation('365R')], 1);

    expect(projection.snapshot()).toMatchObject([
      {
        key: originalKey,
        nativeId: '365R',
        provisionalId: '363R',
        annotation: { color: '#ffd400', identity: { id: '365R', kind: 'stable' } },
        writable: true,
      },
    ]);
  });

  it('disambiguates ambiguous overlapping geometry identities by annotation color', () => {
    const projection = new AnnotationProjection();
    projection.upsert({
      ...viewportAnnotation('temporary-red', 'selection-red'),
      color: '#ff6666',
      comment: 'Red comment',
    });
    projection.upsert({
      ...viewportAnnotation('temporary-blue', 'selection-blue'),
      color: '#2f80ed',
      comment: 'Blue comment',
    });
    const red = {
      ...verifiedAnnotation('stable-red'),
      color: '#ff6666',
      comment: 'Red comment',
    };
    const blue = {
      ...verifiedAnnotation('stable-blue'),
      color: '#2f80ed',
      comment: 'Blue comment',
    };

    projection.reconcile([blue, red]);

    expect(
      projection.snapshot().map((row) => ({
        key: row.key,
        nativeId: row.nativeId,
        color: row.annotation.color,
        comment: row.annotation.comment,
      })),
    ).toEqual([
      {
        key: 'annotation-row-1',
        nativeId: 'stable-blue',
        color: '#2f80ed',
        comment: 'Blue comment',
      },
      {
        key: 'annotation-row-0',
        nativeId: 'stable-red',
        color: '#ff6666',
        comment: 'Red comment',
      },
    ]);

    projection.reconcile([
      { ...red, comment: 'Red confirmed again' },
      { ...blue, comment: 'Blue confirmed again' },
    ]);
    expect(
      projection.snapshot().map((row) => ({
        key: row.key,
        nativeId: row.nativeId,
        comment: row.annotation.comment,
      })),
    ).toEqual([
      {
        key: 'annotation-row-0',
        nativeId: 'stable-red',
        comment: 'Red confirmed again',
      },
      {
        key: 'annotation-row-1',
        nativeId: 'stable-blue',
        comment: 'Blue confirmed again',
      },
    ]);
  });

  it('causally binds coalesced exact duplicate creations without replacing their row keys', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('internal-a', 'selection-a'), 1);
    projection.bindCommittedSelection('selection-a', verifiedAnnotation('internal-a'), 1);
    projection.upsert(viewportAnnotation('internal-b', 'selection-b'), 2);
    projection.bindCommittedSelection('selection-b', verifiedAnnotation('internal-b'), 2);

    projection.reconcile([verifiedAnnotation('stable-a'), verifiedAnnotation('stable-b')], 2);
    const beforeRemoval = projection
      .snapshot()
      .map((row) => ({ key: row.key, nativeId: row.nativeId, runtimeId: row.runtimeId }));
    projection.remove('stable-a');

    expect({ beforeRemoval, afterRemoval: projection.snapshot().map((row) => row.key) }).toEqual({
      beforeRemoval: [
        { key: 'annotation-row-0', nativeId: 'stable-a', runtimeId: 'internal-a' },
        { key: 'annotation-row-1', nativeId: 'stable-b', runtimeId: 'internal-b' },
      ],
      afterRemoval: ['annotation-row-1'],
    });
  });

  it('does not swap overlapping row identities when verified PDF object ids are renumbered', () => {
    const projection = new AnnotationProjection();
    const first = { ...verifiedAnnotation('internal-a'), comment: 'First' };
    const second = { ...verifiedAnnotation('internal-b'), comment: 'Second' };
    projection.upsert({ ...viewportAnnotation('internal-a', 'selection-a'), comment: 'First' }, 1);
    projection.bindCommittedSelection('selection-a', first, 1);
    projection.upsert({ ...viewportAnnotation('internal-b', 'selection-b'), comment: 'Second' }, 2);
    projection.bindCommittedSelection('selection-b', second, 2);
    projection.reconcile(
      [
        { ...first, identity: { kind: 'stable', id: '29R' as AnnotationId } },
        { ...second, identity: { kind: 'stable', id: '30R' as AnnotationId } },
      ],
      2,
    );

    projection.reconcile(
      [
        { ...first, identity: { kind: 'stable', id: '30R' as AnnotationId } },
        { ...second, identity: { kind: 'stable', id: '31R' as AnnotationId } },
      ],
      3,
    );

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
        runtimeId: row.runtimeId,
      })),
    ).toEqual([
      {
        comment: 'First',
        key: 'annotation-row-0',
        nativeId: '30R',
        runtimeId: 'internal-a',
      },
      {
        comment: 'Second',
        key: 'annotation-row-1',
        nativeId: '31R',
        runtimeId: 'internal-b',
      },
    ]);
  });

  it('preserves causal order when identical overlapping PDF objects are renumbered', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('internal-a', 'selection-a'), 1);
    projection.bindCommittedSelection('selection-a', verifiedAnnotation('internal-a'), 1);
    projection.upsert(viewportAnnotation('internal-b', 'selection-b'), 2);
    projection.bindCommittedSelection('selection-b', verifiedAnnotation('internal-b'), 2);
    projection.reconcile([verifiedAnnotation('29R'), verifiedAnnotation('30R')], 2);

    projection.reconcile([verifiedAnnotation('30R'), verifiedAnnotation('31R')], 3);

    expect(
      projection.snapshot().map((row) => ({
        key: row.key,
        nativeId: row.nativeId,
        runtimeId: row.runtimeId,
      })),
    ).toEqual([
      { key: 'annotation-row-0', nativeId: '30R', runtimeId: 'internal-a' },
      { key: 'annotation-row-1', nativeId: '31R', runtimeId: 'internal-b' },
    ]);
  });

  it('keeps a canonical row distinct from a neighbours retained historical alias', () => {
    const projection = renumberedOverlapProjection();
    const before = projection.snapshot();

    projection.upsert({
      ...viewportAnnotation('30R'),
      comment: 'First live',
      runtimeId: 'internal-a',
    });

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
        runtimeId: row.runtimeId,
      })),
    ).toEqual([
      {
        comment: 'First live',
        key: before[0]?.key,
        nativeId: '30R',
        runtimeId: 'internal-a',
      },
      {
        comment: 'Second',
        key: before[1]?.key,
        nativeId: '31R',
        runtimeId: 'internal-b',
      },
    ]);
  });

  it('removes only the canonical row when another row retains that id as history', () => {
    const projection = renumberedOverlapProjection();

    expect(projection.remove('30R')).toBe(true);
    expect(
      projection
        .snapshot()
        .map((row) => ({ comment: row.annotation.comment, nativeId: row.nativeId })),
    ).toEqual([{ comment: 'Second', nativeId: '31R' }]);
  });

  it('edits only the canonical row when another row retains that id as history', () => {
    const projection = renumberedOverlapProjection();
    const canonical = projection.snapshot()[0]?.annotation;
    if (canonical === undefined) throw new Error('Expected canonical overlap row.');

    expect(
      projection.applyEditorUpdate({ annotations: [canonical], comment: 'First edited' }, 4),
    ).toBe(true);
    expect(
      projection
        .snapshot()
        .map((row) => ({ comment: row.annotation.comment, nativeId: row.nativeId })),
    ).toEqual([
      { comment: 'First edited', nativeId: '30R' },
      { comment: 'Second', nativeId: '31R' },
    ]);
  });

  it('keeps canonical overlap identities when row order reverses under an optimistic overlay', () => {
    const projection = renumberedOverlapProjection();
    const [firstRow, secondRow] = projection.snapshot();
    if (firstRow === undefined || secondRow === undefined)
      throw new Error('Expected two overlap rows.');
    projection.reconcile(
      [
        { ...secondRow.annotation, comment: 'Second' },
        { ...firstRow.annotation, comment: 'First' },
      ],
      4,
    );
    const first = projection.snapshot().find((row) => row.key === firstRow.key)?.annotation;
    if (first === undefined) throw new Error('Expected first canonical row after reorder.');
    projection.applyEditorUpdate({ annotations: [first], comment: 'Optimistic A' }, 6);

    projection.reconcile(
      [
        { ...firstRow.annotation, comment: 'First' },
        { ...secondRow.annotation, comment: 'Second' },
      ],
      5,
    );

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
        runtimeId: row.runtimeId,
      })),
    ).toEqual([
      {
        comment: 'Optimistic A',
        key: firstRow.key,
        nativeId: '30R',
        runtimeId: 'internal-a',
      },
      {
        comment: 'Second',
        key: secondRow.key,
        nativeId: '31R',
        runtimeId: 'internal-b',
      },
    ]);
  });

  it('reserves every canonical overlap identity before replaying a newer deletion', () => {
    const projection = renumberedOverlapProjection();
    const [firstRow, secondRow] = projection.snapshot();
    if (firstRow === undefined || secondRow === undefined)
      throw new Error('Expected two renumbered overlap rows.');

    projection.remove(firstRow.nativeId, 'selection-a', 5);
    projection.reconcile(
      [
        { ...firstRow.annotation, comment: 'First' },
        { ...secondRow.annotation, comment: 'Second' },
      ],
      4,
    );

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
        runtimeId: row.runtimeId,
      })),
    ).toEqual([
      {
        comment: 'Second',
        key: secondRow.key,
        nativeId: '31R',
        runtimeId: 'internal-b',
      },
    ]);
  });

  it('keeps exact stable ids when an edited overlap adopts a neighbours old content', () => {
    const projection = new AnnotationProjection();
    const first = { ...verifiedAnnotation('29R'), comment: 'First' };
    const second = { ...verifiedAnnotation('30R'), comment: 'Second' };
    projection.reconcile([first, second], 1);

    projection.reconcile(
      [
        { ...first, comment: 'Second' },
        { ...second, comment: 'Third' },
      ],
      2,
    );

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
      })),
    ).toEqual([
      { comment: 'Second', key: 'annotation-row-0', nativeId: '29R' },
      { comment: 'Third', key: 'annotation-row-1', nativeId: '30R' },
    ]);
  });

  it('does not swap optimistic overlap overlays when an older verified scan arrives', () => {
    const projection = new AnnotationProjection();
    const first = { ...verifiedAnnotation('29R'), comment: 'First' };
    const second = { ...verifiedAnnotation('30R'), comment: 'Second' };
    projection.reconcile([first, second], 1);
    projection.applyEditorUpdate({ annotations: [first], comment: 'Second' }, 3);
    projection.applyEditorUpdate({ annotations: [second], comment: 'Third' }, 3);

    projection.reconcile([first, second], 2);

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
      })),
    ).toEqual([
      { comment: 'Second', key: 'annotation-row-0', nativeId: '29R' },
      { comment: 'Third', key: 'annotation-row-1', nativeId: '30R' },
    ]);
  });

  it('does not mistake swapped optimistic overlap comments for object-id renumbering', () => {
    const projection = new AnnotationProjection();
    const first = { ...verifiedAnnotation('29R'), comment: 'First' };
    const second = { ...verifiedAnnotation('30R'), comment: 'Second' };
    projection.reconcile([first, second], 1);
    projection.applyEditorUpdate({ annotations: [first], comment: 'Second' }, 3);
    projection.applyEditorUpdate({ annotations: [second], comment: 'First' }, 3);

    projection.reconcile([first, second], 2);

    expect(
      projection.snapshot().map((row) => ({
        comment: row.annotation.comment,
        key: row.key,
        nativeId: row.nativeId,
      })),
    ).toEqual([
      { comment: 'Second', key: 'annotation-row-0', nativeId: '29R' },
      { comment: 'First', key: 'annotation-row-1', nativeId: '30R' },
    ]);
  });

  it('causally binds a normalized toolbar creation without a selection token', () => {
    const projection = new AnnotationProjection();
    const snapshot = {
      ...viewportAnnotation('internal-freetext'),
      type: 'free-text' as const,
    };
    const verified = {
      ...verifiedAnnotation('29R'),
      type: 'free-text' as const,
      anchor: {
        kind: 'fixed-page' as const,
        pageIndex: 1,
        coordinateSpace: 'page-points-top-left' as const,
        geometry: { kind: 'point' as const, point: { x: 10, y: 20 } },
      },
    };

    projection.upsert(snapshot, 1);
    projection.reconcile([verified], 1);

    expect(projection.snapshot()).toMatchObject([
      {
        key: 'annotation-row-0',
        nativeId: '29R',
        runtimeId: 'internal-freetext',
      },
    ]);
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
      nativeId: 'stable-id',
      provisionalId: 'pdfjs_internal_editor_0',
      runtimeId: 'pdfjs_internal_editor_0',
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

  it('ignores a stale mounted-editor removal after that row receives a new runtime id', () => {
    const projection = new AnnotationProjection();
    projection.upsert(viewportAnnotation('internal-a', 'selection-a'));
    projection.reconcile([verifiedAnnotation('29R')]);
    const key = projection.snapshot()[0]?.key;
    projection.upsert({ ...viewportAnnotation('29R'), runtimeId: 'remounted-a' });

    expect(projection.remove('internal-a', 'selection-a')).toBe(false);
    projection.upsert({ ...viewportAnnotation('29R'), runtimeId: 'remounted-a' });

    expect(projection.snapshot()).toMatchObject([
      {
        key,
        nativeId: '29R',
        runtimeId: 'remounted-a',
      },
    ]);
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
