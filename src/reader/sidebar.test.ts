import { describe, expect, it, vi } from 'vitest';
import { ReaderShell, type ReaderShellIntent } from './reader-shell.js';
import { ReaderSidebar, type ReaderSidebarCallbacks } from './sidebar.js';

function callbacks(): ReaderSidebarCallbacks {
  return {
    onClose: vi.fn(),
    onOutlineNavigate: vi.fn(),
    onSearchNavigate: vi.fn(),
    onSearchQuery: vi.fn(),
    onTabChange: vi.fn(),
  };
}

describe('ReaderSidebar', () => {
  it('keeps sidebar DOM absent until an explicit open and remembers the selected tab', () => {
    const host = createDiv();
    const handlers = callbacks();
    const onIntent = (intent: ReaderShellIntent): void => {
      if (intent.type === 'toggle-sidebar') {
        if (shell.sidebar?.isOpen === true) shell.closeSidebar();
        else shell.openSidebar(shell.sidebar?.activeTab ?? 'outline', handlers);
      }
    };
    const shell = new ReaderShell(host, onIntent);

    expect(shell.sidebar).toBeNull();
    expect(host.querySelector('[data-region="sidebar"]')).toBeNull();

    shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]')?.click();
    expect(shell.sidebar?.activeTab).toBe('outline');
    shell.sidebar?.root.querySelector<HTMLButtonElement>('[data-sidebar-tab="search"]')?.click();
    expect(handlers.onTabChange).toHaveBeenCalledWith('search');
    shell.closeSidebar();
    shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]')?.click();

    expect(shell.sidebar?.activeTab).toBe('search');
    expect(shell.sidebar?.isOpen).toBe(true);
  });

  it('opens document search only for a view-local Ctrl/Cmd+F and focuses its field', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const outside = createEl('input');
    host.doc.body.append(outside);
    const handlers = callbacks();
    const onIntent = (intent: ReaderShellIntent): void => {
      if (intent.type === 'open-sidebar') shell.openSidebar(intent.tab, handlers);
    };
    const shell = new ReaderShell(host, onIntent);
    const OwnerKeyboardEvent = (
      shell.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;

    outside.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'f', metaKey: true }),
    );
    expect(shell.sidebar).toBeNull();

    const shortcut = new OwnerKeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'f',
    });
    shell.documentHost.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(true);
    expect(shell.sidebar?.activeTab).toBe('search');
    expect(shell.root.doc.activeElement).toBe(shell.sidebar?.searchPanel.input);
    expect(shell.sidebar?.root.textContent).not.toMatch(/annotation/iu);
  });

  it('removes a closed mobile overlay from focus and returns focus through its owner callback', () => {
    const host = createDiv();
    const handlers = callbacks();
    const sidebar = new ReaderSidebar(host, handlers, { mobile: true });
    sidebar.open('search');

    sidebar.close();

    expect(sidebar.root.hidden).toBe(true);
    expect(sidebar.root.getAttribute('aria-hidden')).toBe('true');
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('removes the owned document shortcut listener on shell destruction', () => {
    const host = createDiv();
    const onIntent = vi.fn();
    const shell = new ReaderShell(host, onIntent);
    const root = shell.root;
    const OwnerKeyboardEvent = (
      root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    shell.destroy();

    root.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'f' }),
    );

    expect(onIntent).not.toHaveBeenCalled();
  });

  it('closes through search Escape and the close control, then destroys retained DOM', () => {
    const host = createDiv();
    const handlers = callbacks();
    const sidebar = new ReaderSidebar(host, handlers);
    const OwnerKeyboardEvent = (
      sidebar.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    sidebar.open('search');
    sidebar.searchPanel.input.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
    );
    expect(sidebar.isOpen).toBe(false);

    sidebar.open('outline');
    sidebar.root.querySelector<HTMLButtonElement>('[data-action="close-sidebar"]')?.click();
    sidebar.close();
    expect(handlers.onClose).toHaveBeenCalledTimes(2);

    sidebar.destroy();
    expect(host.contains(sidebar.root)).toBe(false);
  });
});
