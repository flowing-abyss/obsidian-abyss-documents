import { describe, expect, it, vi } from 'vitest';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import { ReaderShell, type ReaderShellIntent } from './reader-shell.js';
import { ReaderSidebar, type ReaderSidebarCallbacks } from './sidebar.js';

function callbacks(): ReaderSidebarCallbacks {
  return {
    onAnnotationNavigate: vi.fn(),
    onClose: vi.fn(),
    onOutlineNavigate: vi.fn(),
    onSearchNavigate: vi.fn(),
    onSearchQuery: vi.fn(),
    onTabChange: vi.fn(),
  };
}

function toggleSidebar(shell: ReaderShell, handlers: ReaderSidebarCallbacks): void {
  const sidebar = shell.sidebar;
  if (sidebar?.isOpen === true) {
    shell.closeSidebar();
    return;
  }
  shell.openSidebar(sidebar?.activeTab ?? 'outline', handlers);
}

describe('ReaderSidebar', () => {
  it('constructs the annotation panel without requesting extraction until its tab is selected', () => {
    const handlers = callbacks();
    const sidebar = new ReaderSidebar(createDiv(), handlers);
    expect(handlers.onTabChange).not.toHaveBeenCalled();
    sidebar.root.querySelector<HTMLButtonElement>('[data-sidebar-tab="annotations"]')?.click();
    expect(handlers.onTabChange).toHaveBeenCalledWith('annotations');
    expect(sidebar.annotationsPanel.root.hidden).toBe(false);
  });
  it('passes configured color meanings into annotation cards', () => {
    const handlers = { ...callbacks(), annotationColorMeanings: { '#ffd400': 'Important' } };
    const sidebar = new ReaderSidebar(createDiv(), handlers);
    const annotation = {
      ...({} as DocumentAnnotation),
      identity: { kind: 'stable' as const, id: 'one' as never },
      type: 'highlight' as const,
      anchor: {
        kind: 'fixed-page' as const,
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left' as const,
        geometry: { kind: 'point' as const, point: { x: 0, y: 0 } },
      },
      color: '#ffd400',
      selectedText: 'Text',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: '',
      tags: [],
      links: [],
    };
    sidebar.annotationsPanel.setAnnotations([annotation]);
    expect(sidebar.annotationsPanel.root.textContent).toContain('Important');
  });
  it('forwards optional drag, copy, and insert callbacks into annotation cards', () => {
    const onAnnotationCopy = vi.fn();
    const onAnnotationInsert = vi.fn();
    const onAnnotationTransfer = vi.fn();
    const handlers = { ...callbacks(), onAnnotationCopy, onAnnotationInsert, onAnnotationTransfer };
    const sidebar = new ReaderSidebar(createDiv(), handlers);
    const item = {
      ...({} as DocumentAnnotation),
      identity: { kind: 'stable' as const, id: 'one' as never },
      type: 'highlight' as const,
      anchor: {
        kind: 'fixed-page' as const,
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left' as const,
        geometry: { kind: 'point' as const, point: { x: 0, y: 0 } },
      },
      color: null,
      selectedText: 'Text',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: '',
      tags: [],
      links: [],
    };
    sidebar.annotationsPanel.setAnnotations([item]);
    const row = sidebar.root.querySelector<HTMLElement>('[draggable="true"]');
    if (row === null) throw new Error('Expected draggable card.');
    const transfer = { setData: vi.fn() } as unknown as DataTransfer;
    row.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: transfer }),
    );
    sidebar.root.querySelector<HTMLButtonElement>('[data-action="copy-annotation-link"]')?.click();
    sidebar.root.querySelector<HTMLButtonElement>('[data-action="insert-annotation"]')?.click();
    expect(onAnnotationTransfer).toHaveBeenCalledWith(item, transfer);
    expect(onAnnotationCopy).toHaveBeenCalledWith(item);
    expect(onAnnotationInsert).toHaveBeenCalledWith(item);
  });
  it('keeps sidebar DOM absent until an explicit open and remembers the selected tab', () => {
    const host = createDiv();
    const handlers = callbacks();
    const onIntent = (intent: ReaderShellIntent): void => {
      if (intent.type === 'toggle-sidebar') toggleSidebar(shell, handlers);
    };
    const shell = new ReaderShell(host, onIntent);

    expect(shell.sidebar).toBeNull();
    expect(host.querySelector('[data-region="sidebar"]')).toBeNull();

    shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]')?.click();
    expect(shell.sidebar?.activeTab).toBe('outline');
    expect(shell.sidebar?.root.querySelector('[data-tab="outline"]')).not.toBeNull();
    shell.sidebar?.root.querySelector<HTMLButtonElement>('[data-sidebar-tab="search"]')?.click();
    expect(
      shell.sidebar?.root.querySelector('[data-tab="search"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(handlers.onTabChange).toHaveBeenCalledWith('search');
    shell.closeSidebar();
    shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]')?.click();

    expect(shell.sidebar?.activeTab).toBe('search');
    expect(shell.sidebar?.isOpen).toBe(true);
  });

  it('uses a fixed, roving tab order for Outline, Annotations, and Search', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const sidebar = new ReaderSidebar(host, callbacks());
    const tabs = Array.from(sidebar.root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const OwnerKeyboardEvent = (
      sidebar.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;

    expect(sidebar.tabLabels).toEqual(['Outline', 'Annotations', 'Search']);
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Outline', 'Annotations', 'Search']);
    tabs[0]?.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'End' }));

    expect(sidebar.activeTab).toBe('search');
    expect(sidebar.root.doc.activeElement).toBe(tabs[2]);
    tabs[2]?.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'Home' }));
    expect(sidebar.activeTab).toBe('outline');
    tabs[0]?.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(sidebar.activeTab).toBe('annotations');
    tabs[1]?.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(sidebar.activeTab).toBe('search');
    tabs[2]?.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(sidebar.activeTab).toBe('annotations');
    tabs[1]?.dispatchEvent(new OwnerKeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(sidebar.activeTab).toBe('outline');
    sidebar.destroy();
    host.remove();
  });

  it('keeps tab and panel relationships unique when two reader sidebars share a document', () => {
    const host = createDiv();
    const first = new ReaderSidebar(host, callbacks());
    const second = new ReaderSidebar(host, callbacks());
    const tabs = [first, second].flatMap((sidebar) =>
      Array.from(sidebar.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')),
    );
    const panels = [first, second].flatMap((sidebar) =>
      Array.from(sidebar.root.querySelectorAll<HTMLElement>('[role="tabpanel"]')),
    );

    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(6);
    expect(new Set(panels.map((panel) => panel.id)).size).toBe(6);
    for (const tab of tabs) {
      const panel = host.querySelector<HTMLElement>(`#${tab.getAttribute('aria-controls')}`);
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    first.destroy();
    second.destroy();
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
    expect(shell.sidebar?.root.textContent).toMatch(/annotations/iu);
  });

  it('removes a closed mobile overlay from focus and returns focus through its owner callback', () => {
    const host = createDiv();
    const handlers = callbacks();
    const sidebar = new ReaderSidebar(host, handlers, { mobile: true });
    sidebar.open('search');

    sidebar.close();

    expect(sidebar.root.classList.contains('is-mobile')).toBe(true);
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
