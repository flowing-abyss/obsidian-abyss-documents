import type { DataAdapter } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AnnotationCache, type AnnotationCacheV2 } from './annotation-cache.js';
import { asAnnotationId } from './document-core/annotations.js';

const CONFIG_DIR = '.config-test';

function adapter(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const read = vi.fn(async (path: string) => {
    const found = files.get(path);
    if (found === undefined) throw new Error('missing');
    return found;
  });
  const write = vi.fn(async (path: string, data: string) => {
    files.set(path, data);
  });
  const value = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read,
    write,
    mkdir: vi.fn(async () => undefined),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  } as unknown as DataAdapter;
  return { files, read, value, write };
}

const record: AnnotationCacheV2 = {
  version: 2,
  documentPath: 'Books/Guide.pdf',
  fingerprint: 'fp',
  annotations: [
    {
      identity: { kind: 'stable', id: asAnnotationId('cached-annotation') },
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 12, y: 24 } },
      },
      color: '#ffd400',
      selectedText: 'Cached text',
      author: 'Reader',
      createdAt: null,
      modifiedAt: null,
      comment: '',
      tags: ['review'],
      links: ['Notes/Review'],
      capabilities: {
        geometry: { available: true },
        comment: { available: true },
        color: { available: true },
        deletion: { available: true },
        metadata: { available: true },
        conversions: {
          highlight: { available: true },
          underline: { available: false, reason: { code: 'lossy-conversion', message: 'No' } },
        },
      },
    },
  ],
};

function cachedAnnotation(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record.annotations[0])) as Record<string, unknown>;
}

describe('AnnotationCache', () => {
  it('ignores an annotations-v1 partition containing structural rows and writability state', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const currentPath = await cache.partitionPath(record.documentPath);
    const oldPath = currentPath.replace('/annotations-v2/', '/annotations-v1/');
    fixture.files.set(
      oldPath,
      JSON.stringify({
        ...record,
        version: 1,
        annotations: [
          {
            ...cachedAnnotation(),
            type: 'unsupported',
            externalType: 'Link',
            writable: false,
          },
        ],
      }),
    );

    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    expect(fixture.files.has(oldPath)).toBe(true);
  });

  it('writes cache v2 without transient materialization or binding state', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const transient = {
      ...record,
      pendingRevision: 7,
      annotations: record.annotations.map((annotation) => ({
        ...annotation,
        materialized: true,
        bound: { nativeId: 'temporary-binding' },
      })),
    };

    await cache.write(transient);

    const payload = JSON.parse([...fixture.files.values()][0] ?? 'null') as Record<string, unknown>;
    expect(payload['version']).toBe(2);
    expect(payload).not.toHaveProperty('pendingRevision');
    expect((payload['annotations'] as unknown[])[0]).not.toHaveProperty('materialized');
    expect((payload['annotations'] as unknown[])[0]).not.toHaveProperty('bound');
  });

  it('uses a bounded SHA-256 partition for long Cyrillic paths and still verifies the source path', async () => {
    const documentPath =
      'Библиотека/Очень длинное название документа на русском языке с повторяющимися словами и символами.pdf';
    const neighboringPath = documentPath.replace('символами', 'символом');
    expect(
      new TextEncoder().encode(`${encodeURIComponent(documentPath)}.json`).byteLength,
    ).toBeGreaterThan(255);
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);

    const path = await cache.partitionPath(documentPath);
    const repeatedPath = await cache.partitionPath(documentPath);
    const neighboringPartition = await cache.partitionPath(neighboringPath);
    const basename = path.slice(path.lastIndexOf('/') + 1);

    expect(path).toBe(repeatedPath);
    expect(basename).toMatch(/^[0-9a-f]{64}\.json$/u);
    expect(new TextEncoder().encode(basename).byteLength).toBeLessThanOrEqual(255);
    expect(neighboringPartition).not.toBe(path);

    const longPathRecord = { ...record, documentPath };
    await cache.write(longPathRecord);
    await expect(cache.read(documentPath, record.fingerprint)).resolves.toEqual(record.annotations);
    await expect(cache.read(neighboringPath, record.fingerprint)).resolves.toBeNull();
  });

  it('stores the derived partition below configDir and reads only a matching fingerprint', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    await cache.write(record);

    expect([...fixture.files.keys()][0]).toMatch(
      /^\.config-test\/plugins\/abyss-documents\/cache\/annotations-v2\//u,
    );
    await expect(cache.read('Books/Guide.pdf', 'fp')).resolves.toEqual(record.annotations);
    await expect(cache.read('Books/Guide.pdf', 'other')).resolves.toBeNull();
  });

  it.each(['not json', JSON.stringify({ ...record, version: 3 })])(
    'deletes a corrupt or future cache partition and permits a rebuild: %s',
    async (payload) => {
      const fixture = adapter();
      const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
      const path = await cache.partitionPath(record.documentPath);
      fixture.files.set(path, payload);

      await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
      expect(fixture.files.has(path)).toBe(false);
      await cache.write(record);
      expect(fixture.files.has(path)).toBe(true);
    },
  );

  it('deletes a partition containing malformed annotation records', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = await cache.partitionPath(record.documentPath);
    fixture.files.set(path, JSON.stringify({ ...record, annotations: [{}] }));
    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    expect(fixture.files.has(path)).toBe(false);
  });

  it.each([null, { identity: {}, type: 'highlight' }, { identity: {}, anchor: {} }])(
    'deletes malformed cache annotation shape %#',
    async (annotation) => {
      const fixture = adapter();
      const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
      const path = await cache.partitionPath(record.documentPath);
      fixture.files.set(path, JSON.stringify({ ...record, annotations: [annotation] }));
      await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    },
  );

  it.each([
    ['missing tags', { tags: undefined }],
    ['null links', { links: null }],
    ['wrong comment type', { comment: 4 }],
    ['unknown annotation discriminant', { type: 'strikeout' }],
    ['malformed identity', { identity: { kind: 'stable', id: '' } }],
    ['malformed anchor', { anchor: { kind: 'fixed-page', pageIndex: -1 } }],
    [
      'malformed nested geometry',
      {
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'rectangle', rectangle: { x: 0, y: null, width: 1, height: 1 } },
        },
      },
    ],
    ['malformed capabilities', { capabilities: { geometry: { available: true } } }],
  ])('deletes a cache record with %s', async (_label, override) => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = await cache.partitionPath(record.documentPath);
    fixture.files.set(
      path,
      JSON.stringify({
        ...record,
        annotations: [{ ...record.annotations[0], ...override }],
      }),
    );

    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    expect(fixture.files.has(path)).toBe(false);
  });

  it('accepts every persisted annotation, anchor, geometry, identity, and reason discriminant', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = await cache.partitionPath(record.documentPath);
    const types = ['highlight', 'underline', 'ink', 'text-note', 'free-text', 'unsupported'];
    const reasons = [
      'document-read-only',
      'signed-document',
      'encrypted-document',
      'permission-restricted',
      'pure-xfa',
      'unsupported-annotation',
      'unsupported-adapter',
      'identity-conflict',
      'lossy-conversion',
    ];
    const geometries = [
      { kind: 'point', point: { x: 1, y: 2 } },
      { kind: 'rectangle', rectangle: { x: 1, y: 2, width: 3, height: 4 } },
      {
        kind: 'quadrilaterals',
        quadrilaterals: [
          {
            bottomLeft: { x: 1, y: 2 },
            bottomRight: { x: 3, y: 2 },
            topLeft: { x: 1, y: 4 },
            topRight: { x: 3, y: 4 },
          },
        ],
      },
      { kind: 'ink', paths: [[{ x: 1, y: 2 }]] },
    ];
    const annotations = reasons.map((code, index) => {
      const value = cachedAnnotation();
      value['type'] = types[index % types.length];
      value['identity'] = { kind: 'legacy', fingerprint: `legacy-${index}` };
      value['externalType'] = 'pdf-type';
      value['createdAt'] = '2026-08-11T12:00:00.000Z';
      value['modifiedAt'] = '2026-08-12T12:00:00.000Z';
      value['anchor'] =
        index === 0
          ? {
              kind: 'reflowable-text',
              selector: { exact: 'text', prefix: '', suffix: '' },
              progression: 0.5,
            }
          : {
              kind: 'fixed-page',
              pageIndex: index,
              coordinateSpace: 'page-points-top-left',
              geometry: geometries[index % geometries.length],
            };
      const unavailable = { available: false, reason: { code, message: 'Unavailable' } };
      value['capabilities'] = {
        geometry: unavailable,
        comment: unavailable,
        color: unavailable,
        deletion: unavailable,
        metadata: unavailable,
        conversions: { highlight: unavailable, underline: unavailable },
      };
      return value;
    });
    fixture.files.set(path, JSON.stringify({ ...record, annotations }));

    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toHaveLength(9);
  });

  it.each([
    ['empty document path', { documentPath: '' }],
    ['empty fingerprint', { fingerprint: '' }],
    ['non-array annotations', { annotations: null }],
  ])('deletes malformed cache root: %s', async (_label, override) => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = await cache.partitionPath(record.documentPath);
    fixture.files.set(path, JSON.stringify({ ...record, ...override }));
    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
  });

  it.each([
    ['external type', { externalType: 2 }],
    ['color', { color: 2 }],
    ['selected text', { selectedText: [] }],
    ['author', { author: null }],
    ['created timestamp type', { createdAt: 4 }],
    ['created timestamp value', { createdAt: 'not-a-date' }],
    ['modified timestamp normalization', { modifiedAt: '2026-08-11' }],
    ['tag entry', { tags: ['ok', 2] }],
    ['link entry', { links: [null] }],
    ['legacy identity', { identity: { kind: 'legacy', fingerprint: '' } }],
    ['identity record', { identity: [] }],
    ['anchor record', { anchor: null }],
    [
      'reflowable selector',
      { anchor: { kind: 'reflowable-text', selector: null, progression: null } },
    ],
    [
      'reflowable selector exact',
      {
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 1, prefix: '', suffix: '' },
          progression: null,
        },
      },
    ],
    [
      'reflowable progression',
      {
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: '', prefix: '', suffix: '' },
          progression: 2,
        },
      },
    ],
    [
      'rectangle size',
      {
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'rectangle', rectangle: { x: 0, y: 0, width: -1, height: 1 } },
        },
      },
    ],
    [
      'quadrilateral point',
      {
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'quadrilaterals', quadrilaterals: [{ topLeft: null }] },
        },
      },
    ],
    [
      'ink path',
      {
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'ink', paths: [null] },
        },
      },
    ],
    ['capability reason', { capabilities: { conversions: {} } }],
  ])('rejects malformed nested persisted field: %s', async (_label, override) => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = await cache.partitionPath(record.documentPath);
    fixture.files.set(
      path,
      JSON.stringify({ ...record, annotations: [{ ...cachedAnnotation(), ...override }] }),
    );
    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
  });

  it('invalidates modify/delete and moves no derived state on rename', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    await cache.write(record);
    await cache.invalidate(record.documentPath);
    expect(fixture.files.size).toBe(0);
  });

  it('rejects a stale extraction write after invalidation advances the generation', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const generation = cache.generation(record.documentPath);
    await cache.invalidate(record.documentPath);

    await expect(cache.write(record, generation)).resolves.toBe(false);
    expect(fixture.files.size).toBe(0);
    await expect(cache.write(record, cache.generation(record.documentPath))).resolves.toBe(true);
  });

  it('removes a write invalidated while the adapter is persisting it', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    fixture.write.mockImplementation(async (path, data) => {
      fixture.files.set(path, data);
      await cache.invalidate(record.documentPath);
    });

    await expect(cache.write(record)).resolves.toBe(false);
    expect(fixture.files.size).toBe(0);
  });

  it('rejects a read invalidated while the adapter is loading it', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = await cache.partitionPath(record.documentPath);
    fixture.files.set(path, JSON.stringify(record));
    let releaseRead: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    fixture.read.mockImplementation(async () => {
      await blocked;
      return JSON.stringify(record);
    });
    const generation = cache.generation(record.documentPath);
    const reading = cache.read(record.documentPath, record.fingerprint, generation);
    await vi.waitFor(() => {
      expect(fixture.read).toHaveBeenCalled();
    });
    await cache.invalidate(record.documentPath);
    releaseRead?.();

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects valid-shaped data for a different path without deleting it', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = await cache.partitionPath(record.documentPath);
    fixture.files.set(path, JSON.stringify({ ...record, documentPath: 'Other.pdf' }));
    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    expect(fixture.files.has(path)).toBe(true);
  });
});
