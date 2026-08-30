import { Menu, type IconName } from 'obsidian';
import {
  DEFAULT_READER_LAYOUT,
  type ReaderLayout,
  type ReaderScale,
  type ReadingProfileId,
} from '../document-core/reading.js';
import { createIconButton } from './icon-button.js';
import { markReaderMenuClosing, shouldRestoreMenuTriggerFocus } from './menu-focus.js';

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

interface ActiveMenu {
  readonly menu: Menu;
  readonly trigger: HTMLButtonElement;
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

const COMPACT_TOOLBAR_WIDTH = 760;
const LONG_PRESS_DELAY_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

function isLongPressPointer(event: PointerEvent): boolean {
  return event.pointerType !== 'mouse' && event.isPrimary && event.button === 0;
}

/** @internal Shared gesture state for the reader toolbar's split controls. */
export class LongPressMenuGesture {
  private clickSuppressionTimer: number | null = null;
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private suppressClick = false;
  private timer: number | null = null;

  constructor(
    private readonly trigger: HTMLElement,
    private readonly ownerWindow: Window,
    private readonly show: () => void,
  ) {}

  readonly onPointerDown = (event: PointerEvent): void => {
    if (!isLongPressPointer(event)) return;
    this.clearTimer();
    this.pointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.clearClickSuppression();
    if (typeof this.trigger.setPointerCapture === 'function')
      this.trigger.setPointerCapture(this.pointerId);
    this.timer = this.ownerWindow.setTimeout(() => {
      this.timer = null;
      if (this.pointerId === null) return;
      this.suppressClick = true;
      this.show();
    }, LONG_PRESS_DELAY_MS);
  };

  readonly onPointerMove = (event: PointerEvent): void => {
    if (
      event.pointerId !== this.pointerId ||
      Math.hypot(event.clientX - this.startX, event.clientY - this.startY) <=
        LONG_PRESS_MOVE_TOLERANCE
    )
      return;
    this.clearTimer();
  };

  readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.clearTimer();
    this.releasePointer();
    if (!this.suppressClick) return;
    event.preventDefault();
    this.scheduleClickSuppressionCleanup();
  };

  readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.clearTimer();
    this.releasePointer();
    if (this.suppressClick) this.scheduleClickSuppressionCleanup();
    else this.clearClickSuppression();
  };

  consumeClick(): boolean {
    if (!this.suppressClick) return false;
    this.clearClickSuppression();
    return true;
  }

  handleContextMenu(event: MouseEvent, showContextMenu: () => void): boolean {
    if (this.pointerId === null && !this.suppressClick) return false;
    event.preventDefault();
    event.stopPropagation();
    this.clearTimer();
    if (!this.suppressClick) {
      this.suppressClick = true;
      showContextMenu();
    }
    return true;
  }

  destroy(): void {
    this.clearTimer();
    this.clearClickSuppression();
    this.releasePointer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.ownerWindow.clearTimeout(this.timer);
    this.timer = null;
  }

  private clearClickSuppression(): void {
    if (this.clickSuppressionTimer !== null) {
      this.ownerWindow.clearTimeout(this.clickSuppressionTimer);
      this.clickSuppressionTimer = null;
    }
    this.suppressClick = false;
  }

  private scheduleClickSuppressionCleanup(): void {
    if (!this.suppressClick) return;
    if (this.clickSuppressionTimer !== null)
      this.ownerWindow.clearTimeout(this.clickSuppressionTimer);
    this.clickSuppressionTimer = this.ownerWindow.setTimeout(() => {
      this.clickSuppressionTimer = null;
      this.suppressClick = false;
    }, 1_000);
  }

  private releasePointer(): void {
    const releasedPointerId = this.pointerId;
    this.pointerId = null;
    releaseCapturedPointer(this.trigger, releasedPointerId);
  }
}

function releaseCapturedPointer(trigger: HTMLElement, pointerId: number | null): void {
  if (
    pointerId !== null &&
    typeof trigger.hasPointerCapture === 'function' &&
    trigger.hasPointerCapture(pointerId)
  ) {
    trigger.releasePointerCapture(pointerId);
  }
}

export class ReaderToolbar {
  readonly annotationHost: HTMLElement;
  readonly root: HTMLElement;
  readonly sidebarButton: HTMLButtonElement;

  private readonly cleanups: Array<() => void> = [];
  private readonly focusFrames = new Set<number>();
  private readonly nextButton: HTMLButtonElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private activeMenu: ActiveMenu | null = null;
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
    const left = this.root.createDiv({
      cls: 'abyss-reader-toolbar-zone',
      attr: { 'data-toolbar-zone': 'left' },
    });
    const center = this.root.createDiv({
      cls: 'abyss-reader-toolbar-zone',
      attr: { 'data-toolbar-zone': 'center' },
    });
    const right = this.root.createDiv({
      cls: 'abyss-reader-toolbar-zone',
      attr: { 'data-toolbar-zone': 'right' },
    });

    this.sidebarButton = this.iconButton('sidebar', 'Toggle sidebar', 'panel-left', left);
    this.sidebarButton.setAttribute('aria-pressed', 'false');
    this.listen(this.sidebarButton, 'click', () => {
      this.onIntent({ type: 'toggle-sidebar' });
    });

    const navigation = center.createDiv({ cls: 'abyss-reader-toolbar-navigation' });
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
    this.listen(this.pageInput, 'blur', () => {
      this.restorePageField();
    });

    this.pageTotal = navigation.createSpan({
      cls: 'abyss-reader-toolbar-page-total',
      attr: { 'aria-label': 'Total pages', 'data-control': 'page-total' },
    });
    this.nextButton = this.iconButton('next-page', 'Next page', 'chevron-right', navigation);
    this.listen(this.nextButton, 'click', () => {
      this.onIntent({ type: 'next-page' });
    });

    const zoom = left.createDiv({ cls: 'abyss-reader-toolbar-zoom' });
    const zoomOut = this.iconButton('zoom-out', 'Zoom out', 'minus', zoom);
    this.listen(zoomOut, 'click', () => {
      this.onIntent({ type: 'zoom-step', direction: -1 });
    });
    this.createFitControl(zoom);
    const zoomIn = this.iconButton('zoom-in', 'Zoom in', 'plus', zoom);
    this.listen(zoomIn, 'click', () => {
      this.onIntent({ type: 'zoom-step', direction: 1 });
    });

    this.annotationHost = right.createDiv({ cls: 'abyss-reader-toolbar-annotations' });

    const overflow = this.iconButton('overflow', 'More options', 'ellipsis', right);
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
  }

  setLayout(layout: ReaderLayout): void {
    this.currentLayout = { ...layout };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.activeMenu?.menu.close();
    this.activeMenu = null;
    for (const frame of this.focusFrames) this.root.win.cancelAnimationFrame(frame);
    this.focusFrames.clear();
  }

  private createFitControl(parent: HTMLElement): void {
    const split = parent.createDiv({
      cls: ['abyss-reader-split-control', 'abyss-reader-fit-control'],
      attr: {
        'aria-label': 'Fit width — more fit options',
        'data-control-group': 'fit',
        role: 'group',
      },
    });
    const fit = this.iconButton('fit', 'Fit width — more fit options', 'scan-line', split);
    fit.addClass('abyss-reader-split-main');
    fit.setAttribute('aria-haspopup', 'menu');
    fit.setAttribute('aria-expanded', 'false');
    const showFitMenu = (): void => {
      this.showMenuAtButton(fit, (menu) => {
        this.addFitChoices(menu);
      });
    };
    const longPress = this.bindLongPressMenuTrigger(fit, showFitMenu);
    this.listen(fit, 'click', (event) => {
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
      this.onIntent({ type: 'set-scale', scale: 'page-width' });
    });
    this.listen(fit, 'keydown', (event) => {
      const opensFitMenu = event.key === 'ArrowDown' || (event.key === 'F10' && event.shiftKey);
      if (!opensFitMenu) return;
      event.preventDefault();
      showFitMenu();
    });
    this.listen(fit, 'contextmenu', (event) => {
      if (
        longPress.handleContextMenu(event, () => {
          this.showMenuAtEvent(fit, event, (menu) => {
            this.addFitChoices(menu);
          });
        })
      )
        return;
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
    if (this.isCompact()) this.addCompactZoomChoices(menu);
    if (this.isNarrowAnnotationToolbar()) this.addCompactAnnotationChoices(menu);
    this.addLayoutChoices(menu);
    menu.addSeparator();
    this.addAppearanceChoices(menu);
    menu.addSeparator();
    this.addExportChoice(menu);
  }

  private addCompactAnnotationChoices(menu: Menu): void {
    const annotationToolbar = this.annotationHost.querySelector<HTMLElement>(
      '[data-region="annotation-toolbar"]',
    );
    if (annotationToolbar === null) return;
    const visibleTool =
      annotationToolbar.dataset['annotationMode'] === 'select'
        ? 'highlight'
        : annotationToolbar.querySelector<HTMLElement>(
            '[data-annotation-tool][aria-pressed="true"]',
          )?.dataset['annotationTool'];
    const choices = [
      { icon: 'highlighter' as const, label: 'Sticky Highlight', tool: 'highlight' },
      { icon: 'pen-tool' as const, label: 'Ink', tool: 'ink' },
      { icon: 'type' as const, label: 'Text', tool: 'freetext' },
    ];
    const hidden = choices.flatMap((choice) => {
      const button = annotationToolbar.querySelector<HTMLButtonElement>(
        `[data-annotation-tool="${choice.tool}"]`,
      );
      return button === null || button.disabled || choice.tool === visibleTool
        ? []
        : [{ ...choice, button }];
    });
    if (hidden.length === 0) return;
    menu.addItem((item) =>
      item.setTitle('Tools').setIsLabel(true).setSection('abyss-documents-tools'),
    );
    for (const choice of hidden) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setIcon(choice.icon)
          .setSection('abyss-documents-tools')
          .onClick(() => {
            choice.button.click();
          });
      });
    }
    menu.addSeparator();
  }

  private addCompactZoomChoices(menu: Menu): void {
    menu.addItem((item) =>
      item.setTitle(`Zoom · ${scaleLabel(this.currentScale)}`).setIsLabel(true),
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

  private addLayoutChoices(menu: Menu): void {
    menu.addItem((item) =>
      item.setTitle('Layout').setIsLabel(true).setSection('abyss-documents-layout'),
    );
    menu.addItem((item) => {
      item
        .setTitle('Single page')
        .setSection('abyss-documents-layout')
        .setChecked(this.currentLayout.pages === 'single')
        .onClick(() => {
          this.onIntent({
            type: 'set-layout',
            layout: { ...this.currentLayout, pages: 'single' },
          });
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('Two pages')
        .setSection('abyss-documents-layout')
        .setChecked(this.currentLayout.pages === 'facing')
        .onClick(() => {
          this.onIntent({
            type: 'set-layout',
            layout: { ...this.currentLayout, pages: 'facing' },
          });
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('Continuous scrolling')
        .setSection('abyss-documents-layout')
        .setChecked(this.currentLayout.scrolling === 'continuous')
        .onClick(() => {
          this.onIntent({
            type: 'set-layout',
            layout: {
              ...this.currentLayout,
              scrolling:
                this.currentLayout.scrolling === 'continuous' ? 'page-by-page' : 'continuous',
            },
          });
        });
    });
  }

  private addAppearanceChoices(menu: Menu): void {
    menu.addItem((item) =>
      item.setTitle('Appearance').setIsLabel(true).setSection('abyss-documents-appearance'),
    );
    for (const choice of PROFILE_CHOICES) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setSection('abyss-documents-appearance')
          .setChecked(choice.id === this.currentProfile)
          .onClick(() => {
            this.onIntent({ type: 'set-profile', profile: choice.id });
          });
      });
    }
  }

  private addExportChoice(menu: Menu): void {
    menu.addItem((item) => {
      item
        .setTitle('Export annotations…')
        .setIcon('download')
        .setSection('abyss-documents-actions')
        .onClick(() => {
          this.onIntent({ type: 'export-annotations' });
        });
    });
  }

  private showMenuAtButton(trigger: HTMLButtonElement, populate: (menu: Menu) => void): void {
    const menu = this.createMenu(trigger);
    if (menu === null) return;
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
    if (menu === null) return;
    populate(menu);
    menu.showAtMouseEvent(event);
  }

  private createMenu(trigger: HTMLButtonElement): Menu | null {
    if (this.activeMenu?.trigger === trigger) {
      this.activeMenu.menu.close();
      return null;
    }
    this.activeMenu?.menu.close();
    const menu = new Menu();
    menu.setUseNativeMenu(false);
    menu.setParentElement(trigger);
    this.activeMenu = { menu, trigger };
    trigger.setAttribute('aria-expanded', 'true');
    menu.onHide(() => {
      markReaderMenuClosing(trigger);
      if (this.activeMenu?.menu === menu) this.activeMenu = null;
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
        this.activeMenu === null &&
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

  private isCompact(): boolean {
    const width = this.root.getBoundingClientRect().width;
    return width > 0 && width <= COMPACT_TOOLBAR_WIDTH;
  }

  private isNarrowAnnotationToolbar(): boolean {
    const width = this.root.getBoundingClientRect().width;
    return (
      (width > 0 && width <= 600) ||
      (typeof this.root.win.matchMedia === 'function' &&
        this.root.win.matchMedia('(pointer: coarse)').matches)
    );
  }
}

function scaleLabel(scale: ReaderScale): string {
  if (typeof scale === 'number') {
    return `${Math.round(scale * 100)}%`;
  }
  if (scale === 'page-fit') return 'Fit page';
  if (scale === 'page-height') return 'Fit height';
  return 'Fit width';
}
