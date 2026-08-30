import { browser } from '@wdio/globals';
import type { App } from 'obsidian';
import type { AnnotationSaveLifecycleViewBoundary } from '../../src/reader/document-view.js';

export interface AnnotationSaveBaseline {
  failures: number;
  minimumCommittedRevision: number;
  minimumSavedGeneration: number;
  minimumSaves: number;
  recoveries: number;
}

export interface AnnotationSaveOracleSnapshot {
  activeSerializations: number;
  activeWrites: number;
  committedRevision: number;
  failures: number;
  isDirty: boolean;
  inFlight: boolean;
  newestGeneration: number;
  paused: boolean;
  pendingRevision: number;
  recoveries: number;
  savedGeneration: number;
  saves: number;
}

export async function readAnnotationSaveLifecycleSnapshot(
  leafId?: string,
): Promise<AnnotationSaveOracleSnapshot> {
  const runner = browser as unknown as {
    executeObsidian<T>(
      callback: (context: { app: App }, input: string | null) => T,
      input: string | null,
    ): Promise<T>;
  };
  const snapshot = await runner.executeObsidian(({ app }, targetLeafId) => {
    const leaf =
      targetLeafId === null
        ? app.workspace.getMostRecentLeaf()
        : app.workspace.getLeafById(targetLeafId);
    const view = leaf?.view as AnnotationSaveLifecycleViewBoundary | undefined;
    return view?.annotationSaveLifecycleSnapshot() ?? null;
  }, leafId ?? null);
  if (snapshot === null) throw new Error('Annotation save lifecycle is unavailable.');
  return snapshot;
}

export async function captureAnnotationSaveBaseline(
  leafId?: string,
): Promise<AnnotationSaveBaseline> {
  const snapshot = await readAnnotationSaveLifecycleSnapshot(leafId);
  return {
    failures: snapshot.failures,
    minimumCommittedRevision: snapshot.pendingRevision + 1,
    minimumSavedGeneration: snapshot.newestGeneration + 1,
    minimumSaves: snapshot.saves + 1,
    recoveries: snapshot.recoveries,
  };
}

export function isVerifiedAnnotationSaveSettled(
  snapshot: AnnotationSaveOracleSnapshot,
  baseline: AnnotationSaveBaseline,
): boolean {
  const failureChainSettled =
    snapshot.failures === baseline.failures ||
    (snapshot.failures > baseline.failures && snapshot.recoveries > baseline.recoveries);
  return (
    snapshot.saves >= baseline.minimumSaves &&
    snapshot.committedRevision >= baseline.minimumCommittedRevision &&
    snapshot.savedGeneration >= baseline.minimumSavedGeneration &&
    failureChainSettled &&
    snapshot.activeSerializations === 0 &&
    snapshot.activeWrites === 0 &&
    !snapshot.inFlight &&
    !snapshot.paused &&
    snapshot.savedGeneration >= snapshot.newestGeneration &&
    !snapshot.isDirty &&
    snapshot.committedRevision === snapshot.pendingRevision
  );
}
