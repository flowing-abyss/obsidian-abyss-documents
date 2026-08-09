import { Platform, setIcon } from 'obsidian';
import type { DocumentLocation, SearchHit } from '../document-core/document.js';
import { OutlinePanel } from './outline-panel.js';
import { ownerWindow } from './owner-dom.js';
import {
  SearchPanel,
  type SearchNavigationKind,
  type SearchPanelCallbacks,
} from './search-panel.js';

export type ReaderSidebarTab = 'outline' | 'search';

export interface ReaderSidebarCallbacks {
  readonly onClose: () => void;
  readonly onTabChange: (tab: ReaderSidebarTab) => void;
  readonly onOutlineNavigate: (location: DocumentLocation) => void;
  readonly onSearchNavigate: (hit: SearchHit, index: number, kind: SearchNavigationKind) => void;
  readonly onSearchQuery: (query: string) => void;
}

interface ReaderSidebarOptions {
  readonly mobile?: boolean;
}

export class ReaderSidebar {
  readonly root: HTMLElement;
  readonly outlinePanel: OutlinePanel;
  readonly searchPanel: SearchPanel;

  activeTab: ReaderSidebarTab = 'outline';
  isOpen = false;

  private readonly tabButtons = new Map<ReaderSidebarTab, HTMLButtonElement>();
  private readonly panelHost: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly callbacks: ReaderSidebarCallbacks,
    options: ReaderSidebarOptions = {},
  ) {
    const owner = ownerWindow(host);
    this.root = owner.createEl('aside');
    this.root.className = 'abyss-reader-sidebar';
    if (options.mobile ?? Platform.isMobile) this.root.addClass('is-mobile');
    this.root.dataset['region'] = 'sidebar';
    this.root.setAttribute('aria-label', 'Document sidebar');
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');

    const header = this.createHeader();
    this.panelHost = owner.createDiv();
    this.panelHost.className = 'abyss-reader-sidebar-panels';
    this.root.append(header, this.panelHost);
    host.append(this.root);

    this.outlinePanel = new OutlinePanel(this.panelHost, callbacks.onOutlineNavigate);
    const searchCallbacks: SearchPanelCallbacks = {
      onClose: () => {
        this.close();
      },
      onNavigate: callbacks.onSearchNavigate,
      onQuery: callbacks.onSearchQuery,
    };
    this.searchPanel = new SearchPanel(this.panelHost, searchCallbacks);
    this.activateTab('outline');
  }

  open(tab: ReaderSidebarTab): void {
    this.isOpen = true;
    this.root.hidden = false;
    this.root.removeAttribute('aria-hidden');
    this.activateTab(tab);
    if (tab === 'search') this.searchPanel.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    this.callbacks.onClose();
  }

  destroy(): void {
    this.isOpen = false;
    this.root.remove();
  }

  private tabButton(tab: ReaderSidebarTab, label: string): HTMLButtonElement {
    const button = ownerWindow(this.root).createEl('button');
    button.type = 'button';
    button.className = 'abyss-reader-sidebar-tab';
    button.dataset['sidebarTab'] = tab;
    button.setAttribute('role', 'tab');
    button.textContent = label;
    button.addEventListener('click', () => {
      this.activateTab(tab);
      if (tab === 'search') this.searchPanel.focus();
      this.callbacks.onTabChange(tab);
    });
    this.tabButtons.set(tab, button);
    return button;
  }

  private createHeader(): HTMLElement {
    const owner = ownerWindow(this.root);
    const header = owner.createDiv();
    header.className = 'abyss-reader-sidebar-header';
    const tabs = owner.createDiv();
    tabs.className = 'abyss-reader-sidebar-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Document sidebar');
    tabs.append(this.tabButton('outline', 'Outline'), this.tabButton('search', 'Search'));
    const close = owner.createEl('button');
    close.type = 'button';
    close.className = 'clickable-icon abyss-reader-sidebar-close';
    close.dataset['action'] = 'close-sidebar';
    close.setAttribute('aria-label', 'Close document sidebar');
    close.title = 'Close document sidebar';
    setIcon(close, 'x');
    close.addEventListener('click', () => {
      this.close();
    });
    header.append(tabs, close);
    return header;
  }

  private activateTab(tab: ReaderSidebarTab): void {
    this.activeTab = tab;
    for (const [id, button] of this.tabButtons) {
      const active = id === tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    this.outlinePanel.root.hidden = tab !== 'outline';
    this.searchPanel.root.hidden = tab !== 'search';
  }
}
