import type {
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfAnnotationTool,
} from '../adapters/pdf/pdf-annotation-editor.js';
import type { PdfAnnotationFocus } from '../adapters/pdf/pdf-comment-bridge.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import type {
  AnnotationEditorCreation,
  AnnotationEditorPopoverRequest,
  AnnotationEditorTarget,
} from './annotation-editor-popover.js';

export interface QuickHighlightState {
  readonly armed: boolean;
  readonly color: string;
}

export interface AnnotationInteractionHost {
  setQuickHighlightState(state: QuickHighlightState): void;
  openAnnotationEditor(request: AnnotationEditorPopoverRequest): boolean;
  closeAnnotationEditor(): boolean;
}

export type AnnotationInteractionInvalidation = 'zoom' | 'layout' | 'navigation' | 'session';

export interface AnnotationInteractionControllerOptions {
  readonly color?: string;
  readonly onColorChange?: (color: string) => void;
  readonly onFailure?: (
    action: string,
    cause: unknown,
    context: Readonly<Record<string, unknown>>,
  ) => void;
  readonly onModeChange?: (mode: PdfAnnotationLogicalMode) => void;
}

const DEFAULT_COLOR = '#ffd400';

export class AnnotationInteractionController {
  private readonly cleanups: Array<() => void> = [];
  private activeAbort: AbortController | null = null;
  private activeColor: string;
  private activeSelectionRevision = 0;
  private destroyed = false;
  private mode: PdfAnnotationLogicalMode = 'neutral';
  private palette: readonly AnnotationPaletteEntry[];
  private quickRequestRevision = 0;

  constructor(
    private readonly interaction: PdfAnnotationInteraction,
    private readonly host: AnnotationInteractionHost,
    palette: readonly AnnotationPaletteEntry[],
    private readonly options: AnnotationInteractionControllerOptions = {},
  ) {
    this.palette = palette;
    this.activeColor = options.color ?? palette[0]?.color ?? DEFAULT_COLOR;
    interaction.setPalette?.(palette);
    this.cleanups.push(
      interaction.onColor((color) => {
        this.handleColor(color);
      }),
      interaction.onMode((mode) => {
        this.handleMode(mode);
      }),
      interaction.onSelection((selection) => {
        this.handleSelection(selection);
      }),
      interaction.onAnnotationFocus((focus) => {
        this.handleAnnotationFocus(focus);
      }),
    );
  }

  get color(): string {
    return this.activeColor;
  }

  get quickHighlightArmed(): boolean {
    return this.mode === 'quick-highlight';
  }

  requestTool(tool: PdfAnnotationTool): boolean {
    if (this.destroyed || (tool !== 'highlight' && tool !== 'select')) return false;
    if (!this.closeActiveSelection()) return false;
    const enabled = tool === 'highlight';
    const revision = ++this.quickRequestRevision;
    this.contain(this.applyQuickHighlight(enabled, revision));
    return true;
  }

  selectColor(color: string): boolean {
    if (
      this.destroyed ||
      this.mode === 'ink' ||
      this.mode === 'freetext' ||
      this.mode === 'disabled'
    )
      return false;
    this.setActiveColor(color);
    this.publishQuickHighlightState();
    if (this.mode !== 'quick-highlight') return true;
    const revision = ++this.quickRequestRevision;
    this.contain(this.applyQuickHighlight(true, revision));
    return true;
  }

  updatePalette(palette: readonly AnnotationPaletteEntry[]): void {
    if (this.destroyed) return;
    this.palette = palette;
    this.interaction.setPalette?.(palette);
    if (!this.closeActiveSelection()) return;
    this.publishQuickHighlightState();
    if (this.mode !== 'quick-highlight') return;
    const revision = ++this.quickRequestRevision;
    this.contain(this.applyQuickHighlight(true, revision));
  }

  invalidate(_reason: AnnotationInteractionInvalidation): void {
    if (this.destroyed) return;
    if (!this.closeActiveSelection()) return;
    this.abortCommit('The PDF annotation selection was invalidated.');
  }

  destroy(): boolean {
    if (this.destroyed) return true;
    if (!this.closeActiveSelection()) return false;
    this.destroyed = true;
    this.quickRequestRevision += 1;
    this.abortCommit('The PDF annotation interaction was closed.');
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    return true;
  }

  private handleMode(mode: PdfAnnotationLogicalMode): void {
    if (this.destroyed) return;
    this.mode = mode;
    this.options.onModeChange?.(mode);
    if (mode === 'one-shot' && this.activeAbort !== null) {
      this.publishQuickHighlightState();
      return;
    }
    if (mode !== 'neutral' && !this.closeActiveSelection()) return;
    this.publishQuickHighlightState();
  }

  private handleColor(color: string): void {
    if (this.destroyed || color.trim().length === 0) return;
    this.setActiveColor(color);
    this.publishQuickHighlightState();
  }

  private handleSelection(selection: PdfTextSelection | null): void {
    if (this.destroyed || this.mode !== 'neutral' || selection === null) {
      this.closeActiveSelection();
      return;
    }
    const revision = this.activeSelectionRevision + 1;
    const opened = this.host.openAnnotationEditor({
      color: this.activeColor,
      onClose: () => {
        if (revision !== this.activeSelectionRevision) return;
        this.activeSelectionRevision += 1;
        this.abortCommit('The PDF annotation selection editor was closed.');
      },
      onCreate: (creation) => this.createSelection(revision, creation),
      onDelete: (annotations) => this.interaction.deleteAnnotations(annotations),
      onUpdate: (update) => this.interaction.updateAnnotations(update),
      palette: this.palette,
      target: { kind: 'selection', selection },
    });
    if (opened) this.activeSelectionRevision = revision;
  }

  private handleAnnotationFocus(focus: PdfAnnotationFocus | null): void {
    if (this.destroyed || this.activeAbort !== null) return;
    const first = focus?.annotations[0];
    if (focus === null || first === undefined) {
      this.closeActiveSelection();
      return;
    }
    let target: AnnotationEditorTarget;
    if (!focus.editable) target = { annotation: first, kind: 'readonly' };
    else if (focus.annotations.length === 1) target = { annotation: first, kind: 'annotation' };
    else target = { annotations: focus.annotations, kind: 'multiple' };
    const opened = this.host.openAnnotationEditor({
      color: first.color ?? undefined,
      onClose: () => undefined,
      onCreate: () => 'dismissed' as const,
      onDelete: (annotations) => this.interaction.deleteAnnotations(annotations),
      onUpdate: (update) => this.interaction.updateAnnotations(update),
      palette: this.palette,
      position: focus.position,
      target,
    });
    if (opened) this.activeSelectionRevision += 1;
  }

  private async createSelection(
    revision: number,
    creation: AnnotationEditorCreation,
  ): Promise<DocumentAnnotation | 'dismissed'> {
    if (this.destroyed || revision !== this.activeSelectionRevision) return 'dismissed';
    this.setActiveColor(creation.color);
    this.publishQuickHighlightState();
    const abort = new AbortController();
    this.abortCommit('The PDF annotation selection was superseded.');
    this.activeAbort = abort;
    try {
      const result = await this.interaction.commitSelection(
        creation.selection.token,
        creation.comment.length === 0
          ? { color: creation.color, kind: 'highlight' }
          : { color: creation.color, kind: 'comment', seed: creation.comment },
        abort.signal,
      );
      if (this.activeAbort === abort) {
        this.activeAbort = null;
        this.publishQuickHighlightState();
      }
      return result;
    } catch (cause) {
      if (this.activeAbort === abort) {
        this.activeAbort = null;
        this.publishQuickHighlightState();
        if (!isAbortFailure(cause)) {
          this.options.onFailure?.('create selection annotation', cause, {
            token: creation.selection.token,
          });
        }
      }
      throw cause;
    }
  }

  private async applyQuickHighlight(enabled: boolean, revision: number): Promise<void> {
    try {
      await this.interaction.setQuickHighlight({ color: this.activeColor, enabled });
      if (this.destroyed || revision !== this.quickRequestRevision) return;
      this.publishQuickHighlightState();
    } catch (cause) {
      if (this.destroyed || revision !== this.quickRequestRevision || isAbortFailure(cause)) return;
      this.host.closeAnnotationEditor();
      this.publishQuickHighlightState();
      this.options.onModeChange?.(this.mode);
      this.options.onFailure?.(enabled ? 'arm Quick Highlight' : 'disarm Quick Highlight', cause, {
        color: this.activeColor,
      });
    }
  }

  private closeActiveSelection(): boolean {
    const revision = this.activeSelectionRevision;
    if (!this.host.closeAnnotationEditor()) return false;
    if (this.activeSelectionRevision === revision) this.activeSelectionRevision += 1;
    return true;
  }

  private abortCommit(message: string): void {
    const abort = this.activeAbort;
    this.activeAbort = null;
    abort?.abort(new DOMException(message, 'AbortError'));
  }

  private publishQuickHighlightState(): void {
    this.host.setQuickHighlightState({
      armed: this.mode === 'quick-highlight',
      color: this.activeColor,
    });
  }

  private setActiveColor(color: string): void {
    if (color === this.activeColor) return;
    this.activeColor = color;
    this.options.onColorChange?.(color);
  }

  private contain(operation: Promise<void>): void {
    operation.catch((cause: unknown) => {
      console.error('[abyss-documents] Unexpected annotation interaction controller failure', {
        cause,
      });
    });
  }
}

function isAbortFailure(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
  );
}
