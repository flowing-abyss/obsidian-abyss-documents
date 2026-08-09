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
