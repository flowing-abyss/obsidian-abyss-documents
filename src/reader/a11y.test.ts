import { describe, expect, it } from 'vitest';
import { FocusReturn, PoliteAnnouncer } from './a11y.js';

describe('FocusReturn', () => {
  it('returns focus to the captured invoking control', () => {
    const toggleButton = createEl('button');
    toggleButton.textContent = 'Toggle sidebar';
    toggleButton.doc.body.append(toggleButton);
    const focusReturn = new FocusReturn();

    focusReturn.capture(toggleButton);
    focusReturn.restore();

    expect(toggleButton.doc.activeElement).toBe(toggleButton);
    toggleButton.remove();
  });

  it('does not focus a captured control after it leaves its owner document', () => {
    const toggleButton = createEl('button');
    toggleButton.doc.body.append(toggleButton);
    const focusReturn = new FocusReturn();
    focusReturn.capture(toggleButton);
    toggleButton.remove();

    focusReturn.restore();

    expect(toggleButton.doc.activeElement).not.toBe(toggleButton);
  });

  it('ignores an empty or hidden focus target and clears a captured target', () => {
    const focusReturn = new FocusReturn();
    focusReturn.restore();
    const toggleButton = createEl('button');
    toggleButton.doc.body.append(toggleButton);
    toggleButton.hidden = true;
    focusReturn.capture(toggleButton);
    focusReturn.restore();
    toggleButton.hidden = false;
    focusReturn.capture(toggleButton);
    focusReturn.clear();

    focusReturn.restore();

    expect(toggleButton.doc.activeElement).not.toBe(toggleButton);
    toggleButton.remove();
  });
});

describe('PoliteAnnouncer', () => {
  it('creates an owner-document polite live region and removes it on destroy', async () => {
    const host = createDiv();
    const announcer = new PoliteAnnouncer(host);

    announcer.announce('Page 2 of 10');
    await new Promise((resolve) => host.win.setTimeout(resolve, 0));

    const region = host.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-atomic')).toBe('true');
    expect(region?.textContent).toBe('Page 2 of 10');

    announcer.destroy();
    announcer.destroy();
    announcer.announce('Ignored after destroy');
    expect(host.contains(region)).toBe(false);
  });

  it('replaces a pending announcement and cancels it during destruction', async () => {
    const host = createDiv();
    const announcer = new PoliteAnnouncer(host);
    announcer.announce('Old message');
    announcer.announce('Current message');
    await new Promise((resolve) => host.win.setTimeout(resolve, 0));
    expect(announcer.root.textContent).toBe('Current message');

    announcer.announce('Never shown');
    announcer.destroy();
    await new Promise((resolve) => host.win.setTimeout(resolve, 0));
    expect(announcer.root.textContent).toBe('');
  });
});
