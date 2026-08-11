import { Menu, setIcon, type IconName } from 'obsidian';
import {
  DEFAULT_READER_LAYOUT,
  type ReaderLayout,
  type ReaderScale,
  type ReadingProfileId,
} from '../document-core/reading.js';

export type ReaderToolbarIntent =
  | { readonly type: 'toggle-sidebar' }
  | { readonly type: 'go-to-page'; readonly pageIndex: number }
  | { readonly type: 'previous-page' }
  | { readonly type: 'next-page' }
  | { readonly type: 'zoom-step'; readonly direction: -1 | 1 }
  | {
      readonly type: 'set-scale';
      readonly scale: ReaderScale;
    }
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

export class ReaderToolbar {
  readonly root: HTMLElement;
  readonly sidebarButton: HTMLButtonElement;

  private readonly cleanups: Array<() => void> = [];
  private readonly menus = new Set<Menu>();
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly profileButton: HTMLButtonElement;
  private readonly layoutButton: HTMLButtonElement;
  private pageCount = 0;
  private currentPageIndex = 0;
  private currentProfile: ReadingProfileId = 'default';
  private currentScale: ReaderScale = 'page-width';
  private currentLayout: ReaderLayout = DEFAULT_READER_LAYOUT;
  private destroyed = false;

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
    this.createZoomControls();

    this.layoutButton = this.iconButton(
      'layout',
      layoutLabel(this.currentLayout),
      layoutIcon(this.currentLayout),
    );
    this.listen(this.layoutButton, 'click', (event) => {
      this.showLayoutMenu(event);
    });

    this.profileButton = this.iconButton('profile', 'Reading profile: Default', 'sun-moon');
    this.listen(this.profileButton, 'click', (event) => {
      this.showProfileMenu(event);
    });
    this.refreshPageState();
  }

  private createZoomControls(): void {
    const zoom = this.root.createDiv({ cls: 'abyss-reader-toolbar-zoom' });
    const zoomOut = this.iconButton('zoom-out', 'Zoom out', 'minus', zoom);
    zoomOut.addClass('abyss-reader-toolbar-zoom-button');
    this.listen(zoomOut, 'click', () => {
      this.onIntent({ type: 'zoom-step', direction: -1 });
    });
    const fit = this.iconButton('fit', 'Fit width', 'maximize-2', zoom);
    fit.addClass('abyss-reader-toolbar-zoom-button');
    this.listen(fit, 'click', () => {
      this.onIntent({ type: 'set-scale', scale: 'page-width' });
    });
    this.listen(fit, 'keydown', (event) => {
      if (event.key !== 'F10' || !event.shiftKey) return;
      event.preventDefault();
      this.showFitMenuAtButton(fit);
    });
    this.listen(fit, 'contextmenu', (event) => {
      event.preventDefault();
      this.showFitMenu(event);
    });
    const zoomIn = this.iconButton('zoom-in', 'Zoom in', 'plus', zoom);
    zoomIn.addClass('abyss-reader-toolbar-zoom-button');
    this.listen(zoomIn, 'click', () => {
      this.onIntent({ type: 'zoom-step', direction: 1 });
    });
    const fitMenu = this.iconButton('fit-menu', 'Fit options', 'chevron-down', zoom);
    fitMenu.addClass('abyss-reader-toolbar-zoom-button');
    fitMenu.setAttribute('aria-haspopup', 'menu');
    this.listen(fitMenu, 'click', (event) => {
      this.showFitMenu(event);
    });
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
    const label = `Reading profile: ${profileLabel(profile)}`;
    this.profileButton.setAttribute('aria-label', label);
    this.profileButton.title = label;
  }

  setScale(scale: ReaderScale): void {
    this.currentScale = scale;
  }

  setLayout(layout: ReaderLayout): void {
    this.currentLayout = layout;
    const label = layoutLabel(layout);
    this.layoutButton.setAttribute('aria-label', label);
    this.layoutButton.title = label;
    this.layoutButton.dataset['layoutIcon'] = layoutIcon(layout);
    setIcon(this.layoutButton, layoutIcon(layout));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const menu of [...this.menus]) menu.close();
    this.menus.clear();
  }

  private iconButton(
    control: string,
    label: string,
    icon: IconName,
    parent: HTMLElement = this.root,
  ): HTMLButtonElement {
    const button = parent.createEl('button', {
      cls: ['clickable-icon', 'abyss-reader-toolbar-button'],
      attr: {
        'aria-label': label,
        'data-control': control,
        'data-toolbar-control': '',
        title: label,
      },
      type: 'button',
    });
    setIcon(button, icon);
    return button;
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

  private showProfileMenu(event: MouseEvent): void {
    const menu = this.createMenu();
    this.addProfileChoices(menu);
    menu.showAtMouseEvent(event);
  }

  private showFitMenu(event: MouseEvent): void {
    const menu = this.createMenu();
    this.addFitChoices(menu);
    menu.showAtMouseEvent(event);
  }

  private showFitMenuAtButton(button: HTMLButtonElement): void {
    const menu = this.createMenu();
    this.addFitChoices(menu);
    const bounds = button.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, this.root.doc);
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

  private showLayoutMenu(event: MouseEvent): void {
    const menu = this.createMenu();
    menu.addItem((item) => item.setTitle('Pages').setDisabled(true));
    for (const pages of ['single', 'facing'] as const) {
      menu.addItem((item) => {
        item
          .setTitle(pages === 'single' ? 'Single' : 'Facing')
          .setChecked(pages === this.currentLayout.pages)
          .onClick(() => {
            this.onIntent({ type: 'set-layout', layout: { ...this.currentLayout, pages } });
          });
      });
    }
    menu.addItem((item) => item.setTitle('Scrolling').setDisabled(true));
    for (const scrolling of ['continuous', 'page-by-page'] as const) {
      menu.addItem((item) => {
        item
          .setTitle(scrolling === 'continuous' ? 'Continuous' : 'Page by page')
          .setChecked(scrolling === this.currentLayout.scrolling)
          .onClick(() => {
            this.onIntent({ type: 'set-layout', layout: { ...this.currentLayout, scrolling } });
          });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private addProfileChoices(menu: Menu): void {
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
  }

  private createMenu(): Menu {
    const menu = new Menu();
    menu.setUseNativeMenu(false);
    this.menus.add(menu);
    menu.onHide(() => {
      this.menus.delete(menu);
    });
    return menu;
  }
}

function profileLabel(profile: ReadingProfileId): string {
  return PROFILE_CHOICES.find((choice) => choice.id === profile)?.label ?? 'Default';
}

function layoutLabel(layout: ReaderLayout): string {
  const pages = layout.pages === 'facing' ? 'Facing' : 'Single';
  const scrolling = layout.scrolling === 'page-by-page' ? 'page by page' : 'continuous';
  return `Layout: ${pages}, ${scrolling}`;
}

function layoutIcon(layout: ReaderLayout): IconName {
  return layout.pages === 'facing' ? 'columns-2' : 'rectangle-horizontal';
}
