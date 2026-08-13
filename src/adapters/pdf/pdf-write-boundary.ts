import type { TFile, Vault } from 'obsidian';
import type {
  BaseToken,
  NativePdfWriteBoundary,
  NativeSaveRecoveryFailure,
  PdfReopenVerifier,
  PdfWriteRequest,
  VerifiedPdfWrite,
  WriteCapability,
} from '../../document-core/save-coordinator.js';
import { SaveConflictError, tokensEqual } from '../../document-core/save-coordinator.js';

type BinaryVault = Pick<Vault, 'getFileByPath' | 'readBinary' | 'modifyBinary'>;

type SaveFailureStage =
  'pre-read' | 'pre-write' | 'write' | 'post-write' | 'readback' | 'parser-reopen';

interface SaveRecoveryAuthority {
  readonly preimage: Uint8Array | null;
  readonly preparedBytes: Uint8Array;
}

const recoveryAuthority = new WeakMap<SaveVerificationError, SaveRecoveryAuthority>();
const recoveryResult = new WeakMap<SaveVerificationError, SaveRecoveryResult>();

interface SaveRecoveryResult {
  restored: boolean;
  restoreCause: unknown;
}

export class SaveVerificationError extends Error {
  readonly path: string;
  readonly stage: SaveFailureStage;
  readonly cause?: unknown;

  constructor(details: {
    readonly path: string;
    readonly stage: SaveFailureStage;
    readonly preimage?: Uint8Array | null;
    readonly preparedBytes: Uint8Array;
    readonly cause?: unknown;
    readonly restored?: boolean;
    readonly restoreCause?: unknown;
  }) {
    super(`Could not verify the PDF annotation save during ${details.stage}: ${details.path}`);
    this.name = new.target.name;
    this.path = details.path;
    this.stage = details.stage;
    this.cause = details.cause;
    recoveryAuthority.set(this, {
      preimage: details.preimage == null ? null : Uint8Array.from(details.preimage),
      preparedBytes: Uint8Array.from(details.preparedBytes),
    });
    recoveryResult.set(this, {
      restored: details.restored ?? false,
      restoreCause: details.restoreCause,
    });
  }

  get preimage(): Uint8Array | null {
    const preimage = authorityFor(this).preimage;
    return preimage === null ? null : Uint8Array.from(preimage);
  }

  get preparedBytes(): Uint8Array {
    return Uint8Array.from(authorityFor(this).preparedBytes);
  }

  get restored(): boolean {
    return resultFor(this).restored;
  }

  get restoreCause(): unknown {
    return resultFor(this).restoreCause;
  }
}

export class PdfWriteBoundary implements NativePdfWriteBoundary {
  readonly capability: WriteCapability = 'best-effort-verified';

  constructor(private readonly vault: BinaryVault) {}

  async write(request: PdfWriteRequest): Promise<VerifiedPdfWrite> {
    throwIfAborted(request.signal);
    const file = this.requireFile(request.path);
    const preimage = await this.readPreimage(file, request);
    await this.assertMayWrite(file, request, preimage);
    await this.writePrepared(file, request, preimage);
    const verified = await this.readAndVerifyBytes(file, request, preimage);
    await this.verifyParser(file, request, preimage, verified);
    return Object.freeze({ token: Object.freeze(verified.token) });
  }

  async inspectRecovery(
    failure: NativeSaveRecoveryFailure,
    signal: AbortSignal,
  ): Promise<BaseToken> {
    throwIfAborted(signal);
    this.requireRecoverable(failure);
    const file = this.requireFile(failure.path);
    const current = new Uint8Array(await this.vault.readBinary(file));
    return baseTokenFor(current, file.stat.mtime);
  }

  async recover(
    failure: NativeSaveRecoveryFailure,
    acknowledgedCurrent: BaseToken,
    verifyPdf: PdfReopenVerifier,
    signal: AbortSignal,
  ): Promise<BaseToken> {
    throwIfAborted(signal);
    const preimage = this.requireRecoverable(failure);
    const file = this.requireFile(failure.path);
    const current = new Uint8Array(await this.vault.readBinary(file));
    const actualCurrent = await baseTokenFor(current, file.stat.mtime);
    if (!tokensEqual(actualCurrent, acknowledgedCurrent)) {
      throw new SaveConflictError(failure.path, acknowledgedCurrent, actualCurrent);
    }
    throwIfAborted(signal);
    await this.vault.modifyBinary(file, exactArrayBuffer(preimage));
    const readback = new Uint8Array(await this.vault.readBinary(file));
    const expected = await baseTokenFor(preimage, file.stat.mtime);
    const actual = await baseTokenFor(readback, file.stat.mtime);
    if (!contentTokensEqual(expected, actual)) {
      throw new SaveVerificationError({
        path: failure.path,
        stage: 'readback',
        preimage,
        preparedBytes: failure.preparedBytes,
        cause: new Error('The explicitly restored PDF differs from the last verified copy.'),
      });
    }
    await verifyPdf(Uint8Array.from(readback), new AbortController().signal);
    return actual;
  }

  private requireRecoverable(failure: NativeSaveRecoveryFailure): Uint8Array {
    if (failure.preimage === null) {
      throw new TypeError('No last verified PDF copy is available for recovery.');
    }
    return failure.preimage;
  }

  private async readPreimage(file: TFile, request: PdfWriteRequest): Promise<Uint8Array> {
    let preimage: Uint8Array;
    try {
      preimage = new Uint8Array(await this.vault.readBinary(file));
    } catch (cause) {
      throw new SaveVerificationError({
        path: request.path,
        stage: 'pre-read',
        preparedBytes: request.bytes,
        cause,
      });
    }
    return preimage;
  }

  private async assertMayWrite(
    file: TFile,
    request: PdfWriteRequest,
    preimage: Uint8Array,
  ): Promise<void> {
    let before: BaseToken;
    try {
      before = await baseTokenFor(preimage, file.stat.mtime);
    } catch (cause) {
      throw new SaveVerificationError({
        path: request.path,
        stage: 'pre-write',
        preimage,
        preparedBytes: request.bytes,
        cause,
      });
    }
    if (!request.overwrite && !tokensEqual(before, request.expected)) {
      throw new SaveConflictError(request.path, request.expected, before);
    }
    if (!request.overwrite && file.stat.mtime !== request.expected.mtime) {
      throw new SaveConflictError(request.path, request.expected, {
        ...before,
        mtime: file.stat.mtime,
      });
    }
    try {
      throwIfAborted(request.signal);
    } catch (cause) {
      throw new SaveVerificationError({
        path: request.path,
        stage: 'pre-write',
        preimage,
        preparedBytes: request.bytes,
        cause,
      });
    }
  }

  private async writePrepared(
    file: TFile,
    request: PdfWriteRequest,
    preimage: Uint8Array,
  ): Promise<void> {
    try {
      await this.vault.modifyBinary(file, exactArrayBuffer(request.bytes));
    } catch (cause) {
      await this.failAfterPossibleMutation(
        file,
        request,
        new SaveVerificationError({
          path: request.path,
          stage: 'write',
          preimage,
          preparedBytes: request.bytes,
          cause,
        }),
      );
    }
  }

  private async readAndVerifyBytes(
    file: TFile,
    request: PdfWriteRequest,
    preimage: Uint8Array,
  ): Promise<{ readonly readback: Uint8Array; readonly token: BaseToken }> {
    let readback: Uint8Array;
    try {
      readback = new Uint8Array(await this.vault.readBinary(file));
    } catch (cause) {
      await this.failAfterPossibleMutation(
        file,
        request,
        new SaveVerificationError({
          path: request.path,
          stage: 'readback',
          preimage,
          preparedBytes: request.bytes,
          cause,
        }),
      );
      throw new Error('Unreachable PDF readback recovery path.');
    }
    let expectedWritten: BaseToken;
    let actualWritten: BaseToken;
    try {
      expectedWritten = await baseTokenFor(request.bytes, file.stat.mtime);
      actualWritten = await baseTokenFor(readback, file.stat.mtime);
    } catch (cause) {
      await this.failAfterPossibleMutation(
        file,
        request,
        new SaveVerificationError({
          path: request.path,
          stage: 'readback',
          preimage,
          preparedBytes: request.bytes,
          cause,
        }),
      );
      throw new Error('Unreachable PDF token recovery path.');
    }
    if (
      expectedWritten.sha256 !== actualWritten.sha256 ||
      expectedWritten.byteSize !== actualWritten.byteSize
    ) {
      await this.failAfterPossibleMutation(
        file,
        request,
        new SaveVerificationError({
          path: request.path,
          stage: 'readback',
          preimage,
          preparedBytes: request.bytes,
          cause: new Error('The bytes read back from the vault differ from the prepared PDF.'),
        }),
      );
    }
    return { readback, token: actualWritten };
  }

  private async verifyParser(
    file: TFile,
    request: PdfWriteRequest,
    preimage: Uint8Array,
    verified: { readonly readback: Uint8Array; readonly token: BaseToken },
  ): Promise<void> {
    try {
      await request.verifyPdf(Uint8Array.from(verified.readback), new AbortController().signal);
    } catch (cause) {
      await this.failAfterPossibleMutation(
        file,
        request,
        new SaveVerificationError({
          path: request.path,
          stage: 'parser-reopen',
          preimage,
          preparedBytes: request.bytes,
          cause,
        }),
      );
    }
  }

  private async failAfterPossibleMutation(
    file: TFile,
    request: PdfWriteRequest,
    failure: SaveVerificationError,
  ): Promise<never> {
    const recoverySignal = new AbortController().signal;
    const authority = authorityFor(failure);
    try {
      if (authority.preimage === null)
        throw new Error('No PDF preimage is available for recovery.');
      const current = new Uint8Array(await this.vault.readBinary(file));
      const currentToken = await baseTokenFor(current, file.stat.mtime);
      const preimageToken = await baseTokenFor(authority.preimage, file.stat.mtime);
      if (contentTokensEqual(currentToken, preimageToken)) {
        await request.verifyPdf(Uint8Array.from(current), recoverySignal);
        throw new RestoredPreimage();
      }
      const attemptedToken = await baseTokenFor(request.bytes, file.stat.mtime);
      if (!contentTokensEqual(currentToken, attemptedToken)) {
        throw new SaveConflictError(failure.path, attemptedToken, currentToken);
      }
      await this.vault.modifyBinary(file, exactArrayBuffer(authority.preimage));
      const readback = new Uint8Array(await this.vault.readBinary(file));
      const expected = await baseTokenFor(authority.preimage, file.stat.mtime);
      const actual = await baseTokenFor(readback, file.stat.mtime);
      if (expected.sha256 !== actual.sha256 || expected.byteSize !== actual.byteSize) {
        throw new Error('The restored PDF preimage did not match readback.');
      }
      await request.verifyPdf(Uint8Array.from(readback), recoverySignal);
    } catch (restoreCause) {
      if (restoreCause instanceof RestoredPreimage) {
        throw reconciled(failure, true);
      }
      throw reconciled(failure, false, restoreCause);
    }
    throw reconciled(failure, true);
  }

  private requireFile(path: string): TFile {
    const file = this.vault.getFileByPath(path);
    if (file === null) throw new Error(`The PDF no longer exists in the vault: ${path}`);
    return file;
  }
}

class RestoredPreimage extends Error {}

function authorityFor(failure: SaveVerificationError): SaveRecoveryAuthority {
  const authority = recoveryAuthority.get(failure);
  if (authority === undefined) throw new TypeError('PDF recovery authority is unavailable.');
  return authority;
}

function resultFor(failure: SaveVerificationError): SaveRecoveryResult {
  const result = recoveryResult.get(failure);
  if (result === undefined) throw new TypeError('PDF recovery result is unavailable.');
  return result;
}

function reconciled(
  failure: SaveVerificationError,
  restored: boolean,
  restoreCause?: unknown,
): SaveVerificationError {
  const result = resultFor(failure);
  result.restored = restored;
  result.restoreCause = restoreCause;
  return failure;
}

function contentTokensEqual(left: BaseToken, right: BaseToken): boolean {
  return left.sha256 === right.sha256 && left.byteSize === right.byteSize;
}

export async function baseTokenFor(bytes: Uint8Array, mtime: number): Promise<BaseToken> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput(bytes)));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ sha256, byteSize: bytes.byteLength, mtime });
}

function digestInput(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : exactArrayBuffer(bytes);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Saving PDF annotations was cancelled.', 'AbortError');
}
