import { Menu } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AnnotationToolbar } from './annotation-toolbar.js';

const palette = [
  { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
  { color: '#ff6666', meaning: '', name: 'Red' },
] as const;

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

describe('AnnotationToolbar', () => {
  it('shows semantic Quick Highlight color and pressed state', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    expect(toolbar.tool).toBe('select');
    expect(toolbar.color).toBe('#ffd400');

    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-annotation-tool]')).map(
        (button) => button.dataset['annotationTool'],
      ),
    ).toEqual(['highlight', 'ink', 'freetext']);
    expect(host.textContent).not.toContain('Underline');
    expect(host.textContent).not.toContain('Text Note');
    expect(
      host.querySelector('[data-annotation-tool="freetext"]')?.getAttribute('aria-label'),
    ).toBe('Text');
    host.querySelector<HTMLButtonElement>('[data-annotation-tool="highlight"]')?.click();
    expect(onIntent).toHaveBeenCalledWith({ type: 'set-annotation-tool', tool: 'highlight' });
    toolbar.setTool('highlight');
    expect(
      host.querySelector('[data-annotation-tool="highlight"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      host.querySelector('[data-annotation-tool="highlight"]')?.getAttribute('aria-label'),
    ).toContain('Key idea');
    toolbar.destroy();
    host.remove();
  });

  it('selects semantic colors from the Quick Highlight menu without a permanent swatch strip', () => {
    const redChoice: { click: (() => void) | null; title: DocumentFragment | null } = {
      click: null,
      title: null,
    };
    vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (
      this: Menu,
      callback: Parameters<Menu['addItem']>[0],
    ) {
      let isRed = false;
      const item = {
        onClick(handler: () => void) {
          if (isRed) redChoice.click = handler;
          return item;
        },
        setChecked() {
          return item;
        },
        setIcon() {
          return item;
        },
        setTitle(title: DocumentFragment | string) {
          isRed = (typeof title === 'string' ? title : title.textContent) === 'Red';
          if (isRed && typeof title !== 'string') redChoice.title = title;
          return item;
        },
      };
      callback(item as never);
      return this;
    });
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    expect(host.querySelector('.abyss-annotation-colors')).toBeNull();
    expect(host.querySelector('[data-annotation-color]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]')?.click();
    redChoice.click?.();
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({ type: 'set-annotation-color', color: '#ff6666' });
    expect(
      redChoice.title
        ?.querySelector<HTMLElement>('.abyss-documents-menu-color')
        ?.style.getPropertyValue('--abyss-documents-menu-color'),
    ).toBe('#ff6666');
    toolbar.destroy();
    host.remove();
  });

  it('opens the Quick Highlight palette from a touch pointer without a duplicate click menu', () => {
    const addItem = vi.spyOn(Menu.prototype, 'addItem');
    const host = document.body.createDiv();
    const toolbar = new AnnotationToolbar(host, palette, null, vi.fn());
    const trigger = host.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]');
    if (trigger === null) throw new Error('Expected Quick Highlight menu.');
    const OwnerPointerEvent = (trigger.win as Window & { PointerEvent: typeof PointerEvent })
      .PointerEvent;
    const OwnerMouseEvent = (trigger.win as Window & { MouseEvent: typeof MouseEvent }).MouseEvent;

    trigger.dispatchEvent(
      new OwnerPointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }),
    );
    expect(addItem).toHaveBeenCalledTimes(palette.length);
    trigger.dispatchEvent(new OwnerMouseEvent('click', { bubbles: true, detail: 1 }));
    expect(addItem).toHaveBeenCalledTimes(palette.length);

    toolbar.destroy();
    host.remove();
  });

  it('opens the Quick Highlight palette with ArrowDown and leaves other keys untouched', () => {
    const addItem = vi.spyOn(Menu.prototype, 'addItem');
    const host = document.body.createDiv();
    const toolbar = new AnnotationToolbar(host, palette, null, vi.fn());
    const trigger = host.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]');
    if (trigger === null) throw new Error('Expected Quick Highlight menu.');

    const ignored = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' });
    trigger.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    expect(addItem).not.toHaveBeenCalled();

    const open = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowDown',
    });
    trigger.dispatchEvent(open);
    expect(open.defaultPrevented).toBe(true);
    expect(addItem).toHaveBeenCalledTimes(palette.length);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    toolbar.destroy();
    host.remove();
  });

  it('toggles active Quick Highlight and Ink tools back to Select', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);

    toolbar.setTool('highlight');
    host.querySelector<HTMLButtonElement>('[data-annotation-tool="highlight"]')?.click();
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'set-annotation-tool', tool: 'select' });

    toolbar.setTool('ink');
    host.querySelector<HTMLButtonElement>('[data-annotation-tool="ink"]')?.click();
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'set-annotation-tool', tool: 'select' });

    toolbar.destroy();
    host.remove();
  });

  it('keeps tools visible but disabled with a stable qualified read-only reason', () => {
    const host = document.body.createDiv();
    const toolbar = new AnnotationToolbar(
      host,
      palette,
      'Signed PDF documents are opened read-only to preserve signatures.',
      vi.fn(),
    );
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('[data-annotation-tool]')).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(
      host.querySelector('[data-region="annotation-toolbar"]')?.getAttribute('aria-description'),
    ).toContain('Signed PDF');
    expect(host.querySelector('[data-region="annotation-read-only-reason"]')).toBeNull();
    toolbar.destroy();
    host.remove();
  });

  it('restores Quick menu focus conditionally and ignores a disconnected trigger', async () => {
    const menu = captureMenuHide();
    const host = document.body.createDiv();
    const toolbar = new AnnotationToolbar(host, palette, null, vi.fn());
    const trigger = host.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]');
    if (trigger === null) throw new Error('Expected Quick Highlight menu.');
    const outside = document.body.createEl('button', { text: 'Outside control', type: 'button' });

    trigger.click();
    outside.focus();
    menu.hide();
    await nextAnimationFrame(host.win);
    expect(document.activeElement).toBe(outside);

    trigger.click();
    outside.focus();
    trigger.click();
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

  it('keeps Undo Redo and Delete out of the toolbar', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    expect(host.querySelector('[data-action="undo-annotation"]')).toBeNull();
    expect(host.querySelector('[data-action="redo-annotation"]')).toBeNull();
    expect(host.querySelector('[data-action="delete-annotation"]')).toBeNull();
    expect(onIntent).not.toHaveBeenCalled();
    toolbar.destroy();
    host.remove();
  });

  it('uses native button keyboard activation, case-insensitive color state, empty palettes, and idempotent teardown', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    toolbar.setColor('#FF6666');
    expect(toolbar.color).toBe('#FF6666');
    expect(
      host.querySelector('[data-annotation-tool="highlight"]')?.getAttribute('aria-label'),
    ).toContain('Red');
    toolbar.setColor('#000000');
    expect(
      host.querySelector('[data-annotation-tool="highlight"]')?.getAttribute('aria-label'),
    ).toContain('#000000');
    toolbar.destroy();
    toolbar.destroy();

    const empty = new AnnotationToolbar(host, [], null, vi.fn());
    expect(empty.root.querySelector('[data-annotation-color]')).toBeNull();
    expect(
      empty.root.querySelector('[data-annotation-tool="highlight"]')?.getAttribute('aria-label'),
    ).toContain('#ffd400');
    empty.destroy();
    host.remove();
  });
});
