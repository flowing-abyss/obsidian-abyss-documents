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

export class OutlinePanel {
  readonly root: HTMLElement;

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

    const controls = owner.createDiv();
    controls.className = 'abyss-reader-outline-controls';
    this.searchInput = owner.createEl('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'abyss-reader-outline-search';
    this.searchInput.dataset['outlineSearch'] = '';
    this.searchInput.placeholder = 'Find a heading…';
    this.searchInput.setAttribute('aria-label', 'Find a heading');
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim().toLocaleLowerCase();
      this.renderTree();
    });
    controls.append(this.searchInput);

    this.tree = owner.createEl('ul');
    this.tree.className = 'abyss-reader-outline-tree';
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-label', 'Document outline');
    this.status = owner.createEl('p');
    this.status.className = 'abyss-reader-sidebar-empty abyss-reader-outline-empty';
    this.status.dataset['outlineStatus'] = '';
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    this.root.append(controls, this.tree, this.status);
    host.append(this.root);
  }

  render(items: readonly OutlineItem[]): void {
    this.items = items;
    this.query = '';
    this.searchInput.value = '';
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
      if (children.length === 0 && !item.label.toLocaleLowerCase().includes(this.query)) return [];
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
    listItem.className = 'abyss-reader-outline-treeitem';
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
    rowShell.className = 'abyss-reader-outline-row-shell';
    rowShell.dataset['outlineRow'] = '';
    rowShell.style.setProperty('--outline-depth', String(level - 1));
    listItem.append(rowShell);
    return rowShell;
  }

  private createLabel(text: string): HTMLElement {
    const owner = ownerWindow(this.root);
    const label = owner.createSpan();
    label.className = 'abyss-reader-outline-label';
    label.dataset['outlineLabel'] = '';
    const normalized = text.toLocaleLowerCase();
    if (this.query === '' || !normalized.includes(this.query)) {
      label.textContent = text;
      return label;
    }

    let cursor = 0;
    for (let match = normalized.indexOf(this.query); match >= 0;) {
      label.append(owner.document.createTextNode(text.slice(cursor, match)));
      const highlighted = owner.createSpan();
      highlighted.className = 'abyss-reader-outline-match';
      highlighted.dataset['outlineMatch'] = '';
      highlighted.textContent = text.slice(match, match + this.query.length);
      label.append(highlighted);
      cursor = match + this.query.length;
      match = normalized.indexOf(this.query, cursor);
    }
    label.append(owner.document.createTextNode(text.slice(cursor)));
    return label;
  }

  private createGroup(listItem: HTMLLIElement, hasChildren: boolean): HTMLUListElement | null {
    if (!hasChildren) return null;
    const group = ownerWindow(this.root).createEl('ul');
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
    slot.className = 'abyss-reader-outline-chevron';
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
}
