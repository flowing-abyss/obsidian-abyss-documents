import { Menu } from 'obsidian';

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

export class ReaderMenu extends Menu {
  override hide(event?: Event): this {
    // Obsidian binds the menu scope's Escape handler to hide and passes the
    // original keydown. Consume that event before it bubbles into the reader.
    if (event?.type === 'keydown') event.preventDefault();
    return super.hide();
  }
}

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
