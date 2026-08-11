import { Menu, Platform, setIcon, type IconName } from 'obsidian';
import type { ReadingProfileId } from '../document-core/reading.js';

export type ReaderToolbarIntent =
  | { readonly type: 'toggle-sidebar' }
  | { readonly type: 'go-to-page'; readonly pageIndex: number }
  | { readonly type: 'previous-page' }
  | { readonly type: 'next-page' }
  | {
      readonly type: 'set-scale';
      readonly scale: ReaderScale;
    }
  | { readonly type: 'set-profile'; readonly profile: ReadingProfileId };

export type ReaderScale = number | 'page-width' | 'page-fit';

interface ReaderToolbarOptions {
  readonly mobile?: boolean;
}

interface ProfileChoice {
  readonly id: ReadingProfileId;
  readonly label: string;
}

interface ScaleChoice {
  readonly label: string;
  readonly value: ReaderScale;
}

const PROFILE_CHOICES: readonly ProfileChoice[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' },
  { id: 'custom', label: 'Custom' },
];

const SCALE_CHOICES: readonly ScaleChoice[] = [
  { label: 'Fit width', value: 'page-width' },
  { label: 'Fit page', value: 'page-fit' },
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2 },
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
  private readonly profileButton: HTMLButtonElement | null;
  private pageCount = 0;
  private currentPageIndex = 0;
  private currentProfile: ReadingProfileId = 'auto';
  private currentScale: ReaderScale = 'page-width';
  private destroyed = false;

  constructor(
    host: HTMLElement,
    private readonly onIntent: (intent: ReaderToolbarIntent) => void,
    options: ReaderToolbarOptions = {},
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
    const selection = this.iconButton('selection', 'Selection mode', 'mouse-pointer-2');
    selection.setAttribute('aria-pressed', 'true');

    const mobile = options.mobile ?? Platform.isMobile;
    this.profileButton = mobile
      ? null
      : this.iconButton('profile', 'Reading profile: Auto', 'sun-moon');
    if (this.profileButton !== null) {
      this.profileButton.addClass('abyss-reader-toolbar-desktop-profile');
      this.listen(this.profileButton, 'click', (event) => {
        this.showProfileMenu(event);
      });
    }

    const overflow = this.iconButton('overflow', 'More options', 'more-horizontal');
    this.listen(overflow, 'click', (event) => {
      this.showOverflowMenu(event);
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
    if (this.profileButton !== null) {
      const label = `Reading profile: ${profileLabel(profile)}`;
      this.profileButton.setAttribute('aria-label', label);
      this.profileButton.title = label;
    }
  }

  setScale(scale: ReaderScale): void {
    this.currentScale = scale;
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

  private showOverflowMenu(event: MouseEvent): void {
    const menu = this.createMenu();
    for (const choice of SCALE_CHOICES) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setChecked(choice.value === this.currentScale)
          .onClick(() => {
            this.onIntent({ type: 'set-scale', scale: choice.value });
          });
      });
    }
    menu.addSeparator();
    this.addProfileChoices(menu);
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
    menu.setParentElement(this.root);
    menu.onHide(() => {
      this.menus.delete(menu);
    });
    return menu;
  }
}

function profileLabel(profile: ReadingProfileId): string {
  return PROFILE_CHOICES.find((choice) => choice.id === profile)?.label ?? 'Auto';
}
