import { setIcon } from 'obsidian';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { DocumentLocation } from '../document-core/document.js';
import { ownerWindow } from './owner-dom.js';

const MAX_CARDS = 80;
const ESTIMATED_CARD_HEIGHT = 112;
const SCROLL_OVERSCAN = 10;
const HEIGHT_EPSILON = 0.5;

export interface AnnotationPanelFilter {
  readonly query: string;
  readonly colors: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
}

export interface AnnotationsPanelOptions {
  readonly colorMeanings?: Readonly<Record<string, string>>;
  readonly onCopy?: (annotation: DocumentAnnotation) => void;
  readonly onInsert?: (annotation: DocumentAnnotation) => void;
  readonly onNavigate: (location: DocumentLocation) => void;
  readonly onTransfer?: (annotation: DocumentAnnotation, transfer: DataTransfer) => void;
  readonly onTransferFailure?: (annotation: DocumentAnnotation, cause: unknown) => void;
}

export class AnnotationsPanel {
  readonly root: HTMLElement;

  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly query: HTMLInputElement;
  private readonly colors: HTMLElement;
  private readonly tags: HTMLDetailsElement;
  private annotations: readonly DocumentAnnotation[] = [];
  private filtered: readonly DocumentAnnotation[] = [];
  private filter: AnnotationPanelFilter = { query: '', colors: new Set(), tags: new Set() };
  private currentPage = 0;
  private selectedAnnotationId: string | null = null;
  private windowStart = 0;
  private estimatedCardHeight = ESTIMATED_CARD_HEIGHT;
  private offsets: number[] = [0];
  private readonly measuredHeights = new Map<string, number>();
  private rowIds = new WeakMap<DocumentAnnotation, string>();
  private nextRowId = 0;
  private measurementFrame: number | null = null;
  private estimateCalibrated = false;
  private focusedRowId: string | null = null;
  private destroyed = false;
  private readonly onScroll = (): void => {
    if (this.destroyed || !this.updateWindowFromScroll()) return;
    this.render();
  };
  private readonly onResize = (): void => {
    if (!this.destroyed) this.invalidateMeasurements(true);
  };
  private readonly onDocumentFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof ownerWindow(this.root).Element)) return;
    this.focusedRowId = this.root.contains(target)
      ? target.getAttribute('data-annotation-row-id')
      : null;
  };

  constructor(
    host: HTMLElement,
    private readonly options: AnnotationsPanelOptions,
  ) {
    const owner = ownerWindow(host);
    this.root = owner.createEl('section');
    this.configureRoot();
    this.status = owner.createDiv();
    this.status.className = 'abyss-annotations-status';
    this.status.setAttribute('aria-live', 'polite');
    const controls = owner.createDiv();
    controls.className = 'abyss-annotation-controls';
    this.query = owner.createEl('input');
    this.query.type = 'search';
    this.query.placeholder = 'Filter annotations';
    this.query.setAttribute('aria-label', 'Filter annotations');
    this.query.dataset['annotationSearch'] = '';
    this.colors = owner.createDiv();
    this.colors.className = 'abyss-annotation-colors';
    this.colors.setAttribute('aria-label', 'Annotation colors');
    controls.append(this.query, this.colors);
    this.tags = owner.createEl('details');
    this.tags.className = 'abyss-annotation-tags';
    this.tags.dataset['section'] = 'tags';
    const summary = owner.createEl('summary');
    summary.textContent = 'Tags';
    this.tags.append(summary);
    this.list = owner.createDiv();
    this.list.className = 'abyss-annotations-list';
    this.list.setAttribute('role', 'list');
    this.root.append(controls, this.status, this.tags, this.list);
    host.append(this.root);
    this.bindEvents();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.removeEventListener('scroll', this.onScroll);
    ownerWindow(this.root).removeEventListener('resize', this.onResize);
    ownerWindow(this.root).document.removeEventListener('focusin', this.onDocumentFocusIn);
    if (this.measurementFrame !== null) {
      ownerWindow(this.root).cancelAnimationFrame(this.measurementFrame);
      this.measurementFrame = null;
    }
  }

  private configureRoot(): void {
    this.root.className = 'abyss-reader-annotations';
    this.root.dataset['sidebarPanel'] = 'annotations';
    this.root.setAttribute('aria-label', 'Annotations');
  }

  private bindEvents(): void {
    this.root.addEventListener('scroll', this.onScroll);
    ownerWindow(this.root).addEventListener('resize', this.onResize);
    ownerWindow(this.root).document.addEventListener('focusin', this.onDocumentFocusIn);
    this.query.addEventListener('input', () => {
      this.filter = { ...this.filter, query: this.query.value };
      this.resetVirtualScroll();
      this.applyFilter(true);
    });
  }

  setLoading(): void {
    this.status.removeAttribute('role');
    this.status.textContent = 'Loading annotations…';
  }

  setError(message: string): void {
    this.status.setAttribute('role', 'alert');
    this.status.textContent = message;
  }

  setAnnotations(annotations: readonly DocumentAnnotation[]): void {
    this.annotations = [...annotations];
    this.rowIds = new WeakMap();
    this.nextRowId = 0;
    this.clearMeasurements();
    this.resetVirtualScroll();
    this.status.removeAttribute('role');
    this.status.textContent = `${annotations.length} ${annotations.length === 1 ? 'annotation' : 'annotations'}`;
    this.renderFacets();
    this.applyFilter();
  }

  setFilter(filter: AnnotationPanelFilter): void {
    this.filter = filter;
    this.query.value = filter.query;
    this.resetVirtualScroll();
    this.renderFacets();
    this.applyFilter(true);
  }

  visibleIds(): string[] {
    return this.filtered.slice(this.windowStart, this.windowStart + MAX_CARDS).map(annotationId);
  }

  setCurrentPage(pageIndex: number): void {
    this.currentPage = Math.max(0, Math.floor(pageIndex));
    const selected = this.filtered.findIndex(
      (annotation) => annotationPage(annotation) === this.currentPage,
    );
    if (
      selected >= 0 &&
      (selected < this.windowStart || selected >= this.windowStart + MAX_CARDS)
    ) {
      this.root.scrollTop = this.scrollTopForIndex(selected);
      this.windowStart = clampWindowStart(selected - SCROLL_OVERSCAN, this.filtered.length);
    }
    this.render();
  }

  selectAnnotation(id: string): boolean {
    const index = this.filtered.findIndex((annotation) => annotationId(annotation) === id);
    if (index < 0) return false;
    this.selectedAnnotationId = id;
    this.root.scrollTop = this.scrollTopForIndex(index);
    this.windowStart = clampWindowStart(index - SCROLL_OVERSCAN, this.filtered.length);
    this.render();
    this.list.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`)?.focus();
    return true;
  }

  setResolutionError(kind: 'ambiguous' | 'unresolved', path: string): void {
    this.status.setAttribute('role', 'alert');
    this.status.textContent =
      kind === 'ambiguous'
        ? `The link in ${path} matches more than one annotation.`
        : `The linked annotation in ${path} could not be found.`;
  }

  private applyFilter(invalidateMeasurements = false): void {
    if (invalidateMeasurements) this.clearMeasurements();
    const query = normalize(this.filter.query.trim());
    const colors = new Set(Array.from(this.filter.colors, normalize));
    const tags = new Set(Array.from(this.filter.tags, normalize));
    this.filtered = this.annotations.filter((annotation) => {
      if (colors.size > 0 && !colors.has(normalize(annotation.color ?? ''))) return false;
      const annotationTags = new Set(annotation.tags.map(normalize));
      if (tags.size > 0 && !Array.from(tags).every((tag) => annotationTags.has(tag))) return false;
      if (query.length === 0) return true;
      return normalize(
        [
          annotation.selectedText,
          annotation.comment,
          annotation.author,
          ...annotation.tags,
          ...annotation.links,
        ]
          .filter((value): value is string => typeof value === 'string')
          .join(' '),
      ).includes(query);
    });
    this.rebuildOffsets();
    this.windowStart = clampWindowStart(this.windowStart, this.filtered.length);
    this.render();
  }

  private renderFacets(): void {
    this.colors.replaceChildren();
    const colorValues = Array.from(
      new Set(
        this.annotations.flatMap((annotation) =>
          annotation.color === null ? [] : [annotation.color],
        ),
      ),
    ).sort((left, right) => left.localeCompare(right));
    for (const color of colorValues) {
      const label = ownerWindow(this.root).createEl('label');
      const input = ownerWindow(this.root).createEl('input');
      input.type = 'checkbox';
      input.dataset['annotationColor'] = color;
      input.checked = this.filter.colors.has(color);
      input.addEventListener('change', () => {
        const selected = new Set(this.filter.colors);
        if (input.checked) selected.add(color);
        else selected.delete(color);
        this.filter = { ...this.filter, colors: selected };
        this.resetVirtualScroll();
        this.applyFilter(true);
      });
      label.append(input, this.options.colorMeanings?.[color] ?? color);
      this.colors.append(label);
    }

    this.tags.querySelectorAll('[data-annotation-tag-row]').forEach((row) => {
      row.remove();
    });
    const displayTags = new Map<string, string>();
    for (const annotation of this.annotations)
      for (const tag of annotation.tags) displayTags.set(normalize(tag), tag);
    for (const [key, display] of Array.from(displayTags.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    )) {
      const label = ownerWindow(this.root).createEl('label');
      label.dataset['annotationTagRow'] = '';
      const input = ownerWindow(this.root).createEl('input');
      input.type = 'checkbox';
      input.dataset['annotationTag'] = key;
      input.checked = Array.from(this.filter.tags, normalize).includes(key);
      input.addEventListener('change', () => {
        const selected = new Set(this.filter.tags);
        const previous = Array.from(selected).find((tag) => normalize(tag) === key);
        if (input.checked) selected.add(display);
        else if (previous !== undefined) selected.delete(previous);
        this.filter = { ...this.filter, tags: selected };
        this.resetVirtualScroll();
        this.applyFilter(true);
      });
      label.append(input, `#${display}`);
      this.tags.append(label);
    }
  }

  private render(): void {
    const focusedRowId = this.activeRowId();
    this.list.replaceChildren();
    const visible = this.filtered.slice(this.windowStart, this.windowStart + MAX_CARDS);
    if (visible.length > 0) this.list.append(this.spacer(this.offsetAt(this.windowStart), 'top'));
    for (const [offset, annotation] of visible.entries())
      this.list.append(this.card(annotation, this.windowStart + offset));
    const end = this.windowStart + visible.length;
    const remainingHeight = this.offsetAt(this.filtered.length) - this.offsetAt(end);
    if (visible.length > 0) this.list.append(this.spacer(remainingHeight, 'bottom'));
    if (this.filtered.length === 0) {
      const empty = ownerWindow(this.root).createEl('p');
      empty.className = 'abyss-reader-sidebar-empty';
      empty.textContent = 'No annotations match the current filters.';
      this.list.append(empty);
    }
    this.restoreFocusedRow(focusedRowId);
    this.scheduleMeasurement();
  }

  private spacer(height: number, edge: 'top' | 'bottom'): HTMLElement {
    const spacer = ownerWindow(this.root).createDiv();
    spacer.className = 'abyss-annotation-virtual-spacer';
    spacer.dataset['virtualSpacer'] = edge;
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.height = `${height}px`;
    return spacer;
  }

  private card(annotation: DocumentAnnotation, index: number): HTMLElement {
    const owner = ownerWindow(this.root);
    const row = this.cardRow(annotation, index);
    const button = owner.createEl('button');
    button.type = 'button';
    button.className = 'abyss-annotation-card';
    button.dataset['annotationId'] = annotationId(annotation);
    button.dataset['annotationRowId'] = this.rowId(annotation);
    button.tabIndex = index === this.windowStart ? 0 : -1;
    if (annotationPage(annotation) === this.currentPage)
      button.setAttribute('aria-current', 'location');
    if (annotationId(annotation) === this.selectedAnnotationId)
      button.setAttribute('aria-current', 'true');
    const header = owner.createDiv();
    header.className = 'abyss-annotation-card-header';
    const meaning =
      annotation.color === null ? undefined : this.options.colorMeanings?.[annotation.color];
    header.textContent = annotationHeader(annotation, meaning);
    const text = owner.createDiv();
    text.className = 'abyss-annotation-card-text';
    text.textContent =
      annotation.selectedText ??
      (annotation.comment.length > 0 ? annotation.comment : 'Annotation');
    button.append(header, text);
    button.addEventListener('click', () => {
      this.options.onNavigate(location(annotation));
    });
    button.addEventListener('keydown', (event) => {
      this.onKeyDown(event, index);
    });
    row.append(button);
    const actions = this.cardActions(annotation);
    if (actions !== null) row.append(actions);
    return row;
  }

  private cardRow(annotation: DocumentAnnotation, index: number): HTMLElement {
    const row = ownerWindow(this.root).createEl('article');
    row.className = 'abyss-annotation-card-row';
    row.dataset['annotationCardId'] = annotationId(annotation);
    row.dataset['annotationRowId'] = this.rowId(annotation);
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-posinset', String(index + 1));
    row.setAttribute('aria-setsize', String(this.filtered.length));
    row.draggable = isTransferableAnnotation(annotation);
    row.addEventListener('dragstart', (event) => {
      if (event.dataTransfer === null || !isTransferableAnnotation(annotation)) return;
      try {
        this.options.onTransfer?.(annotation, event.dataTransfer);
      } catch (cause) {
        event.preventDefault();
        this.options.onTransferFailure?.(annotation, cause);
      }
    });
    return row;
  }

  private cardActions(annotation: DocumentAnnotation): HTMLElement | null {
    if (!isTransferableAnnotation(annotation)) return null;
    if (this.options.onCopy === undefined && this.options.onInsert === undefined) return null;
    const actions = ownerWindow(this.root).createDiv();
    actions.className = 'abyss-annotation-card-actions';
    if (this.options.onCopy !== undefined) {
      actions.append(
        this.actionButton('copy-annotation-link', 'Copy annotation link', () => {
          this.options.onCopy?.(annotation);
        }),
      );
    }
    if (this.options.onInsert !== undefined) {
      actions.append(
        this.actionButton('insert-annotation', 'Insert into active Markdown note', () => {
          this.options.onInsert?.(annotation);
        }),
      );
    }
    return actions;
  }

  private actionButton(action: string, label: string, callback: () => void): HTMLButtonElement {
    const button = ownerWindow(this.root).createEl('button');
    button.type = 'button';
    button.className = 'clickable-icon abyss-annotation-card-action';
    button.dataset['action'] = action;
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, action === 'copy-annotation-link' ? 'copy' : 'file-input');
    button.addEventListener('click', callback);
    return button;
  }

  private onKeyDown(event: KeyboardEvent, index: number): void {
    let target: number | null = null;
    if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    if (event.key === 'ArrowDown') target = Math.min(this.filtered.length - 1, index + 1);
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = this.filtered.length - 1;
    if (target === null) return;
    event.preventDefault();
    if (target < this.windowStart || target >= this.windowStart + MAX_CARDS) {
      this.root.scrollTop = this.scrollTopForIndex(target);
      this.windowStart = clampWindowStart(target - SCROLL_OVERSCAN, this.filtered.length);
    }
    this.render();
    const annotation = this.filtered[target];
    if (annotation === undefined) return;
    this.list
      .querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(annotationId(annotation))}"]`)
      ?.focus();
  }

  private resetVirtualScroll(): void {
    this.windowStart = 0;
    this.root.scrollTop = 0;
  }

  private updateWindowFromScroll(): boolean {
    const target = this.indexAtOffset(this.virtualScrollTop()) - SCROLL_OVERSCAN;
    const next = clampWindowStart(target, this.filtered.length);
    if (next === this.windowStart) return false;
    this.windowStart = next;
    return true;
  }

  private rowId(annotation: DocumentAnnotation): string {
    const existing = this.rowIds.get(annotation);
    if (existing !== undefined) return existing;
    const id = `${annotationId(annotation)}:${this.nextRowId}`;
    this.nextRowId += 1;
    this.rowIds.set(annotation, id);
    return id;
  }

  private clearMeasurements(): void {
    this.measuredHeights.clear();
    this.estimatedCardHeight = ESTIMATED_CARD_HEIGHT;
    this.estimateCalibrated = false;
  }

  private rebuildOffsets(): void {
    const offsets = new Array<number>(this.filtered.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < this.filtered.length; index += 1) {
      const annotation = this.filtered[index];
      const previous = offsets[index] ?? 0;
      offsets[index + 1] =
        previous +
        (annotation === undefined
          ? this.estimatedCardHeight
          : (this.measuredHeights.get(this.rowId(annotation)) ?? this.estimatedCardHeight));
    }
    this.offsets = offsets;
  }

  private offsetAt(index: number): number {
    return this.offsets[Math.max(0, Math.min(index, this.filtered.length))] ?? 0;
  }

  private indexAtOffset(offset: number): number {
    if (this.filtered.length === 0) return 0;
    if (!Number.isFinite(offset) || offset >= this.offsetAt(this.filtered.length))
      return this.filtered.length - 1;
    let low = 0;
    let high = this.filtered.length;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (this.offsetAt(middle) <= Math.max(0, offset)) low = middle;
      else high = middle - 1;
    }
    return Math.min(low, this.filtered.length - 1);
  }

  private scheduleMeasurement(): void {
    if (this.destroyed || this.measurementFrame !== null || this.filtered.length === 0) return;
    this.measurementFrame = ownerWindow(this.root).requestAnimationFrame(() => {
      this.measurementFrame = null;
      this.measureRenderedRows();
    });
  }

  private measureRenderedRows(): void {
    if (this.destroyed) return;
    const activeRowId = this.activeRowId();
    const virtualScrollTop = this.virtualScrollTop();
    const anchorIndex = this.indexAtOffset(virtualScrollTop);
    const anchorDelta = virtualScrollTop - this.offsetAt(anchorIndex);
    const measurements = this.collectMeasurements();
    let { changed } = measurements;
    const { newlyMeasured } = measurements;
    if (!this.estimateCalibrated && newlyMeasured.length > 0) {
      this.estimatedCardHeight = Math.max(
        ESTIMATED_CARD_HEIGHT,
        newlyMeasured.reduce((sum, height) => sum + height, 0) / newlyMeasured.length,
      );
      this.estimateCalibrated = true;
      changed = true;
    }
    if (!changed) return;
    this.rebuildOffsets();
    this.root.scrollTop = this.scrollTopForIndex(anchorIndex) + anchorDelta;
    this.windowStart = this.windowStartForAnchor(anchorIndex, activeRowId);
    this.render();
  }

  private collectMeasurements(): { readonly changed: boolean; readonly newlyMeasured: number[] } {
    let changed = false;
    const newlyMeasured: number[] = [];
    const cards = Array.from(this.list.querySelectorAll<HTMLElement>('.abyss-annotation-card-row'));
    for (const card of cards) {
      const height = measuredCardHeight(card);
      const rowId = card.dataset['annotationRowId'];
      if (rowId === undefined || height <= 0) continue;
      const previous = this.measuredHeights.get(rowId);
      if (previous === undefined) newlyMeasured.push(height);
      if (previous !== undefined && Math.abs(previous - height) <= HEIGHT_EPSILON) continue;
      this.measuredHeights.set(rowId, height);
      changed = true;
    }
    return { changed, newlyMeasured };
  }

  private invalidateMeasurements(preserveAnchor: boolean): void {
    const focusedRowId = this.activeRowId();
    const virtualScrollTop = this.virtualScrollTop();
    const anchorIndex = this.indexAtOffset(virtualScrollTop);
    const anchor = preserveAnchor ? this.filtered[anchorIndex] : undefined;
    const delta = preserveAnchor ? virtualScrollTop - this.offsetAt(anchorIndex) : 0;
    this.clearMeasurements();
    this.rebuildOffsets();
    if (anchor !== undefined) {
      const index = this.filtered.indexOf(anchor);
      this.root.scrollTop = this.scrollTopForIndex(Math.max(0, index)) + delta;
      this.windowStart = clampWindowStart(index - SCROLL_OVERSCAN, this.filtered.length);
    }
    this.render();
    this.restoreFocusedRow(focusedRowId);
  }

  private restoreFocusedRow(rowId: string | undefined): void {
    if (rowId === undefined) return;
    const target = Array.from(
      this.list.querySelectorAll<HTMLElement>('.abyss-annotation-card[data-annotation-row-id]'),
    ).find((candidate) => candidate.dataset['annotationRowId'] === rowId);
    if (target === undefined) return;
    const scrollTop = this.root.scrollTop;
    target.focus();
    this.root.scrollTop = scrollTop;
  }

  private activeRowId(): string | undefined {
    const activeElement = ownerWindow(this.root).document.activeElement;
    return activeElement?.getAttribute('data-annotation-row-id') ?? this.focusedRowId ?? undefined;
  }

  private virtualScrollTop(): number {
    return Math.max(0, this.root.scrollTop - this.list.offsetTop);
  }

  private scrollTopForIndex(index: number): number {
    return this.list.offsetTop + this.offsetAt(index);
  }

  private windowStartForAnchor(anchorIndex: number, focusedRowId: string | undefined): number {
    let start = clampWindowStart(anchorIndex - SCROLL_OVERSCAN, this.filtered.length);
    if (focusedRowId === undefined) return start;
    const focusedIndex = this.filtered.findIndex(
      (annotation) => this.rowId(annotation) === focusedRowId,
    );
    if (focusedIndex < start) start = focusedIndex;
    if (focusedIndex >= start + MAX_CARDS) start = focusedIndex - MAX_CARDS + 1;
    return clampWindowStart(start, this.filtered.length);
  }
}

function measuredCardHeight(card: HTMLElement): number {
  const measuredHeight = card.getBoundingClientRect().height;
  const rectHeight = measuredHeight === 0 ? card.offsetHeight : measuredHeight;
  if (!Number.isFinite(rectHeight) || rectHeight <= 0) return 0;
  const margin = Number.parseFloat(ownerWindow(card).getComputedStyle(card).marginBlockEnd);
  return rectHeight + (Number.isFinite(margin) ? margin : 0);
}

function clampWindowStart(start: number, length: number): number {
  return Math.max(0, Math.min(Math.floor(start), Math.max(0, length - MAX_CARDS)));
}

function annotationId(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function isTransferableAnnotation(annotation: DocumentAnnotation): boolean {
  return annotation.identity.kind === 'stable' && annotation.anchor.kind === 'fixed-page';
}

function annotationPage(annotation: DocumentAnnotation): number {
  return annotation.anchor.kind === 'fixed-page' ? annotation.anchor.pageIndex : 0;
}

function annotationHeader(annotation: DocumentAnnotation, meaning: string | undefined): string {
  const label =
    annotation.identity.kind === 'stable' ? (meaning ?? annotation.type) : 'Pending save';
  return `Page ${annotationPage(annotation) + 1} · ${label}`;
}

function location(annotation: DocumentAnnotation): DocumentLocation {
  if (annotation.anchor.kind !== 'fixed-page') return { pageIndex: 0 };
  const { geometry } = annotation.anchor;
  if (geometry.kind === 'point')
    return { pageIndex: annotation.anchor.pageIndex, ...geometry.point };
  if (geometry.kind === 'rectangle')
    return {
      pageIndex: annotation.anchor.pageIndex,
      x: geometry.rectangle.x,
      y: geometry.rectangle.y,
    };
  if (geometry.kind === 'quadrilaterals')
    return { pageIndex: annotation.anchor.pageIndex, ...geometry.quadrilaterals[0]?.topLeft };
  return { pageIndex: annotation.anchor.pageIndex, ...geometry.paths[0]?.[0] };
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}
