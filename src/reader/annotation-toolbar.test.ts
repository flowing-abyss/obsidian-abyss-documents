import { describe, expect, it, vi } from 'vitest';
import { AnnotationToolbar } from './annotation-toolbar.js';

const palette = [
  { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
  { color: '#ff6666', meaning: '', name: 'Red' },
] as const;

describe('AnnotationToolbar', () => {
  it('offers only Select, Highlight, Ink, and Text in native order', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    expect(toolbar.tool).toBe('select');
    expect(toolbar.color).toBe('#ffd400');

    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-annotation-tool]')).map(
        (button) => button.dataset['annotationTool'],
      ),
    ).toEqual(['select', 'highlight', 'ink', 'freetext']);
    expect(host.textContent).not.toContain('Underline');
    expect(host.textContent).not.toContain('Text Note');
    expect(
      host.querySelector('[data-annotation-tool="freetext"]')?.getAttribute('aria-label'),
    ).toBe('Text');
    host.querySelector<HTMLButtonElement>('[data-annotation-tool="highlight"]')?.click();
    expect(onIntent).toHaveBeenCalledWith({ type: 'set-annotation-tool', tool: 'highlight' });
    expect(
      host.querySelector('[data-annotation-tool="select"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    toolbar.setTool('highlight');
    expect(
      host.querySelector('[data-annotation-tool="highlight"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    toolbar.destroy();
    host.remove();
  });

  it('names palette colors with their meanings and supports keyboard selection', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    const keyIdea = host.querySelector<HTMLButtonElement>('[data-annotation-color="#ffd400"]');
    expect(keyIdea?.getAttribute('aria-label')).toBe('Yellow — Key idea');
    expect(keyIdea?.title).toBe('Yellow — Key idea');
    keyIdea?.click();
    expect(onIntent).toHaveBeenCalledWith({ type: 'set-annotation-color', color: '#ffd400' });
    expect(keyIdea?.getAttribute('aria-pressed')).toBe('true');
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
    expect(
      host.querySelector('[data-region="annotation-read-only-reason"]')?.textContent,
    ).toContain('Signed PDF');
    toolbar.destroy();
    host.remove();
  });

  it('exposes reader-scoped undo and redo without claiming global shortcuts', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    host.querySelector<HTMLButtonElement>('[data-action="undo-annotation"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="redo-annotation"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(onIntent.mock.calls).toEqual([
      [{ type: 'undo-annotation' }],
      [{ type: 'redo-annotation' }],
      [{ type: 'delete-annotation' }],
    ]);
    toolbar.destroy();
    host.remove();
  });

  it('uses native button keyboard activation, case-insensitive color state, empty palettes, and idempotent teardown', () => {
    const host = document.body.createDiv();
    const onIntent = vi.fn();
    const toolbar = new AnnotationToolbar(host, palette, null, onIntent);
    const red = host.querySelector<HTMLButtonElement>('[data-annotation-color="#ff6666"]');
    red?.click();
    toolbar.setColor('#FF6666');
    expect(toolbar.color).toBe('#FF6666');
    expect(red?.getAttribute('aria-pressed')).toBe('true');
    toolbar.setColor('#000000');
    expect(red?.getAttribute('aria-pressed')).toBe('false');
    toolbar.destroy();
    toolbar.destroy();

    const empty = new AnnotationToolbar(host, [], null, vi.fn());
    expect(empty.root.querySelector('[data-annotation-color]')).toBeNull();
    empty.destroy();
    host.remove();
  });
});
