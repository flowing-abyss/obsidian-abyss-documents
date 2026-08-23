import { describe, expect, it, vi } from 'vitest';
import { DocumentSaveCoordinator, type BaseToken } from '../../document-core/save-coordinator.js';
import { PdfEditableSession } from './pdf-editable-session.js';

const baseToken: BaseToken = {
  sha256: 'a'.repeat(64),
  byteSize: 4,
  mtime: 10,
};

function editor() {
  let dirtyListener: ((dirty: boolean) => void) | null = null;
  const savedBytes = new Uint8Array([1, 2, 3, 4]);
  const save = vi.fn(async () => savedBytes);
  return {
    bridge: {
      onDirty(listener: (dirty: boolean) => void) {
        dirtyListener = listener;
        return () => {
          dirtyListener = null;
        };
      },
      save,
    },
    dirty() {
      dirtyListener?.(true);
    },
    reset() {
      dirtyListener?.(false);
    },
    save,
    savedBytes,
  };
}

describe('PdfEditableSession', () => {
  it('turns native modified callbacks into monotonic revisions without treating reset as commit', async () => {
    const native = editor();
    const session = new PdfEditableSession('Books/Guide.pdf', baseToken, native.bridge);

    native.dirty();
    native.reset();
    native.dirty();

    expect(session.pendingRevision).toBe(2);
    expect(session.committedRevision).toBe(0);
    const prepared = await session.prepare(1, new AbortController().signal);
    expect(prepared).toMatchObject({ revision: 1, baseToken });
    expect([...prepared.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('retains one owned PDF.js snapshot for retry after modified state reset', async () => {
    const native = editor();
    const session = new PdfEditableSession('Books/Guide.pdf', baseToken, native.bridge);
    native.dirty();

    const first = await session.prepare(1, new AbortController().signal);
    native.reset();
    const retry = await session.prepare(1, new AbortController().signal);

    expect(retry).toBe(first);
    expect(retry.bytes).toBe(first.bytes);
    expect(first.bytes).toBe(native.savedBytes);
    expect(native.save).toHaveBeenCalledOnce();
    expect(retry.bytes[0]).toBe(1);
  });

  it('commits only the captured revision and keeps an edit made after capture pending', async () => {
    const native = editor();
    const session = new PdfEditableSession('Books/Guide.pdf', baseToken, native.bridge);
    native.dirty();
    const prepared = await session.prepare(1, new AbortController().signal);
    native.reset();
    native.dirty();

    session.commit(prepared, {
      ...baseToken,
      sha256: 'b'.repeat(64),
      mtime: 20,
    });

    expect(session.committedRevision).toBe(1);
    expect(session.pendingRevision).toBe(2);
    expect(session.isDirty).toBe(true);
  });

  it('clears owned native listeners on destroy and records the crash limitation', () => {
    const native = editor();
    const session = new PdfEditableSession('Books/Guide.pdf', baseToken, native.bridge);
    session.destroy();
    native.dirty();

    expect(session.pendingRevision).toBe(0);
    expect(PdfEditableSession.recoveryGuarantee).toBe('last-verified-pdf-bytes-only');
  });

  it('allows a coordinator-owned captured revision to commit after view teardown', async () => {
    const native = editor();
    const session = new PdfEditableSession('Books/Guide.pdf', baseToken, native.bridge);
    native.dirty();
    const prepared = await session.prepare(1, new AbortController().signal);
    session.destroy();

    expect(() => {
      session.commit(prepared, { ...baseToken, sha256: 'b'.repeat(64) });
    }).not.toThrow();
  });

  it('finishes a verified coordinator commit when teardown happens during physical write', async () => {
    const native = editor();
    const session = new PdfEditableSession('Books/Guide.pdf', baseToken, native.bridge);
    native.dirty();
    const gate = deferred<{ readonly token: BaseToken }>();
    const write = vi.fn(async () => gate.promise);
    const coordinator = new DocumentSaveCoordinator(
      { write },
      vi.fn(async () => undefined),
    );
    const saving = coordinator.save(
      { path: session.path, baseToken, revision: 1, source: session },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledOnce();
    });

    session.destroy();
    gate.resolve({ token: { ...baseToken, sha256: 'b'.repeat(64) } });

    await expect(saving).resolves.toMatchObject({ verified: true, generation: 1 });
    expect(session.committedRevision).toBe(1);
  });

  it('accepts a verified reload token and rejects stale, future, and destroyed preparations', async () => {
    const native = editor();
    const session = new PdfEditableSession('Books/Guide.pdf', baseToken, native.bridge);
    const refreshed = { sha256: 'c'.repeat(64), byteSize: 8, mtime: 30 };
    session.acceptVerifiedReload(refreshed);
    expect(session.baseToken).toEqual(refreshed);

    await expect(session.prepare(0, new AbortController().signal)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    native.dirty();
    await expect(session.prepare(2, new AbortController().signal)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    const prepared = await session.prepare(1, new AbortController().signal);
    session.destroy();
    await expect(session.prepare(1, new AbortController().signal)).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    expect(() => {
      session.commit(prepared, refreshed);
    }).not.toThrow();
    session.destroy();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
