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
  ViewportEvent,
} from '../document-core/document.js';

export type AnnotationProjectionViewportEvent = Extract<
  ViewportEvent,
  { readonly type: 'annotation-change' | 'annotation-snapshot' }
>;

export interface AnnotationProjectionViewportObservation {
  readonly event: AnnotationProjectionViewportEvent;
  readonly revision: number;
}

export function withoutViewportObservationIdentities(
  observation: AnnotationProjectionViewportObservation,
  identities: ReadonlySet<string>,
): AnnotationProjectionViewportObservation | null {
  const event = observation.event;
  if (event.type === 'annotation-snapshot') {
    const annotations = event.annotations.filter(
      (annotation) => !viewportSnapshotIntersects(annotation, identities),
    );
    if (annotations.length === event.annotations.length) return observation;
    if (annotations.length === 0) return null;
    return Object.freeze({
      ...observation,
      event: Object.freeze({ ...event, annotations }),
    });
  }
  if (event.change.operation === 'upsert')
    return viewportSnapshotIntersects(event.change.annotation, identities) ? null : observation;
  return identities.has(event.change.nativeId) ||
    (event.change.provisionalId !== undefined && identities.has(event.change.provisionalId))
    ? null
    : observation;
}

function viewportSnapshotIntersects(
  snapshot: ViewportAnnotationSnapshot,
  identities: ReadonlySet<string>,
): boolean {
  return uniqueAliases(snapshot.nativeId, snapshot.runtimeId, snapshot.provisionalId).some(
    (identity) => identities.has(identity),
  );
}

export interface AnnotationProjectionEditorUpdate {
  readonly annotations: readonly DocumentAnnotation[];
  readonly color?: string | undefined;
  readonly comment?: string | undefined;
}

export interface AnnotationProjectionRow {
  readonly aliases?: readonly string[];
  readonly key: string;
  readonly annotation: DocumentAnnotation;
  readonly nativeId: string;
  readonly provisionalId?: string;
  readonly runtimeId?: string;
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
  private readonly pendingOperationIndexes = new Map<string, number[]>();
  private readonly explicitDeletionTombstones = new Set<AnnotationProjectionDeletionTombstone>();
  private readonly explicitDeletionTombstoneByIdentity = new Map<
    string,
    AnnotationProjectionDeletionTombstone
  >();
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
    this.pendingOperationIndexes.clear();
    this.explicitDeletionTombstones.clear();
    this.explicitDeletionTombstoneByIdentity.clear();
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
    const targetKeys = new Set(
      projectionRowsForIdentities(this.rows, identities).map((row) => row.key),
    );
    let changed = false;
    this.rows = this.rows.map((row) => {
      if (!targetKeys.has(row.key)) return row;
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
      this.rows = [...this.rows, committedSelectionRow(replayKey, provisionalId, annotation)];
      return true;
    }
    const bound = committedSelectionRow(current.key, provisionalId, annotation, current);
    const overlay = this.editorOverlays.get(current);
    if (overlay !== undefined) this.editorOverlays.set(bound, overlay);
    this.rows = this.rows.map((row) => (row === current ? bound : row));
    return true;
  }

  private rowForCommittedSelection(provisionalId: string): AnnotationProjectionRow | undefined {
    return projectionRowForIdentity(this.rows, provisionalId);
  }

  upsert(snapshot: ViewportAnnotationSnapshot, revision = 0): boolean {
    if (this.explicitDeletionTombstoneForSnapshot(snapshot) !== undefined) return false;
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
    const identities = new Set<string>();
    if (snapshot.provisionalId !== undefined) identities.add(snapshot.provisionalId);
    identities.add(snapshot.nativeId);
    const matches = projectionRowsForIdentities(this.rows, identities);
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
    return projectionRowsForIdentities(
      this.rows,
      snapshot.provisionalId === undefined
        ? [snapshot.nativeId]
        : [snapshot.nativeId, snapshot.provisionalId],
    )[0];
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

  deleteOptimistically(nativeId: string, provisionalId?: string, revision = 0): boolean {
    const identities = provisionalId === undefined ? [nativeId] : [nativeId, provisionalId];
    const targets = projectionRowsForIdentities(this.rows, identities);
    if (targets.length === 0) return false;
    for (const row of targets)
      this.indexExplicitDeletionTombstone(new Set(rowIdentityAliases(row)), revision);
    if (revision > this.confirmedRevision) {
      for (const row of targets)
        this.recordOperation(
          Object.freeze({
            kind: 'remove',
            nativeId: row.nativeId,
            ...(row.provisionalId === undefined ? {} : { provisionalId: row.provisionalId }),
            revision,
          }),
        );
    }
    return this.removeTargetRows(targets);
  }

  applyViewportBatch(observations: readonly AnnotationProjectionViewportObservation[]): boolean {
    if (observations.length === 0) return false;
    const index = this.buildViewportIdentityIndex();
    let changed = false;
    for (const observation of observations)
      changed =
        this.applyIndexedViewportEvent(index, observation.event, observation.revision) || changed;
    if (changed) this.rows = index.snapshot();
    return changed;
  }

  identityClosure(identities: Iterable<string>): ReadonlySet<string> {
    const closure = new Set(identities);
    for (const row of projectionRowsForIdentities(this.rows, closure))
      for (const identity of rowIdentityAliases(row)) closure.add(identity);
    return closure;
  }

  deletionIdentityClosureConfirmedBy(confirmedRevision: number): ReadonlySet<string> {
    const closure = new Set<string>();
    for (const tombstone of this.explicitDeletionTombstones) {
      if (tombstone.revision > confirmedRevision) continue;
      for (const identity of tombstone.identities) closure.add(identity);
    }
    return closure;
  }

  private buildViewportIdentityIndex(): AnnotationProjectionViewportIndex {
    return new AnnotationProjectionViewportIndex(this.rows, this.editorOverlays);
  }

  private applyIndexedViewportEvent(
    index: AnnotationProjectionViewportIndex,
    event: AnnotationProjectionViewportEvent,
    revision: number,
  ): boolean {
    if (event.type === 'annotation-snapshot')
      return event.annotations.reduce(
        (changed, annotation) =>
          this.applyIndexedViewportUpsert(index, annotation, revision) || changed,
        false,
      );
    if (event.change.operation === 'upsert')
      return this.applyIndexedViewportUpsert(index, event.change.annotation, revision);
    this.recordIndexedViewportRemove(event.change, revision);
    return index.removeByIdentity(event.change.nativeId, event.change.provisionalId);
  }

  private recordIndexedViewportRemove(
    change: Extract<ViewportAnnotationChange, { readonly operation: 'remove' }>,
    revision: number,
  ): void {
    if (revision <= this.confirmedRevision) return;
    this.recordOperation(
      Object.freeze({
        kind: 'remove',
        nativeId: change.nativeId,
        ...(change.provisionalId === undefined ? {} : { provisionalId: change.provisionalId }),
        revision,
      }),
    );
  }

  private applyIndexedViewportUpsert(
    index: AnnotationProjectionViewportIndex,
    snapshot: ViewportAnnotationSnapshot,
    revision: number,
  ): boolean {
    if (this.explicitDeletionTombstoneForSnapshot(snapshot) !== undefined) return false;
    const matches = index.rowsForSnapshot(snapshot);
    const current = matches[0];
    if (current !== undefined)
      return this.updateIndexedViewportRow(index, matches, snapshot, revision);
    const row = this.rowFromSnapshot(`annotation-row-${String(this.nextKey++)}`, snapshot);
    index.append(row);
    this.recordIndexedViewportUpsert(row, snapshot, revision);
    return true;
  }

  private updateIndexedViewportRow(
    index: AnnotationProjectionViewportIndex,
    matches: readonly AnnotationProjectionRow[],
    snapshot: ViewportAnnotationSnapshot,
    revision: number,
  ): boolean {
    const current = matches[0];
    if (current === undefined) return false;
    const overlay = this.editorOverlays.get(current);
    if (matches.length === 1 && rowMatchesSnapshot(current, snapshot, overlay)) {
      this.recordIndexedViewportUpsert(current, snapshot, revision);
      return false;
    }
    for (const duplicate of matches.slice(1)) index.remove(duplicate);
    const updated = this.rowFromSnapshot(current.key, snapshot, overlay, current);
    index.replace(current, updated);
    if (overlay !== undefined) this.editorOverlays.set(updated, overlay);
    this.recordIndexedViewportUpsert(updated, snapshot, revision);
    return true;
  }

  private recordIndexedViewportUpsert(
    row: AnnotationProjectionRow,
    snapshot: ViewportAnnotationSnapshot,
    revision: number,
  ): void {
    if (revision <= this.confirmedRevision) return;
    this.recordOperation(Object.freeze({ key: row.key, kind: 'upsert', revision, snapshot }));
  }

  private indexExplicitDeletionTombstone(identities: ReadonlySet<string>, revision: number): void {
    const overlapping = new Set<AnnotationProjectionDeletionTombstone>();
    const closure = new Set(identities);
    let causalRevision = revision;
    for (const identity of identities) {
      const tombstone = this.explicitDeletionTombstoneByIdentity.get(identity);
      if (tombstone !== undefined) overlapping.add(tombstone);
    }
    for (const tombstone of overlapping) {
      for (const identity of tombstone.identities) closure.add(identity);
      causalRevision = Math.max(causalRevision, tombstone.revision);
      this.removeExplicitDeletionTombstone(tombstone);
    }
    const tombstone = Object.freeze({ identities: closure, revision: causalRevision });
    this.explicitDeletionTombstones.add(tombstone);
    for (const identity of closure)
      this.explicitDeletionTombstoneByIdentity.set(identity, tombstone);
  }

  private explicitDeletionTombstoneForSnapshot(
    snapshot: ViewportAnnotationSnapshot,
  ): AnnotationProjectionDeletionTombstone | undefined {
    for (const identity of uniqueAliases(
      snapshot.nativeId,
      snapshot.runtimeId,
      snapshot.provisionalId,
    )) {
      const tombstone = this.explicitDeletionTombstoneByIdentity.get(identity);
      if (tombstone !== undefined) return tombstone;
    }
    return undefined;
  }

  private removeExplicitDeletionTombstone(tombstone: AnnotationProjectionDeletionTombstone): void {
    this.explicitDeletionTombstones.delete(tombstone);
    for (const identity of tombstone.identities) {
      if (this.explicitDeletionTombstoneByIdentity.get(identity) === tombstone)
        this.explicitDeletionTombstoneByIdentity.delete(identity);
    }
  }

  private releaseConfirmedDeletionTombstones(confirmedRevision: number): void {
    for (const tombstone of this.explicitDeletionTombstones) {
      if (tombstone.revision <= confirmedRevision) this.removeExplicitDeletionTombstone(tombstone);
    }
  }

  private recordOperation(operation: AnnotationProjectionOperation): void {
    const overlappingIndex = this.latestOverlappingOperationIndex(operation);
    const pending = overlappingIndex < 0 ? undefined : this.pendingOperations[overlappingIndex];
    if (pending?.kind === operation.kind && pending.revision === operation.revision) {
      this.pendingOperations[overlappingIndex] = operation;
      this.indexPendingOperation(operation, overlappingIndex);
      return;
    }
    const index = this.pendingOperations.length;
    this.pendingOperations.push(operation);
    this.indexPendingOperation(operation, index);
  }

  private latestOverlappingOperationIndex(operation: AnnotationProjectionOperation): number {
    let latest = -1;
    for (const identity of operationIds(operation)) {
      const indexes = this.pendingOperationIndexes.get(identity);
      if (indexes === undefined) continue;
      removeStaleOperationIndexes(indexes, identity, this.pendingOperations);
      latest = Math.max(latest, indexes[indexes.length - 1] ?? -1);
    }
    return latest;
  }

  private indexPendingOperation(operation: AnnotationProjectionOperation, index: number): void {
    for (const identity of operationIds(operation)) {
      const indexes = this.pendingOperationIndexes.get(identity);
      if (indexes === undefined) this.pendingOperationIndexes.set(identity, [index]);
      else if (indexes[indexes.length - 1] !== index) indexes.push(index);
    }
  }

  private rebuildPendingOperationIndexes(): void {
    this.pendingOperationIndexes.clear();
    this.pendingOperations.forEach((operation, index) => {
      this.indexPendingOperation(operation, index);
    });
  }

  private removeRows(nativeId: string, provisionalId?: string): boolean {
    const targets = projectionRowsForRemovalIdentities(this.rows, [nativeId]);
    if (provisionalId !== undefined) {
      const provisional = projectionRowAtUniqueTier(
        this.rows,
        (row) => row.provisionalId === provisionalId,
      );
      if (
        provisional !== null &&
        provisional !== undefined &&
        !targets.some((row) => row.key === provisional.key)
      )
        targets.push(provisional);
    }
    return this.removeTargetRows(targets);
  }

  private removeTargetRows(targets: readonly AnnotationProjectionRow[]): boolean {
    const removedKeys = new Set(targets.map((row) => row.key));
    if (removedKeys.size === 0) return false;
    this.rows = this.rows.filter((row) => {
      const retained = !removedKeys.has(row.key);
      if (!retained) this.editorOverlays.delete(row);
      return retained;
    });
    return true;
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
    this.releaseConfirmedDeletionTombstones(confirmedRevision);
    const visibleVerified = verified.filter(
      (annotation) => !this.explicitDeletionTombstoneByIdentity.has(annotationId(annotation)),
    );
    const next = this.rowsFromVerified(
      visibleVerified,
      options.retainUnmatched === true,
      confirmedRevision,
    );
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
    confirmedRevision: number,
  ): AnnotationProjectionRow[] {
    const claimed = new Set<string>();
    const newerPendingKeys = newerPendingNonRemoveKeys(this.pendingOperations, confirmedRevision);
    const reconciled = this.bindStrongRows(verified, claimed, newerPendingKeys);
    this.bindExactRows(verified, reconciled, claimed);
    const fallback = fallbackIndex(this.rows, claimed);
    const counts = verifiedFallbackCounts(verified, reconciled);
    this.bindFallbackRows(verified, reconciled, { claimed, counts, fallback });
    this.bindPendingCausalRows(verified, reconciled, claimed, confirmedRevision);
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
    this.rebuildPendingOperationIndexes();
    const replay = new AnnotationProjectionViewportIndex(next, this.editorOverlays);
    for (const operation of this.pendingOperations) this.replayIndexed(replay, operation);
    this.rows = replay.snapshot();
  }

  private replayIndexed(
    index: AnnotationProjectionViewportIndex,
    operation: AnnotationProjectionOperation,
  ): void {
    if (operation.kind === 'upsert') {
      this.replayIndexedUpsert(index, operation);
      return;
    }
    if (operation.kind === 'bind') {
      this.replayIndexedBind(index, operation);
      return;
    }
    index.removeByIdentity(operation.nativeId, operation.provisionalId);
  }

  private replayIndexedUpsert(
    index: AnnotationProjectionViewportIndex,
    operation: Extract<AnnotationProjectionOperation, { readonly kind: 'upsert' }>,
  ): void {
    const matches = index.rowsForSnapshot(operation.snapshot);
    const current = matches[0];
    if (current === undefined) {
      const key =
        operation.key !== undefined && !index.hasKey(operation.key)
          ? operation.key
          : `annotation-row-${String(this.nextKey++)}`;
      index.append(this.rowFromSnapshot(key, operation.snapshot));
      return;
    }
    const overlay = this.editorOverlays.get(current);
    if (matches.length === 1 && rowMatchesSnapshot(current, operation.snapshot, overlay)) return;
    for (const duplicate of matches.slice(1)) index.remove(duplicate);
    const updated = this.rowFromSnapshot(current.key, operation.snapshot, overlay, current);
    index.replace(current, updated);
    if (overlay !== undefined) this.editorOverlays.set(updated, overlay);
  }

  private replayIndexedBind(
    index: AnnotationProjectionViewportIndex,
    operation: Extract<AnnotationProjectionOperation, { readonly kind: 'bind' }>,
  ): void {
    const current = index.rowForIdentity(operation.provisionalId);
    if (current === undefined) {
      if (index.hasKey(operation.key)) return;
      index.append(
        committedSelectionRow(operation.key, operation.provisionalId, operation.annotation),
      );
      return;
    }
    const bound = committedSelectionRow(
      current.key,
      operation.provisionalId,
      operation.annotation,
      current,
    );
    const overlay = this.editorOverlays.get(current);
    index.replace(current, bound);
    if (overlay !== undefined) this.editorOverlays.set(bound, overlay);
  }

  private bindStrongRows(
    verified: readonly DocumentAnnotation[],
    claimed: Set<string>,
    newerPendingKeys: ReadonlySet<string>,
  ): Array<AnnotationProjectionRow | undefined> {
    const reconciled: Array<AnnotationProjectionRow | undefined> = verified.map(() => undefined);
    const candidateBuckets = new Map<string, AnnotationProjectionRow[]>();
    for (const row of this.rows)
      appendCandidate(candidateBuckets, annotationBucket(row.annotation), row);
    const verifiedBuckets = new Map<string, number[]>();
    verified.forEach((annotation, index) => {
      appendIndex(verifiedBuckets, annotationBucket(annotation), index);
    });
    for (const [bucket, indexes] of verifiedBuckets) {
      const rows = candidateBuckets.get(bucket) ?? [];
      if (indexes.length === 0 || indexes.length !== rows.length) continue;
      if (this.strongRowsHavePendingState(rows, newerPendingKeys)) continue;
      const bindings = strongBucketBindings(rows, indexes, verified);
      if (bindings === null) continue;
      for (const { annotation, current, index } of bindings) {
        claimed.add(current.key);
        reconciled[index] = this.rowFromVerified(current.key, annotation, current);
      }
    }
    return reconciled;
  }

  private strongRowsHavePendingState(
    rows: readonly AnnotationProjectionRow[],
    newerPendingKeys: ReadonlySet<string>,
  ): boolean {
    return rows.some((row) => this.editorOverlays.has(row) || newerPendingKeys.has(row.key));
  }

  private bindExactRows(
    verified: readonly DocumentAnnotation[],
    reconciled: Array<AnnotationProjectionRow | undefined>,
    claimed: Set<string>,
  ): void {
    const blocked = new Set<number>();
    const tiers = [
      projectionIdentityIndex(this.rows, (row) => [row.nativeId]),
      projectionIdentityIndex(this.rows, (row) => [row.runtimeId]),
      projectionIdentityIndex(this.rows, (row) => [row.provisionalId]),
      projectionIdentityIndex(this.rows, (row) => [annotationId(row.annotation)]),
      projectionIdentityIndex(this.rows, (row) => row.aliases ?? []),
    ];
    for (const tier of tiers) {
      verified.forEach((annotation, index) => {
        if (reconciled[index] !== undefined || blocked.has(index)) return;
        const identity = annotationId(annotation);
        const current = uniqueUnclaimedRow(tier.get(identity), claimed);
        if (current === undefined) {
          blocked.add(index);
          return;
        }
        if (current === null) return;
        claimed.add(current.key);
        reconciled[index] = this.rowFromVerified(current.key, annotation, current);
      });
    }
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

  private bindPendingCausalRows(
    verified: readonly DocumentAnnotation[],
    reconciled: Array<AnnotationProjectionRow | undefined>,
    claimed: Set<string>,
    confirmedRevision: number,
  ): void {
    const rows = pendingCausalRows(this.pendingOperations, this.rows, claimed, confirmedRevision);
    const indexes = unmatchedVerifiedIndexes(verified, reconciled);
    for (const [key, values] of indexes) {
      const candidates = rows.get(key) ?? [];
      if (values.length === 0 || values.length !== candidates.length) continue;
      values.forEach((index, candidateIndex) => {
        const current = candidates[candidateIndex];
        const annotation = verified[index];
        if (current === undefined || annotation === undefined) return;
        claimed.add(current.key);
        reconciled[index] = this.rowFromVerified(current.key, annotation, current);
      });
    }
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
    const nativeId = canonicalNativeIdForSnapshot(snapshot, current);
    const runtimeId = runtimeIdForSnapshot(snapshot, current);
    const annotation = retainVerifiedMetadata(
      annotationFromViewport(snapshot),
      current?.annotation,
      snapshot,
    );
    const aliases = retainedAliases(current, nativeId, provisionalId, annotationId(annotation));
    return Object.freeze({
      key,
      annotation: annotationWithOverlay(annotation, overlay),
      nativeId,
      ...(provisionalId === undefined ? {} : { provisionalId }),
      ...(runtimeId === undefined ? {} : { runtimeId }),
      ...(aliases.length === 0 ? {} : { aliases }),
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
    if (current !== undefined && verifiedRowIsCurrent(current, annotation, projected))
      return current;
    const verifiedId = annotationId(annotation);
    const provisionalId = previousNativeAlias(current, verifiedId);
    const aliases = retainedAliases(current, verifiedId, provisionalId, verifiedId);
    const row = Object.freeze({
      key,
      annotation: projected,
      nativeId: verifiedId,
      ...(provisionalId === undefined ? {} : { provisionalId }),
      ...(current?.runtimeId === undefined ? {} : { runtimeId: current.runtimeId }),
      ...(aliases.length === 0 ? {} : { aliases }),
      writable: annotationIsWritable(annotation),
    });
    if (overlay !== undefined) this.editorOverlays.set(row, overlay);
    return row;
  }
}

function pendingCausalRows(
  operations: readonly AnnotationProjectionOperation[],
  currentRows: readonly AnnotationProjectionRow[],
  claimed: ReadonlySet<string>,
  confirmedRevision: number,
): Map<string, AnnotationProjectionRow[]> {
  const rows = new Map<string, AnnotationProjectionRow[]>();
  const included = new Set<string>();
  const currentByKey = new Map(currentRows.map((row) => [row.key, row] as const));
  for (const operation of operations) {
    if (operation.kind === 'remove' || operation.revision > confirmedRevision) continue;
    const key = operation.key;
    if (key === undefined || claimed.has(key) || included.has(key)) continue;
    const row = currentByKey.get(key);
    if (row?.writable !== true) continue;
    included.add(key);
    appendCandidate(rows, annotationBucket(row.annotation), row);
  }
  return rows;
}

function newerPendingNonRemoveKeys(
  operations: readonly AnnotationProjectionOperation[],
  confirmedRevision: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === 'remove' || operation.revision <= confirmedRevision) continue;
    if (operation.key !== undefined) keys.add(operation.key);
  }
  return keys;
}

function committedSelectionRow(
  key: string,
  provisionalId: string,
  annotation: DocumentAnnotation,
  current?: AnnotationProjectionRow,
): AnnotationProjectionRow {
  const nativeId = annotationId(annotation);
  if (current === undefined)
    return Object.freeze({
      key,
      annotation,
      nativeId,
      provisionalId,
      runtimeId: nativeId,
      writable: annotationIsWritable(annotation),
    });
  const aliases = retainedAliases(current, nativeId, provisionalId, nativeId);
  return Object.freeze({
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
    runtimeId: nativeId,
    ...(aliases.length === 0 ? {} : { aliases }),
    writable: annotationIsWritable(annotation),
  });
}

function verifiedRowIsCurrent(
  current: AnnotationProjectionRow,
  annotation: DocumentAnnotation,
  projected: DocumentAnnotation,
): boolean {
  return (
    current.nativeId === annotationId(annotation) &&
    current.writable === annotationIsWritable(annotation) &&
    JSON.stringify(current.annotation) === JSON.stringify(projected)
  );
}

function unmatchedVerifiedIndexes(
  verified: readonly DocumentAnnotation[],
  reconciled: ReadonlyArray<AnnotationProjectionRow | undefined>,
): Map<string, number[]> {
  const indexes = new Map<string, number[]>();
  verified.forEach((annotation, index) => {
    if (reconciled[index] !== undefined) return;
    const key = annotationBucket(annotation);
    const values = indexes.get(key);
    if (values === undefined) indexes.set(key, [index]);
    else values.push(index);
  });
  return indexes;
}

function previousNativeAlias(
  current: AnnotationProjectionRow | undefined,
  verifiedId: string,
): string | undefined {
  if (current === undefined) return undefined;
  return current.nativeId === verifiedId ? current.provisionalId : current.nativeId;
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

interface AnnotationProjectionDeletionTombstone {
  readonly identities: ReadonlySet<string>;
  readonly revision: number;
}

class AnnotationProjectionViewportIndex {
  private readonly rows: Array<AnnotationProjectionRow | undefined>;
  private readonly slotByKey = new Map<string, number>();
  private readonly native = new Map<string, Set<AnnotationProjectionRow>>();
  private readonly runtime = new Map<string, Set<AnnotationProjectionRow>>();
  private readonly provisional = new Map<string, Set<AnnotationProjectionRow>>();
  private readonly annotation = new Map<string, Set<AnnotationProjectionRow>>();
  private readonly aliases = new Map<string, Set<AnnotationProjectionRow>>();

  constructor(
    rows: readonly AnnotationProjectionRow[],
    private readonly overlays: WeakMap<AnnotationProjectionRow, AnnotationProjectionOverlay>,
  ) {
    this.rows = [...rows];
    rows.forEach((row, index) => {
      this.slotByKey.set(row.key, index);
      this.indexRow(row);
    });
  }

  rowsForSnapshot(snapshot: ViewportAnnotationSnapshot): AnnotationProjectionRow[] {
    const identities =
      snapshot.provisionalId === undefined
        ? [snapshot.nativeId]
        : [snapshot.provisionalId, snapshot.nativeId];
    const resolved = new Map<string, AnnotationProjectionRow>();
    for (const identity of identities) {
      const row = this.rowForIdentity(identity);
      if (row !== undefined) resolved.set(row.key, row);
    }
    return [...resolved.values()];
  }

  hasKey(key: string): boolean {
    return this.slotByKey.has(key);
  }

  removeByIdentity(nativeId: string, provisionalId?: string): boolean {
    const targets = new Map<string, AnnotationProjectionRow>();
    const native = this.rowForRemovalIdentity(nativeId);
    if (native !== undefined) targets.set(native.key, native);
    if (provisionalId !== undefined) {
      const provisional = uniqueIndexedRow(
        this.provisional.get(provisionalId),
        (row) => row.provisionalId === provisionalId,
      );
      if (provisional !== null && provisional !== undefined)
        targets.set(provisional.key, provisional);
    }
    for (const row of targets.values()) this.remove(row);
    return targets.size > 0;
  }

  append(row: AnnotationProjectionRow): void {
    this.slotByKey.set(row.key, this.rows.length);
    this.rows.push(row);
    this.indexRow(row);
  }

  replace(current: AnnotationProjectionRow, updated: AnnotationProjectionRow): void {
    const slot = this.slotByKey.get(current.key);
    if (slot === undefined) return;
    this.unindexRow(current);
    this.rows[slot] = updated;
    this.indexRow(updated);
  }

  remove(row: AnnotationProjectionRow): void {
    const slot = this.slotByKey.get(row.key);
    if (slot === undefined) return;
    this.slotByKey.delete(row.key);
    this.unindexRow(row);
    this.rows[slot] = undefined;
    this.overlays.delete(row);
  }

  snapshot(): AnnotationProjectionRow[] {
    return this.rows.filter((row): row is AnnotationProjectionRow => row !== undefined);
  }

  rowForIdentity(identity: string): AnnotationProjectionRow | undefined {
    for (const tier of [
      this.native,
      this.runtime,
      this.provisional,
      this.annotation,
      this.aliases,
    ]) {
      const row = uniqueIndexedRow(tier.get(identity));
      if (row !== null) return row;
    }
    return undefined;
  }

  private rowForRemovalIdentity(identity: string): AnnotationProjectionRow | undefined {
    for (const tier of [this.native, this.runtime, this.annotation]) {
      const row = uniqueIndexedRow(tier.get(identity));
      if (row !== null) return row;
    }
    const provisional = uniqueIndexedRow(this.provisional.get(identity), (row) =>
      isPendingSelectionPreview(row),
    );
    return provisional ?? undefined;
  }

  private indexRow(row: AnnotationProjectionRow): void {
    addIndexedRow(this.native, row.nativeId, row);
    addIndexedRow(this.runtime, row.runtimeId, row);
    addIndexedRow(this.provisional, row.provisionalId, row);
    addIndexedRow(this.annotation, annotationId(row.annotation), row);
    for (const alias of row.aliases ?? []) addIndexedRow(this.aliases, alias, row);
  }

  private unindexRow(row: AnnotationProjectionRow): void {
    removeIndexedRow(this.native, row.nativeId, row);
    removeIndexedRow(this.runtime, row.runtimeId, row);
    removeIndexedRow(this.provisional, row.provisionalId, row);
    removeIndexedRow(this.annotation, annotationId(row.annotation), row);
    for (const alias of row.aliases ?? []) removeIndexedRow(this.aliases, alias, row);
  }
}

function addIndexedRow(
  index: Map<string, Set<AnnotationProjectionRow>>,
  identity: string | undefined,
  row: AnnotationProjectionRow,
): void {
  if (identity === undefined) return;
  const rows = index.get(identity);
  if (rows === undefined) index.set(identity, new Set([row]));
  else rows.add(row);
}

function removeIndexedRow(
  index: Map<string, Set<AnnotationProjectionRow>>,
  identity: string | undefined,
  row: AnnotationProjectionRow,
): void {
  if (identity === undefined) return;
  const rows = index.get(identity);
  if (rows === undefined) return;
  rows.delete(row);
  if (rows.size === 0) index.delete(identity);
}

function uniqueIndexedRow(
  rows: ReadonlySet<AnnotationProjectionRow> | undefined,
  predicate: (row: AnnotationProjectionRow) => boolean = () => true,
): AnnotationProjectionRow | undefined | null {
  if (rows === undefined) return null;
  let match: AnnotationProjectionRow | null = null;
  for (const row of rows) {
    if (!predicate(row)) continue;
    if (match !== null) return undefined;
    match = row;
  }
  return match;
}

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

function projectionRowsForIdentities(
  rows: readonly AnnotationProjectionRow[],
  identities: Iterable<string>,
): AnnotationProjectionRow[] {
  const resolved = new Map<string, AnnotationProjectionRow>();
  for (const identity of identities) {
    const row = projectionRowForIdentity(rows, identity);
    if (row !== undefined) resolved.set(row.key, row);
  }
  return [...resolved.values()];
}

function projectionRowsForRemovalIdentities(
  rows: readonly AnnotationProjectionRow[],
  identities: Iterable<string>,
): AnnotationProjectionRow[] {
  const resolved = new Map<string, AnnotationProjectionRow>();
  for (const identity of identities) {
    const row = projectionRowForRemovalIdentity(rows, identity);
    if (row !== undefined) resolved.set(row.key, row);
  }
  return [...resolved.values()];
}

function projectionRowForRemovalIdentity(
  rows: readonly AnnotationProjectionRow[],
  identity: string,
): AnnotationProjectionRow | undefined {
  const current = projectionRowAtUniqueTier(rows, (row) => row.nativeId === identity);
  if (current !== null) return current;
  const runtime = projectionRowAtUniqueTier(rows, (row) => row.runtimeId === identity);
  if (runtime !== null) return runtime;
  const annotation = projectionRowAtUniqueTier(
    rows,
    (row) => annotationId(row.annotation) === identity,
  );
  if (annotation !== null) return annotation;
  return (
    projectionRowAtUniqueTier(
      rows,
      (row) => isPendingSelectionPreview(row) && row.provisionalId === identity,
    ) ?? undefined
  );
}

function projectionRowForIdentity(
  rows: readonly AnnotationProjectionRow[],
  identity: string,
): AnnotationProjectionRow | undefined {
  const tiers: ReadonlyArray<(row: AnnotationProjectionRow) => boolean> = [
    (row) => row.nativeId === identity,
    (row) => row.runtimeId === identity,
    (row) => row.provisionalId === identity,
    (row) => annotationId(row.annotation) === identity,
    (row) => row.aliases?.includes(identity) === true,
  ];
  for (const matchesTier of tiers) {
    const match = projectionRowAtUniqueTier(rows, matchesTier);
    if (match !== null) return match;
  }
  return undefined;
}

function projectionRowAtUniqueTier(
  rows: readonly AnnotationProjectionRow[],
  matchesTier: (row: AnnotationProjectionRow) => boolean,
): AnnotationProjectionRow | undefined | null {
  const matches = rows.filter(matchesTier);
  if (matches.length === 1) return matches[0];
  return matches.length > 1 ? undefined : null;
}

function projectionIdentityIndex(
  rows: readonly AnnotationProjectionRow[],
  identities: (row: AnnotationProjectionRow) => ReadonlyArray<string | undefined>,
): ReadonlyMap<string, readonly AnnotationProjectionRow[]> {
  const index = new Map<string, AnnotationProjectionRow[]>();
  for (const row of rows) {
    for (const identity of identities(row)) {
      if (identity !== undefined) appendCandidate(index, identity, row);
    }
  }
  return index;
}

function uniqueUnclaimedRow(
  rows: readonly AnnotationProjectionRow[] | undefined,
  claimed: ReadonlySet<string>,
): AnnotationProjectionRow | undefined | null {
  if (rows === undefined) return null;
  let match: AnnotationProjectionRow | null = null;
  for (const row of rows) {
    if (claimed.has(row.key)) continue;
    if (match !== null) return undefined;
    match = row;
  }
  return match;
}

function rowIdentityAliases(row: AnnotationProjectionRow): readonly string[] {
  return uniqueAliases(
    row.nativeId,
    row.provisionalId,
    row.runtimeId,
    annotationId(row.annotation),
    ...(row.aliases ?? []),
  );
}

function retainedAliases(
  current: AnnotationProjectionRow | undefined,
  nativeId: string,
  provisionalId: string | undefined,
  annotationIdentity: string,
): readonly string[] {
  if (current === undefined) return [];
  const nextIdentities = new Set(
    [nativeId, provisionalId, annotationIdentity].filter(
      (identity): identity is string => identity !== undefined && identity.length > 0,
    ),
  );
  return rowIdentityAliases(current).filter((identity) => !nextIdentities.has(identity));
}

function uniqueAliases(...identities: ReadonlyArray<string | undefined>): readonly string[] {
  return [
    ...new Set(
      identities.filter(
        (identity): identity is string => identity !== undefined && identity.length > 0,
      ),
    ),
  ];
}

function appendIndex(index: Map<string, number[]>, key: string, value: number): void {
  const values = index.get(key);
  if (values === undefined) index.set(key, [value]);
  else values.push(value);
}

interface StrongBucketBinding {
  readonly annotation: DocumentAnnotation;
  readonly current: AnnotationProjectionRow;
  readonly index: number;
}

function strongBucketBindings(
  rows: readonly AnnotationProjectionRow[],
  indexes: readonly number[],
  verified: readonly DocumentAnnotation[],
): StrongBucketBinding[] | null {
  const annotations = indexes.flatMap((index) => {
    const annotation = verified[index];
    return annotation === undefined ? [] : [{ annotation, index }];
  });
  if (annotations.length !== indexes.length) return null;
  const rowsBySignature = uniqueRowsByStrongSignature(rows);
  if (rowsBySignature === null) {
    if (!rows.every(hasDistinctRuntimeIdentity)) return null;
    return uniformStrongBucketBindings(rows, annotations);
  }
  const signatures = annotations.map(({ annotation }) => annotationStrongSignature(annotation));
  if (
    new Set(signatures).size !== signatures.length ||
    signatures.some((signature) => !rowsBySignature.has(signature))
  )
    return null;
  return annotations.flatMap(({ annotation, index }, bindingIndex) => {
    const signature = signatures[bindingIndex];
    const current = signature === undefined ? undefined : rowsBySignature.get(signature);
    return current === undefined ? [] : [{ annotation, current, index }];
  });
}

function hasDistinctRuntimeIdentity(row: AnnotationProjectionRow): boolean {
  return row.runtimeId !== undefined && row.runtimeId !== row.nativeId;
}

function uniformStrongBucketBindings(
  rows: readonly AnnotationProjectionRow[],
  annotations: ReadonlyArray<{ readonly annotation: DocumentAnnotation; readonly index: number }>,
): StrongBucketBinding[] | null {
  if (rows.length !== annotations.length) return null;
  const expected = rows[0];
  if (expected === undefined) return null;
  const signature = annotationStrongSignature(expected.annotation);
  if (
    !rows.every((row) => annotationStrongSignature(row.annotation) === signature) ||
    !annotations.every(({ annotation }) => annotationStrongSignature(annotation) === signature)
  )
    return null;
  return annotations.flatMap(({ annotation, index }, bindingIndex) => {
    const current = rows[bindingIndex];
    return current === undefined ? [] : [{ annotation, current, index }];
  });
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
  const nativeId = canonicalNativeIdForSnapshot(snapshot, row);
  const runtimeId = runtimeIdForSnapshot(snapshot, row);
  return (
    row.nativeId === nativeId &&
    row.provisionalId === (snapshot.provisionalId ?? row.provisionalId) &&
    row.runtimeId === runtimeId &&
    sameStrings(
      row.aliases ?? [],
      retainedAliases(
        row,
        nativeId,
        snapshot.provisionalId ?? row.provisionalId,
        annotationId(annotation),
      ),
    ) &&
    row.writable === (snapshot.writable ?? annotationIsWritable(annotation)) &&
    JSON.stringify(row.annotation) === JSON.stringify(annotation)
  );
}

function canonicalNativeIdForSnapshot(
  snapshot: ViewportAnnotationSnapshot,
  current: AnnotationProjectionRow | undefined,
): string {
  if (current?.runtimeId !== undefined && current.nativeId !== current.runtimeId)
    return current.nativeId;
  return snapshot.nativeId;
}

function runtimeIdForSnapshot(
  snapshot: ViewportAnnotationSnapshot,
  current: AnnotationProjectionRow | undefined,
): string | undefined {
  if (snapshot.writable !== true) return current?.runtimeId;
  return snapshot.runtimeId ?? snapshot.nativeId;
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

function annotationStrongSignature(annotation: DocumentAnnotation): string {
  return JSON.stringify([
    annotationBucket(annotation),
    annotationSignature(annotation),
    annotation.selectedText ?? '',
    annotation.comment,
    annotation.tags,
    annotation.links,
  ]);
}

function uniqueRowsByStrongSignature(
  rows: readonly AnnotationProjectionRow[],
): Map<string, AnnotationProjectionRow> | null {
  const indexed = new Map<string, AnnotationProjectionRow>();
  for (const row of rows) {
    const signature = annotationStrongSignature(row.annotation);
    if (indexed.has(signature)) return null;
    indexed.set(signature, row);
  }
  return indexed;
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

function removeStaleOperationIndexes(
  indexes: number[],
  identity: string,
  operations: readonly AnnotationProjectionOperation[],
): void {
  while (indexes.length > 0) {
    const index = indexes[indexes.length - 1];
    const operation = index === undefined ? undefined : operations[index];
    if (operation !== undefined && operationIds(operation).has(identity)) return;
    indexes.pop();
  }
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
