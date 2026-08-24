import { Menu, type IconName } from 'obsidian';
import type { PdfAnnotationTool } from '../adapters/pdf/pdf-annotation-editor.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import { createIconButton, updateIconButtonLabel } from './icon-button.js';
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
  readonly tool: 'freetext' | 'ink';
}

const TOOLS: readonly ToolChoice[] = [
  { icon: 'pen-tool', label: 'Ink', tool: 'ink' },
  { icon: 'type', label: 'Text', tool: 'freetext' },
];

export class AnnotationToolbar {
  readonly root: HTMLElement;

  private readonly cleanups: Array<() => void> = [];
  private readonly menus = new Set<Menu>();
  private readonly palette: readonly AnnotationPaletteEntry[];
  private readonly quickButton: HTMLButtonElement;
  private currentColor: string;
  private currentTool: PdfAnnotationTool = 'select';
  private destroyed = false;

  constructor(
    host: HTMLElement,
    palette: readonly AnnotationPaletteEntry[],
    readOnlyReason: string | null,
    private readonly onIntent: (intent: AnnotationToolbarIntent) => void,
  ) {
    this.palette = palette;
    this.currentColor = palette[0]?.color ?? '#ffd400';
    this.root = ownerWindow(host).createDiv();
    this.root.className = 'abyss-annotation-toolbar';
    this.root.dataset['region'] = 'annotation-toolbar';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'PDF annotation tools');
    if (readOnlyReason !== null) this.root.setAttribute('aria-description', readOnlyReason);
    host.append(this.root);

    this.quickButton = this.createQuickControl(readOnlyReason);
    this.addToolControls(readOnlyReason);
    this.refreshQuickPresentation();
  }

  private createQuickControl(readOnlyReason: string | null): HTMLButtonElement {
    const quick = this.root.createDiv({
      cls: ['abyss-reader-split-control', 'abyss-reader-quick-control'],
      attr: {
        'aria-label': 'Quick Highlight',
        'data-control-group': 'quick-highlight',
        role: 'group',
      },
    });
    const quickButton = this.iconButton('Quick Highlight', 'highlighter', quick);
    quickButton.dataset['annotationTool'] = 'highlight';
    quickButton.addClass('abyss-reader-split-main');
    quickButton.disabled = readOnlyReason !== null;
    quickButton.setAttribute('aria-pressed', 'false');
    const colorDot = ownerWindow(this.root).createSpan();
    colorDot.className = 'abyss-reader-quick-color';
    colorDot.setAttribute('aria-hidden', 'true');
    quickButton.append(colorDot);
    this.listen(quickButton, 'click', () => {
      this.chooseTool(this.currentTool === 'highlight' ? 'select' : 'highlight');
    });

    const quickMenu = this.iconButton('Quick Highlight colors', 'chevron-down', quick);
    quickMenu.dataset['control'] = 'quick-highlight-menu';
    quickMenu.addClass('abyss-reader-split-menu');
    quickMenu.disabled = readOnlyReason !== null;
    quickMenu.setAttribute('aria-haspopup', 'menu');
    quickMenu.setAttribute('aria-expanded', 'false');
    this.listen(quickMenu, 'click', () => {
      this.showPaletteMenu(quickMenu);
    });
    this.listen(quickMenu, 'keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      this.showPaletteMenu(quickMenu);
    });
    return quickButton;
  }

  private addToolControls(readOnlyReason: string | null): void {
    for (const choice of TOOLS) {
      const button = this.iconButton(choice.label, choice.icon);
      button.dataset['annotationTool'] = choice.tool;
      button.disabled = readOnlyReason !== null;
      button.setAttribute('aria-pressed', 'false');
      this.listen(button, 'click', () => {
        this.chooseTool(this.currentTool === choice.tool ? 'select' : choice.tool);
      });
    }
  }

  get tool(): PdfAnnotationTool {
    return this.currentTool;
  }

  get color(): string {
    return this.currentColor;
  }

  setTool(tool: PdfAnnotationTool): void {
    this.currentTool = tool;
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-annotation-tool]'),
    )) {
      button.setAttribute('aria-pressed', String(button.dataset['annotationTool'] === tool));
    }
    this.refreshQuickPresentation();
  }

  setColor(color: string): void {
    this.currentColor = color;
    this.refreshQuickPresentation();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const menu of [...this.menus]) menu.close();
    this.menus.clear();
    this.root.remove();
  }

  private chooseTool(tool: PdfAnnotationTool): void {
    this.onIntent({ type: 'set-annotation-tool', tool });
  }

  private chooseColor(color: string): void {
    this.onIntent({ type: 'set-annotation-color', color });
  }

  private refreshQuickPresentation(): void {
    const entry = this.palette.find(
      ({ color }) => color.toLocaleLowerCase() === this.currentColor.toLocaleLowerCase(),
    );
    const semantic = entry === undefined ? this.currentColor : paletteLabel(entry);
    const state = this.currentTool === 'highlight' ? 'on' : 'off';
    updateIconButtonLabel(this.quickButton, `Quick Highlight — ${semantic} — ${state}`);
    this.quickButton.style.setProperty('--abyss-quick-highlight-color', this.currentColor);
  }

  private showPaletteMenu(trigger: HTMLButtonElement): void {
    for (const open of [...this.menus]) open.close();
    const menu = new Menu();
    menu.setUseNativeMenu(false);
    this.menus.add(menu);
    trigger.setAttribute('aria-expanded', 'true');
    for (const entry of this.palette) {
      menu.addItem((item) => {
        item
          .setTitle(this.paletteMenuTitle(entry))
          .setChecked(entry.color.toLocaleLowerCase() === this.currentColor.toLocaleLowerCase())
          .onClick(() => {
            this.chooseColor(entry.color);
          });
      });
    }
    menu.onHide(() => {
      this.menus.delete(menu);
      trigger.setAttribute('aria-expanded', 'false');
      const active = this.root.doc.activeElement;
      if (active === this.root.doc.body || active === this.root.doc.documentElement)
        trigger.focus();
    });
    const bounds = trigger.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, this.root.doc);
  }

  private paletteMenuTitle(entry: AnnotationPaletteEntry): DocumentFragment {
    const owner = ownerWindow(this.root);
    const title = owner.createFragment();
    const swatch = owner.createSpan();
    swatch.className = 'abyss-documents-menu-color';
    swatch.setCssProps({ '--abyss-documents-menu-color': entry.color });
    swatch.setAttribute('aria-hidden', 'true');
    const label = owner.createSpan();
    label.textContent = paletteLabel(entry);
    title.append(swatch, label);
    return title;
  }

  private iconButton(
    label: string,
    icon: IconName,
    parent: HTMLElement = this.root,
  ): HTMLButtonElement {
    return createIconButton(parent, {
      classes: ['abyss-annotation-tool'],
      icon,
      label,
    });
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

function paletteLabel(entry: AnnotationPaletteEntry): string {
  const meaning = entry.meaning.trim();
  return meaning.length > 0 ? `${entry.name} — ${meaning}` : entry.name;
}
