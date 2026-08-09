import { FileView, Notice, type TFile, type WorkspaceLeaf } from 'obsidian';

export const DOCUMENT_VIEW_TYPE = 'abyss-document-view';

export interface ReaderViewController {
  open(file: TFile, host: HTMLElement): Promise<void>;
  close(): Promise<void>;
}

export interface AbyssDocumentViewServices {
  createController: () => ReaderViewController;
}

export class AbyssDocumentView extends FileView {
  private readonly controller: ReaderViewController;

  constructor(leaf: WorkspaceLeaf, services: AbyssDocumentViewServices) {
    super(leaf);
    this.controller = services.createController();
    this.registerDomEvent(this.contentEl, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-action="retry"]') === null) return;
      const file = this.file;
      if (file !== null) {
        this.openAtBoundary(file).catch((cause: unknown) => {
          console.error('[abyss-documents] Failed to handle PDF retry', {
            path: file.path,
            cause,
          });
        });
      }
    });
  }

  override getViewType(): string {
    return DOCUMENT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? 'Document';
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.openAtBoundary(file);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    try {
      await this.controller.close();
    } finally {
      this.clearOpenFailure();
      await super.onUnloadFile(file);
    }
  }

  private async openAtBoundary(file: TFile): Promise<void> {
    this.clearOpenFailure();
    try {
      await this.controller.open(file, this.contentEl);
    } catch (cause) {
      if (this.file !== file) return;
      const reason = cause instanceof Error ? cause.message : 'Unknown failure.';
      new Notice(`Could not open ${file.name}: ${reason}`);
      console.error('[abyss-documents] Failed to open PDF', { path: file.path, cause });
      this.renderOpenFailure(reason);
    }
  }

  private renderOpenFailure(reason: string): void {
    const documentHost =
      this.contentEl.querySelector<HTMLElement>('[data-region="document"]') ?? this.contentEl;
    const surface = createDiv();
    surface.dataset['readerError'] = 'open';
    surface.setAttribute('role', 'alert');

    const message = createEl('p');
    message.textContent = reason;
    const retry = createEl('button');
    retry.type = 'button';
    retry.dataset['action'] = 'retry';
    retry.textContent = 'Retry';
    surface.append(message, retry);
    documentHost.append(surface);
  }

  private clearOpenFailure(): void {
    this.contentEl.querySelector('[data-reader-error="open"]')?.remove();
  }
}
