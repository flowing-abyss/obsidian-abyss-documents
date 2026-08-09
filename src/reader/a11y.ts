import { ownerWindow } from './owner-dom.js';

const ANNOUNCEMENT_DELAY_MS = 150;

export class FocusReturn {
  private invoker: HTMLElement | null = null;

  capture(invoker: HTMLElement): void {
    this.invoker = invoker;
  }

  restore(): void {
    const invoker = this.invoker;
    this.invoker = null;
    if (invoker === null || !invoker.doc.contains(invoker) || isHidden(invoker)) return;
    invoker.focus();
  }

  clear(): void {
    this.invoker = null;
  }
}

export class PoliteAnnouncer {
  readonly root: HTMLElement;

  private deliveredMessage: string | null = null;
  private pendingMessage: string | null = null;
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
    if (message === this.pendingMessage) return;
    if (this.timer === null && message === this.deliveredMessage) return;
    this.pendingMessage = message;
    if (this.timer !== null) return;
    this.timer = this.host.win.setTimeout(() => {
      this.timer = null;
      const pendingMessage = this.pendingMessage;
      this.pendingMessage = null;
      if (this.destroyed || pendingMessage === null || pendingMessage === this.deliveredMessage) {
        return;
      }
      this.root.textContent = pendingMessage;
      this.deliveredMessage = pendingMessage;
    }, ANNOUNCEMENT_DELAY_MS);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) this.host.win.clearTimeout(this.timer);
    this.pendingMessage = null;
    this.timer = null;
    this.root.remove();
  }
}

function isHidden(element: HTMLElement): boolean {
  const win = ownerWindow(element);
  let current: HTMLElement | null = element;
  while (current !== null) {
    const style = win.getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}
