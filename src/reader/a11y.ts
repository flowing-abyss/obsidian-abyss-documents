import { ownerWindow } from './owner-dom.js';

export class FocusReturn {
  private invoker: HTMLElement | null = null;

  capture(invoker: HTMLElement): void {
    this.invoker = invoker;
  }

  restore(): void {
    const invoker = this.invoker;
    this.invoker = null;
    if (invoker === null || !invoker.doc.contains(invoker) || invoker.hidden) return;
    invoker.focus();
  }

  clear(): void {
    this.invoker = null;
  }
}

export class PoliteAnnouncer {
  readonly root: HTMLElement;

  private timer: number | null = null;
  private destroyed = false;

  constructor(private readonly host: HTMLElement) {
    this.root = ownerWindow(host).createDiv();
    this.root.className = 'abyss-reader-announcer';
    this.root.setAttribute('aria-atomic', 'true');
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('role', 'status');
    host.append(this.root);
  }

  announce(message: string): void {
    if (this.destroyed) return;
    if (this.timer !== null) this.host.win.clearTimeout(this.timer);
    this.root.textContent = '';
    this.timer = this.host.win.setTimeout(() => {
      this.timer = null;
      if (!this.destroyed) this.root.textContent = message;
    }, 0);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) this.host.win.clearTimeout(this.timer);
    this.timer = null;
    this.root.remove();
  }
}
