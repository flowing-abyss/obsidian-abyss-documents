import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { DocumentLocation } from '../document-core/document.js';
import { ownerWindow } from './owner-dom.js';

const MAX_CARDS = 80;

export interface AnnotationPanelFilter {
  readonly query: string;
  readonly colors: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
}

export interface AnnotationsPanelOptions {
  readonly colorMeanings?: Readonly<Record<string, string>>;
  readonly onNavigate: (location: DocumentLocation) => void;
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
  private windowStart = 0;

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

  private configureRoot(): void {
    this.root.className = 'abyss-reader-annotations';
    this.root.dataset['sidebarPanel'] = 'annotations';
    this.root.setAttribute('aria-label', 'Annotations');
  }

  private bindEvents(): void {
    this.query.addEventListener('input', () => {
      this.filter = { ...this.filter, query: this.query.value };
      this.windowStart = 0;
      this.applyFilter();
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
    this.status.removeAttribute('role');
    this.status.textContent = `${annotations.length} ${annotations.length === 1 ? 'annotation' : 'annotations'}`;
    this.renderFacets();
    this.applyFilter();
  }

  setFilter(filter: AnnotationPanelFilter): void {
    this.filter = filter;
    this.query.value = filter.query;
    this.windowStart = 0;
    this.renderFacets();
    this.applyFilter();
  }

  visibleIds(): string[] {
    return this.filtered.map(annotationId);
  }

  setCurrentPage(pageIndex: number): void {
    this.currentPage = Math.max(0, Math.floor(pageIndex));
    const selected = this.filtered.findIndex(
      (annotation) => annotationPage(annotation) === this.currentPage,
    );
    if (selected >= 0 && (selected < this.windowStart || selected >= this.windowStart + MAX_CARDS))
      this.windowStart = Math.max(0, selected - Math.floor(MAX_CARDS / 2));
    this.render();
  }

  private applyFilter(): void {
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
    this.windowStart = Math.min(this.windowStart, Math.max(0, this.filtered.length - MAX_CARDS));
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
        this.windowStart = 0;
        this.applyFilter();
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
        this.windowStart = 0;
        this.applyFilter();
      });
      label.append(input, `#${display}`);
      this.tags.append(label);
    }
  }

  private render(): void {
    this.list.replaceChildren();
    const visible = this.filtered.slice(this.windowStart, this.windowStart + MAX_CARDS);
    for (const [offset, annotation] of visible.entries())
      this.list.append(this.card(annotation, this.windowStart + offset));
    if (this.filtered.length === 0) {
      const empty = ownerWindow(this.root).createEl('p');
      empty.className = 'abyss-reader-sidebar-empty';
      empty.textContent = 'No annotations match the current filters.';
      this.list.append(empty);
    }
  }

  private card(annotation: DocumentAnnotation, index: number): HTMLButtonElement {
    const owner = ownerWindow(this.root);
    const button = owner.createEl('button');
    button.type = 'button';
    button.className = 'abyss-annotation-card';
    button.dataset['annotationId'] = annotationId(annotation);
    button.setAttribute('role', 'listitem');
    button.tabIndex = index === this.windowStart ? 0 : -1;
    if (annotationPage(annotation) === this.currentPage)
      button.setAttribute('aria-current', 'location');
    const header = owner.createDiv();
    header.className = 'abyss-annotation-card-header';
    const meaning =
      annotation.color === null ? undefined : this.options.colorMeanings?.[annotation.color];
    header.textContent = `Page ${annotationPage(annotation) + 1} · ${meaning ?? annotation.type}`;
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
    if (target < this.windowStart || target >= this.windowStart + MAX_CARDS)
      this.windowStart = Math.floor(target / MAX_CARDS) * MAX_CARDS;
    this.render();
    const annotation = this.filtered[target];
    if (annotation === undefined) return;
    this.list
      .querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(annotationId(annotation))}"]`)
      ?.focus();
  }
}

function annotationId(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function annotationPage(annotation: DocumentAnnotation): number {
  return annotation.anchor.kind === 'fixed-page' ? annotation.anchor.pageIndex : 0;
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
