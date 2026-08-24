import { setTooltip } from 'obsidian';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { DocumentLocation } from '../document-core/document.js';
import { maximizeReaderCounter, recordReaderPerformanceSample } from '../reader-performance.js';
import { ownerWindow, type ReaderOwnerWindow } from './owner-dom.js';

const MAX_CARDS = 48;
const MAX_COLOR_FACETS = 16;
const MAX_TAG_FACETS = 48;
const ESTIMATED_CARD_HEIGHT = 112;
const SCROLL_OVERSCAN = 10;
const HEIGHT_EPSILON = 0.5;

type AnnotationPanelState = 'loading' | 'empty' | 'content' | 'filtered-empty' | 'unavailable';

interface AnnotationPanelUnavailableOptions {
  readonly onRetry?: () => void;
}

interface AnnotationFocusTarget {
  readonly action: string | null;
  readonly rowId: string;
}

export interface AnnotationPanelFilter {
  readonly query: string;
  readonly colors: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
}

export interface AnnotationColorFacet {
  readonly color: string;
  readonly meaning: string;
  readonly count: number;
}

export interface AnnotationsPanelOptions {
  readonly colorMeanings?: Readonly<Record<string, string>>;
  readonly colorNames?: Readonly<Record<string, string>>;
  readonly onCopy?: (annotation: DocumentAnnotation) => void;
  readonly onInsert?: (annotation: DocumentAnnotation) => void;
  readonly onNavigate: (location: DocumentLocation) => void;
  readonly onTransfer?: (annotation: DocumentAnnotation, transfer: DataTransfer) => void;
  readonly onTransferFailure?: (annotation: DocumentAnnotation, cause: unknown) => void;
}

export class AnnotationsPanel {
  readonly root: HTMLElement;

  private readonly controls: HTMLElement;
  private readonly contextStatus: HTMLElement;
  private readonly list: HTMLElement;
  private readonly scrollHost: HTMLElement;
  private readonly status: HTMLElement;
  private readonly query: HTMLInputElement;
  private readonly colors: HTMLElement;
  private readonly colorSearch: HTMLInputElement;
  private readonly colorRows: HTMLElement;
  private readonly tags: HTMLDetailsElement;
  private readonly tagSearch: HTMLInputElement;
  private readonly tagRows: HTMLElement;
  private displayTags: ReadonlyArray<readonly [string, string]> = [];
  private displayColors: readonly AnnotationColorFacet[] = [];
  private annotations: readonly DocumentAnnotation[] = [];
  private filtered: readonly DocumentAnnotation[] = [];
  private filter: AnnotationPanelFilter = { query: '', colors: new Set(), tags: new Set() };
  private currentPage = 0;
  private state: AnnotationPanelState = 'loading';
  private unavailableOptions: AnnotationPanelUnavailableOptions = {};
  private selectedAnnotationId: string | null = null;
  private windowStart = 0;
  private estimatedCardHeight = ESTIMATED_CARD_HEIGHT;
  private offsets: number[] = [0];
  private readonly measuredHeights = new Map<string, number>();
  private rowIds = new WeakMap<DocumentAnnotation, string>();
  private nextRowId = 0;
  private measurementFrame: number | null = null;
  private estimateCalibrated = false;
  private focusedTarget: AnnotationFocusTarget | null = null;
  private openActionsRowId: string | null = null;
  private suppressedActionsRowId: string | null = null;
  private touchNavigationGuardRowId: string | null = null;
  private destroyed = false;
  private readonly onScroll = (): void => {
    if (this.destroyed || !this.updateWindowFromScroll()) return;
    this.render();
  };
  private readonly onResize = (): void => {
    if (!this.destroyed) this.invalidateMeasurements(true);
  };
  private readonly onTagsToggle = (): void => {
    if (!this.destroyed) this.renderTagFacets();
  };
  private readonly onTagSearchInput = (): void => {
    if (!this.destroyed) this.renderTagRows();
  };
  private readonly onColorSearchInput = (): void => {
    if (!this.destroyed) this.renderColorRows();
  };
  private readonly onDocumentFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof ownerWindow(this.root).Element)) return;
    const row = target.closest<HTMLElement>('.abyss-annotation-card-row');
    this.closeContextActionsExcept(row);
    if (!this.root.contains(target) || row === null) {
      this.focusedTarget = null;
      return;
    }
    const rowId = row.dataset['annotationRowId'];
    const action = target.closest<HTMLElement>('[data-action]')?.dataset['action'] ?? null;
    if (action !== null && rowId !== undefined && this.suppressedActionsRowId === rowId) {
      this.suppressedActionsRowId = null;
      row.removeAttribute('data-actions-suppressed');
    }
    this.focusedTarget = rowId === undefined ? null : { action, rowId };
  };
  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    const row =
      target instanceof ownerWindow(this.root).Element
        ? target.closest('.abyss-annotation-card-row')
        : null;
    this.closeContextActionsExcept(row);
  };

  constructor(
    host: HTMLElement,
    private readonly options: AnnotationsPanelOptions,
  ) {
    const owner = ownerWindow(host);
    this.root = owner.createEl('section');
    this.configureRoot();
    this.status = createStatus(owner);
    this.contextStatus = createContextStatus(owner);
    this.controls = owner.createDiv();
    this.controls.className = 'abyss-annotation-controls';
    this.query = owner.createEl('input');
    this.query.type = 'search';
    this.query.placeholder = 'Filter annotations';
    this.query.setAttribute('aria-label', 'Filter annotations');
    this.query.dataset['annotationSearch'] = '';
    const colorControls = createColorFacetControls(owner);
    this.colors = colorControls.colors;
    this.colorSearch = colorControls.search;
    this.colorRows = colorControls.rows;
    this.controls.append(this.query, this.colors);
    const tagControls = createTagFacetControls(owner);
    this.tags = tagControls.tags;
    this.tagSearch = tagControls.search;
    this.tagRows = tagControls.rows;
    this.list = owner.createDiv();
    this.list.className = 'abyss-annotations-list';
    this.list.setAttribute('role', 'list');
    this.scrollHost = createScrollHost(owner, this.status, this.list);
    this.mount(host);
    this.bindEvents();
    this.renderState();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scrollHost.removeEventListener('scroll', this.onScroll);
    ownerWindow(this.root).removeEventListener('resize', this.onResize);
    ownerWindow(this.root).document.removeEventListener('focusin', this.onDocumentFocusIn);
    ownerWindow(this.root).document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.tags.removeEventListener('toggle', this.onTagsToggle);
    this.tagSearch.removeEventListener('input', this.onTagSearchInput);
    this.colorSearch.removeEventListener('input', this.onColorSearchInput);
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

  private mount(host: HTMLElement): void {
    this.root.append(this.controls, this.contextStatus, this.scrollHost, this.tags);
    host.append(this.root);
  }

  private bindEvents(): void {
    this.scrollHost.addEventListener('scroll', this.onScroll);
    ownerWindow(this.root).addEventListener('resize', this.onResize);
    ownerWindow(this.root).document.addEventListener('focusin', this.onDocumentFocusIn);
    ownerWindow(this.root).document.addEventListener('pointerdown', this.onDocumentPointerDown);
    this.tags.addEventListener('toggle', this.onTagsToggle);
    this.tagSearch.addEventListener('input', this.onTagSearchInput);
    this.colorSearch.addEventListener('input', this.onColorSearchInput);
    this.query.addEventListener('input', () => {
      this.filter = { ...this.filter, query: this.query.value };
      this.resetVirtualScroll();
      this.applyFilter(true);
    });
  }

  setLoading(): void {
    this.clearResolutionFeedback();
    this.state = 'loading';
    this.unavailableOptions = {};
    this.renderState();
  }

  setUnavailable(options: AnnotationPanelUnavailableOptions = {}): void {
    this.clearResolutionFeedback();
    this.unavailableOptions = options;
    this.state = this.annotations.length === 0 ? 'unavailable' : this.dataState();
    this.renderState();
  }

  setAnnotations(annotations: readonly DocumentAnnotation[]): void {
    this.clearResolutionFeedback();
    this.resetContextualActions();
    this.annotations = [...annotations];
    this.rowIds = new WeakMap();
    this.nextRowId = 0;
    this.clearMeasurements();
    this.resetVirtualScroll();
    this.unavailableOptions = {};
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
      this.scrollHost.scrollTop = this.scrollTopForIndex(selected);
      this.windowStart = clampWindowStart(selected - SCROLL_OVERSCAN, this.filtered.length);
    }
    this.render();
  }

  selectAnnotation(id: string): boolean {
    const index = this.filtered.findIndex((annotation) => annotationId(annotation) === id);
    if (index < 0) return false;
    this.clearResolutionFeedback();
    this.selectedAnnotationId = id;
    this.scrollHost.scrollTop = this.scrollTopForIndex(index);
    this.windowStart = clampWindowStart(index - SCROLL_OVERSCAN, this.filtered.length);
    this.render();
    this.list.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`)?.focus();
    return true;
  }

  setResolutionError(kind: 'ambiguous' | 'unresolved', path: string): void {
    this.contextStatus.hidden = false;
    this.contextStatus.setAttribute('role', 'alert');
    this.contextStatus.textContent =
      kind === 'ambiguous'
        ? `The link in ${path} matches more than one annotation.`
        : `The linked annotation in ${path} could not be found.`;
  }

  private applyFilter(invalidateMeasurements = false): void {
    const startedAt = ownerWindow(this.root).performance.now();
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
    this.state = this.dataState();
    this.render();
    recordReaderPerformanceSample(
      query.length === 0 ? 'annotationFilterMs' : 'annotationSearchMs',
      ownerWindow(this.root).performance.now() - startedAt,
    );
  }

  private renderFacets(): void {
    const colorCounts = new Map<string, number>();
    for (const annotation of this.annotations) {
      if (annotation.color === null) continue;
      colorCounts.set(annotation.color, (colorCounts.get(annotation.color) ?? 0) + 1);
    }
    this.displayColors = Array.from(colorCounts, ([color, count]) => ({
      color,
      count,
      meaning: colorMeaning(color, this.options.colorMeanings),
    })).sort((left, right) => left.color.localeCompare(right.color));
    this.renderColorFacets();

    const displayTags = new Map<string, string>();
    for (const annotation of this.annotations)
      for (const tag of annotation.tags) displayTags.set(normalize(tag), tag);
    this.displayTags = Array.from(displayTags.entries()).sort((a, b) => a[1].localeCompare(b[1]));
    this.renderTagFacets();
  }

  private renderColorFacets(): void {
    this.colorSearch.hidden = this.displayColors.length <= MAX_COLOR_FACETS;
    this.renderColorRows();
  }

  private renderColorRows(): void {
    this.colorRows.replaceChildren();
    const query = normalize(this.colorSearch.value.trim());
    const selected = new Set(Array.from(this.filter.colors, normalize));
    const matching = this.displayColors.filter(
      (facet) =>
        query.length === 0 ||
        normalize(facet.color).includes(query) ||
        normalize(facet.meaning).includes(query),
    );
    const visible = [
      ...this.displayColors.filter((facet) => selected.has(normalize(facet.color))),
      ...matching.filter((facet) => !selected.has(normalize(facet.color))),
    ].slice(0, MAX_COLOR_FACETS);
    for (const facet of visible) {
      const chip = ownerWindow(this.root).createEl('button');
      chip.type = 'button';
      chip.className = 'abyss-annotation-color-chip';
      chip.dataset['annotationColorRow'] = '';
      chip.dataset['annotationColor'] = facet.color;
      chip.style.setProperty('--abyss-annotation-color', facet.color);
      const pressed = selected.has(normalize(facet.color));
      chip.setAttribute('aria-pressed', String(pressed));
      chip.setAttribute('aria-label', this.colorFacetAccessibleLabel(facet));
      const swatch = ownerWindow(this.root).createSpan();
      swatch.className = 'abyss-annotation-color-chip-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const meaning = ownerWindow(this.root).createSpan();
      meaning.className = 'abyss-annotation-color-chip-meaning';
      meaning.textContent = facet.meaning;
      const count = ownerWindow(this.root).createSpan();
      count.className = 'abyss-annotation-color-chip-count';
      count.textContent = String(facet.count);
      chip.append(swatch, meaning, count);
      chip.addEventListener('click', () => {
        const next = new Set(this.filter.colors);
        const previous = Array.from(next).find(
          (candidate) => normalize(candidate) === normalize(facet.color),
        );
        if (previous === undefined) next.add(facet.color);
        else next.delete(previous);
        chip.setAttribute('aria-pressed', String(previous === undefined));
        this.filter = { ...this.filter, colors: next };
        this.resetVirtualScroll();
        this.applyFilter(true);
      });
      this.colorRows.append(chip);
    }
    this.recordPanelDomMaximum();
  }

  private renderTagFacets(): void {
    this.tagSearch.hidden = !this.tags.open || this.displayTags.length <= MAX_TAG_FACETS;
    if (!this.tags.open) {
      this.tagRows.replaceChildren();
      return;
    }
    this.renderTagRows();
  }

  private renderTagRows(): void {
    this.tagRows.replaceChildren();
    const query = normalize(this.tagSearch.value.trim());
    const selected = new Set(Array.from(this.filter.tags, normalize));
    const matching = this.displayTags.filter(
      ([key, display]) =>
        query.length === 0 || key.includes(query) || normalize(display).includes(query),
    );
    const visible = [
      ...this.displayTags.filter(([key]) => selected.has(key)),
      ...matching.filter(([key]) => !selected.has(key)),
    ].slice(0, MAX_TAG_FACETS);
    for (const [key, display] of visible) {
      const label = ownerWindow(this.root).createEl('label');
      label.dataset['annotationTagRow'] = '';
      const input = ownerWindow(this.root).createEl('input');
      input.type = 'checkbox';
      input.dataset['annotationTag'] = key;
      input.checked = selected.has(key);
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
      this.tagRows.append(label);
    }
    this.recordPanelDomMaximum();
  }

  private render(): void {
    const focusedTarget = this.activeFocusTarget();
    this.list.replaceChildren();
    const visible = this.filtered.slice(this.windowStart, this.windowStart + MAX_CARDS);
    if (visible.length > 0) this.list.append(this.spacer(this.offsetAt(this.windowStart), 'top'));
    for (const [offset, annotation] of visible.entries())
      this.list.append(this.card(annotation, this.windowStart + offset));
    const end = this.windowStart + visible.length;
    const remainingHeight = this.offsetAt(this.filtered.length) - this.offsetAt(end);
    if (visible.length > 0) this.list.append(this.spacer(remainingHeight, 'bottom'));
    this.renderState();
    this.restoreFocusedTarget(focusedTarget);
    maximizeReaderCounter(
      'maxAnnotationCards',
      this.list.querySelectorAll('.abyss-annotation-card').length,
    );
    this.recordPanelDomMaximum();
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

  private recordPanelDomMaximum(): void {
    maximizeReaderCounter('maxAnnotationPanelNodes', this.root.querySelectorAll('*').length);
  }

  private card(annotation: DocumentAnnotation, index: number): HTMLElement {
    const owner = ownerWindow(this.root);
    const row = this.cardRow(annotation, index);
    const button = owner.createEl('button');
    button.type = 'button';
    button.className = 'abyss-annotation-card';
    button.style.setProperty('--abyss-annotation-color', annotation.color ?? 'transparent');
    button.dataset['annotationId'] = annotationId(annotation);
    button.dataset['annotationRowId'] = this.rowId(annotation);
    button.tabIndex = index === this.windowStart ? 0 : -1;
    if (annotationPage(annotation) === this.currentPage)
      button.setAttribute('aria-current', 'location');
    if (annotationId(annotation) === this.selectedAnnotationId)
      button.setAttribute('aria-current', 'true');
    button.append(
      this.cardHeader(annotation),
      ...[
        this.cardQuote(annotation),
        this.cardComment(annotation),
        this.cardLinks(annotation),
        this.cardTags(annotation),
      ].filter((element): element is HTMLElement => element !== null),
    );
    button.addEventListener('click', (event) => {
      const rowId = this.rowId(annotation);
      if (this.touchNavigationGuardRowId === rowId) {
        this.touchNavigationGuardRowId = null;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      this.clearResolutionFeedback();
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

  private cardHeader(annotation: DocumentAnnotation): HTMLElement {
    const owner = ownerWindow(this.root);
    const header = owner.createDiv();
    header.className = 'abyss-annotation-card-header';
    const page = owner.createSpan();
    page.dataset['annotationPage'] = '';
    page.textContent = `Page ${annotationPage(annotation) + 1}`;
    const meaning = owner.createSpan();
    meaning.className = 'abyss-annotation-card-meaning';
    meaning.dataset['annotationMeaning'] = '';
    meaning.style.setProperty('--abyss-annotation-color', annotation.color ?? 'transparent');
    meaning.textContent = annotationMeaning(annotation, this.options.colorMeanings);
    header.append(page, meaning);
    if (annotation.identity.kind !== 'stable') {
      const pending = owner.createSpan();
      pending.className = 'abyss-annotation-card-pending';
      pending.textContent = 'Pending save';
      header.append(pending);
    }
    return header;
  }

  private cardQuote(annotation: DocumentAnnotation): HTMLElement | null {
    const quote = nonEmpty(annotation.selectedText);
    if (quote === null) return null;
    const text = ownerWindow(this.root).createDiv();
    text.className = 'abyss-annotation-card-text abyss-annotation-card-quote';
    text.dataset['annotationQuote'] = '';
    text.textContent = quote;
    return text;
  }

  private cardComment(annotation: DocumentAnnotation): HTMLElement | null {
    const comment = nonEmpty(annotation.comment);
    if (comment === null) return null;
    const note = ownerWindow(this.root).createDiv();
    note.className = 'abyss-annotation-card-text abyss-annotation-card-comment';
    note.dataset['annotationComment'] = '';
    note.textContent = comment;
    return note;
  }

  private cardLinks(annotation: DocumentAnnotation): HTMLElement | null {
    const links = annotation.links.map(nonEmpty).filter((value): value is string => value !== null);
    if (links.length === 0) return null;
    const owner = ownerWindow(this.root);
    const linkRow = owner.createDiv();
    linkRow.className = 'abyss-annotation-card-links';
    linkRow.dataset['annotationLinks'] = '';
    for (const link of links) {
      const item = owner.createSpan();
      item.className = 'abyss-annotation-card-link';
      item.dataset['annotationLink'] = link;
      item.textContent = link;
      linkRow.append(item);
    }
    return linkRow;
  }

  private cardTags(annotation: DocumentAnnotation): HTMLElement | null {
    const tags = annotation.tags.map(nonEmpty).filter((value): value is string => value !== null);
    if (tags.length === 0) return null;
    const owner = ownerWindow(this.root);
    const tagRow = owner.createDiv();
    tagRow.className = 'abyss-annotation-card-tags';
    tagRow.dataset['annotationCardTags'] = '';
    for (const tag of tags) {
      const item = owner.createSpan();
      item.className = 'abyss-annotation-card-tag';
      item.dataset['annotationCardTag'] = normalize(tag);
      item.textContent = `#${tag}`;
      tagRow.append(item);
    }
    return tagRow;
  }

  private cardRow(annotation: DocumentAnnotation, index: number): HTMLElement {
    const row = ownerWindow(this.root).createEl('article');
    row.className = 'abyss-annotation-card-row';
    row.dataset['annotationCardId'] = annotationId(annotation);
    const rowId = this.rowId(annotation);
    row.dataset['annotationRowId'] = rowId;
    if (this.openActionsRowId === rowId) row.dataset['actionsOpen'] = '';
    if (this.suppressedActionsRowId === rowId) row.dataset['actionsSuppressed'] = '';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-posinset', String(index + 1));
    row.setAttribute('aria-setsize', String(this.filtered.length));
    row.draggable = isTransferableAnnotation(annotation);
    row.addEventListener('contextmenu', (event) => {
      if (row.querySelector('.abyss-annotation-card-actions') === null) return;
      event.preventDefault();
      this.openActionsRowId = rowId;
      this.suppressedActionsRowId = null;
      row.dataset['actionsOpen'] = '';
      row.removeAttribute('data-actions-suppressed');
    });
    row.addEventListener('pointerup', (event) => {
      if (event.pointerType !== 'touch' || this.openActionsRowId === rowId) return;
      this.openActionsRowId = rowId;
      this.suppressedActionsRowId = null;
      this.touchNavigationGuardRowId = rowId;
      row.dataset['actionsOpen'] = '';
      row.removeAttribute('data-actions-suppressed');
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.openActionsRowId = null;
      this.touchNavigationGuardRowId = null;
      this.suppressedActionsRowId = rowId;
      row.removeAttribute('data-actions-open');
      row.dataset['actionsSuppressed'] = '';
      row.querySelector<HTMLElement>('.abyss-annotation-card')?.focus();
    });
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
    actions.dataset['contextual'] = '';
    actions.setAttribute('aria-label', 'Annotation actions');
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
    setTooltip(button, label);
    button.textContent = action === 'copy-annotation-link' ? 'Copy' : 'Insert';
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
      this.scrollHost.scrollTop = this.scrollTopForIndex(target);
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
    this.scrollHost.scrollTop = 0;
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
    const activeTarget = this.activeFocusTarget();
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
    this.scrollHost.scrollTop = this.scrollTopForIndex(anchorIndex) + anchorDelta;
    this.windowStart = this.windowStartForAnchor(anchorIndex, activeTarget?.rowId);
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
    const focusedTarget = this.activeFocusTarget();
    const virtualScrollTop = this.virtualScrollTop();
    const anchorIndex = this.indexAtOffset(virtualScrollTop);
    const anchor = preserveAnchor ? this.filtered[anchorIndex] : undefined;
    const delta = preserveAnchor ? virtualScrollTop - this.offsetAt(anchorIndex) : 0;
    this.clearMeasurements();
    this.rebuildOffsets();
    if (anchor !== undefined) {
      const index = this.filtered.indexOf(anchor);
      this.scrollHost.scrollTop = this.scrollTopForIndex(Math.max(0, index)) + delta;
      this.windowStart = clampWindowStart(index - SCROLL_OVERSCAN, this.filtered.length);
    }
    this.render();
    this.restoreFocusedTarget(focusedTarget);
  }

  private restoreFocusedTarget(focus: AnnotationFocusTarget | null): void {
    if (focus === null) return;
    const row = Array.from(
      this.list.querySelectorAll<HTMLElement>('.abyss-annotation-card-row[data-annotation-row-id]'),
    ).find((candidate) => candidate.dataset['annotationRowId'] === focus.rowId);
    if (row === undefined) return;
    const actionName = focus.action;
    const action =
      actionName === null
        ? null
        : Array.from(row.querySelectorAll<HTMLElement>('[data-action]')).find(
            (candidate) => candidate.dataset['action'] === actionName,
          );
    const target = action ?? row.querySelector<HTMLElement>('.abyss-annotation-card');
    if (target === null) return;
    const scrollTop = this.scrollHost.scrollTop;
    target.focus();
    this.scrollHost.scrollTop = scrollTop;
  }

  private activeFocusTarget(): AnnotationFocusTarget | null {
    const activeElement = ownerWindow(this.root).document.activeElement;
    if (activeElement instanceof ownerWindow(this.root).Element) {
      const row = activeElement.closest<HTMLElement>('.abyss-annotation-card-row');
      const rowId = row?.dataset['annotationRowId'];
      if (rowId !== undefined) {
        return {
          action: activeElement.closest<HTMLElement>('[data-action]')?.dataset['action'] ?? null,
          rowId,
        };
      }
    }
    return this.focusedTarget;
  }

  private virtualScrollTop(): number {
    return Math.max(0, this.scrollHost.scrollTop - this.list.offsetTop);
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

  private dataState(): Extract<AnnotationPanelState, 'empty' | 'content' | 'filtered-empty'> {
    if (this.annotations.length === 0) return 'empty';
    return this.filtered.length === 0 ? 'filtered-empty' : 'content';
  }

  private renderState(): void {
    this.root.dataset['annotationState'] = this.state;
    const hasControls = this.state === 'content' || this.state === 'filtered-empty';
    this.controls.hidden = !hasControls;
    this.query.hidden = !hasControls;
    this.tags.hidden = !hasControls;
    this.list.hidden = this.state !== 'content';
    this.status.hidden = this.state === 'content';
    this.status.removeAttribute('role');
    this.status.replaceChildren();
    if (this.state === 'content') return;
    this.status.setAttribute('role', this.state === 'unavailable' ? 'alert' : 'status');
    const copy: Readonly<Record<Exclude<AnnotationPanelState, 'content'>, string>> = {
      loading: 'Loading annotations…',
      empty: 'No annotations',
      'filtered-empty': 'No matching annotations',
      unavailable: 'Annotations unavailable',
    };
    this.status.append(copy[this.state]);
    if (this.state !== 'unavailable' || this.unavailableOptions.onRetry === undefined) return;
    const retry = ownerWindow(this.root).createEl('button');
    retry.type = 'button';
    retry.className = 'mod-cta abyss-annotations-retry';
    retry.dataset['action'] = 'retry-annotations';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      const onRetry = this.unavailableOptions.onRetry;
      if (onRetry === undefined) return;
      this.setLoading();
      onRetry();
    });
    this.status.append(retry);
  }

  private clearResolutionFeedback(): void {
    this.contextStatus.hidden = true;
    this.contextStatus.removeAttribute('role');
    this.contextStatus.replaceChildren();
  }

  private closeContextActionsExcept(exception: Element | null): void {
    const exceptionRowId =
      exception instanceof ownerWindow(this.root).HTMLElement
        ? (exception.dataset['annotationRowId'] ?? null)
        : null;
    if (
      exceptionRowId === null ||
      (this.openActionsRowId !== null && this.openActionsRowId !== exceptionRowId)
    ) {
      this.openActionsRowId = null;
      this.suppressedActionsRowId = null;
      this.touchNavigationGuardRowId = null;
    }
    const rows = Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-actions-open], [data-actions-suppressed]'),
    );
    for (const row of rows) {
      if (row === exception) continue;
      row.removeAttribute('data-actions-open');
      row.removeAttribute('data-actions-suppressed');
    }
  }

  private resetContextualActions(): void {
    this.focusedTarget = null;
    this.openActionsRowId = null;
    this.suppressedActionsRowId = null;
    this.touchNavigationGuardRowId = null;
  }

  private colorFacetAccessibleLabel(facet: AnnotationColorFacet): string {
    const peers = this.displayColors.filter(
      (candidate) => normalize(candidate.meaning) === normalize(facet.meaning),
    );
    const count = `${facet.count} ${facet.count === 1 ? 'annotation' : 'annotations'}`;
    if (peers.length === 1) return `${facet.meaning}, ${count}`;
    const configuredName = colorSetting(facet.color, this.options.colorNames);
    const configuredNameIsUnique =
      configuredName !== null &&
      peers.filter(
        (candidate) =>
          normalize(colorSetting(candidate.color, this.options.colorNames) ?? '') ===
          normalize(configuredName),
      ).length === 1;
    const qualifier =
      configuredNameIsUnique && normalize(configuredName) !== normalize(facet.meaning)
        ? configuredName
        : `Color ${String(peers.indexOf(facet) + 1)} of ${String(peers.length)}`;
    return `${facet.meaning} — ${qualifier}, ${count}`;
  }
}

function createColorFacetControls(owner: ReaderOwnerWindow): {
  readonly colors: HTMLElement;
  readonly rows: HTMLElement;
  readonly search: HTMLInputElement;
} {
  const colors = owner.createDiv();
  colors.className = 'abyss-annotation-colors';
  colors.setAttribute('aria-label', 'Annotation colors');
  const search = owner.createEl('input');
  search.type = 'search';
  search.placeholder = 'Filter colors';
  search.setAttribute('aria-label', 'Filter annotation colors');
  search.dataset['annotationColorSearch'] = '';
  search.hidden = true;
  const rows = owner.createDiv();
  rows.className = 'abyss-annotation-color-rows';
  colors.append(search, rows);
  return { colors, rows, search };
}

function createStatus(owner: ReaderOwnerWindow): HTMLElement {
  const status = owner.createDiv();
  status.className = 'abyss-annotations-status';
  status.setAttribute('aria-live', 'polite');
  status.dataset['annotationsStatus'] = '';
  return status;
}

function createContextStatus(owner: ReaderOwnerWindow): HTMLElement {
  const status = owner.createDiv();
  status.className = 'abyss-annotations-context-status';
  status.dataset['annotationsContextStatus'] = '';
  status.hidden = true;
  return status;
}

function createScrollHost(
  owner: ReaderOwnerWindow,
  status: HTMLElement,
  list: HTMLElement,
): HTMLElement {
  const scrollHost = owner.createDiv();
  scrollHost.className = 'abyss-annotations-scroll-host';
  scrollHost.dataset['annotationScrollHost'] = '';
  scrollHost.append(status, list);
  return scrollHost;
}

function createTagFacetControls(owner: ReaderOwnerWindow): {
  readonly rows: HTMLElement;
  readonly search: HTMLInputElement;
  readonly tags: HTMLDetailsElement;
} {
  const tags = owner.createEl('details');
  tags.className = 'abyss-annotation-tags';
  tags.dataset['section'] = 'tags';
  const summary = owner.createEl('summary');
  summary.textContent = 'Tags';
  const search = owner.createEl('input');
  search.type = 'search';
  search.placeholder = 'Filter tags';
  search.setAttribute('aria-label', 'Filter annotation tags');
  search.dataset['annotationTagSearch'] = '';
  search.hidden = true;
  const rows = owner.createDiv();
  rows.className = 'abyss-annotation-tag-rows';
  tags.append(summary, search, rows);
  return { rows, search, tags };
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

function annotationMeaning(
  annotation: DocumentAnnotation,
  meanings: Readonly<Record<string, string>> | undefined,
): string {
  return annotation.color === null ? annotation.type : colorMeaning(annotation.color, meanings);
}

function colorMeaning(
  color: string,
  meanings: Readonly<Record<string, string>> | undefined,
): string {
  return colorSetting(color, meanings) ?? 'Custom color';
}

function colorSetting(
  color: string,
  settings: Readonly<Record<string, string>> | undefined,
): string | null {
  if (settings === undefined) return null;
  const match = Object.entries(settings).find(
    ([candidate]) => normalize(candidate) === normalize(color),
  );
  return nonEmpty(match?.[1]);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
