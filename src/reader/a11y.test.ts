import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it.each([
    [
      'hidden ancestor',
      (ancestor: HTMLElement) => {
        ancestor.hidden = true;
      },
    ],
    [
      'aria-hidden ancestor',
      (ancestor: HTMLElement) => {
        ancestor.setAttribute('aria-hidden', 'true');
      },
    ],
    [
      'display-none ancestor',
      (ancestor: HTMLElement) => {
        ancestor.setCssProps({ display: 'none' });
      },
    ],
    [
      'visibility-hidden ancestor',
      (ancestor: HTMLElement) => {
        ancestor.setCssProps({ visibility: 'hidden' });
      },
    ],
  ])('does not focus a target inside a %s', (_name, hide) => {
    const ancestor = createDiv();
    const button = createEl('button');
    ancestor.append(button);
    ancestor.doc.body.append(ancestor);
    const focus = vi.spyOn(button, 'focus');
    hide(ancestor);
    const focusReturn = new FocusReturn();
    focusReturn.capture(button);

    focusReturn.restore();

    expect(focus).not.toHaveBeenCalled();
    ancestor.remove();
  });

  it('focuses a connected target whose ancestor chain is visible', () => {
    const ancestor = createDiv();
    const button = createEl('button');
    ancestor.append(button);
    ancestor.doc.body.append(ancestor);
    const focusReturn = new FocusReturn();
    focusReturn.capture(button);

    focusReturn.restore();

    expect(button.doc.activeElement).toBe(button);
    ancestor.remove();
  });
});

describe('PoliteAnnouncer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an owner-document polite live region and removes it on destroy', () => {
    vi.useFakeTimers();
    const host = createDiv();
    const announcer = new PoliteAnnouncer(host);

    announcer.announce('Page 2 of 10');
    vi.advanceTimersByTime(200);

    const region = host.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-atomic')).toBe('true');
    expect(region?.textContent).toBe('Page 2 of 10');

    announcer.destroy();
    announcer.destroy();
    announcer.announce('Ignored after destroy');
    expect(host.contains(region)).toBe(false);
  });

  it('coalesces rapid page events, deduplicates repeats, and later delivers a distinct message', () => {
    vi.useFakeTimers();
    const host = createDiv();
    const announcer = new PoliteAnnouncer(host);
    for (let page = 1; page <= 20; page += 1) {
      announcer.announce(`Page ${page} of 20`);
    }
    announcer.announce('Page 20 of 20');

    vi.advanceTimersByTime(149);
    expect(announcer.root.textContent).toBe('');
    vi.advanceTimersByTime(1);
    expect(announcer.root.textContent).toBe('Page 20 of 20');
    expect(vi.getTimerCount()).toBe(0);

    announcer.announce('Page 20 of 20');
    expect(vi.getTimerCount()).toBe(0);
    announcer.announce('Search sidebar opened');
    vi.advanceTimersByTime(150);
    expect(announcer.root.textContent).toBe('Search sidebar opened');
  });

  it('cancels a pending announcement during destruction', () => {
    vi.useFakeTimers();
    const host = createDiv();
    const announcer = new PoliteAnnouncer(host);

    announcer.announce('Never shown');
    announcer.destroy();
    vi.runAllTimers();
    expect(announcer.root.textContent).toBe('');
  });
});
