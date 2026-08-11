import { Platform, setIcon } from 'obsidian';
import type { DocumentLocation, SearchHit } from '../document-core/document.js';
import { OutlinePanel } from './outline-panel.js';
import { ownerWindow } from './owner-dom.js';
import {
  SearchPanel,
  type SearchNavigationKind,
  type SearchPanelCallbacks,
} from './search-panel.js';

export type ReaderSidebarTab = 'outline' | 'annotations' | 'search';

const SIDEBAR_TABS: ReadonlyArray<{ readonly id: ReaderSidebarTab; readonly label: string }> = [
  { id: 'outline', label: 'Outline' },
  { id: 'annotations', label: 'Annotations' },
  { id: 'search', label: 'Search' },
];

const SIDEBAR_INSTANCE_COUNTS = new WeakMap<Document, number>();

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
  readonly annotationsPanel: HTMLElement;

  activeTab: ReaderSidebarTab = 'outline';
  isOpen = false;

  private readonly tabButtons = new Map<ReaderSidebarTab, HTMLButtonElement>();
  private readonly panelHost: HTMLElement;
  private readonly idPrefix: string;

  constructor(
    host: HTMLElement,
    private readonly callbacks: ReaderSidebarCallbacks,
    options: ReaderSidebarOptions = {},
  ) {
    const owner = ownerWindow(host);
    this.idPrefix = nextSidebarIdPrefix(host.doc);
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
    this.annotationsPanel = owner.createEl('section');
    this.annotationsPanel.className = 'abyss-reader-annotations';
    this.annotationsPanel.dataset['sidebarPanel'] = 'annotations';
    this.annotationsPanel.setAttribute('aria-label', 'Annotations');
    this.annotationsPanel.textContent = 'Annotations will appear here.';
    this.panelHost.append(this.annotationsPanel);
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

  get tabLabels(): readonly string[] {
    return SIDEBAR_TABS.map((tab) => tab.label);
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
    button.dataset['tab'] = tab;
    button.setAttribute('role', 'tab');
    button.id = this.tabId(tab);
    button.setAttribute('aria-controls', this.panelId(tab));
    button.textContent = label;
    button.addEventListener('click', () => {
      this.selectTab(tab, false, true);
    });
    button.addEventListener('keydown', (event) => {
      const index = SIDEBAR_TABS.findIndex((candidate) => candidate.id === tab);
      const nextIndex = this.tabTargetIndex(event.key, index);
      if (nextIndex === null) return;
      event.preventDefault();
      const next = SIDEBAR_TABS[nextIndex];
      if (next === undefined) return;
      this.selectTab(next.id, true, false);
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
    for (const tab of SIDEBAR_TABS) tabs.append(this.tabButton(tab.id, tab.label));
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
    this.annotationsPanel.hidden = tab !== 'annotations';
    this.searchPanel.root.hidden = tab !== 'search';
    this.outlinePanel.root.id = this.panelId('outline');
    this.outlinePanel.root.setAttribute('role', 'tabpanel');
    this.outlinePanel.root.setAttribute('aria-labelledby', this.tabId('outline'));
    this.annotationsPanel.id = this.panelId('annotations');
    this.annotationsPanel.setAttribute('role', 'tabpanel');
    this.annotationsPanel.setAttribute('aria-labelledby', this.tabId('annotations'));
    this.searchPanel.root.id = this.panelId('search');
    this.searchPanel.root.setAttribute('role', 'tabpanel');
    this.searchPanel.root.setAttribute('aria-labelledby', this.tabId('search'));
  }

  private selectTab(tab: ReaderSidebarTab, focusTab: boolean, focusPanel: boolean): void {
    this.activateTab(tab);
    if (focusTab) this.tabButtons.get(tab)?.focus();
    if (focusPanel && tab === 'search') this.searchPanel.focus();
    this.callbacks.onTabChange(tab);
  }

  private tabTargetIndex(key: string, index: number): number | null {
    if (key === 'Home') return 0;
    if (key === 'End') return SIDEBAR_TABS.length - 1;
    if (key === 'ArrowLeft' || key === 'ArrowUp')
      return (index - 1 + SIDEBAR_TABS.length) % SIDEBAR_TABS.length;
    if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % SIDEBAR_TABS.length;
    return null;
  }

  private tabId(tab: ReaderSidebarTab): string {
    return `${this.idPrefix}-tab-${tab}`;
  }

  private panelId(tab: ReaderSidebarTab): string {
    return `${this.idPrefix}-panel-${tab}`;
  }
}

function nextSidebarIdPrefix(doc: Document): string {
  const instance = (SIDEBAR_INSTANCE_COUNTS.get(doc) ?? 0) + 1;
  SIDEBAR_INSTANCE_COUNTS.set(doc, instance);
  return `abyss-reader-sidebar-${instance}`;
}
