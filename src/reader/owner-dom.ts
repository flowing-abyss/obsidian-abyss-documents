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

const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, summary, textarea, [contenteditable]:not([contenteditable="false"]), [role="button"], [tabindex]';

export function focusableTarget(
  target: EventTarget | null,
  owner: ReaderOwnerWindow,
): HTMLElement | null {
  if (!(target instanceof owner.Element)) return null;
  const candidate = target.closest<HTMLElement>(FOCUSABLE_SELECTOR);
  if (
    candidate === null ||
    candidate.tabIndex < 0 ||
    candidate.matches(':disabled, [aria-disabled="true"]')
  )
    return null;
  return candidate;
}
