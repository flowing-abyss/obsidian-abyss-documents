import { Menu, type IconName } from 'obsidian';
import type { PdfAnnotationTool } from '../adapters/pdf/pdf-annotation-editor.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import { createIconButton, updateIconButtonLabel } from './icon-button.js';
import { markReaderMenuClosing, shouldRestoreMenuTriggerFocus } from './menu-focus.js';
import { ownerWindow } from './owner-dom.js';
import { LongPressMenuGesture } from './toolbar.js';

export type AnnotationToolbarIntent =
  | { readonly type: 'set-annotation-tool'; readonly tool: 'select' }
  | {
      readonly type: 'set-annotation-tool';
      readonly tool: WritableAnnotationTool;
      readonly color: string;
    }
  | {
      readonly type: 'set-annotation-color';
      readonly tool: WritableAnnotationTool;
      readonly color: string;
    }
  | { readonly type: 'undo-annotation' }
  | { readonly type: 'redo-annotation' };

type WritableAnnotationTool = Exclude<PdfAnnotationTool, 'select'>;

interface ToolChoice {
  readonly icon: IconName;
  readonly label: string;
  readonly tool: 'freetext' | 'ink';
}

interface ActiveMenu {
  readonly menu: Menu;
  readonly trigger: HTMLButtonElement;
}

const TOOLS: readonly ToolChoice[] = [
  { icon: 'pen-tool', label: 'Ink', tool: 'ink' },
  { icon: 'type', label: 'Text', tool: 'freetext' },
];

export class AnnotationToolbar {
  readonly root: HTMLElement;

  private readonly cleanups: Array<() => void> = [];
  private readonly focusFrames = new Set<number>();
  private readonly palette: readonly AnnotationPaletteEntry[];
  private readonly toolColors: Record<WritableAnnotationTool, string>;
  private activeMenu: ActiveMenu | null = null;
  private currentTool: PdfAnnotationTool = 'select';
  private destroyed = false;

  constructor(
    host: HTMLElement,
    palette: readonly AnnotationPaletteEntry[],
    readOnlyReason: string | null,
    private readonly onIntent: (intent: AnnotationToolbarIntent) => void,
  ) {
    this.palette = palette;
    const defaultColor = palette[0]?.color ?? '#ffd400';
    this.toolColors = {
      freetext: defaultColor,
      highlight: defaultColor,
      ink: defaultColor,
    };
    this.root = ownerWindow(host).createDiv();
    this.root.className = 'abyss-annotation-toolbar';
    this.root.dataset['region'] = 'annotation-toolbar';
    this.root.dataset['annotationMode'] = 'select';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'PDF annotation tools');
    if (readOnlyReason !== null) this.root.setAttribute('aria-description', readOnlyReason);
    host.append(this.root);

    this.createSelectControl();
    this.createQuickControl(readOnlyReason);
    this.addToolControls(readOnlyReason);
    this.refreshToolPresentations();
  }

  private createSelectControl(): void {
    const select = this.iconButton('Select', 'mouse-pointer-2');
    select.dataset['annotationTool'] = 'select';
    select.setAttribute('aria-pressed', 'true');
    this.listen(select, 'click', () => {
      this.chooseTool('select');
    });
  }

  private createQuickControl(readOnlyReason: string | null): HTMLButtonElement {
    const quick = this.root.createDiv({
      cls: ['abyss-reader-split-control', 'abyss-reader-quick-control'],
      attr: {
        'aria-label': 'Sticky Highlight',
        'data-control-group': 'quick-highlight',
        role: 'group',
      },
    });
    const quickButton = this.iconButton('Sticky Highlight', 'highlighter', quick);
    quickButton.dataset['annotationTool'] = 'highlight';
    quickButton.addClass('abyss-reader-split-main');
    quickButton.disabled = readOnlyReason !== null;
    quickButton.setAttribute('aria-pressed', 'false');
    quickButton.setAttribute('aria-haspopup', 'menu');
    quickButton.setAttribute('aria-expanded', 'false');
    this.addToolColorMarker(quickButton);
    const showQuickMenu = (): void => {
      this.showPaletteMenu(quickButton, 'highlight');
    };
    const longPress = this.bindLongPressMenuTrigger(quickButton, showQuickMenu);
    this.listen(quickButton, 'click', (event) => {
      if (event.button !== 0) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (longPress.consumeClick()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      this.chooseTool(this.currentTool === 'highlight' ? 'select' : 'highlight');
    });
    this.listen(quickButton, 'keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      showQuickMenu();
    });
    this.listen(quickButton, 'contextmenu', (event) => {
      if (
        longPress.handleContextMenu(event, () => {
          this.showPaletteMenu(quickButton, 'highlight', event);
        })
      )
        return;
      event.preventDefault();
      this.showPaletteMenu(quickButton, 'highlight', event);
    });

    const quickMenu = this.iconButton('Sticky Highlight colors', 'chevron-down', quick);
    quickMenu.dataset['control'] = 'quick-highlight-menu';
    quickMenu.addClass('abyss-reader-split-menu');
    quickMenu.disabled = readOnlyReason !== null;
    quickMenu.setAttribute('aria-haspopup', 'menu');
    quickMenu.setAttribute('aria-expanded', 'false');
    this.bindMenuTrigger(quickMenu, () => {
      this.showPaletteMenu(quickMenu, 'highlight');
    });
    return quickButton;
  }

  private addToolControls(readOnlyReason: string | null): void {
    for (const choice of TOOLS) {
      const split = this.root.createDiv({
        cls: ['abyss-reader-split-control', 'abyss-reader-annotation-tool-control'],
        attr: {
          'aria-label': `${choice.label} — more color options`,
          'data-control-group': `${choice.tool}-annotation`,
          role: 'group',
        },
      });
      const button = this.iconButton(choice.label, choice.icon, split);
      button.dataset['annotationTool'] = choice.tool;
      button.addClass('abyss-reader-split-main');
      button.disabled = readOnlyReason !== null;
      button.setAttribute('aria-pressed', 'false');
      this.addToolColorMarker(button);
      this.listen(button, 'click', () => {
        this.chooseTool(this.currentTool === choice.tool ? 'select' : choice.tool);
      });
      const disclosure = this.iconButton(`${choice.label} colors`, 'chevron-down', split);
      disclosure.dataset['control'] = `${choice.tool}-color-menu`;
      disclosure.addClass('abyss-reader-split-menu');
      disclosure.disabled = readOnlyReason !== null;
      disclosure.setAttribute('aria-haspopup', 'menu');
      disclosure.setAttribute('aria-expanded', 'false');
      this.bindMenuTrigger(disclosure, () => {
        this.showPaletteMenu(disclosure, choice.tool);
      });
    }
  }

  get tool(): PdfAnnotationTool {
    return this.currentTool;
  }

  get color(): string {
    return this.toolColors.highlight;
  }

  colorFor(tool: WritableAnnotationTool): string {
    return this.toolColors[tool];
  }

  setTool(tool: PdfAnnotationTool): void {
    this.currentTool = tool;
    this.root.dataset['annotationMode'] = tool === 'highlight' ? 'sticky-highlight' : tool;
    for (const button of Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-annotation-tool]'),
    )) {
      button.setAttribute('aria-pressed', String(button.dataset['annotationTool'] === tool));
    }
    this.refreshToolPresentations();
  }

  setColor(color: string): void;
  setColor(tool: WritableAnnotationTool, color: string): void;
  setColor(toolOrColor: string, nextColor?: string): void {
    const tool = nextColor === undefined ? 'highlight' : (toolOrColor as WritableAnnotationTool);
    const color = nextColor ?? toolOrColor;
    this.toolColors[tool] = color;
    this.refreshToolPresentation(tool);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.activeMenu?.menu.hide();
    this.activeMenu = null;
    for (const frame of this.focusFrames) this.root.win.cancelAnimationFrame(frame);
    this.focusFrames.clear();
    this.root.remove();
  }

  private chooseTool(tool: PdfAnnotationTool): void {
    if (tool === 'select') {
      this.onIntent({ type: 'set-annotation-tool', tool });
      return;
    }
    this.onIntent({ color: this.toolColors[tool], type: 'set-annotation-tool', tool });
  }

  private chooseColor(tool: WritableAnnotationTool, color: string): void {
    this.onIntent({ type: 'set-annotation-color', tool, color });
  }

  private refreshToolPresentations(): void {
    for (const tool of ['highlight', 'ink', 'freetext'] as const)
      this.refreshToolPresentation(tool);
  }

  private refreshToolPresentation(tool: WritableAnnotationTool): void {
    const button = this.root.querySelector<HTMLButtonElement>(`[data-annotation-tool="${tool}"]`);
    if (button === null) return;
    const currentColor = this.toolColors[tool];
    const entry = this.palette.find(
      ({ color }) => color.toLocaleLowerCase() === currentColor.toLocaleLowerCase(),
    );
    const semantic = entry === undefined ? currentColor : paletteLabel(entry);
    let state = 'inactive';
    if (this.currentTool === tool) state = 'active';
    else if (tool === 'highlight' && this.currentTool === 'select') state = 'Select mode';
    const labels: Record<WritableAnnotationTool, string> = {
      freetext: 'Text',
      highlight: 'Sticky Highlight',
      ink: 'Ink',
    };
    const label = labels[tool];
    updateIconButtonLabel(button, `${label} — ${semantic} — ${state}`);
    button.style.setProperty('--abyss-annotation-tool-color', currentColor);
  }

  private addToolColorMarker(button: HTMLButtonElement): void {
    const marker = ownerWindow(this.root).createSpan();
    marker.className = 'abyss-reader-tool-color';
    marker.setAttribute('aria-hidden', 'true');
    button.append(marker);
  }

  private showPaletteMenu(
    trigger: HTMLButtonElement,
    tool: WritableAnnotationTool,
    event?: MouseEvent,
  ): void {
    if (this.activeMenu?.trigger === trigger) {
      this.activeMenu.menu.hide();
      return;
    }
    this.activeMenu?.menu.hide();
    const menu = new Menu();
    menu.setUseNativeMenu(false);
    menu.setParentElement(trigger);
    this.activeMenu = { menu, trigger };
    trigger.setAttribute('aria-expanded', 'true');
    for (const entry of this.palette) {
      menu.addItem((item) => {
        item
          .setTitle(this.paletteMenuTitle(entry))
          .setChecked(entry.color.toLocaleLowerCase() === this.toolColors[tool].toLocaleLowerCase())
          .onClick(() => {
            this.chooseColor(tool, entry.color);
          });
      });
    }
    menu.onHide(() => {
      markReaderMenuClosing(trigger);
      if (this.activeMenu?.menu === menu) this.activeMenu = null;
      trigger.setAttribute('aria-expanded', 'false');
      this.restoreMenuTriggerFocus(trigger);
    });
    if (event === undefined) {
      const bounds = trigger.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, this.root.doc);
    } else {
      menu.showAtMouseEvent(event);
    }
  }

  private restoreMenuTriggerFocus(trigger: HTMLButtonElement): void {
    const frame = this.root.win.requestAnimationFrame(() => {
      this.focusFrames.delete(frame);
      if (
        !this.destroyed &&
        this.activeMenu === null &&
        trigger.isConnected &&
        shouldRestoreMenuTriggerFocus(trigger)
      ) {
        trigger.focus();
      }
    });
    this.focusFrames.add(frame);
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

  private bindMenuTrigger(trigger: HTMLButtonElement, show: () => void): void {
    let lastTouchPointerUp = Number.NEGATIVE_INFINITY;
    this.listen(trigger, 'pointerup', (event) => {
      if (event.pointerType !== 'touch') return;
      event.preventDefault();
      lastTouchPointerUp = event.timeStamp;
      show();
    });
    this.listen(trigger, 'click', (event) => {
      const elapsed = event.timeStamp - lastTouchPointerUp;
      if (event.detail > 0 && elapsed >= 0 && elapsed < 750) return;
      show();
    });
    this.listen(trigger, 'keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      show();
    });
  }

  private bindLongPressMenuTrigger(
    trigger: HTMLButtonElement,
    show: () => void,
  ): LongPressMenuGesture {
    const gesture = new LongPressMenuGesture(trigger, this.root.win, show);
    this.listen(trigger, 'pointerdown', gesture.onPointerDown);
    this.listen(trigger, 'pointermove', gesture.onPointerMove);
    this.listen(trigger, 'pointerup', gesture.onPointerUp);
    this.listen(trigger, 'pointercancel', gesture.onPointerCancel);
    this.listen(trigger, 'lostpointercapture', gesture.onPointerCancel);
    this.cleanups.push(() => {
      gesture.destroy();
    });
    return gesture;
  }
}

function paletteLabel(entry: AnnotationPaletteEntry): string {
  const meaning = entry.meaning.trim();
  return meaning.length > 0 ? `${entry.name} — ${meaning}` : entry.name;
}
