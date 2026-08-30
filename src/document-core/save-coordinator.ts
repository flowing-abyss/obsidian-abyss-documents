import { asUtcTimestamp } from './annotations.js';
import type { VerifiedSaveResult } from './mutation-ledger.js';

export interface BaseToken {
  readonly sha256: string;
  readonly byteSize: number;
  readonly mtime: number;
}

export type WriteCapability = 'atomic-conditional' | 'best-effort-verified' | 'read-only';

export interface PdfWriteRequest {
  readonly path: string;
  readonly expected: BaseToken;
  readonly bytes: Uint8Array;
  readonly overwrite: boolean;
  readonly verifyPdf: PdfReopenVerifier;
  readonly signal: AbortSignal;
}

export interface VerifiedPdfWrite {
  readonly token: BaseToken;
}

export interface NativePdfWriteBoundary {
  readonly capability: WriteCapability;
  write(request: PdfWriteRequest): Promise<VerifiedPdfWrite>;
  inspectRecovery(failure: NativeSaveRecoveryFailure, signal: AbortSignal): Promise<BaseToken>;
  recover(
    failure: NativeSaveRecoveryFailure,
    acknowledgedCurrent: BaseToken,
    verifyPdf: PdfReopenVerifier,
    signal: AbortSignal,
  ): Promise<BaseToken>;
}

export interface NativeSaveRecoveryFailure extends Error {
  readonly path: string;
  readonly preimage: Uint8Array | null;
  readonly preparedBytes: Uint8Array;
  readonly restored: boolean;
}

export function isNativeSaveRecoveryFailure(cause: unknown): cause is NativeSaveRecoveryFailure {
  return (
    cause instanceof Error &&
    'path' in cause &&
    typeof cause.path === 'string' &&
    'preimage' in cause &&
    (cause.preimage === null || cause.preimage instanceof Uint8Array) &&
    'preparedBytes' in cause &&
    cause.preparedBytes instanceof Uint8Array &&
    'restored' in cause &&
    typeof cause.restored === 'boolean'
  );
}

export class SaveConflictError extends Error {
  constructor(
    readonly path: string,
    readonly expected: BaseToken,
    readonly actual: BaseToken,
  ) {
    super(`The PDF changed outside this view before annotations could be saved: ${path}`);
    this.name = new.target.name;
  }
}

export interface PreparedNativeSave {
  readonly revision: number;
  readonly baseToken: BaseToken;
  readonly bytes: Uint8Array;
}

export interface NativeSaveSource {
  prepare(revision: number, signal: AbortSignal): Promise<PreparedNativeSave>;
  commit(prepared: PreparedNativeSave, token: BaseToken): void | Promise<void>;
}

export interface NativeRecoverySource {
  readonly kind: 'recovery';
}

export const NATIVE_RECOVERY_SOURCE: NativeRecoverySource = Object.freeze({ kind: 'recovery' });

export type VerifiedReloadSource = NativeSaveSource | NativeRecoverySource;

export interface NativeEditableSaveSession extends NativeSaveSource {
  readonly baseToken: BaseToken;
  readonly committedRevision?: number;
  readonly pendingRevision: number;
  readonly isDirty: boolean;
  destroy(): void;
}

export interface NativeDocumentSaveRequest {
  readonly path: string;
  readonly baseToken: BaseToken;
  readonly revision: number;
  readonly source: NativeSaveSource;
  readonly beforePrepare?: ((signal: AbortSignal) => void) | undefined;
  readonly overwrite?: boolean;
}

export type VerifiedReloadListener = (
  token: BaseToken,
  revision: number,
  source: VerifiedReloadSource,
) => void | Promise<void>;

export type PdfReopenVerifier = (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;

interface RetainedPreparation {
  readonly revision: number;
  readonly prepared: PreparedNativeSave;
}

export class DocumentSaveCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<VerifiedReloadListener>>();
  private readonly retained = new WeakMap<NativeSaveSource, RetainedPreparation>();

  constructor(
    private readonly boundary: Pick<NativePdfWriteBoundary, 'write'> &
      Partial<Pick<NativePdfWriteBoundary, 'inspectRecovery' | 'recover'>>,
    private readonly verifyPdf: PdfReopenVerifier,
  ) {}

  inspectRecovery(failure: NativeSaveRecoveryFailure, signal: AbortSignal): Promise<BaseToken> {
    if (this.boundary.inspectRecovery === undefined)
      return Promise.reject(new TypeError('PDF recovery is unavailable.'));
    return this.boundary.inspectRecovery(failure, signal);
  }

  recover(
    failure: NativeSaveRecoveryFailure,
    acknowledgedCurrent: BaseToken,
    signal: AbortSignal,
  ): Promise<BaseToken> {
    if (this.boundary.recover === undefined)
      return Promise.reject(new TypeError('PDF recovery is unavailable.'));
    const recover = this.boundary.recover.bind(this.boundary);
    const key = normalizeDocumentPath(failure.path);
    return this.enqueue(key, async () => {
      throwIfAborted(signal);
      const token = await recover(failure, acknowledgedCurrent, this.verifyPdf, signal);
      await this.broadcast(key, { token }, 0, NATIVE_RECOVERY_SOURCE);
      return token;
    });
  }

  register(path: string, listener: VerifiedReloadListener): () => void {
    const key = normalizeDocumentPath(path);
    const listeners = this.listeners.get(key) ?? new Set<VerifiedReloadListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  save(request: NativeDocumentSaveRequest, signal: AbortSignal): Promise<VerifiedSaveResult> {
    const snapshot = normalizeRequest(request);
    const key = normalizeDocumentPath(snapshot.path);
    return this.enqueue(key, async () => {
      throwIfAborted(signal);
      return this.performSave(snapshot, key, signal);
    });
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      },
      () => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      },
    );
    this.tails.set(key, tail);
    return result;
  }

  private async performSave(
    request: NativeDocumentSaveRequest,
    key: string,
    signal: AbortSignal,
  ): Promise<VerifiedSaveResult> {
    const prepared = await this.prepareOnce(request, signal);
    requirePreparation(prepared, request);
    const writeRequest: PdfWriteRequest = {
      path: request.path,
      expected: request.baseToken,
      bytes: prepared.bytes,
      overwrite: request.overwrite === true,
      verifyPdf: this.verifyPdf,
      signal,
    };
    const verified = await this.boundary.write(writeRequest);
    await request.source.commit(prepared, verified.token);
    this.retained.delete(request.source);
    await this.broadcast(key, verified, request.revision, request.source);
    return Object.freeze({
      verified: true,
      generation: request.revision,
      sha256: verified.token.sha256,
      byteSize: verified.token.byteSize,
      committedAt: asUtcTimestamp(new Date().toISOString()),
    });
  }

  private async prepareOnce(
    request: NativeDocumentSaveRequest,
    signal: AbortSignal,
  ): Promise<PreparedNativeSave> {
    request.beforePrepare?.(signal);
    throwIfAborted(signal);
    const retained = this.retained.get(request.source);
    if (retained?.revision === request.revision) return retained.prepared;
    const prepared = await request.source.prepare(request.revision, signal);
    const retainedPreparation = Object.freeze({ revision: request.revision, prepared });
    this.retained.set(request.source, retainedPreparation);
    return prepared;
  }

  private async broadcast(
    key: string,
    verified: VerifiedPdfWrite,
    revision: number,
    source: VerifiedReloadSource,
  ): Promise<void> {
    const listeners = [...(this.listeners.get(key) ?? [])];
    for (const listener of listeners) {
      try {
        await listener(verified.token, revision, source);
      } catch (cause) {
        console.error('[abyss-documents] Failed to reload a verified PDF save in another view', {
          path: key,
          revision,
          cause,
        });
      }
    }
  }
}

function normalizeDocumentPath(path: string): string {
  const normalized = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
  if (normalized.length === 0) throw new TypeError('A document save requires a vault path.');
  return normalized;
}

function normalizeRequest(request: NativeDocumentSaveRequest): NativeDocumentSaveRequest {
  if (!Number.isSafeInteger(request.revision) || request.revision <= 0) {
    throw new TypeError('A native save revision must be a positive safe integer.');
  }
  return Object.freeze({
    path: normalizeDocumentPath(request.path),
    baseToken: Object.freeze({ ...request.baseToken }),
    revision: request.revision,
    source: request.source,
    ...(request.beforePrepare === undefined ? {} : { beforePrepare: request.beforePrepare }),
    overwrite: request.overwrite === true,
  });
}

function requirePreparation(
  prepared: PreparedNativeSave,
  request: NativeDocumentSaveRequest,
): void {
  if (prepared.revision !== request.revision) {
    throw new TypeError('The native PDF snapshot belongs to another revision.');
  }
  if (!tokensEqual(prepared.baseToken, request.baseToken)) {
    throw new TypeError('The native PDF snapshot belongs to another base PDF.');
  }
}

export function tokensEqual(left: BaseToken, right: BaseToken): boolean {
  return (
    left.sha256 === right.sha256 && left.byteSize === right.byteSize && left.mtime === right.mtime
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Saving PDF annotations was cancelled.', 'AbortError');
}
