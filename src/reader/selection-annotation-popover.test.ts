import { describe, expect, it, vi } from 'vitest';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { SelectionAnnotationPopover } from './selection-annotation-popover.js';

const palette = [
  { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
  { color: '#123456', meaning: '   ', name: 'Blue' },
] as const;

function selection(overrides: Partial<PdfTextSelection['clientRect']> = {}): PdfTextSelection {
  return {
    clientRect: {
      bottom: 160,
      height: 20,
      left: 200,
      right: 300,
      top: 140,
      width: 100,
      ...overrides,
    },
    clientRects: [
      {
        bottom: overrides.bottom ?? 160,
        height: overrides.height ?? 20,
        left: overrides.left ?? 200,
        right: overrides.right ?? 300,
        top: overrides.top ?? 140,
        width: overrides.width ?? 100,
      },
    ],
    input: 'pointer',
    pageIndex: 0,
    text: 'Selected text',
    token: 'selection-token',
  };
}

function runNextFrame(host: HTMLElement): () => void {
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(host.win, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  return () => {
    if (frame === undefined) throw new Error('Expected a scheduled animation frame.');
    frame(0);
  };
}

function createPopover() {
  const host = document.body.createDiv();
  document.body.append(host);
  const intents: unknown[] = [];
  const popover = new SelectionAnnotationPopover(host);
  return { host, intents, popover };
}

describe('SelectionAnnotationPopover', () => {
  it('opens at the selection on the next animation frame', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 120, 40),
    });

    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });

    expect(popover.element.hidden).toBe(true);
    runFrame();
    expect(popover.element.hidden).toBe(false);
    expect(popover.element.style.left).toBe('190px');
    expect(popover.element.style.top).toBe('168px');
    expect(popover.element.getAttribute('role')).toBe('toolbar');
    popover.destroy();
    host.remove();
  });

  it('keeps viewport coordinates adjacent to the selection inside a contained workspace leaf', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 120, 40),
    });
    Object.defineProperty(popover.element, 'offsetParent', {
      value: { getBoundingClientRect: () => new DOMRect(50, 30, 800, 600) },
    });

    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();

    expect(popover.element.style.left).toBe('140px');
    expect(popover.element.style.top).toBe('138px');

    popover.open({
      onIntent: (intent) => intents.push(intent),
      palette,
      selection: selection({ left: 0, right: 10, width: 10 }),
    });
    runFrame();
    expect(popover.element.style.left).toBe('0px');
    popover.destroy();
    host.remove();
  });

  it('preserves Selection on pointerdown', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    const text = host.createSpan({ text: 'Selected text' });
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();
    const button = popover.element.querySelector<HTMLButtonElement>('[data-selection-color]');
    if (button === null) throw new Error('Expected a palette swatch.');
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });

    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.getSelection()?.toString()).toBe('Selected text');
    popover.destroy();
    host.remove();
  });

  it('clamps above below and inside visualViewport', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 100, 60),
    });
    Object.defineProperty(host.win, 'visualViewport', {
      configurable: true,
      value: { height: 200, offsetLeft: 20, offsetTop: 30, width: 300 },
    });
    popover.element.setCssProps({
      '--abyss-selection-safe-area-bottom': '18px',
      '--abyss-selection-safe-area-left': '16px',
      '--abyss-selection-safe-area-right': '24px',
      '--abyss-selection-safe-area-top': '12px',
    });

    popover.open({
      onIntent: (intent) => intents.push(intent),
      palette,
      selection: selection({ bottom: 50, left: 0, right: 10, top: 35, width: 10 }),
    });
    runFrame();
    expect(popover.element.style.left).toBe('36px');
    expect(popover.element.style.top).toBe('58px');

    popover.open({
      onIntent: (intent) => intents.push(intent),
      palette,
      selection: selection({ bottom: 228, left: 290, right: 300, top: 225, width: 10 }),
    });
    runFrame();
    expect(popover.element.style.left).toBe('196px');
    expect(popover.element.style.top).toBe('152px');
    Reflect.deleteProperty(host.win, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('emits highlight comment link and tag intents', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    const open = () => {
      popover.open({
        color: '#123456',
        onIntent: (intent) => intents.push(intent),
        palette,
        selection: selection(),
      });
      runFrame();
    };

    open();
    popover.element.querySelector<HTMLButtonElement>('[data-selection-color="#123456"]')?.click();
    open();
    popover.element.querySelector<HTMLButtonElement>('[data-selection-intent="comment"]')?.click();
    open();
    popover.element.querySelector<HTMLButtonElement>('[data-selection-intent="link"]')?.click();
    open();
    popover.element.querySelector<HTMLButtonElement>('[data-selection-intent="tag"]')?.click();

    expect(intents).toEqual([
      { color: '#123456', type: 'highlight' },
      { color: '#123456', type: 'comment' },
      { color: '#123456', type: 'link' },
      { color: '#123456', type: 'tag' },
    ]);
    expect(
      Array.from(popover.element.querySelectorAll<HTMLButtonElement>('[data-selection-color]')).map(
        (button) => button.getAttribute('aria-label'),
      ),
    ).toEqual(['Highlight: Key idea', 'Highlight: Custom color — Blue']);
    popover.destroy();
    host.remove();
  });

  it('supports roving keyboard focus and Escape', () => {
    const { host, intents, popover } = createPopover();
    const invoker = host.createEl('button');
    invoker.focus();
    const runFrame = runNextFrame(host);
    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();
    const buttons = Array.from(popover.element.querySelectorAll<HTMLButtonElement>('button'));
    buttons[0]?.focus();
    const OwnerKeyboardEvent = (host.win as Window & { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;

    buttons[0]?.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    );

    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    expect(host.doc.activeElement).toBe(buttons[1]);
    invoker.focus();
    invoker.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(popover.element.hidden).toBe(true);
    expect(intents).toEqual([{ type: 'dismiss' }]);
    expect(host.doc.activeElement).toBe(invoker);
    popover.destroy();
    host.remove();
  });

  it('supports the full roving-key matrix and ignores unsupported keyboard targets', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();
    const buttons = Array.from(popover.element.querySelectorAll<HTMLButtonElement>('button'));
    const key = (target: EventTarget, value: string) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value });
      target.dispatchEvent(event);
      return event;
    };

    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (first === undefined || last === undefined) throw new Error('Expected action buttons.');
    first.focus();
    expect(key(first, 'ArrowLeft').defaultPrevented).toBe(true);
    expect(host.doc.activeElement).toBe(last);
    expect(key(last, 'ArrowDown').defaultPrevented).toBe(true);
    expect(host.doc.activeElement).toBe(first);
    expect(key(first, 'End').defaultPrevented).toBe(true);
    expect(host.doc.activeElement).toBe(last);
    expect(key(last, 'Home').defaultPrevented).toBe(true);
    expect(host.doc.activeElement).toBe(first);
    expect(key(first, 'ArrowUp').defaultPrevented).toBe(true);
    expect(host.doc.activeElement).toBe(last);
    expect(key(last, 'Enter').defaultPrevented).toBe(false);
    expect(key(popover.element, 'ArrowRight').defaultPrevented).toBe(false);

    popover.destroy();
    host.remove();
  });

  it('dismisses on an outside pointer and restores focus to the document body without a host', () => {
    const { host, intents, popover } = createPopover();
    const invoker = host.createEl('button');
    invoker.focus();
    const runFrame = runNextFrame(host);
    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();
    invoker.remove();
    host.remove();

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

    expect(popover.isOpen).toBe(false);
    expect(intents).toEqual([{ type: 'dismiss' }]);
    expect(document.activeElement).toBe(document.body);
    popover.destroy();
  });

  it('ignores malformed or stale action buttons and uses the default metadata color', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);

    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();
    const swatch = popover.element.querySelector<HTMLButtonElement>('[data-selection-color]');
    if (swatch === null) throw new Error('Expected swatch.');
    delete swatch.dataset['selectionColor'];
    swatch.click();
    expect(popover.isOpen).toBe(true);

    const comment = popover.element.querySelector<HTMLButtonElement>(
      '[data-selection-intent="comment"]',
    );
    if (comment === null) throw new Error('Expected comment action.');
    comment.dataset['selectionIntent'] = 'unknown';
    comment.click();
    expect(popover.isOpen).toBe(true);

    popover.close();
    comment.click();
    expect(intents).toEqual([]);

    popover.open({
      onIntent: (intent) => intents.push(intent),
      palette: [],
      selection: selection(),
    });
    runFrame();
    popover.element.querySelector<HTMLButtonElement>('[data-selection-intent="tag"]')?.click();
    expect(intents).toEqual([{ color: '#ffd400', type: 'tag' }]);

    popover.destroy();
    popover.destroy();
    expect(() => {
      popover.open({ onIntent: vi.fn(), palette, selection: selection() });
    }).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    host.remove();
  });

  it('returns focus without forcing comment focus', () => {
    const { host, intents, popover } = createPopover();
    const invoker = host.createEl('button');
    invoker.focus();
    const runFrame = runNextFrame(host);

    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();

    expect(host.doc.activeElement).toBe(invoker);
    invoker.dispatchEvent(
      new (host.win as Window & { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      }),
    );
    expect(host.doc.activeElement).toBe(invoker);
    expect(host.querySelector('textarea')).toBeNull();
    popover.destroy();
    host.remove();
  });

  it('keeps the original return focus across replacement opens and falls back when it is removed', () => {
    const { host, intents, popover } = createPopover();
    const invoker = host.createEl('button');
    invoker.focus();
    const runFrame = runNextFrame(host);
    const open = () => {
      popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
      runFrame();
    };

    open();
    popover.element.querySelector<HTMLButtonElement>('button')?.focus();
    open();
    invoker.dispatchEvent(
      new (host.win as Window & { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      }),
    );
    expect(host.doc.activeElement).toBe(invoker);

    invoker.focus();
    open();
    invoker.remove();
    host.doc.body.dispatchEvent(
      new (host.win as Window & { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      }),
    );
    expect(host.doc.activeElement).toBe(host);
    popover.destroy();
    host.remove();
  });

  it('contains the default palette in a narrow visual viewport with a scrollable swatch strip', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 176, 52),
    });
    Object.defineProperty(host.win, 'visualViewport', {
      configurable: true,
      value: { height: 120, offsetLeft: 40, offsetTop: 20, width: 180 },
    });

    popover.open({
      onIntent: (intent) => intents.push(intent),
      palette: DEFAULT_SETTINGS.annotations.palette,
      selection: selection({ bottom: 100, left: 100, right: 120, top: 80, width: 20 }),
    });
    runFrame();

    expect(popover.element.style.maxWidth).toBe('180px');
    expect(popover.element.style.left).toBe('40px');
    expect(popover.element.querySelector('[data-region="selection-swatch-strip"]')).not.toBeNull();
    expect(
      popover.element
        .querySelector('[data-region="selection-swatch-strip"]')
        ?.getAttribute('data-overflow'),
    ).toBe('scroll');
    expect(popover.element.querySelector('[data-region="selection-actions"]')).not.toBeNull();
    expect(popover.element.querySelectorAll('button')).toHaveLength(11);
    Reflect.deleteProperty(host.win, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('gives every default blank-meaning swatch a unique semantic name', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    popover.open({
      onIntent: (intent) => intents.push(intent),
      palette: DEFAULT_SETTINGS.annotations.palette,
      selection: selection(),
    });
    runFrame();

    const labels = Array.from(
      popover.element.querySelectorAll<HTMLButtonElement>('[data-selection-color]'),
      (button) => button.getAttribute('aria-label'),
    );
    expect(new Set(labels).size).toBe(DEFAULT_SETTINGS.annotations.palette.length);
    expect(
      labels.every((label) =>
        label === null ? false : label.startsWith('Highlight: Custom color — '),
      ),
    ).toBe(true);
    expect(labels.some((label) => (label === null ? false : label.includes('#')))).toBe(false);
    popover.destroy();
    host.remove();
  });

  it('uses 44 pixel coarse-pointer targets', () => {
    const { host, intents, popover } = createPopover();
    const runFrame = runNextFrame(host);
    popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
    runFrame();

    expect(
      Array.from(popover.element.querySelectorAll<HTMLElement>('button')).map(
        (button) => button.dataset['touchTarget'],
      ),
    ).toEqual(['44', '44', '44', '44', '44']);
    expect(
      Array.from(popover.element.querySelectorAll('button')).every((button) =>
        button.classList.contains('abyss-selection-annotation-popover-button'),
      ),
    ).toBe(true);
    expect(popover.element.querySelector('[data-region="selection-swatch-strip"]')).not.toBeNull();
    popover.destroy();
    host.remove();
  });
});
