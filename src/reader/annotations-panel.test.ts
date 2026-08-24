import { describe, expect, it, vi } from 'vitest';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import { asAnnotationId } from '../document-core/annotations.js';
import {
  beginPluginActivation,
  endPluginActivation,
  readerPerformanceSnapshot,
} from '../reader-performance.js';
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

describe('AnnotationsPanel', () => {
  it('renders exactly No annotations when empty', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setAnnotations([]);

    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe('No annotations');
    expect(root.querySelector<HTMLInputElement>('[data-annotation-search]')?.hidden).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('[data-section="tags"]')?.hidden).toBe(true);
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

  it('hides controls and tags when empty', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setAnnotations([]);

    expect(root.querySelector<HTMLElement>('.abyss-annotation-controls')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.abyss-annotation-tags')?.hidden).toBe(true);
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

  it('renders actionable unavailable without technical jargon', () => {
    const root = createDiv();
    const retry = vi.fn();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });

    panel.setUnavailable({ onRetry: retry });

    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe(
      'Annotations unavailableTry again',
    );
    expect(root.textContent).not.toMatch(/index|cache|reopen/i);
    root.querySelector<HTMLButtonElement>('[data-action="retry-annotations"]')?.click();
    expect(retry).toHaveBeenCalledOnce();

    panel.setUnavailable();
    expect(root.querySelector('[data-action="retry-annotations"]')).toBeNull();
    expect(root.querySelector('[data-annotations-status]')?.textContent).toBe(
      'Annotations unavailable',
    );
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
      root.querySelectorAll<HTMLInputElement>('[data-annotation-color]'),
    ).find((candidate) => candidate.dataset['annotationColor'] === '#ffd400');
    if (color === undefined) throw new Error('Expected Important color filter.');
    color.checked = true;
    color.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.visibleIds()).toEqual(['annotation-0']);
    const tagSection = root.querySelector<HTMLDetailsElement>('[data-section="tags"]');
    expect(tagSection?.open).toBe(false);
    expect(root.querySelector('[data-annotation-tag-row]')).toBeNull();
    if (tagSection === null) throw new Error('Expected Tags section.');
    tagSection.open = true;
    tagSection.dispatchEvent(new Event('toggle'));
    const tag = root.querySelector<HTMLInputElement>('[data-annotation-tag="theory"]');
    if (tag === null) throw new Error('Expected Theory tag filter.');
    tag.checked = true;
    tag.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.visibleIds()).toEqual(['annotation-0']);
    tag.checked = false;
    tag.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.visibleIds()).toEqual(['annotation-0']);
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
    const tagSection = root.querySelector<HTMLDetailsElement>('[data-section="tags"]');
    if (tagSection === null) throw new Error('Expected Tags section.');
    expect(root.querySelectorAll('[data-annotation-tag-row]')).toHaveLength(0);

    tagSection.open = true;
    tagSection.dispatchEvent(new Event('toggle'));
    expect(root.querySelectorAll('[data-annotation-tag-row]').length).toBeLessThanOrEqual(48);
    const search = root.querySelector<HTMLInputElement>('[data-annotation-tag-search]');
    if (search === null) throw new Error('Expected tag search for a high-cardinality facet.');
    search.value = 'unique-09999';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const lateTag = root.querySelector<HTMLInputElement>('[data-annotation-tag="unique-09999"]');
    if (lateTag === null) throw new Error('Expected the searched late tag.');
    lateTag.checked = true;
    lateTag.dispatchEvent(new Event('change', { bubbles: true }));

    expect(panel.visibleIds()).toEqual(['annotation-9999']);
    expect(root.querySelectorAll('[data-annotation-tag-row]').length).toBeLessThanOrEqual(48);
    expect(readerPerformanceSnapshot().counters.maxAnnotationPanelNodes).toBeLessThanOrEqual(1_024);
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
    const lateColor = root.querySelector<HTMLInputElement>('[data-annotation-color="#00270f"]');
    if (lateColor === null) throw new Error('Expected the searched late color.');
    lateColor.checked = true;
    lateColor.dispatchEvent(new Event('change', { bubbles: true }));

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
    const tags = root.querySelector<HTMLDetailsElement>('[data-section="tags"]');
    expect(tags?.open).toBe(false);
    expect(root.textContent).toContain('Important');
    panel.setCurrentPage(1);
    const current = root.querySelector<HTMLElement>('[aria-current="location"]');
    expect(current?.dataset['annotationId']).toBe('annotation-1');
    current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(root.doc.activeElement?.getAttribute('data-annotation-id')).toBe('annotation-0');
    current?.click();
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 1 }));
    root.remove();
  });

  it('shows one background failure state without throwing', () => {
    const root = createDiv();
    const panel = new AnnotationsPanel(root, { onNavigate: vi.fn() });
    panel.setUnavailable();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Annotations unavailable');
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

  it('keeps uncommitted annotations pending with no transfer surface', () => {
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
    expect(root.textContent).toContain('Pending save');
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
    const firstColor = root.querySelector<HTMLInputElement>('[data-annotation-color]');
    if (firstColor === null) throw new Error('Expected color facet.');
    firstColor.checked = true;
    firstColor.dispatchEvent(new Event('change', { bubbles: true }));
    firstColor.checked = false;
    firstColor.dispatchEvent(new Event('change', { bubbles: true }));
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
});
