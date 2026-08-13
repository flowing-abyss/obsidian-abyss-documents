import type { DataAdapter } from 'obsidian';
import type { DocumentAnnotation } from './document-core/annotations.js';

export interface AnnotationCacheV1 {
  readonly version: 1;
  readonly documentPath: string;
  readonly fingerprint: string;
  readonly annotations: readonly DocumentAnnotation[];
}

export class AnnotationCache {
  private readonly root: string;
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly adapter: DataAdapter,
    configDir: string,
  ) {
    this.root = `${configDir}/plugins/abyss-documents/cache/annotations-v1`;
  }

  partitionPath(documentPath: string): string {
    return `${this.root}/${encodeURIComponent(documentPath)}.json`;
  }

  async read(
    documentPath: string,
    fingerprint: string,
  ): Promise<readonly DocumentAnnotation[] | null> {
    const path = this.partitionPath(documentPath);
    if (!(await this.adapter.exists(path))) return null;
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      await this.removeIfPresent(path);
      return null;
    }
    if (!isCacheV1(value)) {
      await this.removeIfPresent(path);
      return null;
    }
    if (value.documentPath !== documentPath || value.fingerprint !== fingerprint) return null;
    return value.annotations;
  }

  generation(documentPath: string): number {
    return this.generations.get(documentPath) ?? 0;
  }

  async write(
    value: AnnotationCacheV1,
    generation = this.generation(value.documentPath),
  ): Promise<boolean> {
    if (generation !== this.generation(value.documentPath)) return false;
    await this.ensureRoot();
    if (generation !== this.generation(value.documentPath)) return false;
    await this.adapter.write(this.partitionPath(value.documentPath), JSON.stringify(value));
    if (generation === this.generation(value.documentPath)) return true;
    await this.removeIfPresent(this.partitionPath(value.documentPath));
    return false;
  }

  async invalidate(documentPath: string): Promise<void> {
    this.generations.set(documentPath, this.generation(documentPath) + 1);
    await this.removeIfPresent(this.partitionPath(documentPath));
  }

  private async ensureRoot(): Promise<void> {
    const segments = this.root.split('/');
    let path = '';
    for (const segment of segments) {
      path = path.length === 0 ? segment : `${path}/${segment}`;
      if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    }
  }

  private async removeIfPresent(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

function isCacheV1(value: unknown): value is AnnotationCacheV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AnnotationCacheV1>;
  return (
    candidate.version === 1 &&
    typeof candidate.documentPath === 'string' &&
    typeof candidate.fingerprint === 'string' &&
    Array.isArray(candidate.annotations) &&
    candidate.annotations.every(isCachedAnnotation)
  );
}

function isCachedAnnotation(value: unknown): value is DocumentAnnotation {
  if (typeof value !== 'object' || value === null) return false;
  return 'identity' in value && 'type' in value && 'anchor' in value;
}
