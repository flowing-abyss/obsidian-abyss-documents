import { freezeAnnotationMutation, type AnnotationMutation } from './annotations.js';
import type { CapturedGeneration } from './editable-document.js';
import { LedgerTransitionError, StaleGenerationError } from './errors.js';

export type MutationLedgerState = 'dirty' | 'serializing' | 'writing' | 'verifying' | 'committed';

export interface MutationLedgerEntry {
  readonly generation: number;
  readonly mutation: AnnotationMutation;
}

export interface MutationLedgerFailure {
  readonly generation: number;
  readonly stage: 'serializing' | 'writing' | 'verifying';
  readonly cause: unknown;
}

export class MutationLedger {
  private entries: MutationLedgerEntry[] = [];
  private activeCapture: CapturedGeneration | null = null;
  private nextGeneration = 1;
  private nextCaptureId = 1;
  private currentState: MutationLedgerState = 'committed';
  private failure: MutationLedgerFailure | null = null;
  private acknowledgedGeneration = 0;

  get state(): MutationLedgerState {
    return this.currentState;
  }

  get lastFailure(): MutationLedgerFailure | null {
    return this.failure;
  }

  get committedGeneration(): number {
    return this.acknowledgedGeneration;
  }

  append(mutation: AnnotationMutation): MutationLedgerEntry {
    const entry = Object.freeze({
      generation: this.nextGeneration,
      mutation: freezeAnnotationMutation(mutation),
    });
    this.nextGeneration += 1;
    this.entries = [...this.entries, entry];
    if (this.activeCapture === null) this.currentState = 'dirty';
    return entry;
  }

  capture(): CapturedGeneration {
    if (this.activeCapture !== null) {
      throw new LedgerTransitionError(this.currentState, 'capture');
    }
    const latest = this.entries[this.entries.length - 1];
    const generation = latest?.generation ?? this.acknowledgedGeneration;
    const mutations = Object.freeze(this.entries.map((entry) => entry.mutation));
    const captured = Object.freeze({
      captureId: this.nextCaptureId,
      generation,
      mutations,
    });
    this.nextCaptureId += 1;
    this.activeCapture = captured;
    this.currentState = 'serializing';
    this.failure = null;
    return captured;
  }

  markWriting(captured: CapturedGeneration): void {
    this.transition(captured, 'serializing', 'writing');
  }

  markVerifying(captured: CapturedGeneration): void {
    this.transition(captured, 'writing', 'verifying');
  }

  commit(captured: CapturedGeneration): void {
    this.requireActive(captured);
    if (this.currentState !== 'verifying') {
      throw new LedgerTransitionError(this.currentState, 'commit');
    }
    this.entries = this.entries.filter((entry) => entry.generation > captured.generation);
    this.acknowledgedGeneration = Math.max(this.acknowledgedGeneration, captured.generation);
    this.activeCapture = null;
    this.currentState = this.entries.length === 0 ? 'committed' : 'dirty';
    this.failure = null;
  }

  fail(captured: CapturedGeneration, cause: unknown): void {
    this.requireActive(captured);
    const stage = this.failureStage();
    this.failure = Object.freeze({ generation: captured.generation, stage, cause });
    this.activeCapture = null;
    this.currentState = this.entries.length === 0 ? 'committed' : 'dirty';
  }

  pending(): readonly AnnotationMutation[] {
    return Object.freeze(this.entries.map((entry) => entry.mutation));
  }

  private transition(
    captured: CapturedGeneration,
    expected: MutationLedgerState,
    next: MutationLedgerState,
  ): void {
    this.requireActive(captured);
    if (this.currentState !== expected) {
      throw new LedgerTransitionError(this.currentState, next);
    }
    this.currentState = next;
  }

  private requireActive(captured: CapturedGeneration): void {
    if (this.activeCapture !== captured) {
      throw new StaleGenerationError(captured.captureId, captured.generation);
    }
  }

  private failureStage(): MutationLedgerFailure['stage'] {
    if (
      this.currentState === 'serializing' ||
      this.currentState === 'writing' ||
      this.currentState === 'verifying'
    ) {
      return this.currentState;
    }
    throw new LedgerTransitionError(this.currentState, 'fail');
  }
}
