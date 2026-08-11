export class DocumentOpenError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class DocumentCancelledError extends DocumentOpenError {}

export class DocumentPasswordError extends DocumentOpenError {}

export class InvalidDocumentError extends DocumentOpenError {}

export type DocumentOperation =
  'list-annotations' | 'apply-mutation' | 'serialize' | 'write' | 'verify';

export class DocumentOperationCancelledError extends Error {
  constructor(
    readonly operation: DocumentOperation,
    readonly path: string,
    readonly cause?: unknown,
  ) {
    super(`${operation.replaceAll('-', ' ')} was cancelled for ${path}.`);
    this.name = new.target.name;
  }
}

export class StaleGenerationError extends Error {
  constructor(
    readonly captureId: number,
    readonly generation: number,
  ) {
    super(`Capture ${captureId} for generation ${generation} is no longer active.`);
    this.name = new.target.name;
  }
}

export class LedgerTransitionError extends Error {
  constructor(
    readonly state: string,
    readonly action: string,
  ) {
    super(`Cannot ${action} while the mutation ledger is ${state}.`);
    this.name = new.target.name;
  }
}
