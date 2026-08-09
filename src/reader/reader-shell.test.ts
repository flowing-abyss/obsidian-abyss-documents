import { describe, expect, it, vi } from 'vitest';
import { ReaderShell } from './reader-shell.js';

describe('ReaderShell', () => {
  it('starts with the sidebar absent from layout', () => {
    const host = createDiv();

    const shell = new ReaderShell(host);

    expect(shell.root.querySelector('[data-region="toolbar"]')).not.toBeNull();
    expect(shell.root.querySelector('[data-region="document"]')).toBe(shell.documentHost);
    expect(shell.root.querySelector('[data-region="sidebar"]')).toBeNull();
    shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]')?.click();
  });

  it('removes only its owned reader root when destroyed', () => {
    const host = createDiv();
    const sibling = createDiv();
    host.append(sibling);
    const shell = new ReaderShell(host);

    shell.destroy();
    shell.destroy();
    const cleanup = shell.onThemeChange(() => undefined);
    cleanup();

    expect(Array.from(host.children)).toEqual(expect.arrayContaining([sibling]));
    expect(host.contains(shell.root)).toBe(false);
  });

  it('observes theme changes in its owner document and disconnects on destroy', async () => {
    const host = createDiv();
    host.doc.body.addClass('theme-light');
    const shell = new ReaderShell(host);
    const onThemeChange = vi.fn();
    const cleanup = shell.onThemeChange(onThemeChange);
    cleanup();
    cleanup();
    shell.onThemeChange(onThemeChange);

    host.doc.body.removeClass('theme-light');
    host.doc.body.addClass('theme-dark');
    await vi.waitFor(() => {
      expect(onThemeChange).toHaveBeenCalledWith('dark');
    });
    shell.destroy();
    onThemeChange.mockClear();
    host.doc.body.removeClass('theme-dark');
    host.doc.body.addClass('theme-light');
    await new Promise((resolve) => host.win.setTimeout(resolve, 0));

    expect(onThemeChange).not.toHaveBeenCalled();
  });
});
