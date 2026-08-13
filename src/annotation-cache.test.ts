import type { DataAdapter } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AnnotationCache, type AnnotationCacheV1 } from './annotation-cache.js';

const CONFIG_DIR = '.config-test';

function adapter(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const write = vi.fn(async (path: string, data: string) => {
    files.set(path, data);
  });
  const value = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const found = files.get(path);
      if (found === undefined) throw new Error('missing');
      return found;
    }),
    write,
    mkdir: vi.fn(async () => undefined),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  } as unknown as DataAdapter;
  return { files, value, write };
}

const record: AnnotationCacheV1 = {
  version: 1,
  documentPath: 'Books/Guide.pdf',
  fingerprint: 'fp',
  annotations: [],
};

describe('AnnotationCache', () => {
  it('stores the derived partition below configDir and reads only a matching fingerprint', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    await cache.write(record);

    expect([...fixture.files.keys()][0]).toMatch(
      /^\.config-test\/plugins\/abyss-documents\/cache\/annotations-v1\//u,
    );
    await expect(cache.read('Books/Guide.pdf', 'fp')).resolves.toEqual(record.annotations);
    await expect(cache.read('Books/Guide.pdf', 'other')).resolves.toBeNull();
  });

  it.each(['not json', JSON.stringify({ ...record, version: 2 })])(
    'deletes a corrupt or future cache partition and permits a rebuild: %s',
    async (payload) => {
      const fixture = adapter();
      const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
      const path = cache.partitionPath(record.documentPath);
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
    const path = cache.partitionPath(record.documentPath);
    fixture.files.set(path, JSON.stringify({ ...record, annotations: [{}] }));
    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    expect(fixture.files.has(path)).toBe(false);
  });

  it.each([null, { identity: {}, type: 'highlight' }, { identity: {}, anchor: {} }])(
    'deletes malformed cache annotation shape %#',
    async (annotation) => {
      const fixture = adapter();
      const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
      const path = cache.partitionPath(record.documentPath);
      fixture.files.set(path, JSON.stringify({ ...record, annotations: [annotation] }));
      await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    },
  );

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

  it('rejects valid-shaped data for a different path without deleting it', async () => {
    const fixture = adapter();
    const cache = new AnnotationCache(fixture.value, CONFIG_DIR);
    const path = cache.partitionPath(record.documentPath);
    fixture.files.set(path, JSON.stringify({ ...record, documentPath: 'Other.pdf' }));
    await expect(cache.read(record.documentPath, record.fingerprint)).resolves.toBeNull();
    expect(fixture.files.has(path)).toBe(true);
  });
});
