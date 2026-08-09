export class ReaderShell {
  readonly root: HTMLElement;
  readonly documentHost: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = createDiv();
    this.root.className = 'abyss-documents';

    const toolbar = createDiv();
    toolbar.dataset['region'] = 'toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Document controls');

    this.documentHost = createDiv();
    this.documentHost.dataset['region'] = 'document';
    this.documentHost.tabIndex = -1;

    this.root.append(toolbar, this.documentHost);
    host.append(this.root);
  }

  destroy(): void {
    this.root.remove();
  }
}
