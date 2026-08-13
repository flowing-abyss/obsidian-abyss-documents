import { describe, expect, it, vi } from 'vitest';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import { asAnnotationId } from '../document-core/annotations.js';
import { AnnotationsPanel } from './annotations-panel.js';

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

describe('AnnotationsPanel', () => {
  it('keeps a 10,000-item virtual list at 80 cards or fewer and filters metadata', () => {
    const root = createDiv();
    const onNavigate = vi.fn();
    const panel = new AnnotationsPanel(root, { onNavigate });
    panel.setAnnotations(Array.from({ length: 10_000 }, (_, index) => annotation(index)));

    expect(root.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(80);
    panel.setFilter({ query: 'concept', colors: new Set(['#ffd400']), tags: new Set(['theory']) });
    expect(panel.visibleIds().slice(0, 3)).toEqual([
      'annotation-0',
      'annotation-2',
      'annotation-4',
    ]);
    expect(root.querySelectorAll('.abyss-annotation-card').length).toBeLessThanOrEqual(80);
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
    expect(root.querySelector<HTMLDetailsElement>('[data-section="tags"]')?.open).toBe(false);
    const tag = root.querySelector<HTMLInputElement>('[data-annotation-tag="theory"]');
    if (tag === null) throw new Error('Expected Theory tag filter.');
    tag.checked = true;
    tag.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.visibleIds()).toEqual(['annotation-0']);
    tag.checked = false;
    tag.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.visibleIds()).toEqual(['annotation-0']);
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
    panel.setError('Could not index annotations. Reopen the PDF to retry.');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Could not index');
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
    expect(root.textContent).toContain('No annotations match');
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
