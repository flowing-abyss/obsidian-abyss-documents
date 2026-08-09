import { Menu } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ReaderToolbar, type ReaderToolbarIntent } from './toolbar.js';

interface CapturedMenuItem {
  checked: boolean | null;
  click: () => void;
  title: string;
}

function captureMenuItems(): CapturedMenuItem[] {
  const entries: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
    this: Menu,
    callback: Parameters<Menu['addItem']>[0],
  ) {
    const entry: CapturedMenuItem = { checked: null, click: () => undefined, title: '' };
    const item = {
      onClick(handler: () => void) {
        entry.click = handler;
        return item;
      },
      setChecked(checked: boolean | null) {
        entry.checked = checked;
        return item;
      },
      setIcon() {
        return item;
      },
      setTitle(title: string) {
        entry.title = title;
        return item;
      },
    };
    callback(item as never);
    entries.push(entry);
    return this;
  });
  return entries;
}

function fixture(options?: { mobile?: boolean }) {
  const host = createDiv();
  const intents: ReaderToolbarIntent[] = [];
  const onIntent = vi.fn((intent: ReaderToolbarIntent) => {
    intents.push(intent);
  });
  const toolbar = new ReaderToolbar(host, onIntent, options);
  return { host, intents, onIntent, toolbar };
}

describe('ReaderToolbar', () => {
  it('clamps an entered page and navigates on Enter', () => {
    const { host, onIntent, toolbar } = fixture();
    toolbar.setPageCount(702);
    const pageInput = host.querySelector<HTMLInputElement>('[data-control="page-field"]');
    if (pageInput === null) throw new Error('Expected the page field.');

    pageInput.value = '900';
    const OwnerKeyboardEvent = (pageInput.win as Window & { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;
    pageInput.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'Enter' }));

    expect(onIntent).toHaveBeenCalledWith({ type: 'go-to-page', pageIndex: 701 });
    expect(pageInput.value).toBe('702');
  });

  it('restores the current page instead of navigating for invalid input', () => {
    const { host, onIntent, toolbar } = fixture();
    toolbar.setPageCount(702);
    toolbar.setCurrentPage(19);
    const pageInput = host.querySelector<HTMLInputElement>('[data-control="page-field"]');
    if (pageInput === null) throw new Error('Expected the page field.');

    pageInput.value = '7.5';
    const OwnerKeyboardEvent = (pageInput.win as Window & { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;
    pageInput.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'Enter' }));

    expect(onIntent).not.toHaveBeenCalled();
    expect(pageInput.value).toBe('20');

    pageInput.value = '999999999999999999999999';
    pageInput.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'Enter' }));
    expect(onIntent).not.toHaveBeenCalled();
    expect(pageInput.value).toBe('20');

    pageInput.value = '30';
    pageInput.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'Escape' }));
    expect(pageInput.value).toBe('20');
  });

  it('emits the Task 7 sidebar placeholder intent without creating a sidebar', () => {
    const { host, intents } = fixture();
    const sidebar = host.querySelector<HTMLButtonElement>('[data-control="sidebar"]');
    if (sidebar === null) throw new Error('Expected the sidebar toggle.');

    sidebar.click();

    expect(intents).toEqual([{ type: 'toggle-sidebar' }]);
    expect(host.querySelector('[data-region="sidebar"]')).toBeNull();
  });

  it('disables page navigation for a non-finite page count', () => {
    const { host, toolbar } = fixture();

    toolbar.setPageCount(Number.NaN);

    expect(host.querySelector<HTMLInputElement>('[data-control="page-field"]')?.disabled).toBe(
      true,
    );
    expect(host.querySelector('[data-control="page-total"]')?.textContent).toBe('/ 0');
  });

  it('keeps calm icon controls accessible without visible word labels', () => {
    const { host, toolbar } = fixture();
    toolbar.setPageCount(702);

    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-toolbar-control]'));
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Toggle sidebar',
      'Previous page',
      'Next page',
      'Selection mode',
      'Reading profile: Auto',
      'More options',
    ]);
    expect(buttons.every((button) => button.title === button.getAttribute('aria-label'))).toBe(
      true,
    );
    expect(buttons.every((button) => button.textContent.trim() === '')).toBe(true);
    expect(host.querySelector('[data-control="selection"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(host.querySelector('[data-control="sidebar"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(host.querySelector('[data-control="page-total"]')?.textContent).toBe('/ 702');
  });

  it('emits navigation intents and disables unavailable page steps', () => {
    const { host, intents, toolbar } = fixture();
    toolbar.setPageCount(3);
    const previous = host.querySelector<HTMLButtonElement>('[data-control="previous-page"]');
    const next = host.querySelector<HTMLButtonElement>('[data-control="next-page"]');
    if (previous === null || next === null) throw new Error('Expected page navigation buttons.');

    expect(previous.disabled).toBe(true);
    next.click();
    toolbar.setCurrentPage(1);
    expect(previous.disabled).toBe(false);
    previous.click();

    expect(intents).toEqual([{ type: 'next-page' }, { type: 'previous-page' }]);
  });

  it('emits profile and fit or zoom choices from native menus', () => {
    const entries = captureMenuItems();
    const { host, intents } = fixture();
    const profile = host.querySelector<HTMLButtonElement>('[data-control="profile"]');
    const overflow = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (profile === null || overflow === null) throw new Error('Expected toolbar menus.');

    profile.click();
    entries.find((entry) => entry.title === 'Dark')?.click();
    entries.length = 0;
    overflow.click();
    entries.find((entry) => entry.title === 'Fit width')?.click();
    entries.find((entry) => entry.title === '125%')?.click();

    expect(intents).toEqual([
      { type: 'set-profile', profile: 'dark' },
      { type: 'set-scale', scale: 'page-width' },
      { type: 'set-scale', scale: 1.25 },
    ]);
  });

  it('moves reading profiles into overflow on mobile', () => {
    const entries = captureMenuItems();
    const { host, intents } = fixture({ mobile: true });
    expect(host.querySelector('[data-control="profile"]')).toBeNull();
    const overflow = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (overflow === null) throw new Error('Expected the overflow button.');

    overflow.click();
    entries.find((entry) => entry.title === 'Sepia')?.click();

    expect(intents).toContainEqual({ type: 'set-profile', profile: 'sepia' });
  });

  it('removes owned listeners when destroyed', () => {
    const { host, onIntent, toolbar } = fixture();
    const sidebar = host.querySelector<HTMLButtonElement>('[data-control="sidebar"]');
    if (sidebar === null) throw new Error('Expected the sidebar toggle.');

    toolbar.destroy();
    sidebar.click();

    expect(onIntent).not.toHaveBeenCalled();
  });
});
