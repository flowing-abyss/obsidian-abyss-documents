import type { DocumentLocation, OutlineItem } from '../document-core/document.js';
import { ownerWindow } from './owner-dom.js';

interface OutlineRow {
  readonly element: HTMLElement;
  readonly item: OutlineItem;
  readonly branch: HTMLDetailsElement | null;
  readonly parentIndex: number | null;
}

export class OutlinePanel {
  readonly root: HTMLElement;

  private readonly tree: HTMLUListElement;
  private readonly rows: OutlineRow[] = [];
  private currentPageIndex = 0;

  constructor(
    host: HTMLElement,
    private readonly onNavigate: (location: DocumentLocation) => void,
  ) {
    const owner = ownerWindow(host);
    this.root = owner.createEl('section');
    this.root.className = 'abyss-reader-outline';
    this.root.dataset['sidebarPanel'] = 'outline';
    this.root.setAttribute('aria-label', 'Document outline');

    this.tree = owner.createEl('ul');
    this.tree.className = 'abyss-reader-outline-tree';
    this.tree.setAttribute('role', 'tree');
    this.tree.setAttribute('aria-label', 'Document outline');
    this.root.append(this.tree);
    host.append(this.root);
  }

  render(items: readonly OutlineItem[]): void {
    this.rows.length = 0;
    this.tree.replaceChildren();
    for (const item of items) this.appendItem(this.tree, item, 1, null);
    this.setRovingIndex(0, false);
    this.updateCurrentPage();
    if (items.length === 0) {
      const empty = ownerWindow(this.root).createEl('p');
      empty.className = 'abyss-reader-sidebar-empty';
      empty.textContent = 'No outline available.';
      this.tree.append(empty);
    }
  }

  setCurrentPage(pageIndex: number): void {
    this.currentPageIndex = Math.max(0, Math.floor(pageIndex));
    this.updateCurrentPage();
  }

  private appendItem(
    parent: HTMLUListElement,
    item: OutlineItem,
    level: number,
    parentIndex: number | null,
  ): void {
    const listItem = ownerWindow(this.root).createEl('li');
    listItem.setAttribute('role', 'treeitem');
    listItem.setAttribute('aria-level', String(level));
    listItem.dataset['outlineItem'] = item.id;
    parent.append(listItem);

    const hasChildren = item.children.length > 0;
    const branch = this.createBranch(listItem, hasChildren);
    const row = this.createRow(item, hasChildren, branch);
    (branch ?? listItem).append(row);

    const rowIndex = this.rows.length;
    this.rows.push({ branch, element: row, item, parentIndex });
    if (!hasChildren || branch === null) return;

    const group = ownerWindow(this.root).createEl('ul');
    group.setAttribute('role', 'group');
    branch.append(group);
    for (const child of item.children) this.appendItem(group, child, level + 1, rowIndex);
  }

  private createBranch(listItem: HTMLLIElement, hasChildren: boolean): HTMLDetailsElement | null {
    if (!hasChildren) return null;
    const branch = ownerWindow(this.root).createEl('details');
    branch.open = true;
    listItem.setAttribute('aria-expanded', 'true');
    listItem.append(branch);
    branch.addEventListener('toggle', () => {
      listItem.setAttribute('aria-expanded', String(branch.open));
    });
    return branch;
  }

  private createRow(
    item: OutlineItem,
    hasChildren: boolean,
    branch: HTMLDetailsElement | null,
  ): HTMLElement {
    const owner = ownerWindow(this.root);
    const row = hasChildren ? owner.createEl('summary') : owner.createEl('button');
    if (!hasChildren) (row as HTMLButtonElement).type = 'button';
    row.className = 'abyss-reader-outline-row';
    row.dataset['outlineRow'] = '';
    row.dataset['outlineId'] = item.id;
    row.textContent = item.label;
    row.tabIndex = -1;
    if (item.target === null) row.setAttribute('aria-disabled', 'true');
    row.addEventListener('click', () => {
      this.setRovingIndex(this.rowIndex(row), false);
      if (item.target !== null) this.onNavigate(item.target);
    });
    row.addEventListener('keydown', (event) => {
      this.onRowKeyDown(event, row, item, branch);
    });
    return row;
  }

  private onRowKeyDown(
    event: KeyboardEvent,
    row: HTMLElement,
    item: OutlineItem,
    branch: HTMLDetailsElement | null,
  ): void {
    const index = this.rowIndex(row);
    if (event.key === 'Enter' && item.target !== null) {
      event.preventDefault();
      this.onNavigate(item.target);
      return;
    }

    if (event.key === 'ArrowRight' && branch !== null) {
      this.moveRight(event, index, branch);
      return;
    }
    if (event.key === 'ArrowLeft') {
      this.moveLeft(event, index, branch);
      return;
    }
    const target = this.linearTarget(event.key, index);
    if (target === undefined) return;
    event.preventDefault();
    this.setRovingIndex(target, true);
  }

  private moveRight(event: KeyboardEvent, index: number, branch: HTMLDetailsElement): void {
    event.preventDefault();
    if (!branch.open) {
      branch.open = true;
      return;
    }
    const visible = this.visibleRowIndexes();
    const target = visible[visible.indexOf(index) + 1];
    if (target !== undefined) this.setRovingIndex(target, true);
  }

  private moveLeft(event: KeyboardEvent, index: number, branch: HTMLDetailsElement | null): void {
    event.preventDefault();
    if (branch?.open === true) {
      branch.open = false;
      return;
    }
    const target = this.rows[index]?.parentIndex;
    if (target !== null && target !== undefined) this.setRovingIndex(target, true);
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
      if (parent?.branch?.open === false) return false;
      parentIndex = parent?.parentIndex ?? null;
    }
    return true;
  }

  private rowIndex(element: HTMLElement): number {
    return this.rows.findIndex((row) => row.element === element);
  }

  private setRovingIndex(index: number, focus: boolean): void {
    if (this.rows.length === 0) return;
    const clamped = Math.min(this.rows.length - 1, Math.max(0, index));
    for (const [rowIndex, row] of this.rows.entries())
      row.element.tabIndex = rowIndex === clamped ? 0 : -1;
    if (focus) this.rows[clamped]?.element.focus();
  }

  private updateCurrentPage(): void {
    for (const row of this.rows) {
      if (row.item.target?.pageIndex === this.currentPageIndex)
        row.element.setAttribute('aria-current', 'location');
      else row.element.removeAttribute('aria-current');
    }
  }
}
