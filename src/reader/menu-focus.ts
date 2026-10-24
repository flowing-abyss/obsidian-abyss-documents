const INTERACTIVE_FOCUS_TARGET = [
  'a[href]',
  'audio[controls]',
  'button',
  'input',
  'select',
  'summary',
  'textarea',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[tabindex]',
].join(',');

const menuClosingFrames = new WeakMap<HTMLElement, number>();

export function bindMenuTriggerKeyboardToggle(
  host: HTMLElement,
  activeTrigger: () => HTMLButtonElement | null,
  close: () => void,
): () => void {
  const owner = host.win;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.target !== activeTrigger()) return;
    // Obsidian's menu scope consumes Enter at window capture before the button
    // receives it. Close only a menu still owned by this exact trigger.
    event.preventDefault();
    close();
  };
  owner.addEventListener('keydown', onKeyDown, true);
  return () => {
    owner.removeEventListener('keydown', onKeyDown, true);
  };
}

export function markReaderMenuClosing(trigger: HTMLElement): void {
  const previous = menuClosingFrames.get(trigger);
  if (previous !== undefined) trigger.win.cancelAnimationFrame(previous);
  trigger.dataset['abyssMenuClosing'] = '';
  const frame = trigger.win.requestAnimationFrame(() => {
    if (menuClosingFrames.get(trigger) !== frame) return;
    menuClosingFrames.delete(trigger);
    delete trigger.dataset['abyssMenuClosing'];
  });
  menuClosingFrames.set(trigger, frame);
}

export function shouldRestoreMenuTriggerFocus(trigger: HTMLButtonElement): boolean {
  const active = trigger.doc.activeElement;
  if (
    active === null ||
    active === trigger.doc.body ||
    active === trigger.doc.documentElement ||
    !active.isConnected
  ) {
    return true;
  }
  return !active.matches(INTERACTIVE_FOCUS_TARGET);
}
