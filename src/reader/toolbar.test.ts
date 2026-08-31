import { Menu } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { ReaderLayout } from '../document-core/reading.js';
import { AnnotationToolbar } from './annotation-toolbar.js';
import { ReaderToolbar, type ReaderToolbarIntent } from './toolbar.js';

interface CapturedMenuItem {
  checked: boolean | null;
  click: () => void;
  disabled: boolean;
  icon: string | null;
  section: string | null;
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
      icon: null,
      section: null,
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
      setIcon(icon: string | null) {
        entry.icon = icon;
        return item;
      },
      setIsLabel(isLabel: boolean) {
        entry.disabled = isLabel;
        return item;
      },
      setSection(section: string) {
        entry.section = section;
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

function setToolbarWidth(host: HTMLElement, width: number): void {
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
    bottom: 44,
    height: 44,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function captureMenuHide(): { hide: () => void } {
  const onHide = vi.spyOn(Menu.prototype, 'onHide');
  return {
    hide: () => {
      const callback = onHide.mock.lastCall?.[0];
      if (callback === undefined) throw new Error('Expected an open menu.');
      callback();
    },
  };
}

async function nextAnimationFrame(owner: Window): Promise<void> {
  await new Promise<void>((resolve) => {
    owner.requestAnimationFrame(() => {
      resolve();
    });
  });
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

  it('restores the current page when an invalid edit loses focus', () => {
    const { host, onIntent, toolbar } = fixture();
    toolbar.setPageCount(12);
    toolbar.setCurrentPage(4);
    const pageInput = host.querySelector<HTMLInputElement>('[data-control="page-field"]');
    if (pageInput === null) throw new Error('Expected the page field.');

    pageInput.value = 'not a page';
    pageInput.dispatchEvent(new FocusEvent('blur'));

    expect(onIntent).not.toHaveBeenCalled();
    expect(pageInput.value).toBe('5');
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

  it('shows only the priority toolbar actions', () => {
    const { host, toolbar } = fixture();
    toolbar.setPageCount(702);

    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-toolbar-control]'));
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining([
        'Toggle sidebar',
        'Previous page',
        'Next page',
        'Zoom out',
        'Fit width — more fit options',
        'Zoom in',
        'More options',
      ]),
    );
    expect(buttons.every((button) => button.textContent.trim() === '')).toBe(true);
    expect(host.querySelector('[data-control="selection"]')).toBeNull();
    expect(host.querySelector('[data-control="layout"]')).toBeNull();
    expect(host.querySelector('[data-control="profile"]')).toBeNull();
    expect(host.querySelector('[data-control="zoom-level"]')).toBeNull();
    expect(host.querySelector('[data-control="overflow"]')).not.toBeNull();
    expect(host.querySelector('[data-control="sidebar"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(host.querySelector('[data-control="page-total"]')?.textContent).toBe('/ 702');
  });

  it.each([390, 480, 768, 1024])(
    'keeps page navigation in the center zone and toolbar controls in tab order at %ipx',
    (width) => {
      const { host, toolbar } = fixture();
      setToolbarWidth(host, width);
      toolbar.setPageCount(702);
      toolbar.setCurrentPage(99);
      const zones = Array.from(host.querySelectorAll<HTMLElement>('[data-toolbar-zone]'));
      const controlsByZone: Record<string, string[]> = {};
      for (const zone of zones) {
        const name = zone.dataset['toolbarZone'];
        if (name === undefined) throw new Error('Expected a named toolbar zone.');
        controlsByZone[name] = Array.from(
          zone.querySelectorAll<HTMLElement>('[data-control]'),
          (control) => control.dataset['control'] ?? '',
        );
      }
      const tabOrder = Array.from(
        host.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
      ).map((control) => control.dataset['control']);

      expect(zones.map((zone) => zone.dataset['toolbarZone'])).toEqual(['left', 'center', 'right']);
      expect(controlsByZone).toEqual({
        center: ['previous-page', 'page-field', 'page-total', 'next-page'],
        left: ['sidebar', 'zoom-out', 'fit', 'fit-menu', 'zoom-in'],
        right: ['overflow'],
      });
      expect(tabOrder).toEqual([
        'sidebar',
        'zoom-out',
        'fit',
        'fit-menu',
        'zoom-in',
        'previous-page',
        'page-field',
        'next-page',
        'overflow',
      ]);
    },
  );

  it('renders Fit as one accessible split control', () => {
    const { host } = fixture();
    const split = host.querySelector('[data-control-group="fit"]');
    const main = split?.querySelector('[data-control="fit"]');
    const menu = split?.querySelector('[data-control="fit-menu"]');

    expect(split?.getAttribute('role')).toBe('group');
    expect(split?.getAttribute('aria-label')).toBe('Fit width — more fit options');
    expect(main?.getAttribute('aria-label')).toBe('Fit width — more fit options');
    expect(main?.getAttribute('aria-haspopup')).toBe('menu');
    expect(main?.getAttribute('aria-expanded')).toBe('false');
    expect(menu?.getAttribute('aria-haspopup')).toBe('menu');
    expect(menu?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the active Fit menu when its disclosure is activated again', () => {
    const entries = captureMenuItems();
    const close = vi.spyOn(Menu.prototype, 'close');
    const { host, toolbar } = fixture();
    const trigger = host.querySelector<HTMLButtonElement>('[data-control="fit-menu"]');
    if (trigger === null) throw new Error('Expected Fit options.');

    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    trigger.click();

    expect(close).toHaveBeenCalledOnce();
    expect(entries.map(({ title }) => title)).toEqual(['Fit width', 'Fit page', 'Fit height']);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    toolbar.destroy();
  });

  it('opens Fit by pointer keyboard touch and context routes', () => {
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
    expect(fit.getAttribute('aria-haspopup')).toBe('menu');
    expect(fitMenu.getAttribute('aria-haspopup')).toBe('menu');
    minus.click();
    fit.click();
    plus.click();
    fit.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'ArrowDown' }));
    fit.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'F10', shiftKey: true }));
    fit.dispatchEvent(new OwnerMouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    fit.dispatchEvent(new OwnerMouseEvent('click', { bubbles: true, button: 2 }));
    fitMenu.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'ArrowDown' }));
    fitMenu.click();

    expect(intents.slice(0, 3)).toEqual([
      { type: 'zoom-step', direction: -1 },
      { type: 'set-scale', scale: 'page-width' },
      { type: 'zoom-step', direction: 1 },
    ]);
    expect(intents).toHaveLength(3);
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

  it('opens Fit on a cancellable long press without firing its primary action', () => {
    vi.useFakeTimers();
    try {
      const entries = captureMenuItems();
      const { host, intents, toolbar } = fixture();
      const bubbledClicks = vi.fn();
      host.addEventListener('click', bubbledClicks);
      const fit = host.querySelector<HTMLButtonElement>('[data-control="fit"]');
      if (fit === null) throw new Error('Expected Fit.');
      const capturedPointers = new Set<number>();
      Object.assign(fit, {
        hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
        releasePointerCapture: (pointerId: number) => capturedPointers.delete(pointerId),
        setPointerCapture: (pointerId: number) => capturedPointers.add(pointerId),
      });
      const OwnerPointerEvent = (fit.win as Window & { PointerEvent: typeof PointerEvent })
        .PointerEvent;
      const OwnerMouseEvent = (fit.win as Window & { MouseEvent: typeof MouseEvent }).MouseEvent;
      const pointer = (type: string, x: number) =>
        new OwnerPointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: 10,
          isPrimary: true,
          pointerId: 7,
          pointerType: 'touch',
        });

      fit.dispatchEvent(pointer('pointerdown', 10));
      fit.dispatchEvent(pointer('pointermove', 30));
      vi.advanceTimersByTime(600);
      expect(entries).toHaveLength(0);

      fit.dispatchEvent(pointer('pointerdown', 10));
      vi.advanceTimersByTime(1_600);
      expect(entries.map(({ title }) => title)).toEqual(['Fit width', 'Fit page', 'Fit height']);
      fit.dispatchEvent(pointer('pointerup', 10));
      fit.dispatchEvent(new OwnerMouseEvent('click', { bubbles: true, detail: 1 }));
      expect(intents).toEqual([]);
      expect(bubbledClicks).not.toHaveBeenCalled();

      fit.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }),
      );

      fit.dispatchEvent(pointer('pointerdown', 10));
      vi.advanceTimersByTime(500);
      fit.dispatchEvent(pointer('pointerup', 10));
      vi.advanceTimersByTime(1_001);
      fit.dispatchEvent(new OwnerMouseEvent('click', { bubbles: true, detail: 1 }));
      expect(intents).toEqual([{ type: 'set-scale', scale: 'page-width' }]);
      expect(bubbledClicks).toHaveBeenCalledTimes(1);

      fit.dispatchEvent(pointer('pointerdown', 10));
      fit.dispatchEvent(pointer('pointercancel', 10));
      vi.advanceTimersByTime(600);
      expect(entries).toHaveLength(6);

      fit.dispatchEvent(pointer('pointerdown', 10));
      toolbar.destroy();
      vi.advanceTimersByTime(600);
      expect(entries).toHaveLength(6);
      expect(capturedPointers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores mouse, secondary, and mismatched long-press lifecycle events', () => {
    vi.useFakeTimers();
    try {
      const entries = captureMenuItems();
      const { host, toolbar } = fixture();
      const fit = host.querySelector<HTMLButtonElement>('[data-control="fit"]');
      if (fit === null) throw new Error('Expected Fit.');
      const OwnerPointerEvent = (fit.win as Window & { PointerEvent: typeof PointerEvent })
        .PointerEvent;
      const pointer = (type: string, pointerId: number, pointerType: string, button = 0) =>
        new OwnerPointerEvent(type, {
          bubbles: true,
          button,
          clientX: 10,
          clientY: 10,
          isPrimary: true,
          pointerId,
          pointerType,
        });

      fit.dispatchEvent(pointer('pointerdown', 1, 'mouse'));
      fit.dispatchEvent(pointer('pointerdown', 2, 'touch', 1));
      fit.dispatchEvent(pointer('pointerdown', 3, 'touch'));
      fit.dispatchEvent(pointer('pointermove', 4, 'touch'));
      fit.dispatchEvent(pointer('pointerup', 4, 'touch'));
      fit.dispatchEvent(pointer('pointercancel', 4, 'touch'));
      fit.dispatchEvent(pointer('pointerup', 3, 'touch'));
      vi.advanceTimersByTime(600);

      expect(entries).toHaveLength(0);
      toolbar.destroy();
      toolbar.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces touch contextmenu before and after the Fit long-press threshold', () => {
    vi.useFakeTimers();
    try {
      const entries = captureMenuItems();
      const { host, intents, toolbar } = fixture();
      const bubbledContexts = vi.fn();
      host.addEventListener('contextmenu', bubbledContexts);
      const fit = host.querySelector<HTMLButtonElement>('[data-control="fit"]');
      if (fit === null) throw new Error('Expected Fit.');
      const OwnerPointerEvent = (fit.win as Window & { PointerEvent: typeof PointerEvent })
        .PointerEvent;
      const OwnerMouseEvent = (fit.win as Window & { MouseEvent: typeof MouseEvent }).MouseEvent;
      const pointer = (type: string, pointerId: number) =>
        new OwnerPointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: 10,
          clientY: 10,
          isPrimary: true,
          pointerId,
          pointerType: 'touch',
        });
      const contextmenu = () =>
        new OwnerMouseEvent('contextmenu', { bubbles: true, cancelable: true });
      const click = () => new OwnerMouseEvent('click', { bubbles: true, detail: 1 });

      fit.dispatchEvent(pointer('pointerdown', 21));
      vi.advanceTimersByTime(200);
      fit.dispatchEvent(contextmenu());
      expect(entries).toHaveLength(3);
      expect(bubbledContexts).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600);
      expect(entries).toHaveLength(3);
      fit.dispatchEvent(pointer('pointerup', 21));
      fit.dispatchEvent(click());
      expect(intents).toEqual([]);

      fit.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }),
      );

      fit.dispatchEvent(pointer('pointerdown', 22));
      vi.advanceTimersByTime(500);
      expect(entries).toHaveLength(6);
      fit.dispatchEvent(contextmenu());
      expect(entries).toHaveLength(6);
      expect(bubbledContexts).not.toHaveBeenCalled();
      fit.dispatchEvent(pointer('pointerup', 22));
      fit.dispatchEvent(click());
      expect(intents).toEqual([]);

      toolbar.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers independent page-count and continuous-scrolling layout choices', () => {
    const entries = captureMenuItems();
    const { host, intents, toolbar } = fixture();
    const layout: ReaderLayout = { pages: 'facing', scrolling: 'page-by-page' };
    toolbar.setLayout(layout);
    const button = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (button === null) throw new Error('Expected More options.');

    button.click();

    const layouts = entries.filter(
      (entry) => entry.section === 'abyss-documents-layout' && !entry.disabled,
    );
    expect(layouts.map((entry) => entry.title)).toEqual([
      'Single page',
      'Two pages',
      'Continuous scrolling',
    ]);
    expect(layouts.every((entry) => entry.icon === null)).toBe(true);
    expect(layouts.every((entry) => entry.section === 'abyss-documents-layout')).toBe(true);
    expect(entries.find((entry) => entry.title === 'Layout')?.section).toBe(
      'abyss-documents-layout',
    );
    expect(layouts.map(({ checked }) => checked)).toEqual([false, true, false]);

    layouts.find((entry) => entry.title === 'Single page')?.click();
    layouts.find((entry) => entry.title === 'Two pages')?.click();
    layouts.find((entry) => entry.title === 'Continuous scrolling')?.click();
    expect(intents).toEqual([
      {
        type: 'set-layout',
        layout: { pages: 'single', scrolling: 'page-by-page' },
      },
      {
        type: 'set-layout',
        layout: { pages: 'facing', scrolling: 'page-by-page' },
      },
      {
        type: 'set-layout',
        layout: { pages: 'facing', scrolling: 'continuous' },
      },
    ]);
  });

  it('defaults Layout to Single page with Continuous scrolling', () => {
    const entries = captureMenuItems();
    const { host } = fixture();

    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();

    expect(
      entries
        .filter((entry) => entry.section === 'abyss-documents-layout' && !entry.disabled)
        .map(({ checked, title }) => ({ checked, title })),
    ).toEqual([
      { checked: true, title: 'Single page' },
      { checked: false, title: 'Two pages' },
      { checked: true, title: 'Continuous scrolling' },
    ]);
  });

  it('preserves scrolling when choosing a page count', () => {
    const entries = captureMenuItems();
    const { host, intents, toolbar } = fixture();
    toolbar.setLayout({ pages: 'facing', scrolling: 'continuous' });

    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();
    entries.find(({ title }) => title === 'Single page')?.click();

    expect(intents).toEqual([
      {
        type: 'set-layout',
        layout: { pages: 'single', scrolling: 'continuous' },
      },
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

  it('moves Layout appearance and Export into More', () => {
    const entries = captureMenuItems();
    const setUseNativeMenu = vi.spyOn(Menu.prototype, 'setUseNativeMenu');
    const { host, intents } = fixture();
    const profile = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (profile === null) throw new Error('Expected More options.');

    profile.click();
    expect(entries.map((entry) => entry.title)).toContain('Layout');
    expect(entries.map((entry) => entry.title)).toContain('Appearance');
    expect(entries.map((entry) => entry.title)).toContain('Export annotations…');
    expect(entries.map((entry) => entry.title)).toContain('Follow Obsidian');
    expect(entries.map((entry) => entry.title)).not.toContain('Auto');
    expect(entries.find(({ title }) => title === 'Appearance')?.section).toBe(
      'abyss-documents-appearance',
    );
    expect(
      entries
        .filter(({ title }) =>
          ['Default', 'Follow Obsidian', 'Light', 'Sepia', 'Dark', 'Custom'].includes(title),
        )
        .map(({ section, title }) => ({ section, title })),
    ).toEqual(
      ['Default', 'Follow Obsidian', 'Light', 'Sepia', 'Dark', 'Custom'].map((title) => ({
        section: 'abyss-documents-appearance',
        title,
      })),
    );
    expect(entries.find(({ title }) => title === 'Export annotations…')?.section).toBe(
      'abyss-documents-actions',
    );
    entries.find((entry) => entry.title === 'Dark')?.click();
    expect(entries.find((entry) => entry.title === 'Default')?.checked).toBe(true);
    expect(entries.find((entry) => entry.title === 'Follow Obsidian')?.checked).toBe(false);

    expect(setUseNativeMenu).toHaveBeenCalledTimes(1);
    expect(setUseNativeMenu).toHaveBeenNthCalledWith(1, false);
    expect(intents).toEqual([{ type: 'set-profile', profile: 'dark' }]);
  });

  it('retains zoom and every Fit action in More when the reader leaf is narrow', () => {
    const entries = captureMenuItems();
    const { host, intents, toolbar } = fixture();
    setToolbarWidth(host, 420);
    toolbar.setScale(1.25);
    const overflow = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (overflow === null) throw new Error('Expected More options.');

    overflow.click();

    expect(entries.map(({ title }) => title)).toEqual(
      expect.arrayContaining([
        'Zoom · 125%',
        'Fit',
        'Zoom out',
        'Reset zoom',
        'Zoom in',
        'Fit width',
        'Fit page',
        'Fit height',
      ]),
    );
    entries.find(({ title }) => title === 'Zoom out')?.click();
    entries.find(({ title }) => title === 'Reset zoom')?.click();
    entries.find(({ title }) => title === 'Zoom in')?.click();
    entries.find(({ title }) => title === 'Fit height')?.click();
    expect(intents).toEqual([
      { type: 'zoom-step', direction: -1 },
      { type: 'set-scale', scale: 1 },
      { type: 'zoom-step', direction: 1 },
      { type: 'set-scale', scale: 'page-height' },
    ]);
  });

  it('keeps page navigation direct without duplicating it in More at phone width', () => {
    const entries = captureMenuItems();
    const { host, toolbar } = fixture();
    setToolbarWidth(host, 390);
    toolbar.setPageCount(3);
    toolbar.setCurrentPage(1);

    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();

    expect(entries.map(({ title }) => title)).not.toContain('Previous page');
    expect(entries.map(({ title }) => title)).not.toContain('Next page');
    expect(host.querySelector('[data-control="previous-page"]')).not.toBeNull();
    expect(host.querySelector('[data-control="next-page"]')).not.toBeNull();
  });

  it('moves only inactive annotation tools into More at phone width', () => {
    const entries = captureMenuItems();
    const { host, toolbar } = fixture();
    setToolbarWidth(host, 390);
    const onAnnotationIntent = vi.fn();
    const annotations = new AnnotationToolbar(
      toolbar.annotationHost,
      [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      null,
      onAnnotationIntent,
    );
    annotations.setTool('ink');

    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();

    const toolItems = entries.filter(
      ({ disabled, section }) => section === 'abyss-documents-tools' && !disabled,
    );
    expect(toolItems.map(({ title }) => title)).toEqual(['Sticky Highlight', 'Text']);
    toolItems[0]?.click();
    expect(onAnnotationIntent).toHaveBeenCalledWith({
      type: 'set-annotation-tool',
      tool: 'highlight',
      color: '#ffd400',
    });

    annotations.destroy();
    toolbar.destroy();
  });

  it('keeps default Select visible without representing it as Sticky Highlight in More', () => {
    const entries = captureMenuItems();
    const { host, toolbar } = fixture();
    setToolbarWidth(host, 390);
    const annotations = new AnnotationToolbar(
      toolbar.annotationHost,
      [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      null,
      vi.fn(),
    );

    const select = host.querySelector<HTMLButtonElement>('[data-annotation-tool="select"]');
    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();
    const toolTitles = entries
      .filter(({ disabled, section }) => section === 'abyss-documents-tools' && !disabled)
      .map(({ title }) => title);

    expect(select?.getAttribute('aria-pressed')).toBe('true');
    expect(toolTitles).not.toContain('Select');
    expect(toolTitles).not.toContain('Sticky Highlight');

    annotations.destroy();
    toolbar.destroy();
  });

  it('does not duplicate zoom and Fit actions in More for a wide reader leaf', () => {
    const entries = captureMenuItems();
    const { host } = fixture();
    setToolbarWidth(host, 900);

    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();

    expect(entries.map(({ title }) => title)).not.toContain('Zoom & fit');
    expect(entries.map(({ title }) => title)).not.toContain('Fit height');
  });

  it.each([
    [600, true],
    [601, true],
    [760, true],
    [761, false],
  ] as const)('uses the same compact boundary at %ipx for More', (width, isCompact) => {
    const entries = captureMenuItems();
    const { host } = fixture();
    setToolbarWidth(host, width);

    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();

    expect(entries.some(({ title }) => title === 'Zoom · Fit width')).toBe(isCompact);
    expect(entries.some(({ title }) => title === 'Fit height')).toBe(isCompact);
  });

  it('opens More from touch pointer and ArrowDown without duplicate menus', () => {
    const entries = captureMenuItems();
    const { host } = fixture();
    const overflow = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (overflow === null) throw new Error('Expected More options.');
    const OwnerPointerEvent = (overflow.win as Window & { PointerEvent: typeof PointerEvent })
      .PointerEvent;
    const OwnerKeyboardEvent = (overflow.win as Window & { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;
    const OwnerMouseEvent = (overflow.win as Window & { MouseEvent: typeof MouseEvent }).MouseEvent;

    overflow.dispatchEvent(
      new OwnerPointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }),
    );
    expect(entries.filter(({ title }) => title === 'Layout')).toHaveLength(1);
    overflow.dispatchEvent(new OwnerMouseEvent('click', { bubbles: true, detail: 1 }));
    expect(entries.filter(({ title }) => title === 'Layout')).toHaveLength(1);
    overflow.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(entries.filter(({ title }) => title === 'Layout')).toHaveLength(1);
    expect(overflow.getAttribute('aria-expanded')).toBe('false');
  });

  it('omits OCR when no provider is qualified', () => {
    const entries = captureMenuItems();
    const { host, intents } = fixture();
    const overflow = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (overflow === null) throw new Error('Expected overflow control.');

    overflow.click();
    expect(entries.map(({ title }) => title)).toContain('Export annotations…');
    expect(entries.map(({ title }) => title)).not.toContain('Recognize page');
    expect(entries.map(({ title }) => title)).not.toContain('Recognize document');
    entries.find(({ title }) => title === 'Export annotations…')?.click();
    expect(intents).toContainEqual({ type: 'export-annotations' });
  });

  it('restores focus after nonfocusable dismissal but preserves a newly focused control', async () => {
    const menu = captureMenuHide();
    const { host, toolbar } = fixture();
    document.body.append(host);
    const trigger = host.querySelector<HTMLButtonElement>('[data-control="overflow"]');
    if (trigger === null) throw new Error('Expected More options.');
    const outside = document.body.createEl('button', { text: 'Outside control', type: 'button' });

    trigger.click();
    outside.focus();
    menu.hide();
    await nextAnimationFrame(host.win);
    expect(document.activeElement).toBe(outside);

    trigger.click();
    outside.focus();
    host.querySelector<HTMLButtonElement>('[data-control="fit-menu"]')?.click();
    await nextAnimationFrame(host.win);
    expect(document.activeElement).toBe(outside);
    menu.hide();
    await nextAnimationFrame(host.win);

    trigger.click();
    outside.remove();
    trigger.blur();
    menu.hide();
    await nextAnimationFrame(host.win);
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    trigger.remove();
    menu.hide();
    await nextAnimationFrame(host.win);
    expect(document.activeElement).not.toBe(trigger);

    toolbar.destroy();
    host.remove();
  });

  it('leaves native menu layout untouched while a reader menu is open', () => {
    const menu = captureMenuHide();
    const { host, toolbar } = fixture();
    document.body.append(host);

    host.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.click();
    expect(host.doc.body.classList.contains('abyss-documents-menu-open')).toBe(false);
    menu.hide();
    expect(host.doc.body.classList.contains('abyss-documents-menu-open')).toBe(false);

    toolbar.destroy();
    host.remove();
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
