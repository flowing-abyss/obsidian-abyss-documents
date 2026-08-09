export interface ReaderOwnerWindow extends Window {
  createDiv(): HTMLDivElement;
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  createSpan(): HTMLSpanElement;
}

export function ownerWindow(element: HTMLElement): ReaderOwnerWindow {
  return element.win as ReaderOwnerWindow;
}
