import { Menu, type IconName } from 'obsidian';
import {
  DEFAULT_READER_LAYOUT,
  type ReaderLayout,
  type ReaderScale,
  type ReadingProfileId,
} from '../document-core/reading.js';
import { createIconButton } from './icon-button.js';
import { shouldRestoreMenuTriggerFocus } from './menu-focus.js';

export type ReaderToolbarIntent =
  | { readonly type: 'toggle-sidebar' }
  | { readonly type: 'go-to-page'; readonly pageIndex: number }
  | { readonly type: 'previous-page' }
  | { readonly type: 'next-page' }
  | { readonly type: 'export-annotations' }
  | { readonly type: 'zoom-step'; readonly direction: -1 | 1 }
  | { readonly type: 'set-scale'; readonly scale: ReaderScale }
  | { readonly type: 'set-profile'; readonly profile: ReadingProfileId }
  | { readonly type: 'set-layout'; readonly layout: ReaderLayout };

interface ProfileChoice {
  readonly id: ReadingProfileId;
  readonly label: string;
}

interface FitChoice {
  readonly label: string;
  readonly value: ReaderScale;
}

interface LayoutChoice {
  readonly icon: IconName;
  readonly label: string;
  readonly value: ReaderLayout;
}

const PROFILE_CHOICES: readonly ProfileChoice[] = [
  { id: 'default', label: 'Default' },
  { id: 'follow-obsidian', label: 'Follow Obsidian' },
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' },
  { id: 'custom', label: 'Custom' },
];

const FIT_CHOICES: readonly FitChoice[] = [
  { label: 'Fit width', value: 'page-width' },
  { label: 'Fit page', value: 'page-fit' },
  { label: 'Fit height', value: 'page-height' },
];

const LAYOUT_CHOICES: readonly LayoutChoice[] = [
  {
    icon: 'rows-3',
    label: 'Single page · Continuous',
    value: { pages: 'single', scrolling: 'continuous' },
  },
  {
    icon: 'rectangle-horizontal',
    label: 'Single page · Paged',
    value: { pages: 'single', scrolling: 'page-by-page' },
  },
  {
    icon: 'layout-grid',
    label: 'Two pages · Continuous',
    value: { pages: 'facing', scrolling: 'continuous' },
  },
  {
    icon: 'columns-2',
    label: 'Two pages · Paged',
    value: { pages: 'facing', scrolling: 'page-by-page' },
  },
];

const COMPACT_TOOLBAR_WIDTH = 760;

export class ReaderToolbar {
  readonly annotationHost: HTMLElement;
  readonly root: HTMLElement;
  readonly sidebarButton: HTMLButtonElement;

  private readonly cleanups: Array<() => void> = [];
  private readonly focusFrames = new Set<number>();
  private readonly menus = new Set<Menu>();
  private readonly nextButton: HTMLButtonElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly zoomLevel: HTMLOutputElement;
  private currentLayout: ReaderLayout = DEFAULT_READER_LAYOUT;
  private currentPageIndex = 0;
  private currentProfile: ReadingProfileId = 'default';
  private currentScale: ReaderScale = 'page-width';
  private destroyed = false;
  private pageCount = 0;

  constructor(
    host: HTMLElement,
    private readonly onIntent: (intent: ReaderToolbarIntent) => void,
  ) {
    this.root = host;
    this.root.addClass('abyss-reader-toolbar');

    this.sidebarButton = this.iconButton('sidebar', 'Toggle sidebar', 'panel-left');
    this.sidebarButton.setAttribute('aria-pressed', 'false');
    this.listen(this.sidebarButton, 'click', () => {
      this.onIntent({ type: 'toggle-sidebar' });
    });

    const navigation = this.root.createDiv({ cls: 'abyss-reader-toolbar-navigation' });
    this.previousButton = this.iconButton(
      'previous-page',
      'Previous page',
      'chevron-left',
      navigation,
    );
    this.listen(this.previousButton, 'click', () => {
      this.onIntent({ type: 'previous-page' });
    });

    this.pageInput = navigation.createEl('input', {
      cls: 'abyss-reader-toolbar-page-field',
      attr: {
        'aria-label': 'Current page',
        'data-control': 'page-field',
        inputmode: 'numeric',
        min: '1',
        step: '1',
      },
      type: 'number',
    });
    this.listen(this.pageInput, 'keydown', (event) => {
      this.onPageKeyDown(event);
    });

    this.pageTotal = navigation.createSpan({
      cls: 'abyss-reader-toolbar-page-total',
      attr: { 'aria-label': 'Total pages', 'data-control': 'page-total' },
    });
    this.nextButton = this.iconButton('next-page', 'Next page', 'chevron-right', navigation);
    this.listen(this.nextButton, 'click', () => {
      this.onIntent({ type: 'next-page' });
    });

    this.root.createDiv({ cls: 'abyss-reader-toolbar-spacer' });
    const zoom = this.root.createDiv({ cls: 'abyss-reader-toolbar-zoom' });
    const zoomOut = this.iconButton('zoom-out', 'Zoom out', 'minus', zoom);
    this.listen(zoomOut, 'click', () => {
      this.onIntent({ type: 'zoom-step', direction: -1 });
    });
    this.zoomLevel = zoom.createEl('output', {
      cls: 'abyss-reader-toolbar-zoom-level',
      attr: { 'aria-label': 'Zoom: Fit width', 'data-control': 'zoom-level' },
      text: 'Width',
    });
    const zoomIn = this.iconButton('zoom-in', 'Zoom in', 'plus', zoom);
    this.listen(zoomIn, 'click', () => {
      this.onIntent({ type: 'zoom-step', direction: 1 });
    });
    this.createFitControl();

    this.annotationHost = this.root.createDiv({ cls: 'abyss-reader-toolbar-annotations' });

    const overflow = this.iconButton('overflow', 'More options', 'ellipsis');
    overflow.setAttribute('aria-haspopup', 'menu');
    overflow.setAttribute('aria-expanded', 'false');
    this.bindMenuTrigger(overflow, () => {
      this.showMenuAtButton(overflow, (menu) => {
        this.addOverflowChoices(menu);
      });
    });
    this.refreshPageState();
  }

  setPageCount(pageCount: number): void {
    this.pageCount = Number.isFinite(pageCount) ? Math.max(0, Math.floor(pageCount)) : 0;
    this.currentPageIndex = this.clampPageIndex(this.currentPageIndex);
    this.refreshPageState();
  }

  setCurrentPage(pageIndex: number): void {
    this.currentPageIndex = this.clampPageIndex(pageIndex);
    this.refreshPageState();
  }

  setProfile(profile: ReadingProfileId): void {
    this.currentProfile = profile;
  }

  setScale(scale: ReaderScale): void {
    this.currentScale = scale;
    const state = scaleLabel(scale);
    this.zoomLevel.textContent = state.short;
    this.zoomLevel.setAttribute('aria-label', `Zoom: ${state.long}`);
  }

  setLayout(layout: ReaderLayout): void {
    this.currentLayout = { ...layout };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const menu of [...this.menus]) menu.close();
    this.menus.clear();
    for (const frame of this.focusFrames) this.root.win.cancelAnimationFrame(frame);
    this.focusFrames.clear();
  }

  private createFitControl(): void {
    const split = this.root.createDiv({
      cls: ['abyss-reader-split-control', 'abyss-reader-fit-control'],
      attr: { 'aria-label': 'Fit document', 'data-control-group': 'fit', role: 'group' },
    });
    const fit = this.iconButton('fit', 'Fit width', 'scan-line', split);
    fit.addClass('abyss-reader-split-main');
    this.listen(fit, 'click', () => {
      this.onIntent({ type: 'set-scale', scale: 'page-width' });
    });
    this.listen(fit, 'keydown', (event) => {
      if (event.key !== 'F10' || !event.shiftKey) return;
      event.preventDefault();
      this.showMenuAtButton(fit, (menu) => {
        this.addFitChoices(menu);
      });
    });
    this.listen(fit, 'contextmenu', (event) => {
      event.preventDefault();
      this.showMenuAtEvent(fit, event, (menu) => {
        this.addFitChoices(menu);
      });
    });

    const fitMenu = this.iconButton('fit-menu', 'Fit options', 'chevron-down', split);
    fitMenu.addClass('abyss-reader-split-menu');
    fitMenu.setAttribute('aria-haspopup', 'menu');
    fitMenu.setAttribute('aria-expanded', 'false');
    this.bindMenuTrigger(fitMenu, () => {
      this.showMenuAtButton(fitMenu, (menu) => {
        this.addFitChoices(menu);
      });
    });
  }

  private iconButton(
    control: string,
    label: string,
    icon: IconName,
    parent: HTMLElement = this.root,
  ): HTMLButtonElement {
    return createIconButton(parent, {
      classes: ['abyss-reader-toolbar-button'],
      control,
      icon,
      label,
    });
  }

  private listen<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    element.addEventListener(type, listener);
    this.cleanups.push(() => {
      element.removeEventListener(type, listener);
    });
  }

  private onPageKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.restorePageField();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = this.pageInput.value.trim();
    if (!/^\d+$/u.test(value) || this.pageCount === 0) {
      this.restorePageField();
      return;
    }
    const pageNumber = Number(value);
    if (!Number.isSafeInteger(pageNumber)) {
      this.restorePageField();
      return;
    }
    const pageIndex = Math.min(this.pageCount - 1, Math.max(0, pageNumber - 1));
    this.pageInput.value = String(pageIndex + 1);
    this.onIntent({ type: 'go-to-page', pageIndex });
  }

  private restorePageField(): void {
    this.pageInput.value = this.pageCount === 0 ? '' : String(this.currentPageIndex + 1);
  }

  private refreshPageState(): void {
    this.restorePageField();
    this.pageInput.disabled = this.pageCount === 0;
    this.pageInput.max = String(this.pageCount);
    this.pageTotal.textContent = `/ ${this.pageCount}`;
    this.previousButton.disabled = this.pageCount === 0 || this.currentPageIndex === 0;
    this.nextButton.disabled = this.pageCount === 0 || this.currentPageIndex >= this.pageCount - 1;
  }

  private clampPageIndex(pageIndex: number): number {
    if (this.pageCount === 0 || !Number.isFinite(pageIndex)) return 0;
    return Math.min(this.pageCount - 1, Math.max(0, Math.floor(pageIndex)));
  }

  private addFitChoices(menu: Menu): void {
    for (const choice of FIT_CHOICES) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setChecked(choice.value === this.currentScale)
          .onClick(() => {
            this.onIntent({ type: 'set-scale', scale: choice.value });
          });
      });
    }
  }

  private addOverflowChoices(menu: Menu): void {
    if (this.isCompact()) {
      menu.addItem((item) =>
        item.setTitle(`Zoom · ${scaleLabel(this.currentScale).long}`).setIsLabel(true),
      );
      menu.addItem((item) => {
        item
          .setTitle('Zoom out')
          .setIcon('minus')
          .onClick(() => {
            this.onIntent({ type: 'zoom-step', direction: -1 });
          });
      });
      menu.addItem((item) => {
        item
          .setTitle('Reset zoom')
          .setIcon('rotate-ccw')
          .setChecked(this.currentScale === 1)
          .onClick(() => {
            this.onIntent({ type: 'set-scale', scale: 1 });
          });
      });
      menu.addItem((item) => {
        item
          .setTitle('Zoom in')
          .setIcon('plus')
          .onClick(() => {
            this.onIntent({ type: 'zoom-step', direction: 1 });
          });
      });
      menu.addItem((item) => item.setTitle('Fit').setIsLabel(true));
      this.addFitChoices(menu);
      menu.addSeparator();
    }
    menu.addItem((item) => item.setTitle('Layout').setIsLabel(true));
    for (const choice of LAYOUT_CHOICES) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setIcon(choice.icon)
          .setChecked(sameLayout(choice.value, this.currentLayout))
          .onClick(() => {
            this.onIntent({ type: 'set-layout', layout: choice.value });
          });
      });
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Appearance').setIsLabel(true));
    for (const choice of PROFILE_CHOICES) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setChecked(choice.id === this.currentProfile)
          .onClick(() => {
            this.onIntent({ type: 'set-profile', profile: choice.id });
          });
      });
    }
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle('Export annotations…')
        .setIcon('download')
        .onClick(() => {
          this.onIntent({ type: 'export-annotations' });
        });
    });
  }

  private showMenuAtButton(trigger: HTMLButtonElement, populate: (menu: Menu) => void): void {
    const menu = this.createMenu(trigger);
    populate(menu);
    const bounds = trigger.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, this.root.doc);
  }

  private showMenuAtEvent(
    trigger: HTMLButtonElement,
    event: MouseEvent,
    populate: (menu: Menu) => void,
  ): void {
    const menu = this.createMenu(trigger);
    populate(menu);
    menu.showAtMouseEvent(event);
  }

  private createMenu(trigger: HTMLButtonElement): Menu {
    for (const open of [...this.menus]) open.close();
    const menu = new Menu();
    menu.setUseNativeMenu(false);
    this.menus.add(menu);
    trigger.setAttribute('aria-expanded', 'true');
    menu.onHide(() => {
      this.menus.delete(menu);
      trigger.setAttribute('aria-expanded', 'false');
      this.restoreMenuTriggerFocus(trigger);
    });
    return menu;
  }

  private restoreMenuTriggerFocus(trigger: HTMLButtonElement): void {
    const frame = this.root.win.requestAnimationFrame(() => {
      this.focusFrames.delete(frame);
      if (
        !this.destroyed &&
        this.menus.size === 0 &&
        trigger.isConnected &&
        shouldRestoreMenuTriggerFocus(trigger)
      ) {
        trigger.focus();
      }
    });
    this.focusFrames.add(frame);
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

  private isCompact(): boolean {
    const width = this.root.getBoundingClientRect().width;
    return width > 0 && width <= COMPACT_TOOLBAR_WIDTH;
  }
}

function scaleLabel(scale: ReaderScale): { readonly long: string; readonly short: string } {
  if (typeof scale === 'number') {
    const percentage = `${Math.round(scale * 100)}%`;
    return { long: percentage, short: percentage };
  }
  if (scale === 'page-fit') return { long: 'Fit page', short: 'Page' };
  if (scale === 'page-height') return { long: 'Fit height', short: 'Height' };
  return { long: 'Fit width', short: 'Width' };
}

function sameLayout(left: ReaderLayout, right: ReaderLayout): boolean {
  return left.pages === right.pages && left.scrolling === right.scrolling;
}
