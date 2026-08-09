import type { ObsidianTheme } from './reading-profiles.js';
import { ReaderToolbar, type ReaderToolbarIntent } from './toolbar.js';

export class ReaderShell {
  readonly root: HTMLElement;
  readonly documentHost: HTMLElement;
  readonly toolbar: ReaderToolbar;

  private readonly cleanups: Array<() => void> = [];
  private destroyed = false;

  constructor(
    host: HTMLElement,
    onIntent: (intent: ReaderToolbarIntent) => void = () => undefined,
  ) {
    this.root = host.createDiv({ cls: 'abyss-documents' });

    const toolbarHost = this.root.createDiv({
      attr: {
        'aria-label': 'Document controls',
        'data-region': 'toolbar',
        role: 'toolbar',
      },
    });
    this.toolbar = new ReaderToolbar(toolbarHost, onIntent);

    this.documentHost = this.root.createDiv({ attr: { 'data-region': 'document' } });
    this.documentHost.tabIndex = -1;
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.toolbar.destroy();
    this.root.remove();
  }
}
