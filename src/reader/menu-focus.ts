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
