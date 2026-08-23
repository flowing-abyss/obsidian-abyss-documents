import { describe, expect, it, vi } from 'vitest';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
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
    input: 'pointer',
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
      popover.open({ onIntent: (intent) => intents.push(intent), palette, selection: selection() });
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
      { color: '#ffd400', type: 'comment' },
      { color: '#ffd400', type: 'link' },
      { color: '#ffd400', type: 'tag' },
    ]);
    expect(
      Array.from(popover.element.querySelectorAll<HTMLButtonElement>('[data-selection-color]')).map(
        (button) => button.getAttribute('aria-label'),
      ),
    ).toEqual(['Highlight: Key idea', 'Highlight: Custom color']);
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
    buttons[1]?.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(popover.element.hidden).toBe(true);
    expect(intents).toEqual([{ type: 'dismiss' }]);
    expect(host.doc.activeElement).toBe(invoker);
    popover.destroy();
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
    popover.element.dispatchEvent(
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
    popover.destroy();
    host.remove();
  });
});
