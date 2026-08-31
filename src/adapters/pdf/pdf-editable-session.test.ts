import type { FileStats, TFile, Vault } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  DocumentSaveCoordinator,
  SaveConflictError,
  isNativeRecoverySource,
  isNativeSaveRecoveryFailure,
  type BaseToken,
} from '../../document-core/save-coordinator.js';
import { PdfEditableSession } from './pdf-editable-session.js';
import { PdfWriteBoundary, baseTokenFor } from './pdf-write-boundary.js';

const baseToken: BaseToken = {
  sha256: 'a'.repeat(64),
  byteSize: 4,
  mtime: 10,
};

function editor(savedBytes = new Uint8Array([1, 2, 3, 4])) {
  let dirtyListener: ((dirty: boolean) => void) | null = null;
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

function writablePdf(initial = new Uint8Array([1, 2, 3, 4])) {
  const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
  const source = app.vault.getAbstractFileByPath('Books/Guide.pdf');
  if (!(source instanceof MockTFile)) throw new Error('Expected a PDF fixture.');
  Object.assign(source, {
    stat: { ctime: 1, mtime: 10, size: initial.byteLength } satisfies FileStats,
  });
  let bytes = Uint8Array.from(initial);
  const vault = {
    getFileByPath: vi.fn(() => source.asOriginalType2__()),
    readBinary: vi.fn(async () => bytes.slice().buffer),
    modifyBinary: vi.fn(async (_file: TFile, next: ArrayBuffer) => {
      bytes = new Uint8Array(next.slice(0));
      source.stat.mtime += 1;
      source.stat.size = bytes.byteLength;
    }),
  } as unknown as Pick<Vault, 'getFileByPath' | 'readBinary' | 'modifyBinary'>;
  return {
    boundary: new PdfWriteBoundary(vault),
    externalChange(next: Uint8Array) {
      bytes = Uint8Array.from(next);
      source.stat.mtime += 1;
      source.stat.size = bytes.byteLength;
    },
    get bytes() {
      return bytes;
    },
    source,
    vault,
  };
}

function saveRevision(coordinator: DocumentSaveCoordinator, session: PdfEditableSession) {
  return coordinator.save(
    {
      path: session.path,
      baseToken: session.baseToken,
      revision: session.pendingRevision,
      source: session,
    },
    new AbortController().signal,
  );
}

describe('PdfEditableSession', () => {
  it('broadcasts verified restoration to a clean peer before that peer saves', async () => {
    const pdf = writablePdf();
    const openedToken = await baseTokenFor(pdf.bytes, pdf.source.stat.mtime);
    const sourceNative = editor(new Uint8Array([5, 6, 7]));
    const peerNative = editor(new Uint8Array([8, 8, 8]));
    const sourceSession = new PdfEditableSession(pdf.source.path, openedToken, sourceNative.bridge);
    const peerSession = new PdfEditableSession(pdf.source.path, openedToken, peerNative.bridge);
    let rejectPreparedOnce = true;
    const coordinator = new DocumentSaveCoordinator(pdf.boundary, async (bytes) => {
      if (bytes[0] === 1 || !rejectPreparedOnce) return;
      rejectPreparedOnce = false;
      throw new Error('invalid xref');
    });
    const recoverySources: unknown[] = [];
    coordinator.register(pdf.source.path, (token, _revision, source) => {
      if (!isNativeRecoverySource(source)) return;
      recoverySources.push(source);
      if (!peerSession.isDirty) peerSession.acceptVerifiedReload(token);
    });
    sourceNative.dirty();

    await expect(saveRevision(coordinator, sourceSession)).rejects.toMatchObject({
      restored: true,
    });

    expect(recoverySources).toEqual([
      expect.objectContaining({ kind: 'recovery', origin: sourceSession }),
    ]);
    expect(peerSession.baseToken).toMatchObject({ mtime: 12, sha256: openedToken.sha256 });
    peerNative.dirty();
    await expect(saveRevision(coordinator, peerSession)).resolves.toMatchObject({
      verified: true,
      generation: 1,
    });
    expect([...pdf.bytes]).toEqual([8, 8, 8]);
    sourceSession.destroy();
    peerSession.destroy();
  });

  it('keeps a dirty peer conflict-safe when another session restores its preimage', async () => {
    const pdf = writablePdf();
    const openedToken = await baseTokenFor(pdf.bytes, pdf.source.stat.mtime);
    const sourceNative = editor(new Uint8Array([5, 6, 7]));
    const peerNative = editor(new Uint8Array([8, 8, 8]));
    const sourceSession = new PdfEditableSession(pdf.source.path, openedToken, sourceNative.bridge);
    const peerSession = new PdfEditableSession(pdf.source.path, openedToken, peerNative.bridge);
    let rejectPreparedOnce = true;
    const coordinator = new DocumentSaveCoordinator(pdf.boundary, async (bytes) => {
      if (bytes[0] === 1 || !rejectPreparedOnce) return;
      rejectPreparedOnce = false;
      throw new Error('invalid xref');
    });
    coordinator.register(pdf.source.path, (token, _revision, source) => {
      if (isNativeRecoverySource(source) && !peerSession.isDirty)
        peerSession.acceptVerifiedReload(token);
    });
    sourceNative.dirty();
    peerNative.dirty();

    await expect(saveRevision(coordinator, sourceSession)).rejects.toMatchObject({
      restored: true,
    });

    expect(peerSession.baseToken).toEqual(openedToken);
    await expect(saveRevision(coordinator, peerSession)).rejects.toBeInstanceOf(SaveConflictError);
    expect([...pdf.bytes]).toEqual([1, 2, 3, 4]);
    sourceSession.destroy();
    peerSession.destroy();
  });

  it('reserializes a restored revision against its verified token before a normal retry', async () => {
    const pdf = writablePdf();
    const openedToken = await baseTokenFor(pdf.bytes, pdf.source.stat.mtime);
    const native = editor(new Uint8Array([5, 6, 7]));
    const session = new PdfEditableSession(pdf.source.path, openedToken, native.bridge);
    let rejectPreparedOnce = true;
    const coordinator = new DocumentSaveCoordinator(pdf.boundary, async (bytes) => {
      if (bytes[0] === 1 || !rejectPreparedOnce) return;
      rejectPreparedOnce = false;
      throw new Error('invalid xref');
    });
    native.dirty();

    const firstFailure = await saveRevision(coordinator, session).catch((cause: unknown) => cause);

    expect(isNativeSaveRecoveryFailure(firstFailure)).toBe(true);
    expect(firstFailure).toMatchObject({
      restored: true,
      restoredToken: { byteSize: 4, mtime: 12, sha256: openedToken.sha256 },
    });
    expect(session.baseToken).toMatchObject({ mtime: 12, sha256: openedToken.sha256 });
    await expect(saveRevision(coordinator, session)).resolves.toMatchObject({
      verified: true,
      generation: 1,
    });
    expect(native.save).toHaveBeenCalledTimes(2);
    expect(session.committedRevision).toBe(1);
    expect(session.baseToken).toMatchObject({ byteSize: 3, mtime: 13 });
    expect([...pdf.bytes]).toEqual([5, 6, 7]);
    session.destroy();
  });

  it('still rejects an external modification made after verified restoration', async () => {
    const pdf = writablePdf();
    const openedToken = await baseTokenFor(pdf.bytes, pdf.source.stat.mtime);
    const native = editor(new Uint8Array([5, 6, 7]));
    const session = new PdfEditableSession(pdf.source.path, openedToken, native.bridge);
    let rejectPreparedOnce = true;
    const coordinator = new DocumentSaveCoordinator(pdf.boundary, async (bytes) => {
      if (bytes[0] === 1 || !rejectPreparedOnce) return;
      rejectPreparedOnce = false;
      throw new Error('invalid xref');
    });
    native.dirty();

    await expect(saveRevision(coordinator, session)).rejects.toMatchObject({ restored: true });
    pdf.externalChange(new Uint8Array([9, 9, 9, 9]));

    await expect(saveRevision(coordinator, session)).rejects.toBeInstanceOf(SaveConflictError);
    expect(native.save).toHaveBeenCalledTimes(2);
    expect(pdf.vault.modifyBinary).toHaveBeenCalledTimes(2);
    expect([...pdf.bytes]).toEqual([9, 9, 9, 9]);
    session.destroy();
  });

  it('keeps the original base and retained revision when restoration itself fails', async () => {
    const pdf = writablePdf();
    const openedToken = await baseTokenFor(pdf.bytes, pdf.source.stat.mtime);
    const native = editor(new Uint8Array([5, 6, 7]));
    const session = new PdfEditableSession(pdf.source.path, openedToken, native.bridge);
    const modify = pdf.vault.modifyBinary;
    const restoreCause = new Error('restore rejected');
    let modifies = 0;
    pdf.vault.modifyBinary = vi.fn(async (file: TFile, bytes: ArrayBuffer) => {
      modifies += 1;
      if (modifies === 2) throw restoreCause;
      await modify(file, bytes);
    });
    const coordinator = new DocumentSaveCoordinator(pdf.boundary, async (bytes) => {
      if (bytes[0] === 5) throw new Error('invalid xref');
    });
    native.dirty();

    await expect(saveRevision(coordinator, session)).rejects.toMatchObject({
      restoreCause,
      restored: false,
      restoredToken: null,
    });

    expect(session.baseToken).toEqual(openedToken);
    await expect(saveRevision(coordinator, session)).rejects.toBeInstanceOf(SaveConflictError);
    expect(native.save).toHaveBeenCalledOnce();
    expect([...pdf.bytes]).toEqual([5, 6, 7]);
    session.destroy();
  });

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
