import {
  asUtcTimestamp,
  freezeAnnotationMutation,
  type AnnotationMutation,
  type UtcTimestamp,
} from './annotations.js';
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

export interface CapturedGeneration {
  readonly captureId: number;
  readonly generation: number;
  readonly mutations: readonly AnnotationMutation[];
}

export interface VerifiedSaveResult {
  readonly verified: true;
  readonly generation: number;
  readonly sha256: string;
  readonly byteSize: number;
  readonly committedAt: UtcTimestamp;
}

export interface DocumentSaveOwner {
  readonly descriptor: { readonly path: string };
}

export interface DocumentSaveService<TSession extends DocumentSaveOwner = DocumentSaveOwner> {
  save(
    attempt: ActiveDocumentSaveAttempt<TSession>,
    signal: AbortSignal,
  ): Promise<VerifiedSaveResult>;
}

type ActiveAttemptAction = 'writing' | 'verifying' | 'commit' | 'fail';
type ActiveAttemptTransition<TSession extends DocumentSaveOwner> = (
  attempt: ActiveDocumentSaveAttempt<TSession>,
  action: ActiveAttemptAction,
  value?: unknown,
) => void;
type AttemptExecutor<TSession extends DocumentSaveOwner> = (
  attempt: DocumentSaveAttempt<TSession>,
  service: DocumentSaveService<TSession>,
  signal: AbortSignal,
) => Promise<VerifiedSaveResult>;

class DocumentPathChangedError extends LedgerTransitionError {
  constructor(state: MutationLedgerState) {
    super(state, 'save after document path changed');
  }
}

const PREPARED_ATTEMPT_TOKEN = Symbol('MutationLedgerPreparedSaveAttempt');
const ACTIVE_ATTEMPT_TOKEN = Symbol('MutationLedgerActiveSaveAttempt');

interface SaveAttemptBinding<TSession extends DocumentSaveOwner> {
  readonly session: TSession;
  readonly path: string;
  readonly captured: CapturedGeneration;
}

class LedgerDocumentSaveAttempt<TSession extends DocumentSaveOwner = DocumentSaveOwner> {
  declare private readonly preparedAttemptBrand: void;
  readonly session: TSession;
  readonly path: string;
  readonly captured: CapturedGeneration;

  constructor(
    token: symbol,
    binding: SaveAttemptBinding<TSession>,
    private readonly execute: AttemptExecutor<TSession>,
  ) {
    if (token !== PREPARED_ATTEMPT_TOKEN) {
      throw new TypeError('A document save attempt must be created by its mutation ledger.');
    }
    this.session = binding.session;
    this.path = binding.path;
    this.captured = binding.captured;
    Object.freeze(this);
  }

  run(service: DocumentSaveService<TSession>, signal: AbortSignal): Promise<VerifiedSaveResult> {
    return this.execute(this, service, signal);
  }
}

export type DocumentSaveAttempt<TSession extends DocumentSaveOwner = DocumentSaveOwner> =
  LedgerDocumentSaveAttempt<TSession>;

class LedgerActiveDocumentSaveAttempt<TSession extends DocumentSaveOwner = DocumentSaveOwner> {
  declare private readonly activeAttemptBrand: void;
  readonly session: TSession;
  readonly path: string;
  readonly captured: CapturedGeneration;

  constructor(
    token: symbol,
    binding: SaveAttemptBinding<TSession>,
    private readonly transition: ActiveAttemptTransition<TSession>,
  ) {
    if (token !== ACTIVE_ATTEMPT_TOKEN) {
      throw new TypeError('An active save attempt must be claimed by its mutation ledger.');
    }
    this.session = binding.session;
    this.path = binding.path;
    this.captured = binding.captured;
    Object.freeze(this);
  }

  markWriting(): void {
    this.transition(this, 'writing');
  }

  markVerifying(): void {
    this.transition(this, 'verifying');
  }

  commit(result: VerifiedSaveResult): void {
    this.transition(this, 'commit', result);
  }

  fail(cause: unknown): void {
    this.transition(this, 'fail', cause);
  }
}

export type ActiveDocumentSaveAttempt<TSession extends DocumentSaveOwner = DocumentSaveOwner> =
  LedgerActiveDocumentSaveAttempt<TSession>;

interface StagedCommit<TSession extends DocumentSaveOwner> {
  readonly attempt: ActiveDocumentSaveAttempt<TSession>;
  readonly result: VerifiedSaveResult;
}

export class MutationLedger<TSession extends DocumentSaveOwner = DocumentSaveOwner> {
  private entries: MutationLedgerEntry[] = [];
  private activeCapture: CapturedGeneration | null = null;
  private preparedAttempt: DocumentSaveAttempt<TSession> | null = null;
  private activeAttempt: ActiveDocumentSaveAttempt<TSession> | null = null;
  private stagedCommit: StagedCommit<TSession> | null = null;
  private nextGeneration = 1;
  private nextCaptureId = 1;
  private currentState: MutationLedgerState = 'committed';
  private failure: MutationLedgerFailure | null = null;
  private acknowledgedGeneration = 0;
  private readonly ownerPath: string;

  constructor(private readonly owner: TSession) {
    this.ownerPath = snapshotDocumentPath(owner);
  }

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

  prepareSave(captured: CapturedGeneration): DocumentSaveAttempt<TSession> {
    this.requireActiveCapture(captured);
    if (this.preparedAttempt !== null || this.activeAttempt !== null) {
      throw new LedgerTransitionError(this.currentState, 'prepare another save');
    }
    const attempt = new LedgerDocumentSaveAttempt(
      PREPARED_ATTEMPT_TOKEN,
      { session: this.owner, path: this.ownerPath, captured },
      async (prepared, service, signal) => this.executeAttempt(prepared, service, signal),
    );
    this.preparedAttempt = attempt;
    return attempt;
  }

  pending(): readonly AnnotationMutation[] {
    return Object.freeze(this.entries.map((entry) => entry.mutation));
  }

  private async executeAttempt(
    prepared: DocumentSaveAttempt<TSession>,
    service: DocumentSaveService<TSession>,
    signal: AbortSignal,
  ): Promise<VerifiedSaveResult> {
    const active = this.claimAttempt(prepared);
    try {
      const result = await service.save(active, signal);
      return this.requireCommittedResult(active, result);
    } catch (cause) {
      if (this.activeAttempt === active) this.failAttempt(active, cause);
      throw cause;
    }
  }

  private claimAttempt(
    prepared: DocumentSaveAttempt<TSession>,
  ): ActiveDocumentSaveAttempt<TSession> {
    if (this.preparedAttempt !== prepared || this.activeCapture !== prepared.captured) {
      throw new StaleGenerationError(prepared.captured.captureId, prepared.captured.generation);
    }
    try {
      this.requireOwnerPath();
    } catch (cause) {
      this.failPreparedAttempt(prepared, cause);
      throw cause;
    }
    const active = new LedgerActiveDocumentSaveAttempt(
      ACTIVE_ATTEMPT_TOKEN,
      { session: this.owner, path: this.ownerPath, captured: prepared.captured },
      (attempt, action, value) => {
        this.transitionAttempt(attempt, action, value);
      },
    );
    this.preparedAttempt = null;
    this.activeAttempt = active;
    this.stagedCommit = null;
    return active;
  }

  private requireCommittedResult(
    active: ActiveDocumentSaveAttempt<TSession>,
    result: VerifiedSaveResult,
  ): VerifiedSaveResult {
    this.requireActiveAttempt(active);
    this.requireOwnerPath();
    const staged = this.stagedCommit;
    if (staged?.attempt !== active) {
      throw new LedgerTransitionError(this.currentState, 'finish save without commit');
    }
    const returned = normalizeVerifiedSaveResult(result, active.captured.generation);
    if (!verifiedResultsMatch(staged.result, returned)) {
      throw new TypeError('The service returned a different verified result than it committed.');
    }
    this.requireOwnerPath();
    this.finalizeCommit(active);
    return staged.result;
  }

  private transition(expected: MutationLedgerState, next: MutationLedgerState): void {
    if (this.currentState !== expected) {
      throw new LedgerTransitionError(this.currentState, next);
    }
    this.currentState = next;
  }

  private requireActiveCapture(captured: CapturedGeneration): void {
    if (this.activeCapture !== captured) {
      throw new StaleGenerationError(captured.captureId, captured.generation);
    }
  }

  private transitionAttempt(
    attempt: ActiveDocumentSaveAttempt<TSession>,
    action: ActiveAttemptAction,
    value?: unknown,
  ): void {
    this.requireActiveAttempt(attempt);
    if (action === 'fail') {
      this.failAttempt(attempt, value);
      return;
    }

    try {
      this.requireOwnerPath();
      this.applyAttemptTransition(attempt, action, value);
      this.requireOwnerPath();
    } catch (cause) {
      this.rethrowAttemptTransitionFailure(attempt, cause);
    }
  }

  private applyAttemptTransition(
    attempt: ActiveDocumentSaveAttempt<TSession>,
    action: Exclude<ActiveAttemptAction, 'fail'>,
    value: unknown,
  ): void {
    if (action === 'writing') {
      this.transition('serializing', 'writing');
      return;
    }
    if (action === 'verifying') {
      this.transition('writing', 'verifying');
      return;
    }
    this.stageCommit(attempt, value as VerifiedSaveResult);
  }

  private rethrowAttemptTransitionFailure(
    attempt: ActiveDocumentSaveAttempt<TSession>,
    cause: unknown,
  ): never {
    const pathFailure = cause instanceof DocumentPathChangedError ? cause : this.ownerPathFailure();
    if (pathFailure !== null) {
      if (this.activeAttempt === attempt) this.failAttempt(attempt, pathFailure);
      throw pathFailure;
    }
    throw cause;
  }

  private stageCommit(
    attempt: ActiveDocumentSaveAttempt<TSession>,
    result: VerifiedSaveResult,
  ): void {
    if (this.currentState !== 'verifying') {
      throw new LedgerTransitionError(this.currentState, 'commit');
    }
    if (this.stagedCommit !== null) {
      throw new LedgerTransitionError(this.currentState, 'commit more than once');
    }
    this.stagedCommit = Object.freeze({
      attempt,
      result: normalizeVerifiedSaveResult(result, attempt.captured.generation),
    });
  }

  private finalizeCommit(attempt: ActiveDocumentSaveAttempt<TSession>): void {
    this.requireActiveAttempt(attempt);
    const generation = attempt.captured.generation;
    this.entries = this.entries.filter((entry) => entry.generation > generation);
    this.acknowledgedGeneration = Math.max(this.acknowledgedGeneration, generation);
    this.completeAttempt();
    this.currentState = this.entries.length === 0 ? 'committed' : 'dirty';
    this.failure = null;
  }

  private failAttempt(attempt: ActiveDocumentSaveAttempt<TSession>, cause: unknown): void {
    const stage = this.failureStage();
    this.failure = Object.freeze({ generation: attempt.captured.generation, stage, cause });
    this.completeAttempt();
    this.currentState = this.entries.length === 0 ? 'committed' : 'dirty';
  }

  private failPreparedAttempt(attempt: DocumentSaveAttempt<TSession>, cause: unknown): void {
    if (this.preparedAttempt !== attempt || this.activeCapture !== attempt.captured) {
      throw new StaleGenerationError(attempt.captured.captureId, attempt.captured.generation);
    }
    this.failure = Object.freeze({
      generation: attempt.captured.generation,
      stage: 'serializing',
      cause,
    });
    this.completeAttempt();
    this.currentState = this.entries.length === 0 ? 'committed' : 'dirty';
  }

  private requireActiveAttempt(attempt: ActiveDocumentSaveAttempt<TSession>): void {
    if (this.activeAttempt !== attempt) {
      throw new StaleGenerationError(attempt.captured.captureId, attempt.captured.generation);
    }
  }

  private completeAttempt(): void {
    this.activeCapture = null;
    this.preparedAttempt = null;
    this.activeAttempt = null;
    this.stagedCommit = null;
  }

  private requireOwnerPath(): void {
    const failure = this.ownerPathFailure();
    if (failure !== null) throw failure;
  }

  private ownerPathFailure(): DocumentPathChangedError | null {
    return this.owner.descriptor.path === this.ownerPath
      ? null
      : new DocumentPathChangedError(this.currentState);
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

const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

function snapshotDocumentPath(owner: DocumentSaveOwner): string {
  const path = owner.descriptor.path;
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new TypeError('A document save owner requires a non-empty path.');
  }
  return path;
}

function normalizeVerifiedSaveResult(
  value: VerifiedSaveResult,
  expectedGeneration: number,
): VerifiedSaveResult {
  const result = value as Partial<Record<keyof VerifiedSaveResult, unknown>> | null;
  const generation = normalizeVerifiedGeneration(
    result?.verified,
    result?.generation,
    expectedGeneration,
  );
  const sha256 = normalizeSha256(result?.sha256);
  const byteSize = normalizeByteSize(result?.byteSize);
  const committedAt = normalizeCommittedAt(result?.committedAt);
  return Object.freeze({ verified: true, generation, sha256, byteSize, committedAt });
}

function normalizeVerifiedGeneration(
  verified: unknown,
  generation: unknown,
  expected: number,
): number {
  if (verified !== true || generation !== expected) {
    throw new TypeError('The verified result is malformed or belongs to another generation.');
  }
  return expected;
}

function normalizeSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError('The verified result contains an invalid SHA-256 hash.');
  }
  return value.toLowerCase();
}

function normalizeByteSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('The verified result contains an invalid byte size.');
  }
  return value;
}

function normalizeCommittedAt(value: unknown): UtcTimestamp {
  if (typeof value !== 'string') {
    throw new TypeError('The verified result contains an invalid committed timestamp.');
  }
  try {
    return asUtcTimestamp(value);
  } catch {
    throw new TypeError('The verified result contains an invalid committed timestamp.');
  }
}

function verifiedResultsMatch(left: VerifiedSaveResult, right: VerifiedSaveResult): boolean {
  return (
    left.generation === right.generation &&
    left.sha256 === right.sha256 &&
    left.byteSize === right.byteSize &&
    left.committedAt === right.committedAt
  );
}
