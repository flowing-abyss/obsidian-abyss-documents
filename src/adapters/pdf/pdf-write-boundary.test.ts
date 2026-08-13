import type { FileStats, TFile, Vault } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { SaveConflictError } from '../../document-core/save-coordinator.js';
import { PdfWriteBoundary, SaveVerificationError, baseTokenFor } from './pdf-write-boundary.js';

function file(mtime = 10): TFile {
  const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
  const source = app.vault.getAbstractFileByPath('Books/Guide.pdf');
  if (!(source instanceof MockTFile)) throw new Error('Expected a PDF fixture.');
  Object.assign(source, { stat: { ctime: 1, mtime, size: 4 } satisfies FileStats });
  return source.asOriginalType2__();
}

function fixture(initial = new Uint8Array([1, 2, 3, 4])) {
  let bytes = Uint8Array.from(initial);
  const source = file();
  const vault = {
    getFileByPath: vi.fn(() => source),
    readBinary: vi.fn(async () => bytes.slice().buffer),
    modifyBinary: vi.fn(async (_file: TFile, next: ArrayBuffer) => {
      bytes = new Uint8Array(next.slice(0));
      source.stat.mtime += 1;
      source.stat.size = bytes.byteLength;
    }),
  } as unknown as Pick<Vault, 'getFileByPath' | 'readBinary' | 'modifyBinary'>;
  return {
    boundary: new PdfWriteBoundary(vault),
    get bytes() {
      return bytes;
    },
    set bytes(next: Uint8Array) {
      bytes = Uint8Array.from(next);
      source.stat.mtime += 1;
      source.stat.size = bytes.byteLength;
    },
    source,
    vault,
  };
}

describe('PdfWriteBoundary', () => {
  it('creates SHA-256/size/mtime tokens using Web Crypto and declares best-effort verification', async () => {
    const token = await baseTokenFor(new Uint8Array([1, 2, 3, 4]), 10);
    expect(token).toEqual({
      sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      byteSize: 4,
      mtime: 10,
    });
    expect(fixture().boundary.capability).toBe('best-effort-verified');
  });

  it('hashes a full owned buffer without first cloning it', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await baseTokenFor(bytes, 10);
    expect(digest.mock.calls[0]?.[1]).toBe(bytes.buffer);
  });

  it('hashes a subarray from only its exact byte span', async () => {
    const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
    const bytes = backing.subarray(1, 5);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(baseTokenFor(bytes, 10)).resolves.toMatchObject({ byteSize: 4 });
    expect(digest.mock.calls[0]?.[1]).not.toBe(backing.buffer);
    expect((digest.mock.calls[0]?.[1] as ArrayBuffer).byteLength).toBe(4);
  });

  it('uses one authoritative preimage read plus one readback for a successful large save', async () => {
    const test = fixture(new Uint8Array(8 * 1024 * 1024));
    const expected = await baseTokenFor(test.bytes, 10);

    await test.boundary.write({
      path: test.source.path,
      expected,
      bytes: new Uint8Array(8 * 1024 * 1024).fill(1),
      overwrite: false,
      verifyPdf: vi.fn(async () => undefined),
      signal: new AbortController().signal,
    });

    expect(test.vault.readBinary).toHaveBeenCalledTimes(2);
  });

  it('rejects a foreign pre-write value before modifying the PDF', async () => {
    const test = fixture();
    const expected = await baseTokenFor(new Uint8Array([1, 2, 3, 4]), 10);
    test.bytes = new Uint8Array([9, 9, 9, 9]);

    await expect(
      test.boundary.write({
        path: test.source.path,
        expected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SaveConflictError);
    expect(test.vault.modifyBinary).not.toHaveBeenCalled();
  });

  it('detects an external modification between the first token check and write', async () => {
    const test = fixture();
    const expected = await baseTokenFor(test.bytes, 10);
    let statReads = 0;
    Object.defineProperty(test.source.stat, 'mtime', {
      configurable: true,
      get: () => (++statReads === 1 ? 10 : 11),
    });

    await expect(
      test.boundary.write({
        path: test.source.path,
        expected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SaveConflictError);

    expect(test.vault.modifyBinary).not.toHaveBeenCalled();
  });

  it('retains independent preimage and prepared bytes when the write throws', async () => {
    const test = fixture();
    Object.assign(test.vault, {
      modifyBinary: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const expected = await baseTokenFor(test.bytes, 10);
    const prepared = new Uint8Array([5, 6, 7]);

    const failure = (await test.boundary
      .write({
        path: test.source.path,
        expected,
        bytes: prepared,
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      })
      .catch((cause: unknown) => cause)) as SaveVerificationError;

    expect(failure).toBeInstanceOf(SaveVerificationError);
    expect(failure).toMatchObject({ stage: 'write' });
    expect(failure.preimage === null ? null : [...failure.preimage]).toEqual([1, 2, 3, 4]);
    expect([...failure.preparedBytes]).toEqual([5, 6, 7]);
  });

  it('rejects partial/foreign readback and parser-reopen failures without reporting a commit', async () => {
    const test = fixture();
    const expected = await baseTokenFor(test.bytes, 10);
    const modify = test.vault.modifyBinary;
    const writePartialBytes = vi.fn(async (target: TFile, bytes: ArrayBuffer) => {
      if (writePartialBytes.mock.calls.length === 1) test.bytes = new Uint8Array([5, 6]);
      else await modify(target, bytes);
    });
    Object.assign(test.vault, { modifyBinary: writePartialBytes });

    await expect(
      test.boundary.write({
        path: test.source.path,
        expected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ stage: 'readback', restored: false });
    expect([...test.bytes]).toEqual([5, 6]);

    const parser = fixture();
    const parserExpected = await baseTokenFor(parser.bytes, 10);
    const verifyPdf = vi.fn(async (bytes: Uint8Array) => {
      if (bytes[0] === 5) throw new Error('invalid xref');
    });
    await expect(
      parser.boundary.write({
        path: parser.source.path,
        expected: parserExpected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ stage: 'parser-reopen', restored: true });
    expect([...parser.bytes]).toEqual([1, 2, 3, 4]);
    expect(verifyPdf).toHaveBeenCalledTimes(2);
  });

  it('finishes verification and commits authoritative bytes when abort wins after mutation', async () => {
    const test = fixture();
    const expected = await baseTokenFor(test.bytes, 10);
    const abort = new AbortController();
    const modify = test.vault.modifyBinary;
    const abortingModify = vi.fn(async (target: TFile, bytes: ArrayBuffer) => {
      await modify(target, bytes);
      if (abortingModify.mock.calls.length === 1) abort.abort(new Error('closed'));
    });
    test.vault.modifyBinary = abortingModify;

    await expect(
      test.boundary.write({
        path: test.source.path,
        expected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: abort.signal,
      }),
    ).resolves.toMatchObject({ token: { byteSize: 3 } });
    expect([...test.bytes]).toEqual([5, 6, 7]);
  });

  it('preserves the primary parser failure and the restore failure together', async () => {
    const test = fixture();
    const expected = await baseTokenFor(test.bytes, 10);
    const parserCause = new Error('invalid xref');
    const restoreCause = new Error('restore rejected');
    const modify = test.vault.modifyBinary;
    const failingRestore = vi.fn(async (target: TFile, bytes: ArrayBuffer) => {
      if (failingRestore.mock.calls.length === 2) throw restoreCause;
      await modify(target, bytes);
    });
    test.vault.modifyBinary = failingRestore;

    await expect(
      test.boundary.write({
        path: test.source.path,
        expected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => Promise.reject(parserCause)),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      stage: 'parser-reopen',
      restored: false,
      cause: parserCause,
      restoreCause,
    });
  });

  it('never restores over a foreign change that arrives during failure reconciliation', async () => {
    const test = fixture();
    const expected = await baseTokenFor(test.bytes, 10);
    const parserCause = new Error('invalid xref');
    const foreign = new Uint8Array([9, 9, 9, 9]);

    const failure = await test.boundary
      .write({
        path: test.source.path,
        expected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => {
          test.bytes = foreign;
          throw parserCause;
        }),
        signal: new AbortController().signal,
      })
      .catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      stage: 'parser-reopen',
      restored: false,
      cause: parserCause,
    });
    expect((failure as SaveVerificationError).restoreCause).toBeInstanceOf(SaveConflictError);
    expect([...test.bytes]).toEqual([...foreign]);
  });

  it('does not restore after unreadable or partial post-write bytes cannot prove ownership', async () => {
    const unreadable = fixture();
    const unreadableExpected = await baseTokenFor(unreadable.bytes, 10);
    unreadable.vault.readBinary = vi
      .fn()
      .mockResolvedValueOnce(unreadable.bytes.buffer.slice(0))
      .mockRejectedValue(new Error('readback unavailable'));
    const unreadableFailure = await unreadable.boundary
      .write({
        path: unreadable.source.path,
        expected: unreadableExpected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      })
      .catch((cause: unknown) => cause);
    expect(unreadable.vault.modifyBinary).toHaveBeenCalledOnce();
    expect(unreadableFailure).toMatchObject({ stage: 'readback', restored: false });
    expect([...unreadable.bytes]).toEqual([5, 6, 7]);

    const partial = fixture();
    const partialExpected = await baseTokenFor(partial.bytes, 10);
    Object.assign(partial.vault, {
      modifyBinary: vi.fn(async () => {
        partial.bytes = new Uint8Array([5, 6]);
      }),
    });
    const partialFailure = await partial.boundary
      .write({
        path: partial.source.path,
        expected: partialExpected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      })
      .catch((cause: unknown) => cause);
    expect(partial.vault.modifyBinary).toHaveBeenCalledOnce();
    expect(partialFailure).toMatchObject({ stage: 'readback', restored: false });
    expect([...partial.bytes]).toEqual([5, 6]);
  });

  it('reconciles a post-write hash failure through the typed recovery boundary', async () => {
    const test = fixture();
    const expected = await baseTokenFor(test.bytes, 10);
    const hashCause = new Error('hash unavailable');
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let digestCalls = 0;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      digestCalls += 1;
      if (digestCalls === 2) return Promise.reject(hashCause);
      return digest(algorithm, data);
    });

    await expect(
      test.boundary.write({
        path: test.source.path,
        expected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ stage: 'readback', cause: hashCause, restored: true });
    expect([...test.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('offers explicit guarded recovery only after acknowledging a fresh current token', async () => {
    const test = fixture();
    const preimage = Uint8Array.from(test.bytes);
    const failure = new SaveVerificationError({
      path: test.source.path,
      stage: 'readback',
      preimage,
      preparedBytes: new Uint8Array([5, 6, 7]),
      cause: new Error('ambiguous write'),
    });
    test.bytes = new Uint8Array([9, 9]);
    const current = await test.boundary.inspectRecovery(failure, new AbortController().signal);
    test.bytes = new Uint8Array([8, 8]);
    await expect(
      test.boundary.recover(
        failure,
        current,
        vi.fn(async () => undefined),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SaveConflictError);
    expect([...test.bytes]).toEqual([8, 8]);

    const acknowledged = await test.boundary.inspectRecovery(failure, new AbortController().signal);
    await expect(
      test.boundary.recover(
        failure,
        acknowledged,
        vi.fn(async () => undefined),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ byteSize: 4 });
    expect([...test.bytes]).toEqual([...preimage]);
  });

  it('does not expose mutable references to retained recovery authority bytes', () => {
    const failure = new SaveVerificationError({
      path: 'Guide.pdf',
      stage: 'readback',
      preimage: new Uint8Array([1, 2]),
      preparedBytes: new Uint8Array([3, 4]),
    });
    const exposedPreimage = failure.preimage;
    if (exposedPreimage === null) throw new Error('Expected recovery bytes.');
    exposedPreimage[0] = 9;
    failure.preparedBytes[0] = 9;
    expect(failure.preimage).toEqual(new Uint8Array([1, 2]));
    expect(failure.preparedBytes).toEqual(new Uint8Array([3, 4]));

    const withoutPreimage = new SaveVerificationError({
      path: 'Guide.pdf',
      stage: 'pre-read',
      preparedBytes: new Uint8Array([5]),
    });
    expect(withoutPreimage.preimage).toBeNull();
    expect(withoutPreimage.restored).toBe(false);
    expect(withoutPreimage.restoreCause).toBeUndefined();

    const explicitNull = new SaveVerificationError({
      path: 'Guide.pdf',
      stage: 'pre-read',
      preimage: null,
      preparedBytes: new Uint8Array([6]),
      restored: true,
      restoreCause: new Error('recovered'),
    });
    expect(explicitNull.preimage).toBeNull();
    expect(explicitNull.restored).toBe(true);
    expect(explicitNull.restoreCause).toBeInstanceOf(Error);
  });

  it('honors recovery cancellation immediately before its destructive write', async () => {
    const test = fixture();
    const preimage = Uint8Array.from(test.bytes);
    const failure = new SaveVerificationError({
      path: test.source.path,
      stage: 'readback',
      preimage,
      preparedBytes: new Uint8Array([5, 6, 7]),
      cause: new Error('ambiguous write'),
    });
    test.bytes = new Uint8Array([9, 9]);
    const acknowledged = await baseTokenFor(test.bytes, test.source.stat.mtime);
    const abort = new AbortController();
    Object.assign(test.vault, {
      readBinary: vi.fn(async () => {
        abort.abort();
        return test.bytes.buffer.slice(0) as ArrayBuffer;
      }),
    });

    await expect(
      test.boundary.recover(failure, acknowledged, vi.fn(), abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.vault.modifyBinary).not.toHaveBeenCalled();
    expect([...test.bytes]).toEqual([9, 9]);
  });

  it('wraps pre-read and immediate pre-write aborts with their typed stages', async () => {
    const preRead = fixture();
    const preReadCause = new Error('initial read rejected');
    preRead.vault.readBinary = vi.fn(async () => Promise.reject(preReadCause));
    await expect(
      preRead.boundary.write({
        path: preRead.source.path,
        expected: await baseTokenFor(preRead.bytes, 10),
        bytes: new Uint8Array([5]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ stage: 'pre-read', cause: preReadCause });

    const prewrite = fixture();
    const abort = new AbortController();
    const prewriteCause = new Error('closed before write');
    prewrite.vault.readBinary = vi.fn(async () => {
      abort.abort(prewriteCause);
      return prewrite.bytes.buffer.slice(0) as ArrayBuffer;
    });
    await expect(
      prewrite.boundary.write({
        path: prewrite.source.path,
        expected: await baseTokenFor(prewrite.bytes, 10),
        bytes: new Uint8Array([5]),
        overwrite: false,
        verifyPdf: vi.fn(async () => undefined),
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ stage: 'pre-write', cause: prewriteCause });
  });

  it('supports explicit overwrite and reports missing and aborted paths', async () => {
    const test = fixture();
    const foreignExpected = { sha256: 'f'.repeat(64), byteSize: 99, mtime: 1 };
    await expect(
      test.boundary.write({
        path: test.source.path,
        expected: foreignExpected,
        bytes: new Uint8Array([5, 6, 7]),
        overwrite: true,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ token: { byteSize: 3 } });

    const missing = fixture();
    missing.vault.getFileByPath = vi.fn(() => null);
    await expect(
      missing.boundary.write({
        path: 'Missing.pdf',
        expected: foreignExpected,
        bytes: new Uint8Array([1]),
        overwrite: true,
        verifyPdf: vi.fn(async () => undefined),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no longer exists');
    await expect(
      test.boundary.write({
        path: test.source.path,
        expected: foreignExpected,
        bytes: new Uint8Array([1]),
        overwrite: true,
        verifyPdf: vi.fn(async () => undefined),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
