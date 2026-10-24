import { describe, expect, it, vi } from 'vitest';
import { ReaderMenu } from './menu-focus.js';

describe('ReaderMenu', () => {
  it.each(['keydown', 'click', undefined])(
    'consumes only a keyboard close before notifying listeners (%s)',
    (type) => {
      const menu = new ReaderMenu();
      const event = type === undefined ? undefined : new Event(type, { cancelable: true });
      const closed = vi.fn(() => event?.defaultPrevented ?? false);
      menu.onHide(closed);

      expect(menu.hide(event)).toBe(menu);

      expect(closed).toHaveReturnedWith(type === 'keydown');
    },
  );

  it('consumes a keyboard close from the menu owner window', () => {
    const frame = document.body.createEl('iframe');
    const owner = frame.contentWindow as Window & { KeyboardEvent: typeof KeyboardEvent };
    try {
      const menu = new ReaderMenu();
      const event = new owner.KeyboardEvent('keydown', { cancelable: true, key: 'Escape' });

      menu.hide(event);

      expect(event.defaultPrevented).toBe(true);
    } finally {
      frame.remove();
    }
  });
});
