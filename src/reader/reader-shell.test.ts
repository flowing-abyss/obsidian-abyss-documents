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

  it('returns focus to the invoking toolbar control after the sidebar closes', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const shell = new ReaderShell(host, (intent) => {
      if (intent.type !== 'toggle-sidebar') return;
      shell.openSidebar('outline', {
        onClose: () => undefined,
        onOutlineNavigate: () => undefined,
        onSearchNavigate: () => undefined,
        onSearchQuery: () => undefined,
        onTabChange: () => undefined,
      });
    });
    const toggle = shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]');
    if (toggle === null) throw new Error('Expected the sidebar toggle.');
    toggle.focus();
    toggle.click();
    const close = shell.sidebar?.root.querySelector<HTMLButtonElement>(
      '[data-action="close-sidebar"]',
    );
    if (close === undefined || close === null)
      throw new Error('Expected the sidebar close button.');
    close.focus();

    close.click();

    expect(shell.root.doc.activeElement).toBe(toggle);
    shell.destroy();
    host.remove();
  });

  it('announces reader changes through one polite live region', async () => {
    const shell = new ReaderShell(createDiv());

    shell.announce('Page 2 of 3');
    await new Promise((resolve) => shell.root.win.setTimeout(resolve, 0));

    const regions = shell.root.querySelectorAll('[role="status"][aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toBe('Page 2 of 3');
    shell.destroy();
  });

  it('applies a bounded stored desktop sidebar width without opening it', () => {
    const shell = new ReaderShell(createDiv(), () => undefined, { sidebarWidth: 900 });

    expect(shell.sidebar).toBeNull();
    expect(shell.root.style.getPropertyValue('--abyss-reader-sidebar-width')).toBe('480px');
    shell.destroy();
  });
});
