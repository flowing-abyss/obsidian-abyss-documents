export interface ReaderOwnerWindow extends Window {
  readonly CustomEvent: typeof CustomEvent;
  readonly Element: typeof Element;
  readonly Event: typeof Event;
  readonly HTMLElement: typeof HTMLElement;
  readonly HTMLButtonElement: typeof HTMLButtonElement;
  createDiv(): HTMLDivElement;
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  createFragment(): DocumentFragment;
  createSpan(): HTMLSpanElement;
}

export function ownerWindow(element: HTMLElement): ReaderOwnerWindow {
  return element.win as ReaderOwnerWindow;
}
