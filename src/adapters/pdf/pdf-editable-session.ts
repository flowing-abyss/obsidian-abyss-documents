import type {
  BaseToken,
  NativeEditableSaveSession,
  NativeSaveSource,
  PreparedNativeSave,
} from '../../document-core/save-coordinator.js';

interface NativePdfEditorBridge {
  onDirty(listener: (dirty: boolean) => void): () => void;
  save(signal: AbortSignal): Promise<Uint8Array>;
}

export class PdfEditableSession implements NativeEditableSaveSession, NativeSaveSource {
  static readonly recoveryGuarantee = 'last-verified-pdf-bytes-only';

  private revision = 0;
  private acknowledgedRevision = 0;
  private base: BaseToken;
  private retained: PreparedNativeSave | null = null;
  private readonly detachDirty: () => void;
  private destroyed = false;

  constructor(
    readonly path: string,
    baseToken: BaseToken,
    private readonly editor: NativePdfEditorBridge,
    private readonly onNativeRevision?: (revision: number) => void,
  ) {
    this.base = Object.freeze({ ...baseToken });
    this.detachDirty = editor.onDirty((dirty) => {
      if (!dirty || this.destroyed) return;
      this.revision += 1;
      this.onNativeRevision?.(this.revision);
    });
  }

  get pendingRevision(): number {
    return this.revision;
  }

  get committedRevision(): number {
    return this.acknowledgedRevision;
  }

  get isDirty(): boolean {
    return this.revision > this.acknowledgedRevision;
  }

  get baseToken(): BaseToken {
    return this.base;
  }

  async prepare(revision: number, signal: AbortSignal): Promise<PreparedNativeSave> {
    this.requireLiveRevision(revision);
    if (this.retained?.revision === revision) return this.retained;
    const ownedBytes = await this.editor.save(signal);
    const prepared = Object.freeze({ revision, baseToken: this.base, bytes: ownedBytes });
    this.retained = prepared;
    return prepared;
  }

  commit(prepared: PreparedNativeSave, token: BaseToken): void {
    if (this.retained !== prepared) {
      throw new DOMException('The prepared PDF revision is no longer active.', 'InvalidStateError');
    }
    this.acknowledgedRevision = Math.max(this.acknowledgedRevision, prepared.revision);
    this.base = Object.freeze({ ...token });
    this.retained = null;
  }

  acceptVerifiedReload(token: BaseToken): void {
    this.base = Object.freeze({ ...token });
    this.retained = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detachDirty();
  }

  private requireLiveRevision(revision: number): void {
    if (this.destroyed)
      throw new DOMException('The PDF edit session is closed.', 'InvalidStateError');
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision > this.revision) {
      throw new DOMException('The requested PDF revision is not pending.', 'InvalidStateError');
    }
  }
}
