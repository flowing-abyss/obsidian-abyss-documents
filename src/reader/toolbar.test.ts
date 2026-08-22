import { Menu } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ReaderLayout } from '../document-core/reading.js';
import { ReaderToolbar, type ReaderToolbarIntent } from './toolbar.js';

interface CapturedMenuItem {
  checked: boolean | null;
  click: () => void;
  disabled: boolean;
  title: string;
}

function captureMenuItems(): CapturedMenuItem[] {
  const entries: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
    this: Menu,
    callback: Parameters<Menu['addItem']>[0],
  ) {
    const entry: CapturedMenuItem = {
      checked: null,
      click: () => undefined,
      disabled: false,
      title: '',
    };
    const item = {
      onClick(handler: () => void) {
        entry.click = handler;
        return item;
      },
      setChecked(checked: boolean | null) {
        entry.checked = checked;
        return item;
      },
      setDisabled(disabled: boolean) {
        entry.disabled = disabled;
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

function fixture() {
  const host = createDiv();
  const intents: ReaderToolbarIntent[] = [];
  const onIntent = vi.fn((intent: ReaderToolbarIntent) => {
    intents.push(intent);
  });
  const toolbar = new ReaderToolbar(host, onIntent);
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
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([
        'Toggle sidebar',
        'Previous page',
        'Next page',
        'Zoom out',
        'Fit width',
        'Zoom in',
        'Layout: Single, continuous',
        'Reading profile: Default',
      ]),
    );
    expect(buttons.every((button) => button.title === button.getAttribute('aria-label'))).toBe(
      true,
    );
    expect(buttons.every((button) => button.textContent.trim() === '')).toBe(true);
    expect(host.querySelector('[data-control="selection"]')).toBeNull();
    expect(host.querySelector('[data-control="overflow"]')).not.toBeNull();
    expect(host.querySelector('[data-control="sidebar"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(host.querySelector('[data-control="page-total"]')?.textContent).toBe('/ 702');
  });

  it('keeps direct minus, Fit width, and plus controls adjacent while exposing Fit choices to keyboards and touch', () => {
    const entries = captureMenuItems();
    const { host, intents } = fixture();
    const controls = Array.from(host.querySelectorAll<HTMLElement>('[data-control]'));
    const minus = host.querySelector<HTMLButtonElement>('[data-control="zoom-out"]');
    const fit = host.querySelector<HTMLButtonElement>('[data-control="fit"]');
    const plus = host.querySelector<HTMLButtonElement>('[data-control="zoom-in"]');
    const fitMenu = host.querySelector<HTMLButtonElement>('[data-control="fit-menu"]');
    if (minus === null || fit === null || plus === null || fitMenu === null)
      throw new Error('Expected direct zoom controls.');
    const OwnerKeyboardEvent = (fit.win as Window & { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;
    const OwnerMouseEvent = (fit.win as Window & { MouseEvent: typeof MouseEvent }).MouseEvent;

    expect(controls.indexOf(minus)).toBeLessThan(controls.indexOf(fit));
    expect(controls.indexOf(fit)).toBeLessThan(controls.indexOf(plus));
    expect(fit.getAttribute('aria-haspopup')).toBeNull();
    expect(fitMenu.getAttribute('aria-haspopup')).toBe('menu');
    minus.click();
    fit.click();
    plus.click();
    fit.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'F10', shiftKey: true }));
    fit.dispatchEvent(new OwnerMouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fitMenu.click();

    expect(intents.slice(0, 3)).toEqual([
      { type: 'zoom-step', direction: -1 },
      { type: 'set-scale', scale: 'page-width' },
      { type: 'zoom-step', direction: 1 },
    ]);
    expect(entries.map((entry) => entry.title)).toEqual([
      'Fit width',
      'Fit page',
      'Fit height',
      'Fit width',
      'Fit page',
      'Fit height',
      'Fit width',
      'Fit page',
      'Fit height',
    ]);
    expect(entries.every((entry) => entry.checked !== null)).toBe(true);
  });

  it('presents two compact layout groups with the current choice checked and no duplicated scale or profile menu', () => {
    const entries = captureMenuItems();
    const { host, intents, toolbar } = fixture();
    const layout: ReaderLayout = { pages: 'facing', scrolling: 'page-by-page' };
    toolbar.setLayout(layout);
    const button = host.querySelector<HTMLButtonElement>('[data-control="layout"]');
    if (button === null) throw new Error('Expected the layout control.');

    expect(button.getAttribute('aria-label')).toBe('Layout: Facing, page by page');
    expect(button.dataset['layoutIcon']).toBe('columns-2');
    button.click();

    expect(entries.map((entry) => entry.title)).toEqual([
      'Pages',
      'Single',
      'Facing',
      'Scrolling',
      'Continuous',
      'Page by page',
    ]);
    expect(entries.find((entry) => entry.title === 'Facing')?.checked).toBe(true);
    expect(entries.find((entry) => entry.title === 'Page by page')?.checked).toBe(true);
    expect(entries.find((entry) => entry.title === 'Pages')?.disabled).toBe(true);
    expect(entries.find((entry) => entry.title === 'Scrolling')?.disabled).toBe(true);
    entries.find((entry) => entry.title === 'Single')?.click();
    entries.find((entry) => entry.title === 'Continuous')?.click();
    expect(intents).toEqual([
      { type: 'set-layout', layout: { pages: 'single', scrolling: 'page-by-page' } },
      { type: 'set-layout', layout: { pages: 'facing', scrolling: 'continuous' } },
    ]);
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

  it('uses one direct profile menu so Default and Follow Obsidian remain distinct', () => {
    const entries = captureMenuItems();
    const setUseNativeMenu = vi.spyOn(Menu.prototype, 'setUseNativeMenu');
    const { host, intents } = fixture();
    const profile = host.querySelector<HTMLButtonElement>('[data-control="profile"]');
    if (profile === null) throw new Error('Expected profile menu.');

    profile.click();
    expect(entries.map((entry) => entry.title)).toContain('Follow Obsidian');
    expect(entries.map((entry) => entry.title)).not.toContain('Auto');
    entries.find((entry) => entry.title === 'Dark')?.click();
    expect(entries.find((entry) => entry.title === 'Default')?.checked).toBe(true);
    expect(entries.find((entry) => entry.title === 'Follow Obsidian')?.checked).toBe(false);

    expect(setUseNativeMenu).toHaveBeenCalledTimes(1);
    expect(setUseNativeMenu).toHaveBeenNthCalledWith(1, false);
    expect(intents).toEqual([{ type: 'set-profile', profile: 'dark' }]);
  });

  it('keeps the profile menu available without adding an overflow duplicate', () => {
    const entries = captureMenuItems();
    const { host, intents } = fixture();
    const profile = host.querySelector<HTMLButtonElement>('[data-control="profile"]');
    if (profile === null) throw new Error('Expected the profile button.');

    profile.click();
    entries.find((entry) => entry.title === 'Sepia')?.click();

    expect(intents).toContainEqual({ type: 'set-profile', profile: 'sepia' });
  });

  it('exposes only the functional annotation export operation in overflow', () => {
    const entries = captureMenuItems();
    const { host, intents } = fixture();
    const overflow = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (overflow === null) throw new Error('Expected overflow control.');

    overflow.click();
    expect(entries.map(({ title }) => title)).toEqual(['Export annotations…']);
    expect(entries.map(({ title }) => title)).not.toContain('Recognize page');
    expect(entries.map(({ title }) => title)).not.toContain('Recognize document');
    entries[0]?.click();
    expect(intents).toEqual([{ type: 'export-annotations' }]);
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
