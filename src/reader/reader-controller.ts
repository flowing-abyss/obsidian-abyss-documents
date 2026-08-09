import type { TFile } from 'obsidian';
import type { DocumentAdapterRegistry } from '../document-core/document-adapter.js';
import type { DocumentSession, DocumentViewport } from '../document-core/document.js';
import { DocumentCancelledError, DocumentOpenError } from '../document-core/errors.js';
import { ReaderShell } from './reader-shell.js';

type ShellFactory = (host: HTMLElement) => ReaderShell;

export class ReaderController {
  private queue: Promise<void> = Promise.resolve();
  private activeOpen: AbortController | null = null;
  private session: DocumentSession | null = null;
  private viewport: DocumentViewport | null = null;
  private shell: ReaderShell | null = null;

  constructor(
    private readonly registry: DocumentAdapterRegistry,
    private readonly createShell: ShellFactory = (host) => new ReaderShell(host),
  ) {}

  open(file: TFile, host: HTMLElement): Promise<void> {
    this.activeOpen?.abort();
    const abortController = new AbortController();
    this.activeOpen = abortController;
    return this.enqueue(async () => {
      try {
        await this.releaseCurrent();
        this.throwIfCancelled(file, abortController.signal);

        const shell = this.createShell(host);
        this.shell = shell;
        let session: DocumentSession | null = null;
        let viewport: DocumentViewport | null = null;
        try {
          const adapter = this.registry.requireFor(file);
          session = await adapter.open(file, abortController.signal);
          this.throwIfCancelled(file, abortController.signal);
          viewport = await session.createViewport();
          this.throwIfCancelled(file, abortController.signal);
          await viewport.mount(shell.documentHost);
          this.throwIfCancelled(file, abortController.signal);
          this.session = session;
          this.viewport = viewport;
        } catch (cause) {
          const cleanupFailure = await this.releasePartial(viewport, session);
          if (cleanupFailure !== undefined) {
            console.error('[abyss-documents] Failed to clean up a partial reader session', {
              path: file.path,
              cause: cleanupFailure,
            });
          }
          if (abortController.signal.aborted) throw this.cancelled(file, cause);
          if (cause instanceof DocumentOpenError) throw cause;
          throw new DocumentOpenError(
            file.path,
            'Could not open this document view. Try again.',
            cause,
          );
        }
      } finally {
        if (this.activeOpen === abortController) this.activeOpen = null;
      }
    });
  }

  close(): Promise<void> {
    this.activeOpen?.abort();
    this.activeOpen = null;
    return this.enqueue(() => this.releaseCurrent());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async releaseCurrent(): Promise<void> {
    const viewport = this.viewport;
    const session = this.session;
    const shell = this.shell;
    this.viewport = null;
    this.session = null;
    this.shell = null;

    const failure = await this.releasePartial(viewport, session);
    shell?.destroy();
    if (failure !== undefined) throw failure;
  }

  private async releasePartial(
    viewport: DocumentViewport | null,
    session: DocumentSession | null,
  ): Promise<Error | undefined> {
    let failure: Error | undefined;
    if (viewport !== null) {
      try {
        await viewport.destroy();
      } catch (cause) {
        failure = this.asError(cause);
      }
    }
    if (session !== null) {
      try {
        await session.close();
      } catch (cause) {
        failure ??= this.asError(cause);
      }
    }
    return failure;
  }

  private throwIfCancelled(file: TFile, signal: AbortSignal): void {
    if (signal.aborted) throw this.cancelled(file, signal.reason);
  }

  private cancelled(file: TFile, cause?: unknown): DocumentCancelledError {
    return new DocumentCancelledError(file.path, 'Opening this PDF was cancelled.', cause);
  }

  private asError(cause: unknown): Error {
    return cause instanceof Error
      ? cause
      : new Error(`Unknown reader cleanup failure: ${String(cause)}`);
  }
}
