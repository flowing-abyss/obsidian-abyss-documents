export interface AnnotationSaveBaseline {
  failures: number;
  minimumSaves: number;
  recoveries: number;
}

export interface AnnotationSaveOracleSnapshot {
  activeSerializations: number;
  activeWrites: number;
  committedRevision: number;
  failures: number;
  isDirty: boolean;
  newestGeneration: number;
  paused: boolean;
  pendingRevision: number;
  recoveries: number;
  savedGeneration: number;
  saves: number;
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
    failureChainSettled &&
    snapshot.activeSerializations === 0 &&
    snapshot.activeWrites === 0 &&
    !snapshot.paused &&
    snapshot.savedGeneration >= snapshot.newestGeneration &&
    !snapshot.isDirty &&
    snapshot.committedRevision === snapshot.pendingRevision
  );
}
