import { describe, expect, it, vi } from 'vitest';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import { asAnnotationId } from '../document-core/annotations.js';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../reader-performance.js';
import type { AnnotationProjectionRow } from './annotation-projection.js';
import { AnnotationsPanel } from './annotations-panel.js';
import { ownerWindow } from './owner-dom.js';

function annotation(
  index: number,
  overrides: Partial<DocumentAnnotation> = {},
): DocumentAnnotation {
  return {
    identity: { kind: 'stable', id: asAnnotationId(`annotation-${index}`) },
    type: 'highlight',
    anchor: {
      kind: 'fixed-page',
      pageIndex: index,
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 0, y: 0 } },
    },
    color: '#ffd400',
    selectedText: `Concept ${index}`,
    author: '',
    createdAt: null,
    modifiedAt: null,
    comment: index % 2 === 0 ? '#Theory [[Foundations]]' : '#Other',
    tags: index % 2 === 0 ? ['Theory'] : ['Other'],
    links: index % 2 === 0 ? ['Foundations'] : [],
    capabilities: {
      geometry: { available: false, reason: { code: 'document-read-only', message: 'Read only' } },
      comment: { available: false, reason: { code: 'document-read-only', message: 'Read only' } },
      color: { available: false, reason: { code: 'document-read-only', message: 'Read only' } },
      deletion: { available: false, reason: { code: 'document-read-only', message: 'Read only' } },
      metadata: { available: false, reason: { code: 'document-read-only', message: 'Read only' } },
      conversions: {
        highlight: { available: false, reason: { code: 'lossy-conversion', message: 'No' } },
        underline: { available: false, reason: { code: 'lossy-conversion', message: 'No' } },
      },
    },
    ...overrides,
  };
}

function annotationScrollHost(root: HTMLElement): HTMLElement {
  const scrollHost = root.querySelector<HTMLElement>('[data-annotation-scroll-host]');
  if (scrollHost === null) throw new Error('Expected annotation scroll host.');
  return scrollHost;
}

function annotationFooter(root: HTMLElement): HTMLElement {
  const footer = root.querySelector<HTMLElement>('[data-annotation-footer]');
  if (footer === null) throw new Error('Expected annotation footer.');
  return footer;
}

function documentTagsFooter(root: HTMLElement): HTMLElement {
  const footer = root.querySelector<HTMLElement>('[data-section="tags"]');
  if (footer === null) throw new Error('Expected Document tags footer.');
  return footer;
}

function toggleDocumentTags(root: HTMLElement): void {
  const toggle = root.querySelector<HTMLButtonElement>('[data-action="toggle-document-tags"]');
  if (toggle === null) throw new Error('Expected Document tags toggle.');
  toggle.click();
}

describe('AnnotationsPanel', () => {
  it('preserves projected row identity, focus, and scroll through provisional reconciliation', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    const provisional = annotation(0, {
      identity: { kind: 'legacy', fingerprint: 'provisional-native-id' },
      selectedText: 'Provisional quote',
    });
    const stable = annotation(0, { selectedText: 'Verified quote' });
    const row = {
      key: 'annotation-row-stable-key',
      annotation: provisional,
      nativeId: 'provisional-native-id',
      provisionalId: 'selection-token',
      writable: true,
    } satisfies AnnotationProjectionRow;
    panel.setProjectedAnnotations([row]);
    const before = root.querySelector<HTMLElement>('.abyss-annotation-card');
    before?.focus();
    const scrollHost = annotationScrollHost(root);
    scrollHost.scrollTop = 137;

    panel.setProjectedAnnotations([{ ...row, annotation: stable, nativeId: 'annotation-0' }]);

    const after = root.querySelector<HTMLElement>('[data-annotation-id="annotation-0"]');
    expect({
      focusedRowId: root.doc.activeElement?.getAttribute('data-annotation-row-id'),
      rowId: after?.dataset['annotationRowId'],
      scrollTop: scrollHost.scrollTop,
    }).toEqual({
      focusedRowId: 'annotation-row-stable-key',
      rowId: 'annotation-row-stable-key',
      scrollTop: 137,
    });
    root.remove();
  });

  it('does not rerender an unchanged projected snapshot', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    const rows = [
      {
        key: 'annotation-row-unchanged',
        annotation: annotation(0),
        nativeId: 'annotation-0',
        writable: false,
      },
    ] satisfies readonly AnnotationProjectionRow[];
    panel.setProjectedAnnotations(rows);
    panel.setCurrentPage(0);
    const card = root.querySelector('.abyss-annotation-card');

    panel.setProjectedAnnotations(rows);
    panel.setCurrentPage(0);

    expect(root.querySelector('.abyss-annotation-card')).toBe(card);
  });

  it('moves roving focus to the nearest projected row when the focused annotation is deleted', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    const rows = [0, 1, 2].map((index) => ({
      key: `row-${String(index)}`,
      annotation: annotation(index),
      nativeId: `annotation-${String(index)}`,
      writable: true,
    })) satisfies AnnotationProjectionRow[];
    panel.setProjectedAnnotations(rows);
    const scrollHost = annotationScrollHost(root);
    scrollHost.scrollTop = 37;
    root.querySelector<HTMLButtonElement>('[data-annotation-id="annotation-1"]')?.focus();

    panel.setProjectedAnnotations([
      rows[0] as AnnotationProjectionRow,
      rows[2] as AnnotationProjectionRow,
    ]);

    const cards = Array.from(root.querySelectorAll<HTMLButtonElement>('.abyss-annotation-card'));
    expect(cards.map((card) => [card.dataset['annotationId'], card.tabIndex])).toEqual([
      ['annotation-0', -1],
      ['annotation-2', 0],
    ]);
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-2');
    expect(scrollHost.scrollTop).toBe(37);
    root.remove();
  });

  it('renders exactly No annotations when empty', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setAnnotations([]);

    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe('No annotations');
    expect(root.querySelector<HTMLInputElement>('[data-annotation-search]')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-section="tags"]')?.hidden).toBe(true);
    expect(root.querySelector('.abyss-annotation-card')).toBeNull();
  });

  it('renders No matching annotations only for filtered content', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations([annotation(0)]);

    panel.setFilter({ query: 'absent', colors: new Set(), tags: new Set() });

    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe(
      'No matching annotations',
    );
    expect(root.querySelector<HTMLInputElement>('[data-annotation-search]')?.hidden).toBe(false);
    panel.setFilter({ query: '', colors: new Set(), tags: new Set() });
    expect(root.querySelector<HTMLElement>('[data-annotations-status]')?.hidden).toBe(true);
  });

  it('delays the textless loading spinner for 250 ms and cancels it on resolution', () => {
    vi.useFakeTimers();
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    try {
      const status = root.querySelector<HTMLElement>('[data-annotations-status]');
      expect(status?.hidden).toBe(true);
      expect(status?.textContent).toBe('');

      vi.advanceTimersByTime(249);
      expect(root.querySelector('[data-annotations-spinner]')).toBeNull();

      vi.advanceTimersByTime(1);
      expect(status?.hidden).toBe(false);
      expect(root.querySelector('[data-annotations-spinner]')).not.toBeNull();
      expect(status?.textContent).toBe('');

      panel.setAnnotations([]);
      expect(root.querySelector('[data-annotations-spinner]')).toBeNull();
      expect(status?.textContent).toBe('No annotations');
    } finally {
      panel.destroy();
      vi.useRealTimers();
    }
  });

  it('hides controls and tags when empty', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setAnnotations([]);

    expect(root.querySelector<HTMLElement>('.abyss-annotation-controls')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.abyss-annotation-tags')?.hidden).toBe(true);
  });

  it('keeps only search above the list and orders fixed Colors then collapsed Document tags', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setAnnotations([annotation(0), annotation(1)]);

    const footer = annotationFooter(root);
    const colors = footer.querySelector<HTMLElement>('[data-section="colors"]');
    const tags = documentTagsFooter(root);
    const toggle = tags.querySelector<HTMLButtonElement>('[data-action="toggle-document-tags"]');
    const body = tags.querySelector<HTMLElement>('.abyss-annotation-tags-body');
    const controls = root.querySelector<HTMLElement>('.abyss-annotation-controls');
    expect(panel.root.lastElementChild).toBe(footer);
    expect(Array.from(footer.children)).toEqual([colors, tags]);
    expect(colors?.querySelector('[data-annotation-colors-label]')?.textContent).toBe('Colors');
    expect(controls?.children).toHaveLength(1);
    expect(controls?.firstElementChild).toBe(
      root.querySelector<HTMLInputElement>('[data-annotation-search]'),
    );
    expect(annotationScrollHost(root).contains(colors)).toBe(false);
    expect(annotationScrollHost(root).contains(tags)).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-controls')).toBe(body?.id);
    expect(body?.id).not.toBe('');
    expect(body?.hidden).toBe(true);
    expect(tags.querySelector('[data-annotation-tags-label]')?.textContent).toBe('Document tags');
    expect(tags.querySelector('[data-annotation-tags-count]')?.textContent).toBe('2');
  });

  it('hides the whole filter footer only when the document has no annotations', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    const footer = annotationFooter(root);

    panel.setAnnotations([]);
    expect(footer.hidden).toBe(true);

    panel.setAnnotations([annotation(0)]);
    panel.setFilter({ query: 'absent', colors: new Set(), tags: new Set() });
    expect(footer.hidden).toBe(false);
  });

  it('hides tags for empty documents', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setAnnotations([]);
    expect(root.querySelector<HTMLElement>('[data-section="tags"]')?.hidden).toBe(true);

    panel.setAnnotations([annotation(0, { tags: [] })]);
    expect(root.querySelector<HTMLElement>('[data-section="tags"]')?.hidden).toBe(true);

    panel.setAnnotations([annotation(0, { tags: ['', '   '] })]);
    expect(root.querySelector<HTMLElement>('[data-section="tags"]')?.hidden).toBe(true);
  });

  it('filters tags in their own region', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations([
      annotation(0, { tags: ['Theory'] }),
      annotation(1, { tags: ['Other'] }),
      annotation(2, { tags: ['theory'] }),
    ]);
    const footer = documentTagsFooter(root);
    toggleDocumentTags(root);
    const search = footer.querySelector<HTMLInputElement>('[data-annotation-tag-search]');
    if (search === null) throw new Error('Expected Document tags search.');
    expect(search.hidden).toBe(false);
    search.value = 'oth';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const chips = Array.from(
      footer.querySelectorAll<HTMLButtonElement>('[data-annotation-tag-row]'),
    );
    expect(chips.map((chip) => chip.textContent)).toEqual(['#Other']);
    expect(
      footer.querySelector('[data-annotation-tag-scroll-host]')?.contains(chips[0] ?? null),
    ).toBe(true);
    chips[0]?.click();
    expect(panel.visibleIds()).toEqual(['annotation-1']);
  });

  it('renders semantic chips instead of browser checkboxes', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations([annotation(0), annotation(1)]);
    const footer = documentTagsFooter(root);
    toggleDocumentTags(root);

    expect(footer.querySelector('input[type="checkbox"]')).toBeNull();
    const chips = Array.from(footer.querySelectorAll<HTMLElement>('[data-annotation-tag]'));
    expect(chips.map((chip) => chip.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
  });

  it('preserves annotation scroll and focus across tag expansion', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    const scrollHost = annotationScrollHost(root);
    scrollHost.scrollTop = 50 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));
    const anchored = panel.visibleIds()[10];
    const card = root.querySelector<HTMLElement>(`[data-annotation-id="${anchored}"]`);
    card?.focus();
    const scrollTop = scrollHost.scrollTop;
    const visibleIds = panel.visibleIds();
    const footer = documentTagsFooter(root);
    toggleDocumentTags(root);

    expect(scrollHost.scrollTop).toBe(scrollTop);
    expect(panel.visibleIds()).toEqual(visibleIds);
    expect(root.doc.activeElement).toBe(card);
    expect(footer.querySelector('[data-annotation-tag-scroll-host]')).not.toBeNull();
    expect(scrollHost.contains(footer)).toBe(false);
    root.remove();
  });

  it('keeps the last focused virtual anchor while disclosure focus drives expansion', () => {
    let scrollHost: HTMLElement | null = null;
    let footer: HTMLElement | null = null;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('abyss-annotation-card')) {
        const expansionOffset = footer?.dataset['expanded'] === 'true' ? 36 : 0;
        return DOMRect.fromRect({
          height: 40,
          y: 200 + expansionOffset - (scrollHost?.scrollTop ?? 0),
        });
      }
      return DOMRect.fromRect();
    });
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    scrollHost = annotationScrollHost(root);
    scrollHost.scrollTop = 100;
    const card = root.querySelector<HTMLElement>('.abyss-annotation-card');
    card?.focus();
    footer = documentTagsFooter(root);
    const toggle = footer.querySelector<HTMLButtonElement>('[data-action="toggle-document-tags"]');
    scrollHost.scrollTop = 116;
    toggle?.focus();
    expect(root.doc.activeElement).toBe(toggle);

    toggle?.click();

    expect(scrollHost.scrollTop).toBe(152);
    expect(card?.getBoundingClientRect().top).toBe(84);
    expect(root.doc.activeElement).toBe(toggle);

    toggle?.click();

    expect(scrollHost.scrollTop).toBe(116);
    expect(card?.getBoundingClientRect().top).toBe(84);
    expect(root.doc.activeElement).toBe(toggle);

    panel.setAnnotations([annotation(0)]);
    toggle?.click();

    expect(scrollHost.scrollTop).toBe(0);
    expect(root.doc.activeElement).toBe(toggle);
    root.remove();
  });

  it('drops a retained visual anchor after scrolling its row out of the virtual window', () => {
    let moved = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('abyss-annotation-card'))
        return DOMRect.fromRect({ height: 40, y: moved ? 200 : 100 });
      return DOMRect.fromRect();
    });
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    const scrollHost = annotationScrollHost(root);
    root.querySelector<HTMLElement>('.abyss-annotation-card')?.focus();

    scrollHost.scrollTop = 80 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));
    const toggle = documentTagsFooter(root).querySelector<HTMLButtonElement>(
      '[data-action="toggle-document-tags"]',
    );
    toggle?.focus();
    toggle?.click();

    scrollHost.scrollTop = 0;
    scrollHost.dispatchEvent(new Event('scroll'));
    moved = true;
    toggle?.click();

    expect(scrollHost.scrollTop).toBe(0);
    expect(root.doc.activeElement).toBe(toggle);
    root.remove();
  });

  it('keeps stale data after extraction failure', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations([annotation(0)]);

    panel.setUnavailable();

    expect(panel.visibleIds()).toEqual(['annotation-0']);
    expect(root.querySelector<HTMLElement>('[data-annotations-status]')?.hidden).toBe(true);
    expect(root.querySelector('[data-annotation-id="annotation-0"]')).not.toBeNull();
    expect(root.textContent).not.toContain('unavailable');
  });

  it('renders a quiet annotation failure without a button or technical jargon', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setUnavailable();

    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe(
      'Couldn’t load annotations',
    );
    expect(root.querySelector('[data-annotations-status]')?.getAttribute('role')).toBe('status');
    expect(root.querySelector('[data-action="retry-annotations"]')).toBeNull();
    expect(root.textContent).not.toMatch(/unavailable|try again|index|cache|reopen/i);
  });

  it('keeps resolution feedback through scroll resize filter and page renders until navigation', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    panel.setResolutionError('unresolved', 'Books/Source.pdf');
    const scrollHost = annotationScrollHost(root);

    scrollHost.scrollTop = 50 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));
    ownerWindow(root).dispatchEvent(new Event('resize'));
    panel.setFilter({ query: 'concept', colors: new Set(), tags: new Set() });
    panel.setCurrentPage(60);

    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      'The linked annotation in Books/Source.pdf could not be found.',
    );
    expect(scrollHost.contains(root.querySelector('[role="alert"]'))).toBe(false);
    expect(panel.root.dataset['annotationState']).toBe('content');
    panel.selectAnnotation('annotation-60');
    expect(root.querySelector('[role="alert"]:not([hidden])')).toBeNull();
    root.remove();
  });

  it('clears resolution feedback on loading recovery and unavailable boundaries', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations([annotation(0)]);
    panel.setResolutionError('ambiguous', 'Books/Source.pdf');

    panel.setLoading();
    expect(root.querySelector('[role="alert"]:not([hidden])')).toBeNull();
    panel.setAnnotations([annotation(1)]);
    panel.setResolutionError('unresolved', 'Books/Source.pdf');
    panel.setUnavailable();
    expect(root.querySelector('[role="alert"]:not([hidden])')).toBeNull();
    expect(root.querySelector('[data-annotation-id="annotation-1"]')).not.toBeNull();

    panel.setResolutionError('unresolved', 'Books/Source.pdf');
    panel.setAnnotations([]);
    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe('No annotations');
    expect(root.querySelector('[role="alert"]:not([hidden])')).toBeNull();
  });

  it('uses an independent list scrollHost', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    const scrollHost = annotationScrollHost(root);

    scrollHost.scrollTop = 50 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));

    expect(panel.visibleIds()).toContain('annotation-50');
    expect(panel.root.scrollTop).toBe(0);
    expect(scrollHost.contains(root.querySelector('.abyss-annotations-list'))).toBe(true);
    expect(scrollHost.contains(root.querySelector('[data-section="tags"]'))).toBe(false);
  });

  it('keeps ten thousand items at forty eight cards or fewer with stable anchors', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 10_000 }, (_, index) => annotation(index)));
    const scrollHost = annotationScrollHost(root);

    scrollHost.scrollTop = 7_500 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));
    const anchored = panel.visibleIds()[10];
    root.querySelector<HTMLElement>(`[data-annotation-id="${anchored}"]`)?.focus();
    ownerWindow(root).dispatchEvent(new Event('resize'));

    expect(panel.visibleIds()).toContain(anchored);
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe(anchored);
    expect(root.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(48);
    root.remove();
  });

  it('maps mixed-height rows through measured prefix offsets without losing scroll anchoring', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const owner = ownerWindow(host);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(owner, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const heights = [64, 112, 240];
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const id = this.dataset['annotationId'] ?? this.dataset['annotationCardId'];
      const index = id === undefined ? -1 : Number(id.slice('annotation-'.length));
      const height = index < 0 ? 0 : (heights[index % heights.length] ?? 0);
      return DOMRect.fromRect({ height });
    });
    const panel = new AnnotationsPanel(host, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 10_000 }, (_, index) => annotation(index)));
    frames.shift()?.(0);
    const bottomBefore = Number.parseFloat(
      host.querySelector<HTMLElement>('[data-virtual-spacer="bottom"]')?.style.height ?? '0',
    );

    const target = 5000;
    const cycles = Math.floor(target / 3);
    const remainder = target % 3;
    const exactOffset =
      cycles * 416 + heights.slice(0, remainder).reduce((sum, value) => sum + value, 0);
    const scrollHost = annotationScrollHost(host);
    scrollHost.scrollTop = exactOffset;
    scrollHost.dispatchEvent(new Event('scroll'));
    const firstMiddle = Number(panel.visibleIds()[0]?.slice('annotation-'.length));
    expect(Math.abs(firstMiddle - target)).toBeLessThanOrEqual(50);
    expect(host.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(48);

    const anchoredId = panel.visibleIds()[10];
    frames.shift()?.(1);
    expect(panel.visibleIds()).toContain(anchoredId);
    scrollHost.scrollTop = 0;
    scrollHost.dispatchEvent(new Event('scroll'));
    const bottomAfter = Number.parseFloat(
      host.querySelector<HTMLElement>('[data-virtual-spacer="bottom"]')?.style.height ?? '0',
    );
    expect(bottomAfter).not.toBe(bottomBefore);

    const focused = host.querySelector<HTMLElement>('[data-annotation-id="annotation-10"]');
    focused?.focus();
    expect(owner.document.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-10');
    heights[0] = 320;
    owner.dispatchEvent(new Event('resize'));
    expect(owner.document.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-10');
    frames.shift()?.(2);
    expect(owner.document.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-10');
    expect(host.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(48);
    frames.shift()?.(3);

    const outside = owner.createEl('button');
    owner.document.body.append(outside);
    outside.focus();
    owner.dispatchEvent(new Event('resize'));
    expect(owner.document.activeElement).toBe(outside);

    scrollHost.scrollTop = Number.MAX_SAFE_INTEGER;
    scrollHost.dispatchEvent(new Event('scroll'));
    expect(panel.visibleIds()).toContain('annotation-9999');
    host.remove();
  });

  it('falls back for zero-height DOM measurements and cancels coalesced measurement on destroy', () => {
    const host = createDiv();
    const owner = ownerWindow(host);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(owner, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return 42;
    });
    const cancel = vi.spyOn(owner, 'cancelAnimationFrame');
    const panel = new AnnotationsPanel(host, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    frames.shift()?.(0);
    const scrollHost = annotationScrollHost(host);
    scrollHost.scrollTop = 50 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));
    expect(panel.visibleIds()).toContain('annotation-50');

    panel.destroy();
    expect(cancel).toHaveBeenCalledWith(42);
    frames.forEach((frame) => {
      frame(0);
    });
    expect(panel.visibleIds()).toContain('annotation-50');
  });

  it('keeps a 10,000-item virtual list at 48 cards or fewer and filters metadata', () => {
    beginPluginActivation();
    endPluginActivation();
    const root = createDiv();
    const onNavigate = vi.fn();
    const panel = new AnnotationsPanel(root, { onNavigate });
    panel.setAnnotations(Array.from({ length: 10_000 }, (_, index) => annotation(index)));

    expect(root.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(48);
    panel.setFilter({ query: 'concept', colors: new Set(['#ffd400']), tags: new Set(['theory']) });
    expect(panel.visibleIds().slice(0, 3)).toEqual([
      'annotation-0',
      'annotation-2',
      'annotation-4',
    ]);
    expect(root.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(48);
    expect(readerPerformanceSnapshot()).toMatchObject({
      counters: { maxAnnotationCards: 48 },
      samples: {
        annotationFilterMs: [expect.any(Number)],
        annotationSearchMs: [expect.any(Number)],
      },
    });
  });

  it('moves its bounded virtual window on scroll, resize, filters, and page sync', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const panel = new AnnotationsPanel(host, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 10_000 }, (_, index) => annotation(index)));
    const firstIds = panel.visibleIds();
    expect(firstIds[0]).toBe('annotation-0');

    const scrollHost = annotationScrollHost(host);
    scrollHost.scrollTop = 5000 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));
    const middleIds = panel.visibleIds();
    expect(middleIds[0]).not.toBe('annotation-0');
    expect(middleIds.some((id) => id === 'annotation-5000')).toBe(true);
    expect(host.querySelectorAll('.abyss-annotation-card')).toHaveLength(middleIds.length);
    expect(middleIds.length).toBeLessThanOrEqual(48);

    scrollHost.scrollTop = Number.MAX_SAFE_INTEGER;
    scrollHost.dispatchEvent(new Event('scroll'));
    expect(panel.visibleIds()).toContain('annotation-9999');
    expect(host.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(48);

    ownerWindow(panel.root).dispatchEvent(new Event('resize'));
    expect(panel.visibleIds()).toContain('annotation-9999');
    panel.setFilter({ query: 'concept 42', colors: new Set(), tags: new Set() });
    expect(scrollHost.scrollTop).toBe(0);
    expect(panel.visibleIds()[0]).toBe('annotation-42');
    panel.setFilter({ query: '', colors: new Set(), tags: new Set() });
    panel.setCurrentPage(7500);
    expect(panel.visibleIds()).toContain('annotation-7500');
    expect(host.querySelector('[data-annotation-id="annotation-7500"]')).not.toBeNull();

    const beforeDestroy = panel.visibleIds();
    panel.destroy();
    panel.destroy();
    scrollHost.scrollTop = 0;
    scrollHost.dispatchEvent(new Event('scroll'));
    expect(panel.visibleIds()).toEqual(beforeDestroy);
    host.remove();
  });

  it('offers real query, color, and collapsed tag controls for panel filtering', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#ffd400': 'Important', '#00ff00': 'Question' },
      onNavigate: vi.fn(),
    });
    panel.setAnnotations([
      annotation(0),
      annotation(1, { color: '#00ff00', selectedText: 'Different' }),
    ]);
    const input = root.querySelector<HTMLInputElement>('[data-annotation-search]');
    if (input === null) throw new Error('Expected annotation search.');
    input.value = 'different';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.visibleIds()).toEqual(['annotation-1']);

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const color = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-annotation-color]'),
    ).find((candidate) => candidate.dataset['annotationColor'] === '#ffd400');
    if (color === undefined) throw new Error('Expected Important color filter.');
    color.click();
    expect(panel.visibleIds()).toEqual(['annotation-0']);
    const tagSection = documentTagsFooter(root);
    expect(
      tagSection
        .querySelector('[data-action="toggle-document-tags"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(root.querySelector('[data-annotation-tag-row]')).toBeNull();
    toggleDocumentTags(root);
    const tag = root.querySelector<HTMLButtonElement>('[data-annotation-tag="theory"]');
    if (tag === null) throw new Error('Expected Theory tag filter.');
    tag.click();
    expect(tag.getAttribute('aria-pressed')).toBe('true');
    expect(panel.visibleIds()).toEqual(['annotation-0']);
    tag.click();
    expect(tag.getAttribute('aria-pressed')).toBe('false');
    expect(panel.visibleIds()).toEqual(['annotation-0']);
  });

  it('counts semantic color facets', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#ffd400': 'Important', '#00ff00': 'Question' },
      onNavigate: vi.fn(),
    });
    panel.setAnnotations([
      annotation(0),
      annotation(1),
      annotation(2, { color: '#00ff00' }),
      annotation(3, { color: '#ff00ff' }),
    ]);

    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-annotation-color]'));
    expect(
      Object.fromEntries(chips.map((chip) => [chip.dataset['annotationColor'], chip.textContent])),
    ).toEqual({ '#00ff00': 'Question1', '#ffd400': 'Important2', '#ff00ff': 'Custom color1' });
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'false',
    ]);
  });

  it('labels unknown colors as Custom color', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#ffd400': '  ', '#00ff00': 'Review', '#0000ff': 'Review' },
      onNavigate: vi.fn(),
    });
    panel.setAnnotations([
      annotation(0),
      annotation(1, { color: '#00ff00' }),
      annotation(2, { color: '#0000ff' }),
    ]);

    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-annotation-color]'));
    expect(chips.map((chip) => chip.textContent)).toEqual(['Review1', 'Review1', 'Custom color1']);
    expect(root.querySelector('.abyss-annotation-colors')?.textContent).not.toMatch(
      /#[\da-f]{6}/iu,
    );
    expect(chips.map((chip) => chip.dataset['annotationColor'])).toEqual([
      '#0000ff',
      '#00ff00',
      '#ffd400',
    ]);
  });

  it('disambiguates duplicate semantic facet names without exposing hex', () => {
    const root = createDiv();
    const options = {
      colorMeanings: { '#0000ff': 'Review', '#00ff00': 'Review' },
      colorNames: { '#0000ff': 'Blue', '#00ff00': 'Green' },
      onNavigate: vi.fn(),
    };
    const panel = new AnnotationsPanel(root, options);
    panel.setAnnotations([
      annotation(0, { color: '#0000ff' }),
      annotation(1, { color: '#00ff00' }),
      annotation(2, { color: '#123456' }),
      annotation(3, { color: '#654321' }),
    ]);

    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-annotation-color]'));
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Review1',
      'Review1',
      'Custom color1',
      'Custom color1',
    ]);
    const names = chips.map((chip) => chip.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual([
      'Review — Blue, 1 annotation',
      'Review — Green, 1 annotation',
      'Custom color — Color 1 of 2, 1 annotation',
      'Custom color — Color 2 of 2, 1 annotation',
    ]);
    expect(names.join(' ')).not.toMatch(/#[\da-f]{6}/iu);

    const repeatedRoot = createDiv();
    const repeatedPanel = new AnnotationsPanel(repeatedRoot, {
      colorMeanings: { '#0000ff': 'Later', '#00ff00': 'Later' },
      colorNames: { '#0000ff': 'Marker', '#00ff00': 'Marker' },
      onNavigate: vi.fn(),
    });
    repeatedPanel.setAnnotations([
      annotation(0, { color: '#0000ff' }),
      annotation(1, { color: '#00ff00' }),
    ]);
    expect(
      Array.from(
        repeatedRoot.querySelectorAll<HTMLButtonElement>('[data-annotation-color]'),
        (chip) => chip.getAttribute('aria-label'),
      ),
    ).toEqual(['Later — Color 1 of 2, 1 annotation', 'Later — Color 2 of 2, 1 annotation']);
  });

  it('filters without scanning rendered DOM', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#ffd400': 'Important', '#00ff00': 'Question' },
      onNavigate: vi.fn(),
    });
    panel.setAnnotations([
      annotation(0),
      annotation(1, { color: '#00ff00' }),
      annotation(2, { color: '#00ff00' }),
    ]);
    root
      .querySelector<HTMLElement>('[data-annotation-id="annotation-0"]')
      ?.replaceChildren('Question');
    const question = root.querySelector<HTMLButtonElement>('[data-annotation-color="#00ff00"]');
    if (question === null) throw new Error('Expected Question color facet.');

    question.click();

    expect(panel.visibleIds()).toEqual(['annotation-1', 'annotation-2']);
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-annotation-color="#00ff00"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('keeps selected zero-count facets available after live projection deletion', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#0000ff': 'Review', '#ffd400': 'Important' },
      onNavigate: vi.fn(),
    });
    const blue = {
      key: 'blue-row',
      annotation: annotation(0, { color: '#0000ff', tags: ['Question'] }),
      nativeId: 'annotation-0',
      writable: true,
    } satisfies AnnotationProjectionRow;
    const yellow = {
      key: 'yellow-row',
      annotation: annotation(1, { color: '#ffd400', tags: ['Theory'] }),
      nativeId: 'annotation-1',
      writable: true,
    } satisfies AnnotationProjectionRow;
    panel.setProjectedAnnotations([blue, yellow]);
    root.querySelector<HTMLButtonElement>('[data-annotation-color="#0000ff"]')?.click();
    toggleDocumentTags(root);
    root.querySelector<HTMLButtonElement>('[data-annotation-tag="question"]')?.click();

    panel.setProjectedAnnotations([yellow]);

    const color = root.querySelector<HTMLButtonElement>('[data-annotation-color="#0000ff"]');
    const tag = root.querySelector<HTMLButtonElement>('[data-annotation-tag="question"]');
    expect(color?.getAttribute('aria-pressed')).toBe('true');
    expect(color?.querySelector('[class$="-count"]')?.textContent).toBe('0');
    expect(tag?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe(
      'No matching annotations',
    );

    color?.click();
    tag?.click();
    expect(panel.visibleIds()).toEqual(['annotation-1']);
    expect(root.querySelector('[data-annotation-color="#0000ff"]')).toBeNull();
    expect(root.querySelector('[data-annotation-tag="question"]')).toBeNull();
    expect(
      documentTagsFooter(root).querySelector('[data-annotation-tags-count]')?.textContent,
    ).toBe('1');
  });

  it('renders structured quote comment links and tags', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#ffd400': 'Important' },
      onNavigate: vi.fn(),
    });
    panel.setAnnotations([
      annotation(0, {
        selectedText: 'A precise passage from the document.',
        comment: 'Compare this with the governing rule.',
        links: ['Governing rule', 'Case notes'],
        tags: ['Evidence', 'Review'],
      }),
      annotation(1, { selectedText: ' ', comment: '', links: [], tags: [] }),
    ]);

    const card = root.querySelector<HTMLElement>('[data-annotation-id="annotation-0"]');
    expect(card?.querySelector('[data-annotation-page]')?.textContent).toBe('Page 1');
    expect(card?.querySelector('[data-annotation-meaning]')?.textContent).toBe('Important');
    expect(card?.querySelector('[data-annotation-quote]')?.textContent).toBe(
      'A precise passage from the document.',
    );
    expect(card?.querySelector('[data-annotation-comment]')?.textContent).toBe(
      'Compare this with the governing rule.',
    );
    expect(
      Array.from(
        card?.querySelectorAll('[data-annotation-link]') ?? [],
        (link) => link.textContent,
      ),
    ).toEqual(['Governing rule', 'Case notes']);
    expect(
      Array.from(
        card?.querySelectorAll('[data-annotation-card-tag]') ?? [],
        (tag) => tag.textContent,
      ),
    ).toEqual(['#Evidence', '#Review']);
    expect(card?.querySelector('div')).toBeNull();
    expect(Array.from(card?.children ?? [], (element) => element.tagName)).toEqual([
      'SPAN',
      'SPAN',
      'SPAN',
      'SPAN',
      'SPAN',
    ]);
    expect(card?.querySelector('.internal-link')).toBeNull();
    const empty = root.querySelector<HTMLElement>('[data-annotation-id="annotation-1"]');
    expect(empty?.querySelector('[data-annotation-quote]')).toBeNull();
    expect(empty?.querySelector('[data-annotation-comment]')).toBeNull();
    expect(empty?.querySelector('[data-annotation-links]')).toBeNull();
    expect(empty?.querySelector('[data-annotation-card-tags]')).toBeNull();
  });

  it('uses one neutral navigation target with a colored quote rail and true roving focus', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const onNavigate = vi.fn();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#ffd400': 'Important' },
      onNavigate,
    });
    panel.setAnnotations([annotation(0), annotation(1)]);
    const firstRow = root.querySelector<HTMLElement>('.abyss-annotation-card-row');
    const firstCard = firstRow?.querySelector<HTMLButtonElement>('.abyss-annotation-card');
    const quote = firstCard?.querySelector<HTMLElement>('[data-annotation-quote]');
    const comment = firstCard?.querySelector<HTMLElement>('[data-annotation-comment]');

    expect(firstRow?.tagName).toBe('ARTICLE');
    expect(firstRow?.getAttribute('role')).toBe('listitem');
    expect(firstRow?.querySelectorAll(':scope > .abyss-annotation-card')).toHaveLength(1);
    expect(firstCard?.querySelector('button, a, input, textarea, select')).toBeNull();
    expect(firstCard?.style.getPropertyValue('--abyss-annotation-color')).toBe('');
    expect(quote?.style.getPropertyValue('--abyss-annotation-color')).toBe('#ffd400');
    expect(comment?.style.getPropertyValue('--abyss-annotation-color')).toBe('');
    expect(
      firstCard
        ?.querySelector<HTMLElement>('[data-annotation-color-swatch]')
        ?.style.getPropertyValue('--abyss-annotation-color'),
    ).toBe('#ffd400');

    firstCard?.focus();
    firstCard?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    const cards = Array.from(root.querySelectorAll<HTMLButtonElement>('.abyss-annotation-card'));
    expect(cards.map((card) => card.tabIndex)).toEqual([-1, 0]);
    expect(root.doc.activeElement).toBe(cards[1]);
    cards[1]?.click();
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 1 }));
    root.remove();
  });

  it('keeps Copy and Insert contextual', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onCopy: vi.fn(),
      onInsert: vi.fn(),
    });
    panel.setAnnotations([annotation(0)]);
    const row = root.querySelector<HTMLElement>('.abyss-annotation-card-row');
    const actions = root.querySelector<HTMLElement>('.abyss-annotation-card-actions');
    const origin = ownerWindow(root).createEl('button');
    root.doc.body.append(origin);
    origin.focus();
    expect(actions?.dataset['contextual']).toBe('');
    expect(row?.hasAttribute('data-actions-open')).toBe(false);

    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(row?.hasAttribute('data-actions-open')).toBe(true);
    expect(root.doc.activeElement).toBe(origin);
    origin.remove();
    root.remove();
  });

  it('keeps actions reachable without hover', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const onCopy = vi.fn();
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onCopy,
      onInsert: vi.fn(),
    });
    panel.setAnnotations([annotation(0)]);
    const row = root.querySelector<HTMLElement>('.abyss-annotation-card-row');
    const card = root.querySelector<HTMLElement>('.abyss-annotation-card');
    const copy = root.querySelector<HTMLButtonElement>('[data-action="copy-annotation-link"]');
    copy?.focus();
    expect(root.doc.activeElement).toBe(copy);

    card?.dispatchEvent(
      Object.assign(new Event('pointerup', { bubbles: true }), { pointerType: 'touch' }),
    );
    expect(row?.hasAttribute('data-actions-open')).toBe(true);
    copy?.click();
    expect(onCopy).toHaveBeenCalledOnce();
    root.remove();
  });

  it('closes contextual actions when interaction moves away', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onCopy: vi.fn(),
      onInsert: vi.fn(),
    });
    panel.setAnnotations([annotation(0)]);
    const row = root.querySelector<HTMLElement>('.abyss-annotation-card-row');
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(row?.hasAttribute('data-actions-open')).toBe(true);
    const outside = ownerWindow(root).createEl('button');
    root.doc.body.append(outside);

    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(row?.hasAttribute('data-actions-open')).toBe(false);
    panel.destroy();
    outside.remove();
    root.remove();
  });

  it('preserves contextual action focus through virtual rerenders and restores the card on Escape', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onCopy: vi.fn(),
      onInsert: vi.fn(),
    });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    const insert = root.querySelector<HTMLButtonElement>('[data-action="insert-annotation"]');
    insert?.focus();
    expect(root.doc.activeElement).toBe(insert);

    panel.setCurrentPage(0);

    const restored = root.querySelector<HTMLButtonElement>('[data-action="insert-annotation"]');
    expect(root.doc.activeElement).toBe(restored);
    restored?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-0');
    expect(
      root
        .querySelector<HTMLElement>('[data-annotation-card-id="annotation-0"]')
        ?.hasAttribute('data-actions-open'),
    ).toBe(false);
    expect(
      root
        .querySelector<HTMLElement>('[data-annotation-card-id="annotation-0"]')
        ?.hasAttribute('data-actions-suppressed'),
    ).toBe(true);
    panel.setCurrentPage(0);
    expect(
      root
        .querySelector<HTMLElement>('[data-annotation-card-id="annotation-0"]')
        ?.hasAttribute('data-actions-suppressed'),
    ).toBe(true);
    const outside = ownerWindow(root).createEl('button');
    root.doc.body.append(outside);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('[data-actions-suppressed]')).toBeNull();
    outside.remove();
    root.remove();
  });

  it('does not rehydrate contextual state after focus moves to a different virtual row', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onCopy: vi.fn(),
      onInsert: vi.fn(),
    });
    panel.setAnnotations(Array.from({ length: 100 }, (_, index) => annotation(index)));
    const firstInsert = root.querySelector<HTMLButtonElement>(
      '[data-annotation-card-id="annotation-0"] [data-action="insert-annotation"]',
    );
    firstInsert?.focus();
    firstInsert?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(
      root
        .querySelector<HTMLElement>('[data-annotation-card-id="annotation-0"]')
        ?.hasAttribute('data-actions-suppressed'),
    ).toBe(true);

    panel.setCurrentPage(50);
    root.querySelector<HTMLButtonElement>('[data-annotation-id="annotation-50"]')?.focus();
    panel.setCurrentPage(0);

    expect(
      root
        .querySelector<HTMLElement>('[data-annotation-card-id="annotation-0"]')
        ?.hasAttribute('data-actions-suppressed'),
    ).toBe(false);
    expect(root.querySelector('[data-actions-open]')).toBeNull();
    root.remove();
  });

  it('uses the first touch only to reveal persistent actions and suppress navigation', () => {
    const root = createDiv();
    const onNavigate = vi.fn();
    const panel = new AnnotationsPanel(root, {
      onNavigate,
      onCopy: vi.fn(),
      onInsert: vi.fn(),
    });
    panel.setAnnotations([annotation(0), annotation(1)]);
    const firstCard = root.querySelector<HTMLButtonElement>('[data-annotation-id="annotation-0"]');
    firstCard?.dispatchEvent(
      Object.assign(new Event('pointerup', { bubbles: true, cancelable: true }), {
        pointerType: 'touch',
      }),
    );
    const generatedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    firstCard?.dispatchEvent(generatedClick);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(generatedClick.defaultPrevented).toBe(true);
    expect(
      root
        .querySelector<HTMLElement>('[data-annotation-card-id="annotation-0"]')
        ?.hasAttribute('data-actions-open'),
    ).toBe(true);
    panel.setCurrentPage(1);
    expect(
      root
        .querySelector<HTMLElement>('[data-annotation-card-id="annotation-0"]')
        ?.hasAttribute('data-actions-open'),
    ).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-annotation-id="annotation-0"]')?.click();
    expect(onNavigate).toHaveBeenCalledOnce();
    panel.setAnnotations([annotation(0), annotation(1)]);
    expect(root.querySelector('[data-actions-open]')).toBeNull();
  });

  it('does not arm card navigation suppression when touch originates on an action', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const onCopy = vi.fn();
    const onNavigate = vi.fn();
    const panel = new AnnotationsPanel(root, {
      onCopy,
      onInsert: vi.fn(),
      onNavigate,
    });
    panel.setAnnotations([annotation(0)]);
    const copy = root.querySelector<HTMLButtonElement>('[data-action="copy-annotation-link"]');
    copy?.focus();
    copy?.dispatchEvent(
      Object.assign(new Event('pointerup', { bubbles: true, cancelable: true }), {
        pointerType: 'touch',
      }),
    );
    copy?.click();
    root.querySelector<HTMLButtonElement>('.abyss-annotation-card')?.click();

    expect(onCopy).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledOnce();
    root.remove();
  });

  it('keeps unique tag facets bounded and finds a late tag on demand', () => {
    beginPluginActivation();
    endPluginActivation();
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(
      Array.from({ length: 10_000 }, (_, index) =>
        annotation(index, { tags: [`Unique-${String(index).padStart(5, '0')}`] }),
      ),
    );
    documentTagsFooter(root);
    expect(root.querySelectorAll('[data-annotation-tag-row]')).toHaveLength(0);

    toggleDocumentTags(root);
    expect(root.querySelectorAll('[data-annotation-tag-row]').length).toBeLessThanOrEqual(48);
    const search = root.querySelector<HTMLInputElement>('[data-annotation-tag-search]');
    if (search === null) throw new Error('Expected tag search for a high-cardinality facet.');
    search.value = 'unique-09999';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const lateTag = root.querySelector<HTMLButtonElement>('[data-annotation-tag="unique-09999"]');
    if (lateTag === null) throw new Error('Expected the searched late tag.');
    lateTag.click();

    expect(panel.visibleIds()).toEqual(['annotation-9999']);
    expect(root.querySelectorAll('[data-annotation-tag-row]').length).toBeLessThanOrEqual(48);
    expect(readerPerformanceSnapshot().counters.maxAnnotationPanelNodes).toBeLessThanOrEqual(1_024);
  });

  it('gives long Unicode and RTL tag tokens bounded text with useful names', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    const longTag = 'قضية-重要事項-'.repeat(24);
    panel.setAnnotations([annotation(0, { tags: [longTag] })]);
    toggleDocumentTags(root);

    const facet = root.querySelector<HTMLButtonElement>('[data-annotation-tag-row]');
    const cardTag = root.querySelector<HTMLElement>('[data-annotation-card-tag]');
    expect(facet?.getAttribute('aria-label')).toBe(`${longTag} tag`);
    expect(facet?.title).toBe(`#${longTag}`);
    expect(cardTag?.title).toBe(`#${longTag}`);
  });

  it('keeps imported color facets bounded and finds a late color on demand', () => {
    beginPluginActivation();
    endPluginActivation();
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(
      Array.from({ length: 10_000 }, (_, index) =>
        annotation(index, { color: `#${index.toString(16).padStart(6, '0')}` }),
      ),
    );
    expect(root.querySelectorAll('[data-annotation-color-row]').length).toBeLessThanOrEqual(16);
    const search = root.querySelector<HTMLInputElement>('[data-annotation-color-search]');
    if (search === null) throw new Error('Expected color search for a high-cardinality facet.');
    search.value = '#00270f';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const lateColor = root.querySelector<HTMLButtonElement>('[data-annotation-color="#00270f"]');
    if (lateColor === null) throw new Error('Expected the searched late color.');
    lateColor.click();

    expect(panel.visibleIds()).toEqual(['annotation-9999']);
    expect(root.querySelectorAll('[data-annotation-color-row]').length).toBeLessThanOrEqual(16);
    expect(readerPerformanceSnapshot().counters.maxAnnotationPanelNodes).toBeLessThanOrEqual(1_024);
  });

  it('renders color meanings, starts Tags collapsed, supports arrows, and syncs current page', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const onNavigate = vi.fn();
    const panel = new AnnotationsPanel(root, {
      colorMeanings: { '#ffd400': 'Important' },
      onNavigate,
    });
    panel.setAnnotations([annotation(0), annotation(1)]);
    const tags = documentTagsFooter(root);
    expect(
      tags.querySelector('[data-action="toggle-document-tags"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(root.textContent).toContain('Important');
    panel.setCurrentPage(1);
    const current = root.querySelector<HTMLElement>('[data-annotation-id="annotation-1"]');
    current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-0');
    current?.click();
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 1 }));
    root.remove();
  });

  it('activates the exact projected annotation from focus, click, Enter, and Space', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const onActivate = vi.fn();
    const panel = new AnnotationsPanel(root, { onActivate, onNavigate: vi.fn() });
    const overlapping = [
      {
        key: 'overlap-first-row',
        annotation: annotation(0, { selectedText: 'First overlap' }),
        nativeId: 'native-first',
        writable: true,
      },
      {
        key: 'overlap-second-row',
        annotation: annotation(1, {
          anchor: annotation(0).anchor,
          selectedText: 'Second overlap',
        }),
        nativeId: 'native-second',
        writable: true,
      },
    ] satisfies readonly AnnotationProjectionRow[];
    panel.setProjectedAnnotations(overlapping);
    const second = root.querySelector<HTMLButtonElement>(
      '.abyss-annotation-card[data-annotation-row-id="overlap-second-row"]',
    );
    if (second === null) throw new Error('Expected the second overlapping annotation card.');

    second.focus();
    second.click();
    second.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    second.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));

    expect(onActivate).toHaveBeenCalledTimes(4);
    expect(onActivate).toHaveBeenLastCalledWith({
      annotation: overlapping[1]?.annotation,
      location: { pageIndex: 0, x: 0, y: 0 },
      nativeId: 'native-second',
      rowId: 'overlap-second-row',
    });
    const selected = root.querySelectorAll('.abyss-annotation-card[aria-current="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute('data-annotation-row-id')).toBe('overlap-second-row');
    root.remove();
  });

  it('deduplicates one pointer focus-and-click gesture and ignores internal focus restoration', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const onActivate = vi.fn();
    const panel = new AnnotationsPanel(root, { onActivate, onNavigate: vi.fn() });
    panel.setAnnotations([annotation(0), annotation(1)]);
    const first = root.querySelector<HTMLButtonElement>('[data-annotation-id="annotation-0"]');
    if (first === null) throw new Error('Expected first annotation card.');

    first.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    first.focus();
    first.click();
    expect(onActivate).toHaveBeenCalledOnce();

    panel.setFilter({ query: '', colors: new Set(), tags: new Set() });
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-0');
    expect(onActivate).toHaveBeenCalledOnce();

    root.doc.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
    );
    expect(onActivate).toHaveBeenCalledTimes(2);
    root.remove();
  });

  it('shows one background failure state without throwing', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setUnavailable();
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Couldn’t load annotations');
  });

  it('sets drag payloads and exposes keyboard/mobile Copy and Insert actions', () => {
    const root = createDiv();
    const onTransfer = vi.fn();
    const onCopy = vi.fn();
    const onInsert = vi.fn();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn(), onTransfer, onCopy, onInsert });
    const item = annotation(2);
    panel.setAnnotations([item]);
    const row = root.querySelector<HTMLElement>('[draggable="true"]');
    if (row === null) throw new Error('Expected draggable annotation row.');
    const transfer = { setData: vi.fn() } as unknown as DataTransfer;
    row.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: transfer }),
    );
    root.querySelector<HTMLButtonElement>('[data-action="copy-annotation-link"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-action="insert-annotation"]')?.click();
    expect(onTransfer).toHaveBeenCalledWith(item, transfer);
    expect(onCopy).toHaveBeenCalledWith(item);
    expect(onInsert).toHaveBeenCalledWith(item);
  });

  it('keeps uncommitted annotations silent with no transfer surface', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onTransfer: vi.fn(),
      onCopy: vi.fn(),
      onInsert: vi.fn(),
    });
    panel.setAnnotations([
      { ...annotation(1), identity: { kind: 'legacy', fingerprint: 'pending' } },
    ]);
    expect(root.textContent).not.toMatch(/save|autosave|pending/iu);
    expect(root.querySelector('[data-annotation-provisional="true"]')).not.toBeNull();
    expect(root.querySelector('[draggable="true"]')).toBeNull();
    expect(root.querySelector('[data-action="copy-annotation-link"]')).toBeNull();
    expect(root.querySelector('[data-action="insert-annotation"]')).toBeNull();
  });

  it('does not expose PDF transfer controls for stable reflowable annotations', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onTransfer: vi.fn(),
      onCopy: vi.fn(),
      onInsert: vi.fn(),
    });
    panel.setAnnotations([
      {
        ...annotation(1),
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 'text', prefix: '', suffix: '' },
          progression: 0.2,
        },
      },
    ]);
    expect(root.querySelector('[draggable="true"]')).toBeNull();
    expect(root.querySelector('[data-action="copy-annotation-link"]')).toBeNull();
    expect(root.querySelector('[data-action="insert-annotation"]')).toBeNull();
  });

  it('uses direct listitem rows and contains drag failures', () => {
    const root = createDiv();
    const item = annotation(1);
    const onTransferFailure = vi.fn();
    const panel = new AnnotationsPanel(root, {
      onNavigate: vi.fn(),
      onTransfer: () => {
        throw new Error('drag failed');
      },
      onTransferFailure,
    });
    panel.setAnnotations([item]);
    const row = root.querySelector<HTMLElement>('[role="listitem"]');
    expect(row?.parentElement).toBe(root.querySelector('[role="list"]'));
    row?.dispatchEvent(
      Object.assign(new Event('dragstart', { bubbles: true }), {
        dataTransfer: { setData: vi.fn() },
      }),
    );
    expect(onTransferFailure).toHaveBeenCalledWith(item, expect.any(Error));
  });

  it('selects a resolved annotation and renders explicit unresolved/ambiguous state', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 200 }, (_, index) => annotation(index)));
    expect(panel.selectAnnotation('annotation-150')).toBe(true);
    expect(
      root.querySelector('[data-annotation-id="annotation-150"]')?.getAttribute('aria-current'),
    ).toBe('true');
    panel.setResolutionError('ambiguous', 'Books/Book.pdf');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'matches more than one annotation',
    );
    panel.setResolutionError('unresolved', 'Books/Book.pdf');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('could not be found');
    root.remove();
  });

  it('clears active facets, renders empty state, and navigates every geometry kind', () => {
    const root = createDiv();
    const onNavigate = vi.fn();
    const panel = new AnnotationsPanel(root, { onNavigate });
    const annotations = [
      annotation(0, { selectedText: null, comment: '' }),
      annotation(1, {
        anchor: {
          kind: 'fixed-page',
          pageIndex: 1,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'rectangle', rectangle: { x: 2, y: 3, width: 4, height: 5 } },
        },
      }),
      annotation(2, {
        anchor: {
          kind: 'fixed-page',
          pageIndex: 2,
          coordinateSpace: 'page-points-top-left',
          geometry: {
            kind: 'quadrilaterals',
            quadrilaterals: [
              {
                topLeft: { x: 6, y: 7 },
                topRight: { x: 8, y: 7 },
                bottomLeft: { x: 6, y: 9 },
                bottomRight: { x: 8, y: 9 },
              },
            ],
          },
        },
      }),
      annotation(3, {
        anchor: {
          kind: 'fixed-page',
          pageIndex: 3,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'ink', paths: [[{ x: 10, y: 11 }]] },
        },
      }),
    ];
    panel.setAnnotations(annotations);
    root.querySelectorAll<HTMLButtonElement>('[data-annotation-id]').forEach((card) => {
      card.click();
    });
    expect(onNavigate).toHaveBeenNthCalledWith(1, { pageIndex: 0, x: 0, y: 0 });
    expect(onNavigate).toHaveBeenNthCalledWith(2, { pageIndex: 1, x: 2, y: 3 });
    expect(onNavigate).toHaveBeenNthCalledWith(3, { pageIndex: 2, x: 6, y: 7 });
    expect(onNavigate).toHaveBeenNthCalledWith(4, { pageIndex: 3, x: 10, y: 11 });

    panel.setFilter({ query: 'missing', colors: new Set(), tags: new Set() });
    expect(root.textContent).toContain('No matching annotations');
    panel.setFilter({ query: '', colors: new Set(), tags: new Set() });
    const firstColor = root.querySelector<HTMLButtonElement>('[data-annotation-color]');
    if (firstColor === null) throw new Error('Expected color facet.');
    firstColor.click();
    root.querySelector<HTMLButtonElement>('[data-annotation-color]')?.click();
  });

  it('moves the virtual window with End, Down, Home and current-page synchronization', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setAnnotations(Array.from({ length: 200 }, (_, index) => annotation(index)));
    const keyboard = (key: string): KeyboardEvent =>
      new KeyboardEvent('keydown', { bubbles: true, key });
    root
      .querySelector<HTMLElement>('[data-annotation-id="annotation-0"]')
      ?.dispatchEvent(keyboard('End'));
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-199');
    root.doc.activeElement?.dispatchEvent(keyboard('Home'));
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-0');
    root.doc.activeElement?.dispatchEvent(keyboard('ArrowDown'));
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-1');
    panel.setCurrentPage(150);
    expect(root.querySelector('[data-annotation-id="annotation-150"]')).not.toBeNull();
    root.remove();
  });

  it('keeps exactly one mounted roving tab stop after every virtual-window transition', () => {
    const root = createDiv();
    root.doc.body.append(root);
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    const rows = Array.from({ length: 200 }, (_, index) => ({
      annotation: annotation(index),
      key: `row-${String(index)}`,
      nativeId: `native-${String(index)}`,
      writable: true,
    }));
    const expectOneMountedTabStop = (): void => {
      const cards = Array.from(root.querySelectorAll<HTMLButtonElement>('.abyss-annotation-card'));
      expect(cards.filter((card) => card.tabIndex === 0)).toHaveLength(1);
    };
    panel.setProjectedAnnotations(rows);
    expectOneMountedTabStop();

    const scrollHost = annotationScrollHost(root);
    scrollHost.scrollTop = 120 * 112;
    scrollHost.dispatchEvent(new Event('scroll'));
    expectOneMountedTabStop();

    panel.setCurrentPage(175);
    expectOneMountedTabStop();

    panel.setFilter({ query: 'Concept 190', colors: new Set(), tags: new Set() });
    expectOneMountedTabStop();

    panel.setFilter({ query: '', colors: new Set(), tags: new Set() });
    panel.selectAnnotation('annotation-190');
    panel.setProjectedAnnotations(rows.filter((row) => row.nativeId !== 'native-190'));
    expectOneMountedTabStop();
    root.remove();
  });
});
