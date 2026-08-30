import { FileView, Notice, Scope, type TFile, type WorkspaceLeaf } from 'obsidian';
import { parseAnnotationHref, type AnnotationHrefReference } from './annotation-transfer.js';
import { ownerWindow } from './owner-dom.js';
import type {
  AnnotationLoadTestFault,
  AnnotationSaveLifecycleSnapshot,
} from './reader-controller.js';

export const DOCUMENT_VIEW_TYPE = 'abyss-document-view';
export const ANNOTATION_LINK_RESOLVED_EVENT = 'abyss-documents:annotation-link-resolved';

declare global {
  interface DocumentEventMap {
    'abyss-documents:annotation-link-resolved': CustomEvent<{
      path: string;
      subpath: string;
    }>;
  }
}

export interface ReaderViewController {
  annotationSaveLifecycleSnapshot(): AnnotationSaveLifecycleSnapshot | null;
  setAnnotationLoadTestFault?(fault: AnnotationLoadTestFault | null): void;
  open(file: TFile, host: HTMLElement): Promise<void>;
  close(): Promise<void>;
  showOutline(): void;
  searchDocument(): void;
  refreshReadingSettings(): void;
  resolveAnnotationLink(reference: AnnotationHrefReference): Promise<boolean>;
  saveDocument(): Promise<void>;
}

export interface AbyssDocumentViewServices {
  createController: () => ReaderViewController;
}

export interface AnnotationSaveLifecycleViewBoundary {
  annotationSaveLifecycleSnapshot(): AnnotationSaveLifecycleSnapshot | null;
}

export class AbyssDocumentView extends FileView {
  private readonly controller: ReaderViewController;
  private loadGeneration = 0;
  private lastOpenFailureNoticeKey: string | null = null;
  private pendingAnnotationReference: {
    reference: AnnotationHrefReference;
    subpath: string;
  } | null = null;

  constructor(leaf: WorkspaceLeaf, services: AbyssDocumentViewServices) {
    super(leaf);
    this.controller = services.createController();
    this.scope = new Scope(this.app.scope);
    this.scope.register(['Mod'], 'f', () => {
      this.controller.searchDocument();
      return false;
    });
    this.scope.register(['Mod'], 's', () => {
      this.saveAtBoundary().catch((cause: unknown) => {
        console.error('[abyss-documents] Failed to contain PDF save boundary', { cause });
      });
      return false;
    });
    this.registerDomEvent(this.contentEl, 'click', (event) => {
      const target = event.target;
      if (
        !(target instanceof ownerWindow(this.contentEl).Element) ||
        target.closest('[data-action="retry"]') === null
      )
        return;
      const file = this.file;
      if (file !== null) {
        const generation = ++this.loadGeneration;
        this.openAtBoundary(file, generation).catch((cause: unknown) => {
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
    const generation = ++this.loadGeneration;
    await super.onLoadFile(file);
    await this.openAtBoundary(file, generation);
    await this.resolvePendingAnnotation();
  }

  override async setState(
    state: Record<string, unknown>,
    result: { history: boolean },
  ): Promise<void> {
    this.captureAnnotationReference(state);
    await super.setState(state, result);
  }

  override setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    this.captureAnnotationReference(state);
    void this.resolvePendingAnnotation().catch((cause: unknown) => {
      console.error('[abyss-documents] Failed to contain PDF annotation link resolution', {
        cause,
      });
    });
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    ++this.loadGeneration;
    await this.controller.close();
    this.lastOpenFailureNoticeKey = null;
    this.clearOpenFailure();
    await super.onUnloadFile(file);
  }

  showOutline(): void {
    this.controller.showOutline();
  }

  searchDocument(): void {
    this.controller.searchDocument();
  }

  annotationSaveLifecycleSnapshot(): AnnotationSaveLifecycleSnapshot | null {
    return this.controller.annotationSaveLifecycleSnapshot();
  }

  setAnnotationLoadTestFault(fault: AnnotationLoadTestFault | null): void {
    if (this.controller.setAnnotationLoadTestFault === undefined)
      throw new DOMException('Annotation load test faults are unavailable.', 'NotSupportedError');
    this.controller.setAnnotationLoadTestFault(fault);
  }

  refreshReadingSettings(): void {
    this.controller.refreshReadingSettings();
  }

  private async saveAtBoundary(): Promise<void> {
    try {
      await this.controller.saveDocument();
    } catch (cause) {
      const path = this.file?.path ?? null;
      console.error('[abyss-documents] Failed to save PDF annotations', { path, cause });
    }
  }

  private async openAtBoundary(file: TFile, generation: number): Promise<void> {
    if (generation !== this.loadGeneration) return;
    this.clearOpenFailure();
    try {
      await this.controller.open(file, this.contentEl);
      this.lastOpenFailureNoticeKey = null;
    } catch (cause) {
      if (generation !== this.loadGeneration || this.file !== file) return;
      const reason = cause instanceof Error ? cause.message : 'Unknown failure.';
      const noticeKey = `${file.path}\u0000${reason}`;
      if (noticeKey !== this.lastOpenFailureNoticeKey) {
        new Notice(`Could not open ${file.name}: ${reason}`);
        this.lastOpenFailureNoticeKey = noticeKey;
      }
      console.error('[abyss-documents] Failed to open PDF', { path: file.path, cause });
      this.renderOpenFailure(reason);
    }
  }

  private captureAnnotationReference(state: unknown): void {
    if (typeof state !== 'object' || state === null) return;
    const subpath = (state as Record<string, unknown>)['subpath'];
    if (typeof subpath !== 'string') return;
    const reference = parseAnnotationHref(subpath);
    this.pendingAnnotationReference = reference === null ? null : { reference, subpath };
  }

  private async resolvePendingAnnotation(): Promise<void> {
    const pending = this.pendingAnnotationReference;
    const file = this.file;
    const generation = this.loadGeneration;
    if (pending === null || file === null) return;
    this.pendingAnnotationReference = null;
    const resolved = await this.controller.resolveAnnotationLink(pending.reference);
    if (!resolved || generation !== this.loadGeneration || file !== this.file) return;
    const event = new (ownerWindow(this.contentEl).CustomEvent)(ANNOTATION_LINK_RESOLVED_EVENT, {
      bubbles: true,
      detail: { path: file.path, subpath: pending.subpath },
    });
    this.contentEl.dispatchEvent(event);
  }

  private renderOpenFailure(reason: string): void {
    const documentHost =
      this.contentEl.querySelector<HTMLElement>('[data-region="document"]') ?? this.contentEl;
    const owner = ownerWindow(this.contentEl);
    const surface = owner.createDiv();
    surface.dataset['readerError'] = 'open';
    surface.setAttribute('role', 'alert');

    const message = owner.createEl('p');
    message.textContent = reason;
    const retry = owner.createEl('button');
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
