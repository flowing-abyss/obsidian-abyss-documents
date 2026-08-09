export interface ReaderOwnerWindow extends Window {
  readonly Element: typeof Element;
  createDiv(): HTMLDivElement;
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  createSpan(): HTMLSpanElement;
}

export function ownerWindow(element: HTMLElement): ReaderOwnerWindow {
  return element.win as ReaderOwnerWindow;
}
