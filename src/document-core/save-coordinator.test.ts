import { describe, expect, it, vi } from 'vitest';
import {
  DocumentSaveCoordinator,
  SaveConflictError,
  type BaseToken,
  type VerifiedPdfWrite,
} from './save-coordinator.js';

const tokenA: BaseToken = { sha256: 'a'.repeat(64), byteSize: 4, mtime: 10 };
const tokenB: BaseToken = { sha256: 'b'.repeat(64), byteSize: 5, mtime: 20 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function source(revision: number, bytes = new Uint8Array([1, 2, 3])) {
  const prepare = vi.fn(async () => ({ revision, baseToken: tokenA, bytes }));
  const commit = vi.fn();
  return { prepare, commit };
}

function verified(): VerifiedPdfWrite {
  return { token: tokenB };
}

describe('DocumentSaveCoordinator', () => {
  it('delegates guarded recovery and reports when an adapter cannot recover', async () => {
    const failure = Object.assign(new Error('ambiguous write'), {
      path: 'Guide.pdf',
      preimage: new Uint8Array([1]),
      preparedBytes: new Uint8Array([2]),
      restored: false,
    });
    const inspectRecovery = vi.fn(async () => tokenA);
    const recover = vi.fn(async () => tokenB);
    const verifyPdf = vi.fn(async () => undefined);
    const coordinator = new DocumentSaveCoordinator(
      { write: vi.fn(), inspectRecovery, recover },
      verifyPdf,
    );
    const signal = new AbortController().signal;

    await expect(coordinator.inspectRecovery(failure, signal)).resolves.toBe(tokenA);
    await expect(coordinator.recover(failure, tokenA, signal)).resolves.toBe(tokenB);
    expect(recover).toHaveBeenCalledWith(failure, tokenA, verifyPdf, signal);

    const unavailable = new DocumentSaveCoordinator({ write: vi.fn() }, verifyPdf);
    await expect(unavailable.inspectRecovery(failure, signal)).rejects.toThrow(
      'recovery is unavailable',
    );
    await expect(unavailable.recover(failure, tokenA, signal)).rejects.toThrow(
      'recovery is unavailable',
    );
  });

  it('serializes confirmed recovery behind a concurrent save for the same normalized path', async () => {
    const writeGate = deferred<void>();
    let current = tokenA;
    const write = vi.fn(async () => {
      await writeGate.promise;
      current = tokenB;
      return verified();
    });
    const recover = vi.fn(async (_failure: unknown, acknowledged: BaseToken) => {
      if (current !== acknowledged)
        throw new SaveConflictError('Books/Guide.pdf', acknowledged, current);
      return tokenA;
    });
    const coordinator = new DocumentSaveCoordinator(
      { write, recover },
      vi.fn(async () => undefined),
    );
    const activeSave = coordinator.save(
      { path: 'Books//Guide.pdf', baseToken: tokenA, revision: 1, source: source(1) },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
    });
    const recovery = coordinator.recover(
      Object.assign(new Error('ambiguous write'), {
        path: 'Books/Guide.pdf',
        preimage: new Uint8Array([1]),
        preparedBytes: new Uint8Array([2]),
        restored: false,
      }),
      tokenA,
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    writeGate.resolve();
    await activeSave;
    await expect(recovery).rejects.toBeInstanceOf(SaveConflictError);
    expect(recover).toHaveBeenCalledOnce();
  });

  it('broadcasts an explicitly recovered token to every registered view', async () => {
    const recover = vi.fn(async () => tokenB);
    const coordinator = new DocumentSaveCoordinator(
      { write: vi.fn(), recover },
      vi.fn(async () => undefined),
    );
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    coordinator.register('Books/Guide.pdf', listenerA);
    coordinator.register('Books//Guide.pdf', listenerB);
    const failure = Object.assign(new Error('ambiguous write'), {
      path: 'Books/Guide.pdf',
      preimage: new Uint8Array([1]),
      preparedBytes: new Uint8Array([2]),
      restored: false,
    });

    await expect(coordinator.recover(failure, tokenA, new AbortController().signal)).resolves.toBe(
      tokenB,
    );
    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).toHaveBeenCalledOnce();
    expect(listenerA.mock.calls[0]?.[0]).toBe(tokenB);
    expect(listenerA.mock.calls[0]?.[1]).toBe(0);
    expect(listenerA.mock.calls[0]?.[2]).toEqual({ kind: 'recovery', origin: null });
  });

  it('serializes two views per normalized path and broadcasts only verified bytes', async () => {
    const gate = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const write = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (write.mock.calls.length === 1) await gate.promise;
      active -= 1;
      return verified();
    });
    const coordinator = new DocumentSaveCoordinator(
      { write },
      vi.fn(async () => undefined),
    );
    const sessionA = source(1);
    const sessionB = source(2);
    const reloadA = vi.fn();
    const reloadB = vi.fn();
    coordinator.register('Books/Guide.pdf', reloadA);
    coordinator.register('Books/Guide.pdf', reloadB);

    const saveA = coordinator.save(
      { path: 'Books/Guide.pdf', baseToken: tokenA, revision: 1, source: sessionA },
      new AbortController().signal,
    );
    const saveB = coordinator.save(
      { path: 'Books//Guide.pdf', baseToken: tokenA, revision: 2, source: sessionB },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
    });
    gate.resolve();
    await Promise.all([saveA, saveB]);

    expect(maxActive).toBe(1);
    expect(sessionA.commit).toHaveBeenCalledOnce();
    expect(sessionB.commit).toHaveBeenCalledOnce();
    expect(reloadA).toHaveBeenCalledTimes(2);
    expect(reloadB).toHaveBeenCalledTimes(2);
    expect(reloadA.mock.calls[0]).toHaveLength(3);
    expect(reloadB.mock.calls[0]).toHaveLength(3);
  });

  it('rechecks the caller preparation boundary after waiting for a peer save', async () => {
    const firstWrite = deferred<void>();
    const write = vi.fn(async () => {
      if (write.mock.calls.length === 1) await firstWrite.promise;
      return verified();
    });
    const coordinator = new DocumentSaveCoordinator(
      { write },
      vi.fn(async () => undefined),
    );
    const first = source(1);
    const second = source(2);
    const beforePrepare = vi.fn();
    const saveA = coordinator.save(
      { path: 'Books/Guide.pdf', baseToken: tokenA, revision: 1, source: first },
      new AbortController().signal,
    );
    const saveB = coordinator.save(
      {
        path: 'Books/Guide.pdf',
        baseToken: tokenA,
        revision: 2,
        source: second,
        beforePrepare,
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
    });
    expect(beforePrepare).not.toHaveBeenCalled();

    firstWrite.resolve();
    await vi.waitFor(() => {
      expect(beforePrepare).toHaveBeenCalledOnce();
    });
    await Promise.all([saveA, saveB]);

    expect(second.prepare).toHaveBeenCalledOnce();
  });

  it('uses one prepared native snapshot for a retry after a vault failure', async () => {
    const native = source(1);
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(verified());
    const coordinator = new DocumentSaveCoordinator(
      { write },
      vi.fn(async () => undefined),
    );
    const request = { path: 'Books/Guide.pdf', baseToken: tokenA, revision: 1, source: native };

    await expect(coordinator.save(request, new AbortController().signal)).rejects.toThrow(
      'disk full',
    );
    await expect(coordinator.save(request, new AbortController().signal)).resolves.toMatchObject({
      verified: true,
      generation: 1,
    });

    expect(native.prepare).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not commit or broadcast a revision when verification rejects', async () => {
    const native = source(1);
    const reload = vi.fn();
    const coordinator = new DocumentSaveCoordinator(
      { write: vi.fn(async () => Promise.reject(new Error('bad readback'))) },
      vi.fn(async () => undefined),
    );
    coordinator.register('Books/Guide.pdf', reload);

    await expect(
      coordinator.save(
        { path: 'Books/Guide.pdf', baseToken: tokenA, revision: 1, source: native },
        new AbortController().signal,
      ),
    ).rejects.toThrow('bad readback');

    expect(native.commit).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps a verified commit when a stale view reload listener rejects and logs one diagnostic', async () => {
    const native = source(1);
    const cause = new Error('view already closed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const coordinator = new DocumentSaveCoordinator(
      { write: vi.fn(async () => verified()) },
      vi.fn(async () => undefined),
    );
    coordinator.register('Books/Guide.pdf', async () => {
      throw cause;
    });

    await expect(
      coordinator.save(
        { path: 'Books/Guide.pdf', baseToken: tokenA, revision: 1, source: native },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ verified: true, generation: 1 });

    expect(native.commit).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[abyss-documents] Failed to reload a verified PDF save in another view',
      { path: 'Books/Guide.pdf', revision: 1, cause },
    );
  });

  it('rejects invalid requests, aborted work, and snapshots for another revision/base', async () => {
    const coordinator = new DocumentSaveCoordinator(
      { write: vi.fn(async () => verified()) },
      vi.fn(async () => undefined),
    );
    const native = source(1);
    expect(() =>
      coordinator.save(
        { path: '', baseToken: tokenA, revision: 1, source: native },
        new AbortController().signal,
      ),
    ).toThrow(TypeError);
    expect(() =>
      coordinator.save(
        { path: 'Guide.pdf', baseToken: tokenA, revision: 0, source: native },
        new AbortController().signal,
      ),
    ).toThrow(TypeError);
    await expect(
      coordinator.save(
        { path: 'Guide.pdf', baseToken: tokenA, revision: 1, source: native },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      coordinator.save(
        { path: 'Guide.pdf', baseToken: tokenA, revision: 1, source: native },
        AbortSignal.abort('closed'),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const wrongRevision = source(2);
    await expect(
      coordinator.save(
        { path: 'Revision.pdf', baseToken: tokenA, revision: 1, source: wrongRevision },
        new AbortController().signal,
      ),
    ).rejects.toThrow('another revision');
    const wrongBase = source(1);
    wrongBase.prepare.mockResolvedValue({
      revision: 1,
      baseToken: tokenB,
      bytes: new Uint8Array([1]),
    });
    await expect(
      coordinator.save(
        { path: 'Base.pdf', baseToken: tokenA, revision: 1, source: wrongBase },
        new AbortController().signal,
      ),
    ).rejects.toThrow('another base');
  });

  it('unregisters listeners and continues the per-path queue after a failed save', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce(verified());
    const coordinator = new DocumentSaveCoordinator(
      { write },
      vi.fn(async () => undefined),
    );
    const listener = vi.fn();
    const unregister = coordinator.register('Guide.pdf', listener);
    unregister();
    await expect(
      coordinator.save(
        { path: 'Guide.pdf', baseToken: tokenA, revision: 1, source: source(1) },
        new AbortController().signal,
      ),
    ).rejects.toThrow('first failed');
    await expect(
      coordinator.save(
        { path: 'Guide.pdf', baseToken: tokenA, revision: 2, source: source(2) },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ generation: 2 });
    expect(listener).not.toHaveBeenCalled();
  });
});
