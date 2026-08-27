import type {
  AnnotationCapabilities,
  AnnotationGeometry,
  AnnotationId,
  DocumentAnnotation,
} from '../document-core/annotations.js';
import type {
  ViewportAnnotationChange,
  ViewportAnnotationSnapshot,
} from '../document-core/document.js';

export interface AnnotationProjectionRow {
  readonly key: string;
  readonly annotation: DocumentAnnotation;
  readonly nativeId: string;
  readonly provisionalId?: string;
  readonly writable: boolean;
}

interface CandidateQueue {
  index: number;
  readonly rows: AnnotationProjectionRow[];
}

export class AnnotationProjection {
  private rows: AnnotationProjectionRow[] = [];
  private nextKey = 0;

  snapshot(): readonly AnnotationProjectionRow[] {
    return this.rows;
  }

  annotations(): readonly DocumentAnnotation[] {
    return this.rows.map((row) => row.annotation);
  }

  apply(change: ViewportAnnotationChange): boolean {
    return change.operation === 'upsert'
      ? this.upsert(change.annotation)
      : this.remove(change.nativeId, change.provisionalId);
  }

  reset(): void {
    this.rows = [];
    this.nextKey = 0;
  }

  upsert(snapshot: ViewportAnnotationSnapshot): boolean {
    const identities = new Set([snapshot.nativeId]);
    if (snapshot.provisionalId !== undefined) identities.add(snapshot.provisionalId);
    const matches = this.rows.filter(
      (row) =>
        identities.has(row.nativeId) ||
        (row.provisionalId !== undefined && identities.has(row.provisionalId)),
    );
    const current = matches[0];
    if (current !== undefined) {
      if (matches.length === 1 && rowMatchesSnapshot(current, snapshot)) return false;
      const duplicateKeys = new Set(matches.slice(1).map((row) => row.key));
      this.rows = this.rows
        .filter((row) => !duplicateKeys.has(row.key))
        .map((row) =>
          row.key === current.key ? this.rowFromSnapshot(current.key, snapshot) : row,
        );
      return true;
    }
    this.rows = [...this.rows, this.createRow(snapshot)];
    return true;
  }

  remove(nativeId: string, provisionalId?: string): boolean {
    const previousLength = this.rows.length;
    this.rows = this.rows.filter(
      (row) =>
        row.nativeId !== nativeId &&
        (provisionalId === undefined || row.provisionalId !== provisionalId),
    );
    return this.rows.length !== previousLength;
  }

  reconcile(
    verified: readonly DocumentAnnotation[],
    options: { readonly retainUnmatched?: boolean } = {},
  ): boolean {
    const previous = this.rows;
    const claimed = new Set<string>();
    const reconciled = this.bindExactRows(verified, claimed);
    const fallback = fallbackIndex(this.rows, claimed);
    this.bindFallbackRows(verified, reconciled, fallback, claimed);
    const verifiedRows = reconciled.filter(
      (row): row is AnnotationProjectionRow => row !== undefined,
    );
    const next =
      options.retainUnmatched === true
        ? [...verifiedRows, ...this.rows.filter((row) => !claimed.has(row.key))]
        : verifiedRows;
    if (next.length === previous.length && next.every((row, index) => row === previous[index]))
      return false;
    this.rows = next;
    return true;
  }

  private bindExactRows(
    verified: readonly DocumentAnnotation[],
    claimed: Set<string>,
  ): Array<AnnotationProjectionRow | undefined> {
    const exact = exactIdentityIndex(this.rows);
    return verified.map((annotation) => {
      const current = takeUnclaimed(exact.get(annotationId(annotation)), claimed);
      return current === undefined
        ? undefined
        : this.rowFromVerified(current.key, annotation, current);
    });
  }

  private bindFallbackRows(
    verified: readonly DocumentAnnotation[],
    reconciled: Array<AnnotationProjectionRow | undefined>,
    fallback: ReadonlyMap<string, ReadonlyMap<string, CandidateQueue>>,
    claimed: Set<string>,
  ): void {
    verified.forEach((annotation, index) => {
      if (reconciled[index] !== undefined) return;
      const queue = fallback
        .get(annotationBucket(annotation))
        ?.get(annotationSignature(annotation));
      const current = takeQueued(queue);
      if (current !== undefined) claimed.add(current.key);
      reconciled[index] = this.rowFromVerified(
        current?.key ?? `annotation-row-${String(this.nextKey++)}`,
        annotation,
        current,
      );
    });
  }

  private createRow(snapshot: ViewportAnnotationSnapshot): AnnotationProjectionRow {
    return this.rowFromSnapshot(`annotation-row-${String(this.nextKey++)}`, snapshot);
  }

  private rowFromSnapshot(
    key: string,
    snapshot: ViewportAnnotationSnapshot,
  ): AnnotationProjectionRow {
    return Object.freeze({
      key,
      annotation: annotationFromViewport(snapshot),
      nativeId: snapshot.nativeId,
      ...(snapshot.provisionalId === undefined ? {} : { provisionalId: snapshot.provisionalId }),
      writable: snapshot.writable,
    });
  }

  private rowFromVerified(
    key: string,
    annotation: DocumentAnnotation,
    current: AnnotationProjectionRow | undefined,
  ): AnnotationProjectionRow {
    if (
      current?.nativeId === annotationId(annotation) &&
      JSON.stringify(current.annotation) === JSON.stringify(annotation)
    )
      return current;
    return Object.freeze({
      key,
      annotation,
      nativeId: annotationId(annotation),
      ...(current?.provisionalId === undefined ? {} : { provisionalId: current.provisionalId }),
      writable: current?.writable ?? annotationIsWritable(annotation),
    });
  }
}

function annotationId(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function rowMatchesSnapshot(
  row: AnnotationProjectionRow,
  snapshot: ViewportAnnotationSnapshot,
): boolean {
  return (
    row.nativeId === snapshot.nativeId &&
    row.provisionalId === snapshot.provisionalId &&
    row.writable === snapshot.writable &&
    JSON.stringify(row.annotation) === JSON.stringify(annotationFromViewport(snapshot))
  );
}

function annotationSignature(annotation: DocumentAnnotation): string {
  const geometry = annotation.anchor.kind === 'fixed-page' ? annotation.anchor.geometry : null;
  return JSON.stringify([geometry, annotation.selectedText]);
}

function annotationBucket(annotation: DocumentAnnotation): string {
  const pageIndex = annotation.anchor.kind === 'fixed-page' ? annotation.anchor.pageIndex : -1;
  return `${String(pageIndex)}\u0000${annotation.type}`;
}

function exactIdentityIndex(
  rows: readonly AnnotationProjectionRow[],
): Map<string, AnnotationProjectionRow[]> {
  const index = new Map<string, AnnotationProjectionRow[]>();
  for (const row of rows) {
    appendCandidate(index, row.nativeId, row);
    if (row.provisionalId !== undefined) appendCandidate(index, row.provisionalId, row);
  }
  return index;
}

function fallbackIndex(
  rows: readonly AnnotationProjectionRow[],
  claimed: ReadonlySet<string>,
): Map<string, Map<string, CandidateQueue>> {
  const index = new Map<string, Map<string, CandidateQueue>>();
  for (const row of rows) {
    if (claimed.has(row.key)) continue;
    const bucket = annotationBucket(row.annotation);
    const signatures = index.get(bucket) ?? new Map<string, CandidateQueue>();
    if (!index.has(bucket)) index.set(bucket, signatures);
    const signature = annotationSignature(row.annotation);
    const queue = signatures.get(signature);
    if (queue === undefined) signatures.set(signature, { index: 0, rows: [row] });
    else queue.rows.push(row);
  }
  return index;
}

function annotationIsWritable(annotation: DocumentAnnotation): boolean {
  const capabilities = annotation.capabilities as Partial<AnnotationCapabilities> | undefined;
  return capabilities?.deletion?.available === true;
}

function appendCandidate(
  index: Map<string, AnnotationProjectionRow[]>,
  id: string,
  row: AnnotationProjectionRow,
): void {
  const candidates = index.get(id);
  if (candidates === undefined) index.set(id, [row]);
  else candidates.push(row);
}

function takeUnclaimed(
  candidates: readonly AnnotationProjectionRow[] | undefined,
  claimed: Set<string>,
): AnnotationProjectionRow | undefined {
  if (candidates === undefined) return undefined;
  for (const candidate of candidates) {
    if (claimed.has(candidate.key)) continue;
    claimed.add(candidate.key);
    return candidate;
  }
  return undefined;
}

function takeQueued(queue: CandidateQueue | undefined): AnnotationProjectionRow | undefined {
  if (queue === undefined) return undefined;
  const row = queue.rows[queue.index];
  queue.index += 1;
  return row;
}

function annotationFromViewport(snapshot: ViewportAnnotationSnapshot): DocumentAnnotation {
  const annotation: DocumentAnnotation = {
    identity: { kind: 'stable', id: snapshot.nativeId as AnnotationId },
    type: snapshot.type,
    anchor: {
      kind: 'fixed-page',
      pageIndex: snapshot.pageIndex,
      coordinateSpace: 'page-points-top-left',
      geometry: annotationGeometry(snapshot.rects),
    },
    color: snapshot.color,
    selectedText: snapshot.selectedText,
    author: '',
    createdAt: null,
    modifiedAt: null,
    comment: snapshot.comment,
    tags: Object.freeze([...snapshot.tags]),
    links: Object.freeze([...snapshot.links]),
    capabilities: capabilities(snapshot.writable),
  };
  return Object.freeze(annotation);
}

function annotationGeometry(rects: ViewportAnnotationSnapshot['rects']): AnnotationGeometry {
  if (rects.length <= 1) {
    return {
      kind: 'rectangle',
      rectangle: rects[0] ?? { x: 0, y: 0, width: 0, height: 0 },
    };
  }
  return {
    kind: 'quadrilaterals',
    quadrilaterals: rects.map(({ x, y, width, height }) => ({
      topLeft: { x, y },
      topRight: { x: x + width, y },
      bottomLeft: { x, y: y + height },
      bottomRight: { x: x + width, y: y + height },
    })),
  };
}

function capabilities(writable: boolean): AnnotationCapabilities {
  const available = Object.freeze({ available: true as const });
  const unavailable = Object.freeze({
    available: false as const,
    reason: Object.freeze({
      code: 'document-read-only' as const,
      message: 'This annotation is read-only.',
    }),
  });
  const mutation = writable ? available : unavailable;
  return Object.freeze({
    geometry: mutation,
    comment: mutation,
    color: mutation,
    deletion: mutation,
    metadata: mutation,
    conversions: Object.freeze({ highlight: mutation, underline: mutation }),
  });
}
