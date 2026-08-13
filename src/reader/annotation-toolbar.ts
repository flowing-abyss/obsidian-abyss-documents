import { setIcon, type IconName } from 'obsidian';
import type { PdfAnnotationTool } from '../adapters/pdf/pdf-annotation-editor.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import { ownerWindow } from './owner-dom.js';

export type AnnotationToolbarIntent =
  | { readonly type: 'set-annotation-tool'; readonly tool: PdfAnnotationTool }
  | { readonly type: 'set-annotation-color'; readonly color: string }
  | { readonly type: 'undo-annotation' }
  | { readonly type: 'redo-annotation' }
  | { readonly type: 'delete-annotation' };

interface ToolChoice {
  readonly icon: IconName;
  readonly label: string;
  readonly tool: PdfAnnotationTool;
}

const TOOLS: readonly ToolChoice[] = [
  { icon: 'mouse-pointer-2', label: 'Select', tool: 'select' },
  { icon: 'highlighter', label: 'Highlight', tool: 'highlight' },
  { icon: 'pen-tool', label: 'Ink', tool: 'ink' },
  { icon: 'type', label: 'Text', tool: 'freetext' },
];

export class AnnotationToolbar {
  readonly root: HTMLElement;

  private readonly cleanups: Array<() => void> = [];
  private currentTool: PdfAnnotationTool = 'select';
  private currentColor: string;
  private destroyed = false;

  constructor(
    host: HTMLElement,
    palette: readonly AnnotationPaletteEntry[],
    readOnlyReason: string | null,
    private readonly onIntent: (intent: AnnotationToolbarIntent) => void,
  ) {
    this.root = ownerWindow(host).createDiv();
    this.root.className = 'abyss-annotation-toolbar';
    this.root.dataset['region'] = 'annotation-toolbar';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'PDF annotation tools');
    if (readOnlyReason !== null) this.root.setAttribute('aria-description', readOnlyReason);
    host.append(this.root);

    if (readOnlyReason !== null) {
      const reason = ownerWindow(this.root).createDiv();
      reason.className = 'abyss-annotation-read-only-reason';
      reason.dataset['region'] = 'annotation-read-only-reason';
      reason.textContent = readOnlyReason;
      this.root.append(reason);
    }

    this.addToolChoices(readOnlyReason);

    const colors = ownerWindow(this.root).createDiv();
    colors.className = 'abyss-annotation-colors';
    colors.setAttribute('role', 'group');
    colors.setAttribute('aria-label', 'Annotation color');
    this.root.append(colors);
    this.currentColor = palette[0]?.color ?? '#ffd400';
    this.addPaletteChoices(colors, palette, readOnlyReason);
    this.addHistoryChoices(readOnlyReason);
  }

  setTool(tool: PdfAnnotationTool): void {
    this.currentTool = tool;
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-annotation-tool]'),
    )) {
      button.setAttribute('aria-pressed', String(button.dataset['annotationTool'] === tool));
    }
  }

  get tool(): PdfAnnotationTool {
    return this.currentTool;
  }

  get color(): string {
    return this.currentColor;
  }

  setColor(color: string): void {
    this.currentColor = color;
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-annotation-color]'),
    )) {
      button.setAttribute(
        'aria-pressed',
        String(
          button.dataset['annotationColor']?.toLocaleLowerCase() === color.toLocaleLowerCase(),
        ),
      );
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.root.remove();
  }

  private chooseTool(tool: PdfAnnotationTool): void {
    this.onIntent({ type: 'set-annotation-tool', tool });
  }

  private addToolChoices(readOnlyReason: string | null): void {
    for (const choice of TOOLS) {
      const button = this.iconButton(choice.label, choice.icon);
      button.dataset['annotationTool'] = choice.tool;
      button.disabled = readOnlyReason !== null;
      button.setAttribute('aria-pressed', String(choice.tool === this.currentTool));
      this.listen(button, 'click', () => {
        this.chooseTool(choice.tool);
      });
    }
  }

  private addPaletteChoices(
    colors: HTMLElement,
    palette: readonly AnnotationPaletteEntry[],
    readOnlyReason: string | null,
  ): void {
    for (const entry of palette) {
      const button = ownerWindow(this.root).createEl('button');
      button.type = 'button';
      button.className = 'clickable-icon abyss-annotation-color';
      button.dataset['annotationColor'] = entry.color;
      button.style.backgroundColor = entry.color;
      button.disabled = readOnlyReason !== null;
      const meaning = entry.meaning.trim();
      const label = meaning.length > 0 ? `${entry.name} — ${meaning}` : entry.name;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.setAttribute('aria-pressed', String(entry.color === this.currentColor));
      this.listen(button, 'click', () => {
        this.chooseColor(entry.color);
      });
      colors.append(button);
    }
  }

  private addHistoryChoices(readOnlyReason: string | null): void {
    this.actionButton('undo-annotation', 'Undo annotation', 'undo-2', readOnlyReason);
    this.actionButton('redo-annotation', 'Redo annotation', 'redo-2', readOnlyReason);
    this.actionButton('delete-annotation', 'Delete selected annotation', 'trash-2', readOnlyReason);
  }

  private actionButton(
    action: 'delete-annotation' | 'redo-annotation' | 'undo-annotation',
    label: string,
    icon: IconName,
    readOnlyReason: string | null,
  ): void {
    const button = this.iconButton(label, icon);
    button.dataset['action'] = action;
    button.disabled = readOnlyReason !== null;
    this.listen(button, 'click', () => {
      this.onIntent({ type: action });
    });
  }

  private chooseColor(color: string): void {
    this.onIntent({ type: 'set-annotation-color', color });
  }

  private iconButton(label: string, icon: IconName): HTMLButtonElement {
    const button = ownerWindow(this.root).createEl('button');
    button.type = 'button';
    button.className = 'clickable-icon abyss-annotation-tool';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, icon);
    this.root.append(button);
    return button;
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, listener);
    this.cleanups.push(() => {
      target.removeEventListener(type, listener);
    });
  }
}
