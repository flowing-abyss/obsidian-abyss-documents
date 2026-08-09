import { setIcon } from 'obsidian';
import type { SearchHit, SearchResultSet } from '../document-core/document.js';
import { ownerWindow } from './owner-dom.js';

export type SearchNavigationKind = 'direct' | 'next' | 'previous';

export interface SearchPanelCallbacks {
  readonly onClose: () => void;
  readonly onNavigate: (hit: SearchHit, index: number, kind: SearchNavigationKind) => void;
  readonly onQuery: (query: string) => void;
}

const RESULT_BATCH_SIZE = 50;

export class SearchPanel {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;

  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private results: SearchResultSet = { query: '', hits: [], complete: true };
  private visibleLimit = RESULT_BATCH_SIZE;
  private selectedIndex = -1;

  constructor(
    host: HTMLElement,
    private readonly callbacks: SearchPanelCallbacks,
  ) {
    const owner = ownerWindow(host);
    this.root = owner.createEl('section');
    this.root.className = 'abyss-reader-search';
    this.root.dataset['sidebarPanel'] = 'search';
    this.root.setAttribute('aria-label', 'Search document');

    const controls = this.createControls();
    this.input = controls.input;
    this.previous = controls.previous;
    this.next = controls.next;

    this.count = owner.createDiv();
    this.count.className = 'abyss-reader-search-count';
    this.count.dataset['searchCount'] = '';
    this.count.setAttribute('aria-live', 'polite');
    this.list = owner.createDiv();
    this.list.className = 'abyss-reader-search-results';
    this.list.setAttribute('role', 'list');
    this.root.append(controls.root, this.count, this.list);
    host.append(this.root);
    this.bindEvents();
    this.render();
  }

  private bindEvents(): void {
    this.input.addEventListener('input', () => {
      this.results = { query: this.input.value, hits: [], complete: false };
      this.selectedIndex = -1;
      this.visibleLimit = RESULT_BATCH_SIZE;
      this.render();
      this.callbacks.onQuery(this.input.value);
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (this.input.value.length > 0) {
        this.input.value = '';
        this.results = { query: '', hits: [], complete: true };
        this.selectedIndex = -1;
        this.render();
        this.callbacks.onQuery('');
      } else this.callbacks.onClose();
    });
    this.previous.addEventListener('click', () => {
      this.moveSelection('previous');
    });
    this.next.addEventListener('click', () => {
      this.moveSelection('next');
    });
  }

  setResults(results: SearchResultSet): void {
    if (results.query !== this.input.value) return;
    const selectedId = this.results.hits[this.selectedIndex]?.id;
    this.results = results;
    this.selectedIndex = this.nextSelectedIndex(results, selectedId);
    if (this.selectedIndex < 0 && results.hits.length > 0) this.selectedIndex = 0;
    this.render();
  }

  private nextSelectedIndex(results: SearchResultSet, selectedId: string | undefined): number {
    if (selectedId !== undefined) return results.hits.findIndex((hit) => hit.id === selectedId);
    return results.hits.length > 0 ? 0 : -1;
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  private render(): void {
    this.list.replaceChildren();
    const hitCount = this.results.hits.length;
    if (this.input.value.length === 0) this.count.textContent = '';
    else if (this.results.complete)
      this.count.textContent = `${hitCount} ${hitCount === 1 ? 'result' : 'results'}`;
    else this.count.textContent = `${hitCount}+ results`;

    const visible = this.results.hits.slice(0, this.visibleLimit);
    for (const [index, hit] of visible.entries()) this.list.append(this.resultButton(hit, index));
    if (hitCount > visible.length) {
      const more = ownerWindow(this.root).createEl('button');
      more.type = 'button';
      more.className = 'abyss-reader-search-more';
      more.dataset['action'] = 'show-more-results';
      more.textContent = `Show ${Math.min(RESULT_BATCH_SIZE, hitCount - visible.length)} more`;
      more.addEventListener('click', () => {
        this.visibleLimit += RESULT_BATCH_SIZE;
        this.render();
      });
      this.list.append(more);
    }
    this.previous.disabled = hitCount === 0;
    this.next.disabled = hitCount === 0;
  }

  private resultButton(hit: SearchHit, index: number): HTMLButtonElement {
    const button = ownerWindow(this.root).createEl('button');
    button.type = 'button';
    button.className = 'abyss-reader-search-result';
    button.dataset['searchResult'] = hit.id;
    button.setAttribute('role', 'listitem');
    if (index === this.selectedIndex) button.setAttribute('aria-current', 'true');
    const page = ownerWindow(this.root).createSpan();
    page.className = 'abyss-reader-search-page';
    page.textContent = `Page ${hit.pageIndex + 1}`;
    const preview = ownerWindow(this.root).createSpan();
    preview.className = 'abyss-reader-search-preview';
    preview.textContent = hit.preview;
    button.append(page, preview);
    button.addEventListener('click', () => {
      this.select(index, 'direct');
    });
    return button;
  }

  private moveSelection(direction: 'next' | 'previous'): void {
    if (this.results.hits.length === 0) return;
    const offset = direction === 'next' ? 1 : -1;
    const current = this.selectedIndex < 0 ? 0 : this.selectedIndex;
    const index = (current + offset + this.results.hits.length) % this.results.hits.length;
    this.select(index, direction);
  }

  private select(index: number, kind: SearchNavigationKind): void {
    const hit = this.results.hits[index];
    if (hit === undefined) return;
    this.selectedIndex = index;
    if (index >= this.visibleLimit) this.visibleLimit = index + 1;
    this.render();
    Array.from(this.list.querySelectorAll<HTMLElement>('[data-search-result]'))
      .find((element) => element.dataset['searchResult'] === hit.id)
      ?.focus();
    this.callbacks.onNavigate(hit, index, kind);
  }

  private iconButton(label: string, icon: 'chevron-down' | 'chevron-up'): HTMLButtonElement {
    const button = ownerWindow(this.root).createEl('button');
    button.type = 'button';
    button.className = 'clickable-icon abyss-reader-search-button';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, icon);
    return button;
  }

  private createControls(): {
    readonly root: HTMLElement;
    readonly input: HTMLInputElement;
    readonly previous: HTMLButtonElement;
    readonly next: HTMLButtonElement;
  } {
    const owner = ownerWindow(this.root);
    const root = owner.createDiv();
    root.className = 'abyss-reader-search-controls';
    const input = owner.createEl('input');
    input.type = 'search';
    input.className = 'abyss-reader-search-input';
    input.placeholder = 'Search document';
    input.setAttribute('aria-label', 'Search document');
    input.dataset['searchInput'] = '';
    const previous = this.iconButton('Previous result', 'chevron-up');
    previous.dataset['action'] = 'previous-result';
    const next = this.iconButton('Next result', 'chevron-down');
    next.dataset['action'] = 'next-result';
    root.append(input, previous, next);
    return { input, next, previous, root };
  }
}
