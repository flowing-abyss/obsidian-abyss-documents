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
