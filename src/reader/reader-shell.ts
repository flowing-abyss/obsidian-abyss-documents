import type { ObsidianTheme } from './reading-profiles.js';
import { ReaderSidebar, type ReaderSidebarCallbacks, type ReaderSidebarTab } from './sidebar.js';
import { ReaderToolbar, type ReaderToolbarIntent } from './toolbar.js';

export type ReaderShellIntent =
  ReaderToolbarIntent | { readonly type: 'open-sidebar'; readonly tab: ReaderSidebarTab };

export class ReaderShell {
  readonly root: HTMLElement;
  readonly documentHost: HTMLElement;
  readonly toolbar: ReaderToolbar;

  private readonly cleanups: Array<() => void> = [];
  private readonly body: HTMLElement;
  private sidebarValue: ReaderSidebar | null = null;
  private destroyed = false;

  constructor(host: HTMLElement, onIntent: (intent: ReaderShellIntent) => void = () => undefined) {
    this.root = host.createDiv({ cls: 'abyss-documents' });

    const toolbarHost = this.root.createDiv({
      attr: {
        'aria-label': 'Document controls',
        'data-region': 'toolbar',
        role: 'toolbar',
      },
    });
    this.toolbar = new ReaderToolbar(toolbarHost, onIntent);

    this.body = this.root.createDiv({ cls: 'abyss-reader-body' });
    this.documentHost = this.body.createDiv({ attr: { 'data-region': 'document' } });
    this.documentHost.tabIndex = -1;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key.toLocaleLowerCase() !== 'f' ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onIntent({ type: 'open-sidebar', tab: 'search' });
    };
    this.root.addEventListener('keydown', onKeyDown);
    this.cleanups.push(() => {
      this.root.removeEventListener('keydown', onKeyDown);
    });
  }

  get sidebar(): ReaderSidebar | null {
    return this.sidebarValue;
  }

  get obsidianTheme(): ObsidianTheme {
    return this.root.doc.body.hasClass('theme-dark') ? 'dark' : 'light';
  }

  onThemeChange(listener: (theme: ObsidianTheme) => void): () => void {
    if (this.destroyed) return () => undefined;
    let theme = this.obsidianTheme;
    const OwnerMutationObserver = (
      this.root.win as Window & { MutationObserver: typeof MutationObserver }
    ).MutationObserver;
    const observer = new OwnerMutationObserver(() => {
      const nextTheme = this.obsidianTheme;
      if (nextTheme === theme) return;
      theme = nextTheme;
      listener(theme);
    });
    const options: MutationObserverInit = { attributeFilter: ['class'], attributes: true };
    observer.observe(this.root.doc.body, options);
    observer.observe(this.root.doc.documentElement, options);
    const cleanup = (): void => {
      observer.disconnect();
      const index = this.cleanups.indexOf(cleanup);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
    this.cleanups.push(cleanup);
    return cleanup;
  }

  openSidebar(tab: ReaderSidebarTab, callbacks: ReaderSidebarCallbacks): ReaderSidebar {
    this.sidebarValue ??= new ReaderSidebar(this.body, {
      ...callbacks,
      onClose: () => {
        this.setSidebarPressed(false);
        callbacks.onClose();
      },
    });
    this.sidebarValue.open(tab);
    this.setSidebarPressed(true);
    return this.sidebarValue;
  }

  closeSidebar(): void {
    this.sidebarValue?.close();
    this.setSidebarPressed(false);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.sidebarValue?.destroy();
    this.sidebarValue = null;
    this.toolbar.destroy();
    this.root.remove();
  }

  private setSidebarPressed(pressed: boolean): void {
    this.root
      .querySelector('[data-control="sidebar"]')
      ?.setAttribute('aria-pressed', String(pressed));
  }
}
