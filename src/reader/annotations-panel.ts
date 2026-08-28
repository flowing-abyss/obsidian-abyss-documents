import { setIcon, setTooltip } from 'obsidian';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { DocumentLocation } from '../document-core/document.js';
import { maximizeReaderCounter, recordReaderPerformanceSample } from '../reader-performance.js';
import type { AnnotationProjectionRow } from './annotation-projection.js';
import { ownerWindow, type ReaderOwnerWindow } from './owner-dom.js';

const MAX_CARDS = 48;
const MAX_COLOR_FACETS = 16;
const ESTIMATED_CARD_HEIGHT = 112;
const SCROLL_OVERSCAN = 10;
const HEIGHT_EPSILON = 0.5;
const LOADING_SPINNER_DELAY_MS = 250;

type AnnotationPanelState = 'loading' | 'empty' | 'content' | 'filtered-empty' | 'unavailable';

interface AnnotationFocusTarget {
  readonly action: string | null;
  readonly rowId: string;
}

interface AnnotationVisualAnchor {
  readonly rowId: string;
  top: number;
}

interface ProjectionRovingSnapshot {
  readonly index: number;
  readonly restoreFocus: boolean;
  readonly rowId: string | null;
}

export interface AnnotationPanelFilter {
  readonly query: string;
  readonly colors: ReadonlySet<string>;
}

export interface AnnotationColorFacet {
  readonly color: string;
  readonly meaning: string;
  readonly count: number;
}

export interface AnnotationPanelActivation {
  readonly annotation: DocumentAnnotation;
  readonly location: DocumentLocation;
  readonly nativeId: string;
  readonly rowId: string;
}

export interface AnnotationsPanelOptions {
  readonly colorMeanings?: Readonly<Record<string, string>>;
  readonly colorNames?: Readonly<Record<string, string>>;
  readonly onCopy?: (annotation: DocumentAnnotation) => void;
  readonly onInsert?: (annotation: DocumentAnnotation) => void;
  readonly onActivate?: (activation: AnnotationPanelActivation) => void;
  readonly onNavigate: (location: DocumentLocation) => void;
  readonly onTransfer?: (annotation: DocumentAnnotation, transfer: DataTransfer) => void;
  readonly onTransferFailure?: (annotation: DocumentAnnotation, cause: unknown) => void;
}

export class AnnotationsPanel {
  readonly root: HTMLElement;

  private readonly controls: HTMLElement;
  private readonly contextStatus: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly list: HTMLElement;
  private readonly scrollHost: HTMLElement;
  private readonly status: HTMLElement;
  private readonly query: HTMLInputElement;
  private readonly colors: HTMLElement;
  private readonly colorSearch: HTMLInputElement;
  private readonly colorRows: HTMLElement;
  private displayColors: readonly AnnotationColorFacet[] = [];
  private annotations: readonly DocumentAnnotation[] = [];
  private projectionRows: readonly AnnotationProjectionRow[] | null = null;
  private provisionalRowIds = new Set<string>();
  private filtered: readonly DocumentAnnotation[] = [];
  private filter: AnnotationPanelFilter = { query: '', colors: new Set() };
  private currentPage = 0;
  private state: AnnotationPanelState = 'loading';
  private loadingVisible = false;
  private loadingTimer: number | null = null;
  private selectedRowId: string | null = null;
  private rovingRowId: string | null = null;
  private windowStart = 0;
  private estimatedCardHeight = ESTIMATED_CARD_HEIGHT;
  private offsets: number[] = [0];
  private readonly measuredHeights = new Map<string, number>();
  private readonly cardButtons = new Map<string, HTMLButtonElement>();
  private readonly cardRows = new Map<string, HTMLElement>();
  private readonly cardAnnotations = new WeakMap<HTMLButtonElement, DocumentAnnotation>();
  private readonly topSpacer: HTMLElement;
  private readonly bottomSpacer: HTMLElement;
  private rowIds = new WeakMap<DocumentAnnotation, string>();
  private nativeIds = new WeakMap<DocumentAnnotation, string>();
  private nextRowId = 0;
  private measurementFrame: number | null = null;
  private estimateCalibrated = false;
  private focusedTarget: AnnotationFocusTarget | null = null;
  private lastFocusedVisualAnchor: AnnotationVisualAnchor | null = null;
  private openActionsRowId: string | null = null;
  private pointerFocusRowId: string | null = null;
  private suppressClickActivationRowId: string | null = null;
  private suppressFocusActivationRowId: string | null = null;
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
  private readonly onColorSearchInput = (): void => {
    if (!this.destroyed) this.renderColorRows();
  };
  private readonly onDocumentFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof ownerWindow(this.root).Element)) return;
    const row = target.closest<HTMLElement>('.abyss-annotation-card-row');
    this.closeContextActionsExcept(row);
    if (!this.root.contains(target)) {
      this.focusedTarget = null;
      this.lastFocusedVisualAnchor = null;
      return;
    }
    if (row === null) {
      this.focusedTarget = null;
      return;
    }
    const rowId = row.dataset['annotationRowId'];
    const action = target.closest<HTMLElement>('[data-action]')?.dataset['action'] ?? null;
    this.restoreContextualActions(row, rowId, action);
    if (rowId !== undefined) {
      this.setRovingRow(rowId);
      this.handleCardFocus(target, rowId);
    }
    this.focusedTarget = rowId === undefined ? null : { action, rowId };
    this.lastFocusedVisualAnchor = this.visualAnchorFor(row, rowId);
  };
  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    const element =
      target instanceof ownerWindow(this.root).Element ? (target as HTMLElement) : null;
    const row = element?.closest<HTMLElement>('.abyss-annotation-card-row') ?? null;
    this.pointerFocusRowId =
      element?.closest<HTMLElement>('.abyss-annotation-card')?.dataset['annotationRowId'] ?? null;
    this.suppressClickActivationRowId = null;
    this.closeContextActionsExcept(row);
  };

  private handleCardFocus(target: Element, rowId: string): void {
    if (target.closest('.abyss-annotation-card') === null) return;
    if (this.suppressFocusActivationRowId === rowId) {
      this.suppressFocusActivationRowId = null;
      return;
    }
    this.activateRow(rowId);
    if (this.pointerFocusRowId === rowId) this.suppressClickActivationRowId = rowId;
  }

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
    this.controls.append(this.query);
    this.list = owner.createDiv();
    this.list.className = 'abyss-annotations-list';
    this.list.setAttribute('role', 'list');
    [this.topSpacer, this.bottomSpacer] = createVirtualSpacers(owner);
    this.scrollHost = createScrollHost(owner, this.status, this.list);
    this.footer = owner.createDiv();
    this.footer.className = 'abyss-annotation-footer';
    this.footer.dataset['annotationFooter'] = '';
    this.footer.append(this.colors);
    this.mount(host);
    this.bindEvents();
    this.setLoading();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scrollHost.removeEventListener('scroll', this.onScroll);
    ownerWindow(this.root).removeEventListener('resize', this.onResize);
    ownerWindow(this.root).document.removeEventListener('focusin', this.onDocumentFocusIn);
    ownerWindow(this.root).document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.colorSearch.removeEventListener('input', this.onColorSearchInput);
    if (this.measurementFrame !== null) {
      ownerWindow(this.root).cancelAnimationFrame(this.measurementFrame);
      this.measurementFrame = null;
    }
    this.clearLoadingTimer();
  }

  private configureRoot(): void {
    this.root.className = 'abyss-reader-annotations';
    this.root.dataset['sidebarPanel'] = 'annotations';
    this.root.setAttribute('aria-label', 'Annotations');
  }

  private mount(host: HTMLElement): void {
    this.root.append(this.controls, this.contextStatus, this.scrollHost, this.footer);
    host.append(this.root);
  }

  private bindEvents(): void {
    this.scrollHost.addEventListener('scroll', this.onScroll);
    ownerWindow(this.root).addEventListener('resize', this.onResize);
    ownerWindow(this.root).document.addEventListener('focusin', this.onDocumentFocusIn);
    ownerWindow(this.root).document.addEventListener('pointerdown', this.onDocumentPointerDown);
    this.colorSearch.addEventListener('input', this.onColorSearchInput);
    this.query.addEventListener('input', () => {
      this.filter = { ...this.filter, query: this.query.value };
      this.resetVirtualScroll();
      this.applyFilter(true);
    });
  }

  setLoading(): void {
    this.clearResolutionFeedback();
    this.clearLoadingTimer();
    this.loadingVisible = false;
    this.state = 'loading';
    this.renderState();
    this.loadingTimer = ownerWindow(this.root).setTimeout(() => {
      this.loadingTimer = null;
      if (this.destroyed || this.state !== 'loading') return;
      this.loadingVisible = true;
      this.renderState();
    }, LOADING_SPINNER_DELAY_MS);
  }

  setUnavailable(preserveExisting = true): void {
    this.clearResolutionFeedback();
    this.clearLoadingTimer();
    this.loadingVisible = false;
    this.state = preserveExisting && this.annotations.length > 0 ? this.dataState() : 'unavailable';
    this.renderState();
  }

  setAnnotations(annotations: readonly DocumentAnnotation[]): void {
    this.clearResolutionFeedback();
    this.clearLoadingTimer();
    this.loadingVisible = false;
    this.resetContextualActions();
    this.projectionRows = null;
    this.provisionalRowIds.clear();
    this.annotations = [...annotations];
    this.rowIds = new WeakMap();
    this.nativeIds = new WeakMap();
    this.nextRowId = 0;
    this.cardButtons.clear();
    this.cardRows.clear();
    this.clearMeasurements();
    this.resetVirtualScroll();
    this.renderFacets();
    this.applyFilter();
  }

  setProjectedAnnotations(rows: readonly AnnotationProjectionRow[]): void {
    if (sameProjectionRows(this.projectionRows, rows)) return;
    this.clearResolutionFeedback();
    this.clearLoadingTimer();
    this.loadingVisible = false;
    const scrollTop = this.scrollHost.scrollTop;
    const roving = this.captureProjectionRoving();
    this.projectionRows = rows;
    this.provisionalRowIds = new Set(
      rows
        .filter((row) => row.provisionalId !== undefined && row.nativeId === row.provisionalId)
        .map((row) => row.key),
    );
    this.annotations = rows.map((row) => row.annotation);
    this.rowIds = new WeakMap();
    this.nativeIds = new WeakMap();
    for (const row of rows) {
      this.rowIds.set(row.annotation, row.key);
      this.nativeIds.set(row.annotation, row.nativeId);
    }
    const retainedKeys = new Set(rows.map((row) => row.key));
    this.pruneCardCache(retainedKeys);
    for (const key of this.measuredHeights.keys()) {
      if (!retainedKeys.has(key)) this.measuredHeights.delete(key);
    }
    this.renderFacets();
    this.applyFilter();
    this.restoreProjectionRoving(roving);
    this.scrollHost.scrollTop = scrollTop;
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
    const nextPage = Math.max(0, Math.floor(pageIndex));
    if (this.currentPage === nextPage) return;
    this.currentPage = nextPage;
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

  selectAnnotation(id: string, focus = true): boolean {
    const index = this.filtered.findIndex((annotation) => annotationId(annotation) === id);
    if (index < 0) return false;
    this.clearResolutionFeedback();
    this.selectedRowId = this.rowId(this.filtered[index] as DocumentAnnotation);
    this.rovingRowId = this.selectedRowId;
    this.scrollHost.scrollTop = this.scrollTopForIndex(index);
    this.windowStart = clampWindowStart(index - SCROLL_OVERSCAN, this.filtered.length);
    this.render();
    if (focus) {
      const target = this.list.querySelector<HTMLElement>(
        `[data-annotation-id="${CSS.escape(id)}"]`,
      );
      this.focusWithoutActivation(target, this.selectedRowId);
    }
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
    this.filtered = this.annotations.filter((annotation) => {
      if (colors.size > 0 && !colors.has(normalize(annotation.color ?? ''))) return false;
      if (query.length === 0) return true;
      return normalize(
        [annotation.selectedText, annotation.comment, annotation.author]
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
    this.displayColors = collectColorFacets(
      this.annotations,
      this.filter.colors,
      this.options.colorMeanings,
    );
    this.renderColorFacets();
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
      configureColorFacetTooltip(chip, facet, this.colorFacetAccessibleLabel(facet));
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
        this.renderFacets();
        this.applyFilter(true);
      });
      this.colorRows.append(chip);
    }
    this.recordPanelDomMaximum();
  }

  private render(): void {
    const focusedTarget = this.activeFocusTarget();
    this.ensureRovingRow();
    const visible = this.filtered.slice(this.windowStart, this.windowStart + MAX_CARDS);
    const visibleRowIds = new Set(visible.map((annotation) => this.rowId(annotation)));
    for (const rowId of this.cardButtons.keys()) {
      if (!visibleRowIds.has(rowId)) this.cardButtons.delete(rowId);
    }
    for (const rowId of this.cardRows.keys()) {
      if (!visibleRowIds.has(rowId)) this.cardRows.delete(rowId);
    }
    const desired: HTMLElement[] = [];
    if (visible.length > 0) {
      this.topSpacer.style.height = `${this.offsetAt(this.windowStart)}px`;
      desired.push(this.topSpacer);
    }
    for (const [offset, annotation] of visible.entries())
      desired.push(this.card(annotation, this.windowStart + offset));
    const end = this.windowStart + visible.length;
    const remainingHeight = this.offsetAt(this.filtered.length) - this.offsetAt(end);
    if (visible.length > 0) {
      this.bottomSpacer.style.height = `${remainingHeight}px`;
      desired.push(this.bottomSpacer);
    }
    this.reconcileList(desired);
    this.renderState();
    this.restoreFocusedTarget(focusedTarget);
    maximizeReaderCounter(
      'maxAnnotationCards',
      this.list.querySelectorAll('.abyss-annotation-card').length,
    );
    this.recordPanelDomMaximum();
    this.scheduleMeasurement();
  }

  private reconcileList(desired: readonly HTMLElement[]): void {
    let cursor = this.list.firstElementChild;
    for (const node of desired) {
      if (cursor === node) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      this.list.insertBefore(node, cursor);
    }
    while (cursor !== null) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  private pruneCardCache(retainedRowIds: ReadonlySet<string>): void {
    for (const key of this.cardButtons.keys()) {
      if (!retainedRowIds.has(key)) this.cardButtons.delete(key);
    }
    for (const key of this.cardRows.keys()) {
      if (!retainedRowIds.has(key)) this.cardRows.delete(key);
    }
  }

  private recordPanelDomMaximum(): void {
    maximizeReaderCounter('maxAnnotationPanelNodes', this.root.querySelectorAll('*').length);
  }

  private card(annotation: DocumentAnnotation, index: number): HTMLElement {
    const rowId = this.rowId(annotation);
    let row = this.cardRows.get(rowId);
    if (row === undefined) {
      row = this.cardRow(rowId);
      this.cardRows.set(rowId, row);
    }
    const button = this.cardButton(rowId);
    this.updateCardButton(button, annotation, index, rowId);
    this.updateCardRow(row, annotation, index, rowId);
    if (button.parentElement !== row) row.prepend(button);
    this.updateCardActions(row, annotation);
    return row;
  }

  private cardButton(rowId: string): HTMLButtonElement {
    const retained = this.cardButtons.get(rowId);
    if (retained !== undefined) return retained;
    const button = ownerWindow(this.root).createEl('button');
    button.type = 'button';
    button.className = 'abyss-annotation-card';
    button.addEventListener('click', (event) => {
      this.onCardClick(button, event);
    });
    button.addEventListener('keydown', (event) => {
      this.onCardKeyDown(button, event);
    });
    this.cardButtons.set(rowId, button);
    return button;
  }

  private updateCardButton(
    button: HTMLButtonElement,
    annotation: DocumentAnnotation,
    index: number,
    rowId: string,
  ): void {
    this.cardAnnotations.set(button, annotation);
    button.dataset['annotationId'] = annotationId(annotation);
    button.dataset['annotationIndex'] = String(index);
    button.dataset['annotationRowId'] = rowId;
    delete button.dataset['annotationProvisional'];
    if (annotation.identity.kind !== 'stable' || this.provisionalRowIds.has(rowId))
      button.dataset['annotationProvisional'] = 'true';
    button.tabIndex = rowId === this.rovingRowId ? 0 : -1;
    if (rowId === this.selectedRowId) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
    button.replaceChildren(
      this.cardHeader(annotation),
      ...[this.cardQuote(annotation), this.cardComment(annotation)].filter(
        (element): element is HTMLElement => element !== null,
      ),
    );
  }

  private updateCardActions(row: HTMLElement, annotation: DocumentAnnotation): void {
    const retained = row.querySelector<HTMLElement>(':scope > .abyss-annotation-card-actions');
    if (
      !isTransferableAnnotation(annotation) ||
      (this.options.onCopy === undefined && this.options.onInsert === undefined)
    ) {
      retained?.remove();
      return;
    }
    if (retained !== null) return;
    row.append(this.cardActions(row));
  }

  private onCardClick(button: HTMLButtonElement, event: MouseEvent): void {
    const current = this.cardAnnotations.get(button);
    if (current === undefined) return;
    const currentRowId = this.rowId(current);
    if (this.touchNavigationGuardRowId === currentRowId) {
      this.touchNavigationGuardRowId = null;
      this.suppressClickActivationRowId = null;
      this.pointerFocusRowId = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.suppressClickActivationRowId === currentRowId) {
      this.suppressClickActivationRowId = null;
      this.pointerFocusRowId = null;
      return;
    }
    this.activate(current);
  }

  private onCardKeyDown(button: HTMLButtonElement, event: KeyboardEvent): void {
    const current = this.cardAnnotations.get(button);
    if (current === undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.suppressClickActivationRowId = null;
      this.pointerFocusRowId = null;
      this.activate(current);
      return;
    }
    this.onKeyDown(event, Number(button.dataset['annotationIndex'] ?? 0));
  }

  private cardHeader(annotation: DocumentAnnotation): HTMLElement {
    const owner = ownerWindow(this.root);
    const header = owner.createSpan();
    header.className = 'abyss-annotation-card-header';
    const page = owner.createSpan();
    page.dataset['annotationPage'] = '';
    page.textContent = `Page ${annotationPage(annotation) + 1}`;
    const meaning = owner.createSpan();
    meaning.className = 'abyss-annotation-card-meaning';
    meaning.dataset['annotationMeaning'] = '';
    meaning.textContent = annotationMeaning(annotation, this.options.colorMeanings);
    const swatch = owner.createSpan();
    swatch.className = 'abyss-annotation-card-swatch';
    swatch.dataset['annotationColorSwatch'] = '';
    swatch.style.setProperty('--abyss-annotation-color', annotation.color ?? 'transparent');
    swatch.setAttribute('aria-hidden', 'true');
    header.append(page, swatch, meaning);
    return header;
  }

  private cardQuote(annotation: DocumentAnnotation): HTMLElement | null {
    const quote = nonEmpty(annotation.selectedText);
    if (quote === null) return null;
    const text = ownerWindow(this.root).createSpan();
    text.className = 'abyss-annotation-card-text abyss-annotation-card-quote';
    text.dataset['annotationQuote'] = '';
    text.style.setProperty('--abyss-annotation-color', annotation.color ?? 'transparent');
    text.textContent = quote;
    return text;
  }

  private cardComment(annotation: DocumentAnnotation): HTMLElement | null {
    const comment = nonEmpty(annotation.comment);
    if (comment === null) return null;
    const note = ownerWindow(this.root).createSpan();
    note.className = 'abyss-annotation-card-text abyss-annotation-card-comment';
    note.dataset['annotationComment'] = '';
    note.textContent = comment;
    return note;
  }

  private cardRow(rowId: string): HTMLElement {
    const row = ownerWindow(this.root).createEl('article');
    row.className = 'abyss-annotation-card-row';
    row.setAttribute('role', 'listitem');
    row.addEventListener('contextmenu', (event) => {
      if (row.querySelector('.abyss-annotation-card-actions') === null) return;
      event.preventDefault();
      this.openActionsRowId = rowId;
      this.suppressedActionsRowId = null;
      row.dataset['actionsOpen'] = '';
      row.removeAttribute('data-actions-suppressed');
    });
    row.addEventListener('pointerup', (event) => {
      const target = event.target;
      const card =
        target instanceof ownerWindow(this.root).Element
          ? target.closest('.abyss-annotation-card')
          : null;
      if (
        event.pointerType !== 'touch' ||
        card?.closest('.abyss-annotation-card-row') !== row ||
        this.openActionsRowId === rowId
      )
        return;
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
      this.focusWithoutActivation(
        row.querySelector<HTMLElement>('.abyss-annotation-card'),
        rowId,
        true,
      );
    });
    row.addEventListener('dragstart', (event) => {
      const annotation = this.annotationForRow(row);
      if (
        annotation === null ||
        event.dataTransfer === null ||
        !isTransferableAnnotation(annotation)
      )
        return;
      try {
        this.options.onTransfer?.(annotation, event.dataTransfer);
      } catch (cause) {
        event.preventDefault();
        this.options.onTransferFailure?.(annotation, cause);
      }
    });
    return row;
  }

  private updateCardRow(
    row: HTMLElement,
    annotation: DocumentAnnotation,
    index: number,
    rowId: string,
  ): void {
    row.dataset['annotationCardId'] = annotationId(annotation);
    row.dataset['annotationRowId'] = rowId;
    if (this.openActionsRowId === rowId) row.dataset['actionsOpen'] = '';
    else delete row.dataset['actionsOpen'];
    if (this.suppressedActionsRowId === rowId) row.dataset['actionsSuppressed'] = '';
    else delete row.dataset['actionsSuppressed'];
    row.setAttribute('aria-posinset', String(index + 1));
    row.setAttribute('aria-setsize', String(this.filtered.length));
    row.draggable = isTransferableAnnotation(annotation);
  }

  private annotationForRow(row: HTMLElement): DocumentAnnotation | null {
    const button = row.querySelector<HTMLButtonElement>('.abyss-annotation-card');
    return button === null ? null : (this.cardAnnotations.get(button) ?? null);
  }

  private cardActions(row: HTMLElement): HTMLElement {
    const actions = ownerWindow(this.root).createDiv();
    actions.className = 'abyss-annotation-card-actions';
    actions.dataset['contextual'] = '';
    actions.setAttribute('aria-label', 'Annotation actions');
    if (this.options.onCopy !== undefined) {
      actions.append(
        this.actionButton('copy-annotation-link', 'Copy annotation link', () => {
          const annotation = this.annotationForRow(row);
          if (annotation !== null) this.options.onCopy?.(annotation);
        }),
      );
    }
    if (this.options.onInsert !== undefined) {
      actions.append(
        this.actionButton('insert-annotation', 'Insert into active Markdown note', () => {
          const annotation = this.annotationForRow(row);
          if (annotation !== null) this.options.onInsert?.(annotation);
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
    const annotation = this.filtered[target];
    if (annotation === undefined) return;
    this.rovingRowId = this.rowId(annotation);
    this.render();
    this.list
      .querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(annotationId(annotation))}"]`)
      ?.focus();
  }

  private ensureRovingRow(): void {
    const mounted = this.filtered.slice(this.windowStart, this.windowStart + MAX_CARDS);
    const mountedIds = new Set(mounted.map((annotation) => this.rowId(annotation)));
    const active = ownerWindow(this.root).document.activeElement;
    const focusedRowId =
      active instanceof ownerWindow(this.root).Element && this.list.contains(active)
        ? (active.closest<HTMLElement>('.abyss-annotation-card')?.dataset['annotationRowId'] ??
          null)
        : null;
    if (focusedRowId !== null && mountedIds.has(focusedRowId)) {
      this.rovingRowId = focusedRowId;
      return;
    }
    if (this.rovingRowId !== null && mountedIds.has(this.rovingRowId)) return;
    const candidate = mounted[0];
    this.rovingRowId = candidate === undefined ? null : this.rowId(candidate);
  }

  private setRovingRow(rowId: string): void {
    if (this.rovingRowId === rowId) return;
    this.rovingRowId = rowId;
    const cards = Array.from(
      this.list.querySelectorAll('.abyss-annotation-card'),
      (element) => element as HTMLButtonElement,
    );
    for (const card of cards) {
      card.tabIndex = card.dataset['annotationRowId'] === rowId ? 0 : -1;
    }
  }

  private activateRow(rowId: string): void {
    const annotation = this.filtered.find((candidate) => this.rowId(candidate) === rowId);
    if (annotation !== undefined) this.activate(annotation);
  }

  private activate(annotation: DocumentAnnotation): void {
    const rowId = this.rowId(annotation);
    this.clearResolutionFeedback();
    this.selectedRowId = rowId;
    for (const card of Array.from(
      this.list.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
    )) {
      if (card.dataset['annotationRowId'] === rowId) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    }
    const target: AnnotationPanelActivation = {
      annotation,
      location: location(annotation),
      nativeId: this.nativeIds.get(annotation) ?? annotationId(annotation),
      rowId,
    };
    if (this.options.onActivate !== undefined) this.options.onActivate(target);
    else this.options.onNavigate(target.location);
  }

  private captureProjectionRoving(): ProjectionRovingSnapshot {
    const rowId = this.rovingRowId;
    const index =
      rowId === null
        ? -1
        : this.filtered.findIndex((annotation) => this.rowId(annotation) === rowId);
    const activeElement = ownerWindow(this.root).document.activeElement;
    const focusedRowId =
      activeElement instanceof ownerWindow(this.root).Element
        ? (activeElement.closest<HTMLElement>('.abyss-annotation-card')?.dataset[
            'annotationRowId'
          ] ?? null)
        : null;
    return { index, restoreFocus: rowId !== null && focusedRowId === rowId, rowId };
  }

  private restoreProjectionRoving(snapshot: ProjectionRovingSnapshot): void {
    if (
      snapshot.rowId === null ||
      this.filtered.some((annotation) => this.rowId(annotation) === snapshot.rowId)
    )
      return;
    const candidate =
      this.filtered[Math.min(Math.max(0, snapshot.index), this.filtered.length - 1)];
    this.rovingRowId = candidate === undefined ? null : this.rowId(candidate);
    this.render();
    if (!snapshot.restoreFocus || candidate === undefined) return;
    this.focusWithoutActivation(
      this.list.querySelector<HTMLElement>(
        `.abyss-annotation-card[data-annotation-row-id="${CSS.escape(this.rowId(candidate))}"]`,
      ),
      this.rowId(candidate),
      true,
    );
  }

  private restoreContextualActions(
    row: HTMLElement,
    rowId: string | undefined,
    action: string | null,
  ): void {
    if (action === null || rowId === undefined || this.suppressedActionsRowId !== rowId) return;
    this.suppressedActionsRowId = null;
    row.removeAttribute('data-actions-suppressed');
  }

  private resetVirtualScroll(): void {
    this.windowStart = 0;
    this.scrollHost.scrollTop = 0;
  }

  private updateWindowFromScroll(): boolean {
    const target = this.indexAtOffset(this.virtualScrollTop()) - SCROLL_OVERSCAN;
    let next = clampWindowStart(target, this.filtered.length);
    const focusedRowId = this.retainedVisualRowId();
    if (focusedRowId !== undefined) {
      const focusedIndex = this.filtered.findIndex(
        (annotation) => this.rowId(annotation) === focusedRowId,
      );
      const distanceBefore = next - focusedIndex;
      const distanceAfter = focusedIndex - (next + MAX_CARDS - 1);
      if (distanceBefore > 0 && distanceBefore <= SCROLL_OVERSCAN) next = focusedIndex;
      else if (distanceAfter > 0 && distanceAfter <= SCROLL_OVERSCAN)
        next = focusedIndex - MAX_CARDS + 1;
    }
    next = clampWindowStart(next, this.filtered.length);
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
    this.windowStart = this.windowStartForAnchor(
      anchorIndex,
      activeTarget?.rowId ?? this.lastFocusedVisualAnchor?.rowId,
    );
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
      this.windowStart = this.windowStartForAnchor(
        index,
        focusedTarget?.rowId ?? this.lastFocusedVisualAnchor?.rowId,
      );
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
    this.focusWithoutActivation(target, focus.rowId);
    this.scrollHost.scrollTop = scrollTop;
  }

  private focusWithoutActivation(
    target: HTMLElement | null,
    rowId: string | null,
    preventScroll = false,
  ): void {
    if (target === null || rowId === null) return;
    this.suppressFocusActivationRowId = rowId;
    target.focus({ preventScroll });
    if (this.suppressFocusActivationRowId === rowId) this.suppressFocusActivationRowId = null;
  }

  private visualAnchorFor(
    row: HTMLElement,
    rowId: string | undefined,
  ): AnnotationVisualAnchor | null {
    if (rowId === undefined) return null;
    const card = row.querySelector<HTMLElement>('.abyss-annotation-card');
    if (card === null) return null;
    const top = card.getBoundingClientRect().top;
    return Number.isFinite(top) ? { rowId, top } : null;
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

  private retainedVisualRowId(): string | undefined {
    return this.activeFocusTarget()?.rowId ?? this.lastFocusedVisualAnchor?.rowId;
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
    this.footer.hidden = !hasControls || this.displayColors.length === 0;
    this.query.hidden = !hasControls;
    this.list.hidden = this.state !== 'content';
    this.status.hidden =
      this.state === 'content' || (this.state === 'loading' && !this.loadingVisible);
    this.status.removeAttribute('role');
    this.status.replaceChildren();
    if (this.state === 'content') return;
    this.status.setAttribute('role', 'status');
    if (this.state === 'loading') {
      if (!this.loadingVisible) return;
      const spinner = ownerWindow(this.root).createSpan();
      spinner.className = 'abyss-annotations-spinner';
      spinner.dataset['annotationsSpinner'] = '';
      spinner.setAttribute('aria-label', 'Loading annotations');
      setIcon(spinner, 'loader-circle');
      this.status.append(spinner);
      return;
    }
    const copy: Readonly<Record<Exclude<AnnotationPanelState, 'content' | 'loading'>, string>> = {
      empty: 'No annotations',
      'filtered-empty': 'No matching annotations',
      unavailable: 'Couldn’t load annotations',
    };
    this.status.append(copy[this.state]);
  }

  private clearLoadingTimer(): void {
    if (this.loadingTimer === null) return;
    ownerWindow(this.root).clearTimeout(this.loadingTimer);
    this.loadingTimer = null;
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
    const contextualRowIds = [
      this.openActionsRowId,
      this.suppressedActionsRowId,
      this.touchNavigationGuardRowId,
    ].filter((rowId): rowId is string => rowId !== null);
    const crossesContextBoundary =
      exceptionRowId === null || contextualRowIds.some((rowId) => rowId !== exceptionRowId);
    if (crossesContextBoundary) {
      this.openActionsRowId = null;
      this.suppressedActionsRowId = null;
      this.touchNavigationGuardRowId = null;
    }
    const rows = Array.from(
      this.root.querySelectorAll<HTMLElement>('[data-actions-open], [data-actions-suppressed]'),
    );
    for (const row of rows) {
      if (!crossesContextBoundary && row === exception) continue;
      row.removeAttribute('data-actions-open');
      row.removeAttribute('data-actions-suppressed');
    }
  }

  private resetContextualActions(): void {
    this.focusedTarget = null;
    this.lastFocusedVisualAnchor = null;
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

function sameProjectionRows(
  current: readonly AnnotationProjectionRow[] | null,
  next: readonly AnnotationProjectionRow[],
): boolean {
  return (
    current !== null &&
    current.length === next.length &&
    current.every((row, index) => {
      const candidate = next[index];
      return (
        row.key === candidate?.key &&
        row.annotation === candidate.annotation &&
        row.nativeId === candidate.nativeId &&
        row.provisionalId === candidate.provisionalId &&
        row.writable === candidate.writable
      );
    })
  );
}

function collectColorFacets(
  annotations: readonly DocumentAnnotation[],
  selectedColors: ReadonlySet<string>,
  meanings: Readonly<Record<string, string>> | undefined,
): readonly AnnotationColorFacet[] {
  const counts = new Map<string, number>();
  for (const annotation of annotations) {
    const color = nonEmpty(annotation.color);
    if (color !== null) counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  for (const selectedColor of selectedColors) retainSelectedColor(counts, selectedColor);
  return Array.from(counts, ([color, count]) => ({
    color,
    count,
    meaning: colorMeaning(color, meanings),
  })).sort((left, right) => left.color.localeCompare(right.color));
}

function configureColorFacetTooltip(
  chip: HTMLButtonElement,
  facet: AnnotationColorFacet,
  accessibleLabel: string,
): void {
  chip.title = facet.meaning;
  setTooltip(chip, facet.meaning, { delay: 250 });
  chip.setAttribute('aria-label', accessibleLabel);
}

function retainSelectedColor(counts: Map<string, number>, selectedColor: string): void {
  const display = nonEmpty(selectedColor);
  if (display === null) return;
  const retained = Array.from(counts.keys()).some(
    (candidate) => normalize(candidate) === normalize(display),
  );
  if (!retained) counts.set(display, 0);
}

function createColorFacetControls(owner: ReaderOwnerWindow): {
  readonly colors: HTMLElement;
  readonly rows: HTMLElement;
  readonly search: HTMLInputElement;
} {
  const colors = owner.createEl('section');
  colors.className = 'abyss-annotation-colors';
  colors.dataset['section'] = 'colors';
  colors.setAttribute('aria-label', 'Annotation colors');
  const label = owner.createSpan();
  label.className = 'abyss-annotation-colors-label';
  label.dataset['annotationColorsLabel'] = '';
  label.textContent = 'Colors';
  const search = owner.createEl('input');
  search.type = 'search';
  search.placeholder = 'Filter colors';
  search.setAttribute('aria-label', 'Filter annotation colors');
  search.dataset['annotationColorSearch'] = '';
  search.hidden = true;
  const rows = owner.createDiv();
  rows.className = 'abyss-annotation-color-rows';
  colors.append(label, search, rows);
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

function createVirtualSpacers(owner: ReaderOwnerWindow): readonly [HTMLElement, HTMLElement] {
  return [createVirtualSpacer(owner, 'top'), createVirtualSpacer(owner, 'bottom')];
}

function createVirtualSpacer(owner: ReaderOwnerWindow, edge: 'top' | 'bottom'): HTMLElement {
  const spacer = owner.createDiv();
  spacer.className = 'abyss-annotation-virtual-spacer';
  spacer.dataset['virtualSpacer'] = edge;
  spacer.setAttribute('aria-hidden', 'true');
  return spacer;
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
  const color = nonEmpty(annotation.color);
  return color === null ? annotation.type : colorMeaning(color, meanings);
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
