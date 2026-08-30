import { decodeAnnotationComment } from '../annotation-tokens.js';
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

export interface AnnotationProjectionEditorUpdate {
  readonly annotations: readonly DocumentAnnotation[];
  readonly color?: string | undefined;
  readonly comment?: string | undefined;
}

export interface AnnotationProjectionRow {
  readonly key: string;
  readonly annotation: DocumentAnnotation;
  readonly nativeId: string;
  readonly provisionalId?: string;
  readonly writable: boolean;
}

interface CandidateQueue {
  readonly rows: AnnotationProjectionRow[];
}

interface FallbackBindingContext {
  readonly claimed: Set<string>;
  readonly counts: ReadonlyMap<string, number>;
  readonly fallback: ReadonlyMap<string, ReadonlyMap<string, CandidateQueue>>;
}

export class AnnotationProjection {
  private rows: AnnotationProjectionRow[] = [];
  private nextKey = 0;
  private confirmedRevision = 0;
  private pendingOperations: AnnotationProjectionOperation[] = [];
  private readonly editorOverlays = new WeakMap<
    AnnotationProjectionRow,
    AnnotationProjectionOverlay
  >();

  snapshot(): readonly AnnotationProjectionRow[] {
    return this.rows;
  }

  annotations(): readonly DocumentAnnotation[] {
    return this.rows.map((row) => row.annotation);
  }

  apply(change: ViewportAnnotationChange, revision = 0): boolean {
    return change.operation === 'upsert'
      ? this.upsert(change.annotation, revision)
      : this.remove(change.nativeId, change.provisionalId, revision);
  }

  reset(): void {
    this.rows = [];
    this.nextKey = 0;
    this.confirmedRevision = 0;
    this.pendingOperations = [];
  }

  applyEditorUpdate(update: AnnotationProjectionEditorUpdate, revision = 0): boolean {
    return this.applyEditorChange(update, revision, false);
  }

  applyEditorPreview(update: AnnotationProjectionEditorUpdate): boolean {
    return this.applyEditorChange(update, this.confirmedRevision, true);
  }

  private applyEditorChange(
    update: AnnotationProjectionEditorUpdate,
    revision: number,
    preview: boolean,
  ): boolean {
    const identities = new Set(update.annotations.map(annotationId));
    let changed = false;
    this.rows = this.rows.map((row) => {
      if (
        !identities.has(row.nativeId) &&
        (row.provisionalId === undefined || !identities.has(row.provisionalId)) &&
        !identities.has(annotationId(row.annotation))
      )
        return row;
      const currentOverlay = this.editorOverlays.get(row);
      const base = annotationWithoutPreview(row.annotation, currentOverlay);
      const overlay = editorOverlay(currentOverlay, update, { base, preview, revision });
      const annotation = annotationWithOverlay(base, overlay);
      if (sameEditorFields(annotation, row.annotation)) {
        this.setEditorOverlay(row, overlay);
        return row;
      }
      changed = true;
      const updated = Object.freeze({ ...row, annotation });
      this.setEditorOverlay(updated, overlay);
      return updated;
    });
    return changed;
  }

  private setEditorOverlay(
    row: AnnotationProjectionRow,
    overlay: AnnotationProjectionOverlay | undefined,
  ): void {
    if (overlay === undefined) this.editorOverlays.delete(row);
    else this.editorOverlays.set(row, overlay);
  }

  bindCommittedSelection(
    provisionalId: string,
    annotation: DocumentAnnotation,
    revision = 0,
  ): boolean {
    const current = this.rowForCommittedSelection(provisionalId);
    const changed = this.bindCommittedSelectionRow(provisionalId, annotation);
    if (changed && revision > this.confirmedRevision && current !== undefined) {
      const committed = this.rows.find((row) => row.key === current.key);
      if (committed !== undefined)
        this.recordOperation(
          Object.freeze({
            annotation: committed.annotation,
            key: committed.key,
            kind: 'bind',
            provisionalId,
            revision,
          }),
        );
    }
    return changed;
  }

  private bindCommittedSelectionRow(
    provisionalId: string,
    annotation: DocumentAnnotation,
    replayKey?: string,
  ): boolean {
    const current = this.rowForCommittedSelection(provisionalId);
    if (current === undefined) {
      if (replayKey === undefined || this.rows.some((row) => row.key === replayKey)) return false;
      this.rows = [
        ...this.rows,
        Object.freeze({
          key: replayKey,
          annotation,
          nativeId: annotationId(annotation),
          provisionalId,
          writable: annotationIsWritable(annotation),
        }),
      ];
      return true;
    }
    const nativeId = annotationId(annotation);
    const bound = Object.freeze({
      ...current,
      annotation: Object.freeze({
        ...current.annotation,
        author: annotation.author,
        capabilities: annotation.capabilities,
        color: annotation.color ?? current.annotation.color,
        comment: annotation.comment,
        createdAt: annotation.createdAt,
        identity: annotation.identity,
        links: annotation.links,
        modifiedAt: annotation.modifiedAt,
        tags: annotation.tags,
        type: annotation.type,
      }),
      nativeId,
      provisionalId,
      writable: annotationIsWritable(annotation),
    });
    const overlay = this.editorOverlays.get(current);
    if (overlay !== undefined) this.editorOverlays.set(bound, overlay);
    this.rows = this.rows.map((row) => (row === current ? bound : row));
    return true;
  }

  private rowForCommittedSelection(provisionalId: string): AnnotationProjectionRow | undefined {
    return this.rows.find(
      (row) => row.nativeId === provisionalId || row.provisionalId === provisionalId,
    );
  }

  upsert(snapshot: ViewportAnnotationSnapshot, revision = 0): boolean {
    const changed = this.upsertRows(snapshot);
    if (changed && revision > this.confirmedRevision) {
      const row = this.rowForSnapshot(snapshot);
      this.recordOperation(
        Object.freeze({
          ...(row === undefined ? {} : { key: row.key }),
          kind: 'upsert',
          revision,
          snapshot,
        }),
      );
    }
    return changed;
  }

  private upsertRows(snapshot: ViewportAnnotationSnapshot, replayKey?: string): boolean {
    const identities = new Set([snapshot.nativeId]);
    if (snapshot.provisionalId !== undefined) identities.add(snapshot.provisionalId);
    const matches = this.rows.filter(
      (row) =>
        identities.has(row.nativeId) ||
        (row.provisionalId !== undefined && identities.has(row.provisionalId)),
    );
    const current = matches[0];
    if (current !== undefined) {
      if (
        matches.length === 1 &&
        rowMatchesSnapshot(current, snapshot, this.editorOverlays.get(current))
      )
        return false;
      const duplicateKeys = new Set(matches.slice(1).map((row) => row.key));
      for (const duplicate of matches.slice(1)) this.editorOverlays.delete(duplicate);
      const overlay = this.editorOverlays.get(current);
      this.rows = this.rows
        .filter((row) => !duplicateKeys.has(row.key))
        .map((row) => {
          if (row.key !== current.key) return row;
          const updated = this.rowFromSnapshot(current.key, snapshot, overlay, current);
          if (overlay !== undefined) this.editorOverlays.set(updated, overlay);
          return updated;
        });
      return true;
    }
    this.rows = [...this.rows, this.createRow(snapshot, replayKey)];
    return true;
  }

  private rowForSnapshot(
    snapshot: ViewportAnnotationSnapshot,
  ): AnnotationProjectionRow | undefined {
    return this.rows.find(
      (row) =>
        row.nativeId === snapshot.nativeId ||
        row.provisionalId === snapshot.nativeId ||
        (snapshot.provisionalId !== undefined &&
          (row.nativeId === snapshot.provisionalId ||
            row.provisionalId === snapshot.provisionalId)),
    );
  }

  remove(nativeId: string, provisionalId?: string, revision = 0): boolean {
    if (revision > this.confirmedRevision)
      this.recordOperation(
        Object.freeze({
          kind: 'remove',
          nativeId,
          ...(provisionalId === undefined ? {} : { provisionalId }),
          revision,
        }),
      );
    return this.removeRows(nativeId, provisionalId);
  }

  private recordOperation(operation: AnnotationProjectionOperation): void {
    for (let index = this.pendingOperations.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingOperations[index];
      if (pending === undefined || !operationsOverlap(pending, operation)) continue;
      if (pending.kind === operation.kind && pending.revision === operation.revision) {
        this.pendingOperations[index] = operation;
        return;
      }
      break;
    }
    this.pendingOperations.push(operation);
  }

  private removeRows(nativeId: string, provisionalId?: string): boolean {
    const previousLength = this.rows.length;
    this.rows = this.rows.filter((row) => {
      const retained =
        row.nativeId !== nativeId &&
        annotationId(row.annotation) !== nativeId &&
        row.provisionalId !== nativeId &&
        (provisionalId === undefined || row.provisionalId !== provisionalId);
      if (!retained) this.editorOverlays.delete(row);
      return retained;
    });
    return this.rows.length !== previousLength;
  }

  reconcile(
    verified: readonly DocumentAnnotation[],
    revisionOrOptions: number | { readonly retainUnmatched?: boolean } = {},
  ): boolean {
    const confirmedRevision =
      typeof revisionOrOptions === 'number' ? revisionOrOptions : Number.MAX_SAFE_INTEGER;
    const options = typeof revisionOrOptions === 'number' ? {} : revisionOrOptions;
    if (confirmedRevision < this.confirmedRevision) return false;
    const previous = this.rows;
    this.releaseConfirmedOverlays(confirmedRevision);
    const next = this.rowsFromVerified(verified, options.retainUnmatched === true);
    this.confirmAndReplay(next, confirmedRevision);
    if (!sameRows(this.rows, previous)) return true;
    this.rows = previous;
    return false;
  }

  private releaseConfirmedOverlays(confirmedRevision: number): void {
    for (const row of this.rows) {
      const overlay = this.editorOverlays.get(row);
      if (overlay === undefined) continue;
      const retained = overlayAfterRevision(overlay, confirmedRevision);
      if (retained === undefined) this.editorOverlays.delete(row);
      else this.editorOverlays.set(row, retained);
    }
  }

  private rowsFromVerified(
    verified: readonly DocumentAnnotation[],
    retainUnmatched: boolean,
  ): AnnotationProjectionRow[] {
    const claimed = new Set<string>();
    const reconciled = this.bindExactRows(verified, claimed);
    const fallback = fallbackIndex(this.rows, claimed);
    const counts = verifiedFallbackCounts(verified, reconciled);
    this.bindFallbackRows(verified, reconciled, { claimed, counts, fallback });
    this.createUnmatchedRows(verified, reconciled);
    const verifiedRows = reconciled.filter(
      (row): row is AnnotationProjectionRow => row !== undefined,
    );
    const retainedRows = this.rows.filter(
      (row) => !claimed.has(row.key) && (retainUnmatched || isPendingSelectionPreview(row)),
    );
    return [...verifiedRows, ...retainedRows];
  }

  private confirmAndReplay(next: AnnotationProjectionRow[], confirmedRevision: number): void {
    this.confirmedRevision = Math.max(this.confirmedRevision, confirmedRevision);
    this.pendingOperations = this.pendingOperations.filter(
      (operation) => operation.revision > this.confirmedRevision,
    );
    this.rows = next;
    for (const operation of this.pendingOperations) this.replay(operation);
  }

  private replay(operation: AnnotationProjectionOperation): void {
    if (operation.kind === 'upsert') {
      this.upsertRows(operation.snapshot, operation.key);
      return;
    }
    if (operation.kind === 'bind') {
      this.bindCommittedSelectionRow(operation.provisionalId, operation.annotation, operation.key);
      return;
    }
    this.removeRows(operation.nativeId, operation.provisionalId);
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
    context: FallbackBindingContext,
  ): void {
    verified.forEach((annotation, index) => {
      if (reconciled[index] !== undefined) return;
      const queue = context.fallback
        .get(annotationBucket(annotation))
        ?.get(annotationSignature(annotation));
      if (queue === undefined || context.counts.get(annotationFallbackKey(annotation)) !== 1)
        return;
      const current = takeUnique(queue);
      if (current === undefined) return;
      context.claimed.add(current.key);
      reconciled[index] = this.rowFromVerified(current.key, annotation, current);
    });
  }

  private createUnmatchedRows(
    verified: readonly DocumentAnnotation[],
    reconciled: Array<AnnotationProjectionRow | undefined>,
  ): void {
    verified.forEach((annotation, index) => {
      if (reconciled[index] !== undefined) return;
      reconciled[index] = this.rowFromVerified(
        `annotation-row-${String(this.nextKey++)}`,
        annotation,
        undefined,
      );
    });
  }

  private createRow(
    snapshot: ViewportAnnotationSnapshot,
    replayKey?: string,
  ): AnnotationProjectionRow {
    const key =
      replayKey !== undefined && !this.rows.some((row) => row.key === replayKey)
        ? replayKey
        : `annotation-row-${String(this.nextKey++)}`;
    return this.rowFromSnapshot(key, snapshot);
  }

  private rowFromSnapshot(
    key: string,
    snapshot: ViewportAnnotationSnapshot,
    overlay?: AnnotationProjectionOverlay,
    current?: AnnotationProjectionRow,
  ): AnnotationProjectionRow {
    const provisionalId = snapshot.provisionalId ?? current?.provisionalId;
    const annotation = retainVerifiedMetadata(
      annotationFromViewport(snapshot),
      current?.annotation,
      snapshot,
    );
    return Object.freeze({
      key,
      annotation: annotationWithOverlay(annotation, overlay),
      nativeId: snapshot.nativeId,
      ...(provisionalId === undefined ? {} : { provisionalId }),
      writable: snapshot.writable ?? annotationIsWritable(annotation),
    });
  }

  private rowFromVerified(
    key: string,
    annotation: DocumentAnnotation,
    current: AnnotationProjectionRow | undefined,
  ): AnnotationProjectionRow {
    const overlay = current === undefined ? undefined : this.editorOverlays.get(current);
    const projected = annotationWithOverlay(annotation, overlay);
    if (
      current?.nativeId === annotationId(annotation) &&
      current.writable === annotationIsWritable(annotation) &&
      JSON.stringify(current.annotation) === JSON.stringify(projected)
    )
      return current;
    const verifiedId = annotationId(annotation);
    let provisionalId: string | undefined;
    if (current !== undefined)
      provisionalId = current.nativeId === verifiedId ? current.provisionalId : current.nativeId;
    const row = Object.freeze({
      key,
      annotation: projected,
      nativeId: verifiedId,
      ...(provisionalId === undefined ? {} : { provisionalId }),
      writable: annotationIsWritable(annotation),
    });
    if (overlay !== undefined) this.editorOverlays.set(row, overlay);
    return row;
  }
}

function retainVerifiedMetadata(
  viewport: DocumentAnnotation,
  current: DocumentAnnotation | undefined,
  snapshot: ViewportAnnotationSnapshot,
): DocumentAnnotation {
  if (current === undefined) return viewport;
  return Object.freeze({
    ...viewport,
    ...(current.identity.kind === 'stable' ? { identity: current.identity } : {}),
    ...retainedExternalType(current),
    author: current.author,
    createdAt: current.createdAt,
    modifiedAt: current.modifiedAt,
    color: retainOptional(snapshot.color, viewport.color, current.color),
    comment: retainOptional(snapshot.comment, viewport.comment, current.comment),
    links: retainDerivedList(viewport.links, current.links, snapshot.comment),
    selectedText: retainOptional(
      snapshot.selectedText,
      viewport.selectedText,
      current.selectedText,
    ),
    tags: retainDerivedList(viewport.tags, current.tags, snapshot.comment),
    capabilities: current.capabilities,
  });
}

function retainedExternalType(
  annotation: DocumentAnnotation,
): Pick<DocumentAnnotation, 'externalType'> {
  return annotation.externalType === undefined ? {} : { externalType: annotation.externalType };
}

function retainOptional<T>(presence: unknown, value: T, fallback: T): T {
  return presence === undefined ? fallback : value;
}

function retainDerivedList(
  value: readonly string[],
  fallback: readonly string[],
  comment: string | undefined,
): readonly string[] {
  return comment === undefined && value.length === 0 ? fallback : value;
}

interface AnnotationProjectionOverlay {
  readonly color?: AnnotationProjectionOverlayField<string>;
  readonly comment?: AnnotationProjectionOverlayField<string>;
  readonly links?: AnnotationProjectionOverlayField<readonly string[]>;
  readonly tags?: AnnotationProjectionOverlayField<readonly string[]>;
}

interface AnnotationProjectionOverlayField<T> {
  readonly baseValue?: T;
  readonly preview?: true;
  readonly revision: number;
  readonly value: T;
}

type AnnotationProjectionOperation =
  | {
      readonly kind: 'bind';
      readonly annotation: DocumentAnnotation;
      readonly key: string;
      readonly provisionalId: string;
      readonly revision: number;
    }
  | {
      readonly kind: 'remove';
      readonly nativeId: string;
      readonly provisionalId?: string;
      readonly revision: number;
    }
  | {
      readonly key?: string;
      readonly kind: 'upsert';
      readonly revision: number;
      readonly snapshot: ViewportAnnotationSnapshot;
    };

function editorOverlay(
  current: AnnotationProjectionOverlay | undefined,
  update: AnnotationProjectionEditorUpdate,
  context: EditorOverlayContext,
): AnnotationProjectionOverlay | undefined {
  const next: MutableAnnotationProjectionOverlay = { ...current };
  applyColorOverlay(next, current, update, context);
  applyCommentOverlay(next, current, update, context);
  return Object.keys(next).length === 0 ? undefined : Object.freeze(next);
}

interface MutableAnnotationProjectionOverlay {
  color?: AnnotationProjectionOverlayField<string>;
  comment?: AnnotationProjectionOverlayField<string>;
  links?: AnnotationProjectionOverlayField<readonly string[]>;
  tags?: AnnotationProjectionOverlayField<readonly string[]>;
}

function applyColorOverlay(
  next: MutableAnnotationProjectionOverlay,
  current: AnnotationProjectionOverlay | undefined,
  update: AnnotationProjectionEditorUpdate,
  context: EditorOverlayContext,
): void {
  if (update.color === undefined) return;
  const color = overlayField(current?.color, update.color, context.base.color ?? '', context);
  if (color === undefined) delete next.color;
  else next.color = color;
}

function applyCommentOverlay(
  next: MutableAnnotationProjectionOverlay,
  current: AnnotationProjectionOverlay | undefined,
  update: AnnotationProjectionEditorUpdate,
  context: EditorOverlayContext,
): void {
  if (update.comment === undefined) return;
  const decoded = decodeAnnotationComment(update.comment);
  const comment = overlayField(current?.comment, update.comment, context.base.comment, context);
  const links = overlayField(current?.links, decoded.links, context.base.links, context);
  const tags = overlayField(current?.tags, decoded.tags, context.base.tags, context);
  if (comment === undefined) delete next.comment;
  else next.comment = comment;
  if (links === undefined) delete next.links;
  else next.links = links;
  if (tags === undefined) delete next.tags;
  else next.tags = tags;
}

interface EditorOverlayContext {
  readonly base: DocumentAnnotation;
  readonly preview: boolean;
  readonly revision: number;
}

function overlayField<T>(
  current: AnnotationProjectionOverlayField<T> | undefined,
  value: T,
  baseValue: T,
  context: Pick<EditorOverlayContext, 'preview' | 'revision'>,
): AnnotationProjectionOverlayField<T> | undefined {
  const original =
    current?.preview === true && current.baseValue !== undefined ? current.baseValue : baseValue;
  if (context.preview && sameOverlayValue(value, original)) return undefined;
  return context.preview
    ? Object.freeze({
        baseValue: original,
        preview: true as const,
        revision: context.revision,
        value,
      })
    : Object.freeze({ revision: context.revision, value });
}

function sameOverlayValue<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function annotationWithoutPreview(
  annotation: DocumentAnnotation,
  overlay: AnnotationProjectionOverlay | undefined,
): DocumentAnnotation {
  if (overlay === undefined) return annotation;
  return Object.freeze({
    ...annotation,
    color: valueBeforePreview(overlay.color, annotation.color),
    comment: valueBeforePreview(overlay.comment, annotation.comment),
    links: valueBeforePreview(overlay.links, annotation.links),
    tags: valueBeforePreview(overlay.tags, annotation.tags),
  });
}

function valueBeforePreview<T>(
  field: AnnotationProjectionOverlayField<T> | undefined,
  current: T,
): T {
  return field?.preview === true && field.baseValue !== undefined ? field.baseValue : current;
}

function annotationWithOverlay(
  annotation: DocumentAnnotation,
  overlay: AnnotationProjectionOverlay | undefined,
): DocumentAnnotation {
  if (overlay === undefined) return annotation;
  return Object.freeze({
    ...annotation,
    ...(overlay.color === undefined ? {} : { color: overlay.color.value }),
    ...(overlay.comment === undefined ? {} : { comment: overlay.comment.value }),
    ...(overlay.links === undefined ? {} : { links: overlay.links.value }),
    ...(overlay.tags === undefined ? {} : { tags: overlay.tags.value }),
  });
}

function overlayAfterRevision(
  overlay: AnnotationProjectionOverlay,
  confirmedRevision: number,
): AnnotationProjectionOverlay | undefined {
  const retained: {
    color?: AnnotationProjectionOverlayField<string>;
    comment?: AnnotationProjectionOverlayField<string>;
    links?: AnnotationProjectionOverlayField<readonly string[]>;
    tags?: AnnotationProjectionOverlayField<readonly string[]>;
  } = {};
  const color = retainedOverlayField(overlay.color, confirmedRevision);
  const comment = retainedOverlayField(overlay.comment, confirmedRevision);
  const links = retainedOverlayField(overlay.links, confirmedRevision);
  const tags = retainedOverlayField(overlay.tags, confirmedRevision);
  if (color !== undefined) retained.color = color;
  if (comment !== undefined) retained.comment = comment;
  if (links !== undefined) retained.links = links;
  if (tags !== undefined) retained.tags = tags;
  return Object.keys(retained).length === 0 ? undefined : retained;
}

function retainedOverlayField<T>(
  field: AnnotationProjectionOverlayField<T> | undefined,
  confirmedRevision: number,
): AnnotationProjectionOverlayField<T> | undefined {
  return field?.preview === true || (field !== undefined && field.revision > confirmedRevision)
    ? field
    : undefined;
}

function sameEditorFields(left: DocumentAnnotation, right: DocumentAnnotation): boolean {
  return (
    left.color === right.color &&
    left.comment === right.comment &&
    sameStrings(left.links, right.links) &&
    sameStrings(left.tags, right.tags)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function annotationId(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function rowMatchesSnapshot(
  row: AnnotationProjectionRow,
  snapshot: ViewportAnnotationSnapshot,
  overlay: AnnotationProjectionOverlay | undefined,
): boolean {
  const annotation = annotationWithOverlay(
    retainVerifiedMetadata(annotationFromViewport(snapshot), row.annotation, snapshot),
    overlay,
  );
  return (
    row.nativeId === snapshot.nativeId &&
    row.provisionalId === (snapshot.provisionalId ?? row.provisionalId) &&
    row.writable === (snapshot.writable ?? annotationIsWritable(annotation)) &&
    JSON.stringify(row.annotation) === JSON.stringify(annotation)
  );
}

function annotationSignature(annotation: DocumentAnnotation): string {
  const geometry = annotation.anchor.kind === 'fixed-page' ? annotation.anchor.geometry : null;
  const color = annotation.color?.trim().toLowerCase() ?? null;
  return JSON.stringify([color, normalizedGeometry(geometry)]);
}

function normalizedGeometry(geometry: AnnotationGeometry | null): unknown {
  if (geometry === null) return null;
  if (geometry.kind === 'point') return ['point', normalizedPoint(geometry.point)];
  if (geometry.kind === 'rectangle')
    return [
      'rectangle',
      normalizedPoint(geometry.rectangle),
      normalizedNumber(geometry.rectangle.width),
      normalizedNumber(geometry.rectangle.height),
    ];
  if (geometry.kind === 'ink')
    return ['ink', geometry.paths.map((path) => path.map(normalizedPoint))];
  return [
    'quadrilaterals',
    geometry.quadrilaterals.map((quad) => [
      normalizedPoint(quad.topLeft),
      normalizedPoint(quad.topRight),
      normalizedPoint(quad.bottomLeft),
      normalizedPoint(quad.bottomRight),
    ]),
  ];
}

function normalizedPoint(point: { readonly x: number; readonly y: number }): readonly number[] {
  return [normalizedNumber(point.x), normalizedNumber(point.y)];
}

function normalizedNumber(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function annotationBucket(annotation: DocumentAnnotation): string {
  const pageIndex = annotation.anchor.kind === 'fixed-page' ? annotation.anchor.pageIndex : -1;
  return `${String(pageIndex)}\u0000${annotation.type}`;
}

function annotationFallbackKey(annotation: DocumentAnnotation): string {
  return `${annotationBucket(annotation)}\u0000${annotationSignature(annotation)}`;
}

function verifiedFallbackCounts(
  verified: readonly DocumentAnnotation[],
  reconciled: ReadonlyArray<AnnotationProjectionRow | undefined>,
): Map<string, number> {
  const counts = new Map<string, number>();
  verified.forEach((annotation, index) => {
    if (reconciled[index] !== undefined) return;
    const key = annotationFallbackKey(annotation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
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
    if (queue === undefined) signatures.set(signature, { rows: [row] });
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

function takeUnique(queue: CandidateQueue | undefined): AnnotationProjectionRow | undefined {
  return queue?.rows.length === 1 ? queue.rows[0] : undefined;
}

function sameRows(
  left: readonly AnnotationProjectionRow[],
  right: readonly AnnotationProjectionRow[],
): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

function isPendingSelectionPreview(row: AnnotationProjectionRow): boolean {
  return row.provisionalId !== undefined && row.nativeId === row.provisionalId;
}

function operationsOverlap(
  left: AnnotationProjectionOperation,
  right: AnnotationProjectionOperation,
): boolean {
  const leftIds = operationIds(left);
  for (const id of operationIds(right)) {
    if (leftIds.has(id)) return true;
  }
  return false;
}

function operationIds(operation: AnnotationProjectionOperation): Set<string> {
  if (operation.kind === 'bind')
    return new Set([operation.provisionalId, annotationId(operation.annotation)]);
  if (operation.kind === 'remove')
    return new Set([
      operation.nativeId,
      ...(operation.provisionalId === undefined ? [] : [operation.provisionalId]),
    ]);
  return new Set([
    operation.snapshot.nativeId,
    ...(operation.snapshot.provisionalId === undefined ? [] : [operation.snapshot.provisionalId]),
  ]);
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
    color: snapshot.color ?? null,
    selectedText: snapshot.selectedText ?? null,
    author: '',
    createdAt: null,
    modifiedAt: null,
    comment: snapshot.comment ?? '',
    tags: Object.freeze([...snapshot.tags]),
    links: Object.freeze([...snapshot.links]),
    capabilities: capabilities(snapshot.writable ?? false),
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
