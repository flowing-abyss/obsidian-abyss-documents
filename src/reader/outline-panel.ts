import { setIcon } from 'obsidian';
import type { DocumentLocation, OutlineItem } from '../document-core/document.js';
import { ownerWindow } from './owner-dom.js';

interface OutlineRow {
  readonly chevron: HTMLSpanElement;
  readonly element: HTMLLIElement;
  readonly group: HTMLUListElement | null;
  readonly item: OutlineItem;
  readonly parentIndex: number | null;
}

interface FoldedSource {
  readonly ends: readonly number[];
  readonly starts: readonly number[];
  readonly text: string;
}

interface SourceRange {
  end: number;
  readonly start: number;
}

export class OutlinePanel {
  readonly root: HTMLElement;

  private readonly searchButton: HTMLButtonElement;
  private readonly searchInput: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly tree: HTMLUListElement;
  private readonly rows: OutlineRow[] = [];
  private readonly expanded = new Map<string, boolean>();
  private items: readonly OutlineItem[] = [];
  private currentPageIndex = 0;
  private query = '';

  constructor(
    host: HTMLElement,
    private readonly onNavigate: (location: DocumentLocation) => void,
  ) {
    const owner = ownerWindow(host);
    this.root = owner.createEl('section');
    this.root.className = 'abyss-reader-outline';
    this.root.dataset['sidebarPanel'] = 'outline';
    this.root.setAttribute('aria-label', 'Document outline');

    const controls = this.createSearchControls();
    this.searchButton = controls.button;
    this.searchInput = controls.input;

    this.tree = owner.createEl('ul');
    this.tree.className = 'abyss-reader-outline-tree';
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-label', 'Document outline');
    this.status = owner.createEl('p');
    this.status.className = 'abyss-reader-sidebar-empty abyss-reader-outline-empty';
    this.status.dataset['outlineStatus'] = '';
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    this.root.append(controls.root, this.tree, this.status);
    host.append(this.root);
  }

  render(items: readonly OutlineItem[]): void {
    this.items = items;
    this.query = '';
    this.searchInput.value = '';
    this.setSearchVisible(false);
    this.expanded.clear();
    this.initializeExpansion(items);
    this.renderTree();
  }

  setCurrentPage(pageIndex: number): void {
    this.currentPageIndex = Math.max(0, Math.floor(pageIndex));
    this.updateCurrentPage();
  }

  private initializeExpansion(items: readonly OutlineItem[]): void {
    for (const item of items) {
      if (item.children.length > 0) this.expanded.set(item.id, true);
      this.initializeExpansion(item.children);
    }
  }

  private createSearchControls(): {
    readonly button: HTMLButtonElement;
    readonly input: HTMLInputElement;
    readonly root: HTMLElement;
  } {
    const owner = ownerWindow(this.root);
    const root = owner.createDiv();
    root.className = 'abyss-reader-outline-controls';
    const button = owner.createEl('button');
    button.type = 'button';
    button.className = 'clickable-icon abyss-reader-outline-search-toggle';
    button.dataset['action'] = 'toggle-outline-search';
    button.setAttribute('aria-label', 'Find headings');
    button.setAttribute('aria-expanded', 'false');
    button.title = 'Find headings';
    setIcon(button, 'search');
    const input = owner.createEl('input');
    input.type = 'search';
    input.className = 'abyss-reader-outline-search';
    input.dataset['outlineSearch'] = '';
    input.placeholder = 'Find a heading…';
    input.setAttribute('aria-label', 'Find a heading');
    input.hidden = true;
    input.addEventListener('input', () => {
      this.query = this.foldText(input.value.trim());
      this.renderTree();
    });
    input.addEventListener('keydown', (event) => {
      this.onSearchKeyDown(event);
    });
    button.addEventListener('click', () => {
      this.toggleSearch();
    });
    root.append(input, button);
    return { button, input, root };
  }

  private onSearchKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (this.searchInput.value.length > 0) {
      this.searchInput.value = '';
      this.query = '';
      this.renderTree();
      this.searchInput.focus();
      return;
    }
    this.setSearchVisible(false);
    this.searchButton.focus();
  }

  private toggleSearch(): void {
    if (this.searchInput.hidden) {
      this.setSearchVisible(true);
      return;
    }
    this.searchInput.value = '';
    this.query = '';
    this.renderTree();
    this.setSearchVisible(false);
  }

  private renderTree(): void {
    const focusedId = this.focusedRowId();
    this.rows.length = 0;
    this.tree.replaceChildren();
    const visibleItems = this.filteredItems(this.items);
    for (const item of visibleItems) this.appendItem(this.tree, item, 1, null);
    this.restoreRovingRow(focusedId);
    this.updateCurrentPage();
    this.updateStatus(visibleItems.length > 0);
  }

  private updateStatus(hasItems: boolean): void {
    this.tree.hidden = !hasItems;
    this.status.hidden = hasItems;
    if (hasItems) {
      this.status.textContent = '';
      return;
    }
    this.status.textContent = this.query === '' ? 'No outline available.' : 'No matching headings';
  }

  private filteredItems(items: readonly OutlineItem[]): readonly OutlineItem[] {
    if (this.query === '') return items;
    return items.flatMap((item) => {
      const children = this.filteredItems(item.children);
      if (children.length === 0 && !this.foldText(item.label).includes(this.query)) return [];
      return [{ ...item, children }];
    });
  }

  private appendItem(
    parent: HTMLUListElement,
    item: OutlineItem,
    level: number,
    parentIndex: number | null,
  ): void {
    const listItem = this.createTreeItem(parent, item, level);
    const rowShell = this.createRowShell(listItem, level);
    const hasChildren = item.children.length > 0;
    listItem.addClass(hasChildren ? 'nav-folder' : 'nav-file');
    rowShell.addClass(hasChildren ? 'nav-folder-title' : 'nav-file-title');
    const chevron = this.createChevron(item, hasChildren);
    const label = this.createLabel(item.label);
    rowShell.append(chevron, label);
    const group = this.createGroup(listItem, hasChildren);
    const rowIndex = this.rows.length;
    this.rows.push({ chevron, element: listItem, group, item, parentIndex });
    this.installRowInteractions(listItem, item);
    if (group === null) return;
    const isExpanded = this.query !== '' || (this.expanded.get(item.id) ?? true);
    this.applyExpansion(rowIndex, isExpanded);
    for (const child of item.children) this.appendItem(group, child, level + 1, rowIndex);
  }

  private createTreeItem(
    parent: HTMLUListElement,
    item: OutlineItem,
    level: number,
  ): HTMLLIElement {
    const listItem = ownerWindow(this.root).createEl('li');
    listItem.className = 'tree-item abyss-reader-outline-treeitem';
    listItem.setAttribute('role', 'treeitem');
    listItem.setAttribute('aria-level', String(level));
    listItem.dataset['outlineItem'] = item.id;
    listItem.dataset['outlineId'] = item.id;
    listItem.setAttribute('aria-label', item.label);
    listItem.tabIndex = -1;
    listItem.title = item.label;
    if (item.target === null) listItem.setAttribute('aria-disabled', 'true');
    parent.append(listItem);
    return listItem;
  }

  private createRowShell(listItem: HTMLLIElement, level: number): HTMLElement {
    const rowShell = ownerWindow(this.root).createDiv();
    rowShell.className = 'tree-item-self abyss-reader-outline-row-shell';
    rowShell.dataset['outlineRow'] = '';
    rowShell.style.setProperty('--outline-depth', String(level - 1));
    listItem.append(rowShell);
    return rowShell;
  }

  private createLabel(text: string): HTMLElement {
    const owner = ownerWindow(this.root);
    const label = owner.createSpan();
    label.className = 'tree-item-inner abyss-reader-outline-label';
    label.dataset['outlineLabel'] = '';
    const ranges = this.matchRanges(text);
    if (ranges.length === 0) {
      label.textContent = text;
      return label;
    }

    let cursor = 0;
    for (const range of ranges) {
      label.append(owner.document.createTextNode(text.slice(cursor, range.start)));
      const highlighted = owner.createSpan();
      highlighted.className = 'abyss-reader-outline-match';
      highlighted.dataset['outlineMatch'] = '';
      highlighted.textContent = text.slice(range.start, range.end);
      label.append(highlighted);
      cursor = range.end;
    }
    label.append(owner.document.createTextNode(text.slice(cursor)));
    return label;
  }

  private matchRanges(text: string): readonly SourceRange[] {
    if (this.query === '') return [];
    const folded = this.foldSource(text);
    const ranges: SourceRange[] = [];
    for (let match = folded.text.indexOf(this.query); match >= 0;) {
      const start = folded.starts[match];
      const end = folded.ends[match + this.query.length - 1];
      if (start !== undefined && end !== undefined) {
        const previous = ranges[ranges.length - 1];
        if (previous !== undefined && start < previous.end)
          previous.end = Math.max(previous.end, end);
        else ranges.push({ end, start });
      }
      match = folded.text.indexOf(this.query, match + this.query.length);
    }
    return ranges;
  }

  private foldSource(text: string): FoldedSource {
    const starts: number[] = [];
    const ends: number[] = [];
    let foldedText = '';
    let sourceOffset = 0;
    for (const symbol of text) {
      const foldedSymbol = this.foldSymbol(symbol);
      foldedText += foldedSymbol;
      for (let index = 0; index < foldedSymbol.length; index += 1) {
        starts.push(sourceOffset);
        ends.push(sourceOffset + symbol.length);
      }
      sourceOffset += symbol.length;
    }
    return { ends, starts, text: foldedText };
  }

  private foldText(text: string): string {
    let folded = '';
    for (const symbol of text) folded += this.foldSymbol(symbol);
    return folded;
  }

  private foldSymbol(symbol: string): string {
    return symbol.normalize('NFD').toUpperCase().toLowerCase();
  }

  private createGroup(listItem: HTMLLIElement, hasChildren: boolean): HTMLUListElement | null {
    if (!hasChildren) return null;
    const group = ownerWindow(this.root).createEl('ul');
    group.className = 'tree-item-children nav-folder-children';
    group.setAttribute('role', 'group');
    listItem.append(group);
    return group;
  }

  private installRowInteractions(listItem: HTMLLIElement, item: OutlineItem): void {
    const owner = ownerWindow(this.root);
    listItem.addEventListener('click', (event) => {
      const target = event.target;
      if (
        target instanceof owner.Element &&
        target !== listItem &&
        target.closest('.abyss-reader-outline-row-shell')?.parentElement !== listItem
      )
        return;
      this.setRovingIndex(this.rowIndex(listItem), true);
      if (item.target !== null) this.onNavigate(item.target);
    });
    listItem.addEventListener('keydown', (event) => {
      if (event.target === listItem) this.onRowKeyDown(event, listItem, item);
    });
  }

  private createChevron(item: OutlineItem, hasChildren: boolean): HTMLSpanElement {
    const owner = ownerWindow(this.root);
    const slot = owner.createSpan();
    slot.className = 'nav-folder-collapse-indicator abyss-reader-outline-chevron';
    slot.dataset['outlineChevron'] = '';
    slot.setAttribute('aria-hidden', 'true');
    if (!hasChildren) return slot;
    slot.addClass('is-interactive');
    slot.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.query !== '') return;
      const index = this.rows.findIndex((candidate) => candidate.item.id === item.id);
      if (index < 0) return;
      this.setExpanded(index, !(this.expanded.get(item.id) ?? true));
      this.setRovingIndex(index, true);
    });
    return slot;
  }

  private onRowKeyDown(event: KeyboardEvent, row: HTMLLIElement, item: OutlineItem): void {
    const index = this.rowIndex(row);
    if (event.key === 'Enter' && item.target !== null) {
      event.preventDefault();
      this.onNavigate(item.target);
      return;
    }
    if (event.key === 'ArrowRight') {
      this.moveRight(event, index);
      return;
    }
    if (event.key === 'ArrowLeft') {
      this.moveLeft(event, index);
      return;
    }
    const target = this.linearTarget(event.key, index);
    if (target === undefined) return;
    event.preventDefault();
    this.setRovingIndex(target, true);
  }

  private moveRight(event: KeyboardEvent, index: number): void {
    const row = this.rows[index];
    if (row?.group === null || row === undefined) return;
    event.preventDefault();
    if (row.group.hidden && this.query === '') {
      this.setExpanded(index, true);
      return;
    }
    const child = this.rows.findIndex((candidate) => candidate.parentIndex === index);
    if (child >= 0) this.setRovingIndex(child, true);
  }

  private moveLeft(event: KeyboardEvent, index: number): void {
    const row = this.rows[index];
    if (row === undefined) return;
    event.preventDefault();
    if (row.group !== null && !row.group.hidden && this.query === '') {
      this.setExpanded(index, false);
      return;
    }
    if (row.parentIndex !== null) this.setRovingIndex(row.parentIndex, true);
  }

  private setExpanded(index: number, expanded: boolean): void {
    const row = this.rows[index];
    if (row?.group === null || row === undefined) return;
    this.expanded.set(row.item.id, expanded);
    this.applyExpansion(index, expanded);
  }

  private applyExpansion(index: number, expanded: boolean): void {
    const row = this.rows[index];
    if (row?.group === null || row === undefined) return;
    row.element.setAttribute('aria-expanded', String(expanded));
    row.group.hidden = !expanded;
    row.chevron.classList.toggle('is-interactive', this.query === '');
    row.chevron.replaceChildren();
    setIcon(row.chevron, expanded ? 'chevron-down' : 'chevron-right');
  }

  private linearTarget(key: string, index: number): number | undefined {
    const visible = this.visibleRowIndexes();
    const visibleIndex = visible.indexOf(index);
    switch (key) {
      case 'ArrowDown':
        return visible[visibleIndex + 1];
      case 'ArrowUp':
        return visible[visibleIndex - 1];
      case 'Home':
        return visible[0];
      case 'End':
        return visible[visible.length - 1];
      default:
        return undefined;
    }
  }

  private visibleRowIndexes(): number[] {
    return this.rows.flatMap((row, index) => (this.isVisible(row) ? [index] : []));
  }

  private isVisible(row: OutlineRow): boolean {
    let parentIndex = row.parentIndex;
    while (parentIndex !== null) {
      const parent = this.rows[parentIndex];
      if (parent?.group?.hidden === true) return false;
      parentIndex = parent?.parentIndex ?? null;
    }
    return true;
  }

  private focusedRowId(): string | null {
    const active = this.root.doc.activeElement;
    return active instanceof ownerWindow(this.root).HTMLElement
      ? (active.dataset['outlineId'] ?? null)
      : null;
  }

  private restoreRovingRow(focusedId: string | null): void {
    if (this.rows.length === 0) return;
    const focusedIndex = this.rows.findIndex((row) => row.item.id === focusedId);
    const firstVisible = this.visibleRowIndexes()[0] ?? 0;
    this.setRovingIndex(focusedIndex >= 0 ? focusedIndex : firstVisible, false);
  }

  private rowIndex(element: HTMLLIElement): number {
    return this.rows.findIndex((row) => row.element === element);
  }

  private setRovingIndex(index: number, focus: boolean): void {
    const visible = this.visibleRowIndexes();
    if (visible.length === 0) return;
    const target = visible.includes(index) ? index : (visible[0] ?? 0);
    for (const [rowIndex, row] of this.rows.entries())
      row.element.tabIndex = rowIndex === target ? 0 : -1;
    if (focus) this.rows[target]?.element.focus();
  }

  private updateCurrentPage(): void {
    const currentId = this.currentHeadingId();
    for (const row of this.rows) {
      if (row.item.id === currentId) row.element.setAttribute('aria-current', 'location');
      else row.element.removeAttribute('aria-current');
    }
  }

  private currentHeadingId(): string | null {
    let candidateId: string | null = null;
    let candidatePage = -1;
    const visit = (items: readonly OutlineItem[]): void => {
      for (const item of items) {
        const pageIndex = item.target?.pageIndex;
        if (
          pageIndex !== undefined &&
          pageIndex <= this.currentPageIndex &&
          pageIndex >= candidatePage
        ) {
          candidateId = item.id;
          candidatePage = pageIndex;
        }
        visit(item.children);
      }
    };
    visit(this.items);
    return candidateId;
  }

  private setSearchVisible(visible: boolean): void {
    this.searchInput.hidden = !visible;
    this.searchButton.setAttribute('aria-expanded', String(visible));
    this.root.classList.toggle('is-searching', visible);
    if (visible) this.searchInput.focus();
  }
}
