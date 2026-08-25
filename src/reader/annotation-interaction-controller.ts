import type {
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfAnnotationTool,
  PdfSelectionAction,
} from '../adapters/pdf/pdf-annotation-editor.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import type {
  SelectionAnnotationIntent,
  SelectionAnnotationPopoverRequest,
} from './selection-annotation-popover.js';

export interface QuickHighlightState {
  readonly armed: boolean;
  readonly color: string;
}

export interface AnnotationInteractionHost {
  setQuickHighlightState(state: QuickHighlightState): void;
  openSelectionPopover(request: SelectionAnnotationPopoverRequest): void;
  closeSelectionPopover(): void;
}

export type AnnotationInteractionInvalidation =
  'zoom' | 'layout' | 'navigation' | 'save' | 'session';

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
    this.cleanups.push(
      interaction.onMode((mode) => {
        this.handleMode(mode);
      }),
      interaction.onSelection((selection) => {
        this.handleSelection(selection);
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
    this.closeActiveSelection();
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
    const stillAvailable = palette.some(
      (entry) => entry.color.toLocaleLowerCase() === this.activeColor.toLocaleLowerCase(),
    );
    if (!stillAvailable) this.setActiveColor(palette[0]?.color ?? DEFAULT_COLOR);
    this.closeActiveSelection();
    this.publishQuickHighlightState();
    if (this.mode !== 'quick-highlight') return;
    const revision = ++this.quickRequestRevision;
    this.contain(this.applyQuickHighlight(true, revision));
  }

  invalidate(_reason: AnnotationInteractionInvalidation): void {
    if (this.destroyed) return;
    this.closeActiveSelection();
    this.abortCommit('The PDF annotation selection was invalidated.');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.quickRequestRevision += 1;
    this.closeActiveSelection();
    this.abortCommit('The PDF annotation interaction was closed.');
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private handleMode(mode: PdfAnnotationLogicalMode): void {
    if (this.destroyed) return;
    this.mode = mode;
    this.options.onModeChange?.(mode);
    if (mode !== 'neutral') this.closeActiveSelection();
    this.publishQuickHighlightState();
  }

  private handleSelection(selection: PdfTextSelection | null): void {
    if (this.destroyed || this.mode !== 'neutral' || selection === null) {
      this.closeActiveSelection();
      return;
    }
    const revision = ++this.activeSelectionRevision;
    const request: SelectionAnnotationPopoverRequest = {
      palette: this.palette,
      selection,
      onIntent: (intent) => {
        this.handleSelectionIntent(revision, selection, intent);
      },
    };
    this.host.openSelectionPopover(request);
  }

  private handleSelectionIntent(
    revision: number,
    selection: PdfTextSelection,
    intent: SelectionAnnotationIntent,
  ): void {
    if (this.destroyed || revision !== this.activeSelectionRevision) return;
    this.closeActiveSelection();
    if (intent.type === 'dismiss') return;
    this.setActiveColor(intent.color);
    this.publishQuickHighlightState();
    const action = selectionAction(intent);
    const abort = new AbortController();
    this.abortCommit('The PDF annotation selection was superseded.');
    this.activeAbort = abort;
    void this.interaction.commitSelection(selection.token, action, abort.signal).then(
      () => {
        if (this.activeAbort !== abort) return;
        this.activeAbort = null;
        this.publishQuickHighlightState();
      },
      (cause: unknown) => {
        if (this.destroyed || this.activeAbort !== abort) return;
        this.activeAbort = null;
        this.host.closeSelectionPopover();
        this.publishQuickHighlightState();
        if (!isAbortFailure(cause)) {
          this.options.onFailure?.('create selection annotation', cause, {
            intent: intent.type,
            token: selection.token,
          });
        }
      },
    );
  }

  private async applyQuickHighlight(enabled: boolean, revision: number): Promise<void> {
    try {
      await this.interaction.setQuickHighlight({ color: this.activeColor, enabled });
      if (this.destroyed || revision !== this.quickRequestRevision) return;
      this.publishQuickHighlightState();
    } catch (cause) {
      if (this.destroyed || revision !== this.quickRequestRevision || isAbortFailure(cause)) return;
      this.host.closeSelectionPopover();
      this.publishQuickHighlightState();
      this.options.onModeChange?.(this.mode);
      this.options.onFailure?.(enabled ? 'arm Quick Highlight' : 'disarm Quick Highlight', cause, {
        color: this.activeColor,
      });
    }
  }

  private closeActiveSelection(): void {
    this.activeSelectionRevision += 1;
    this.host.closeSelectionPopover();
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

function selectionAction(
  intent: Exclude<SelectionAnnotationIntent, { readonly type: 'dismiss' }>,
): PdfSelectionAction {
  if (intent.type === 'highlight') return { color: intent.color, kind: 'highlight' };
  let seed: '' | '[[' | '#' = '';
  if (intent.type === 'link') seed = '[[';
  if (intent.type === 'tag') seed = '#';
  return { color: intent.color, kind: 'comment', seed };
}

function isAbortFailure(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
  );
}
