import { describe, expect, it } from 'vitest';
import { isVerifiedAnnotationSaveSettled } from '../tests/e2e/annotation-save-oracle.js';

const settled = {
  activeSerializations: 0,
  activeWrites: 0,
  committedRevision: 1,
  failures: 1,
  inFlight: false,
  isDirty: false,
  newestGeneration: 3,
  paused: false,
  pendingRevision: 1,
  recoveries: 1,
  savedGeneration: 3,
  saves: 2,
};

describe('annotation E2E save oracle', () => {
  it('requires a verified successful Retry before accepting a transient save failure', () => {
    const baseline = { failures: 0, minimumSaves: 2, recoveries: 0 };

    expect(isVerifiedAnnotationSaveSettled({ ...settled, saves: 1 }, baseline)).toBe(false);
    expect(isVerifiedAnnotationSaveSettled({ ...settled, recoveries: 0 }, baseline)).toBe(false);
    expect(isVerifiedAnnotationSaveSettled(settled, baseline)).toBe(true);
  });

  it('rejects dirty, paused, active, or lagging autosave state after a success counter advances', () => {
    const baseline = { failures: 1, minimumSaves: 2, recoveries: 1 };

    expect(isVerifiedAnnotationSaveSettled({ ...settled, isDirty: true }, baseline)).toBe(false);
    expect(isVerifiedAnnotationSaveSettled({ ...settled, paused: true }, baseline)).toBe(false);
    expect(isVerifiedAnnotationSaveSettled({ ...settled, activeWrites: 1 }, baseline)).toBe(false);
    expect(isVerifiedAnnotationSaveSettled({ ...settled, inFlight: true }, baseline)).toBe(false);
    expect(isVerifiedAnnotationSaveSettled({ ...settled, activeSerializations: 1 }, baseline)).toBe(
      false,
    );
    expect(isVerifiedAnnotationSaveSettled({ ...settled, savedGeneration: 2 }, baseline)).toBe(
      false,
    );
    expect(isVerifiedAnnotationSaveSettled({ ...settled, pendingRevision: 2 }, baseline)).toBe(
      false,
    );
  });

  it('accepts a save that completed before polling begins when its baseline was captured first', () => {
    const baseline = { failures: 0, minimumSaves: 2, recoveries: 0 };

    expect(isVerifiedAnnotationSaveSettled({ ...settled, failures: 0 }, baseline)).toBe(true);
    expect(isVerifiedAnnotationSaveSettled({ ...settled, failures: 0, saves: 1 }, baseline)).toBe(
      false,
    );
  });
});
