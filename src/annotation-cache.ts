import type { DataAdapter } from 'obsidian';
import type {
  AnnotationAnchor,
  AnnotationCapabilities,
  AnnotationCapability,
  AnnotationGeometry,
  AnnotationIdentity,
  AnnotationPoint,
  DocumentAnnotation,
} from './document-core/annotations.js';

export interface AnnotationCacheV1 {
  readonly version: 1;
  readonly documentPath: string;
  readonly fingerprint: string;
  readonly annotations: readonly DocumentAnnotation[];
}

export class StaleAnnotationCacheReadError extends Error {
  override readonly name = 'AbortError';

  constructor() {
    super('The annotation cache changed while it was being read.');
  }
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

  async partitionPath(documentPath: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(documentPath));
    const key = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return `${this.root}/${key}.json`;
  }

  async read(
    documentPath: string,
    fingerprint: string,
    generation = this.generation(documentPath),
  ): Promise<readonly DocumentAnnotation[] | null> {
    const path = await this.partitionPath(documentPath);
    this.assertCurrent(documentPath, generation);
    const exists = await this.adapter.exists(path);
    this.assertCurrent(documentPath, generation);
    if (!exists) return null;
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      this.assertCurrent(documentPath, generation);
      await this.removeIfPresent(path);
      this.assertCurrent(documentPath, generation);
      return null;
    }
    this.assertCurrent(documentPath, generation);
    if (!isCacheV1(value)) {
      await this.removeIfPresent(path);
      this.assertCurrent(documentPath, generation);
      return null;
    }
    if (value.documentPath !== documentPath || value.fingerprint !== fingerprint) {
      this.assertCurrent(documentPath, generation);
      return null;
    }
    this.assertCurrent(documentPath, generation);
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
    const path = await this.partitionPath(value.documentPath);
    await this.adapter.write(path, JSON.stringify(value));
    if (generation === this.generation(value.documentPath)) return true;
    await this.removeIfPresent(path);
    return false;
  }

  async invalidate(documentPath: string): Promise<void> {
    this.generations.set(documentPath, this.generation(documentPath) + 1);
    await this.removeIfPresent(await this.partitionPath(documentPath));
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

  private assertCurrent(documentPath: string, generation: number): void {
    if (generation !== this.generation(documentPath)) throw new StaleAnnotationCacheReadError();
  }
}

function isCacheV1(value: unknown): value is AnnotationCacheV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AnnotationCacheV1>;
  return (
    candidate.version === 1 &&
    isNonEmptyString(candidate.documentPath) &&
    isNonEmptyString(candidate.fingerprint) &&
    Array.isArray(candidate.annotations) &&
    candidate.annotations.every(isCachedAnnotation)
  );
}

function isCachedAnnotation(value: unknown): value is DocumentAnnotation {
  if (!isRecord(value)) return false;
  return (
    isIdentity(value['identity']) &&
    isAnnotationType(value['type']) &&
    isAnchor(value['anchor']) &&
    hasAnnotationMetadata(value) &&
    isCapabilities(value['capabilities'])
  );
}

function hasAnnotationMetadata(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value['externalType'] === undefined || typeof value['externalType'] === 'string') &&
    isNullableString(value['color']) &&
    isNullableString(value['selectedText']) &&
    typeof value['author'] === 'string' &&
    isTimestamp(value['createdAt']) &&
    isTimestamp(value['modifiedAt']) &&
    typeof value['comment'] === 'string' &&
    isStringArray(value['tags']) &&
    isStringArray(value['links'])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is AnnotationIdentity {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'stable') return isNonEmptyString(value['id']);
  if (value['kind'] === 'legacy') return isNonEmptyString(value['fingerprint']);
  return false;
}

function isAnnotationType(value: unknown): boolean {
  return (
    value === 'highlight' ||
    value === 'underline' ||
    value === 'ink' ||
    value === 'text-note' ||
    value === 'free-text' ||
    value === 'unsupported'
  );
}

function isAnchor(value: unknown): value is AnnotationAnchor {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'fixed-page') return isFixedPageAnchor(value);
  return value['kind'] === 'reflowable-text' && isReflowableAnchor(value);
}

function isFixedPageAnchor(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isNonNegativeInteger(value['pageIndex']) &&
    value['coordinateSpace'] === 'page-points-top-left' &&
    isGeometry(value['geometry'])
  );
}

function isReflowableAnchor(value: Readonly<Record<string, unknown>>): boolean {
  if (!isRecord(value['selector'])) return false;
  const selector = value['selector'];
  return (
    typeof selector['exact'] === 'string' &&
    typeof selector['prefix'] === 'string' &&
    typeof selector['suffix'] === 'string' &&
    (value['progression'] === null ||
      (isFiniteNumber(value['progression']) &&
        value['progression'] >= 0 &&
        value['progression'] <= 1))
  );
}

function isGeometry(value: unknown): value is AnnotationGeometry {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'point') return isPoint(value['point']);
  if (value['kind'] === 'rectangle') return isRectangle(value['rectangle']);
  if (value['kind'] === 'quadrilaterals') return isQuadrilaterals(value['quadrilaterals']);
  return value['kind'] === 'ink' && isInkPaths(value['paths']);
}

function isRectangle(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const width = value['width'];
  const height = value['height'];
  return (
    isPoint(value) && isFiniteNumber(width) && width >= 0 && isFiniteNumber(height) && height >= 0
  );
}

function isQuadrilaterals(value: unknown): boolean {
  return Array.isArray(value) && value.every(isQuadrilateral);
}

function isQuadrilateral(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPoint(value['bottomLeft']) &&
    isPoint(value['bottomRight']) &&
    isPoint(value['topLeft']) &&
    isPoint(value['topRight'])
  );
}

function isInkPaths(value: unknown): boolean {
  return Array.isArray(value) && value.every((path) => Array.isArray(path) && path.every(isPoint));
}

function isPoint(value: unknown): value is AnnotationPoint {
  return isRecord(value) && isFiniteNumber(value['x']) && isFiniteNumber(value['y']);
}

function isCapabilities(value: unknown): value is AnnotationCapabilities {
  if (!isRecord(value) || !isRecord(value['conversions'])) return false;
  return (
    isCapability(value['geometry']) &&
    isCapability(value['comment']) &&
    isCapability(value['color']) &&
    isCapability(value['deletion']) &&
    isCapability(value['metadata']) &&
    isCapability(value['conversions']['highlight']) &&
    isCapability(value['conversions']['underline'])
  );
}

function isCapability(value: unknown): value is AnnotationCapability {
  if (!isRecord(value)) return false;
  if (value['available'] === true) return true;
  if (value['available'] !== false || !isRecord(value['reason'])) return false;
  return (
    isUnavailableCode(value['reason']['code']) && typeof value['reason']['message'] === 'string'
  );
}

function isUnavailableCode(value: unknown): boolean {
  return (
    value === 'document-read-only' ||
    value === 'signed-document' ||
    value === 'encrypted-document' ||
    value === 'permission-restricted' ||
    value === 'pure-xfa' ||
    value === 'unsupported-annotation' ||
    value === 'unsupported-adapter' ||
    value === 'identity-conflict' ||
    value === 'lossy-conversion'
  );
}

function isTimestamp(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
