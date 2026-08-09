import { describe, expect, it, vi } from 'vitest';
import type { SearchHit, SearchResultSet } from '../document-core/document.js';
import { SearchPanel, type SearchPanelCallbacks } from './search-panel.js';

function hit(index: number): SearchHit {
  return {
    id: `hit-${index}`,
    matchIndex: index % 3,
    pageIndex: Math.floor(index / 3),
    preview: `Preview ${index}`,
  };
}

function results(query: string, count: number, complete: boolean): SearchResultSet {
  return { query, hits: Array.from({ length: count }, (_, index) => hit(index)), complete };
}

function callbacks(): SearchPanelCallbacks {
  return {
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onQuery: vi.fn(),
  };
}

function enterQuery(panel: SearchPanel, query: string): void {
  panel.input.value = query;
  const OwnerEvent = (panel.root.win as Window & { Event: typeof Event }).Event;
  panel.input.dispatchEvent(new OwnerEvent('input', { bubbles: true }));
}

describe('SearchPanel', () => {
  it('accepts ordered partial results, rejects stale updates, and limits long result DOM', () => {
    const handlers = callbacks();
    const panel = new SearchPanel(createDiv(), handlers);
    enterQuery(panel, 'needle');

    panel.setResults(results('needle', 75, false));

    expect(panel.root.querySelector('[data-search-count]')?.textContent).toBe('75+ results');
    expect(panel.root.querySelectorAll('[data-search-result]')).toHaveLength(50);
    expect(
      Array.from(panel.root.querySelectorAll('[data-search-result]')).map(
        (element) => element.textContent,
      ),
    ).toEqual(
      Array.from({ length: 50 }, (_, index) => `Page ${Math.floor(index / 3) + 1}Preview ${index}`),
    );

    panel.setResults(results('older query', 1, true));
    expect(panel.root.querySelectorAll('[data-search-result]')).toHaveLength(50);
    panel.root.querySelector<HTMLButtonElement>('[data-action="show-more-results"]')?.click();
    expect(panel.root.querySelectorAll('[data-search-result]')).toHaveLength(75);
  });

  it('keeps the selected snippet, PDF occurrence direction, and page target synchronized', () => {
    const handlers = callbacks();
    const panel = new SearchPanel(createDiv(), handlers);
    enterQuery(panel, 'needle');
    panel.setResults(results('needle', 4, true));
    const third = panel.root.querySelectorAll<HTMLButtonElement>('[data-search-result]')[2];
    third?.click();

    expect(
      panel.root
        .querySelectorAll<HTMLButtonElement>('[data-search-result]')[2]
        ?.getAttribute('aria-current'),
    ).toBe('true');
    expect(handlers.onNavigate).toHaveBeenLastCalledWith(hit(2), 2, 'direct');

    panel.root.querySelector<HTMLButtonElement>('[data-action="previous-result"]')?.click();
    expect(handlers.onNavigate).toHaveBeenLastCalledWith(hit(1), 1, 'previous');
    expect(
      panel.root
        .querySelectorAll<HTMLButtonElement>('[data-search-result]')[1]
        ?.getAttribute('aria-current'),
    ).toBe('true');
  });

  it('clears the active document query before Escape closes the sidebar', () => {
    const handlers = callbacks();
    const panel = new SearchPanel(createDiv(), handlers);
    enterQuery(panel, 'needle');

    const OwnerKeyboardEvent = (
      panel.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    panel.input.dispatchEvent(
      new OwnerKeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      }),
    );

    expect(panel.input.value).toBe('');
    expect(handlers.onQuery).toHaveBeenLastCalledWith('');
    expect(handlers.onClose).not.toHaveBeenCalled();

    panel.input.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('covers empty, singular, next, and retained-selection states', () => {
    const handlers = callbacks();
    const panel = new SearchPanel(createDiv(), handlers);
    const OwnerKeyboardEvent = (
      panel.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    panel.input.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    panel.root.querySelector<HTMLButtonElement>('[data-action="next-result"]')?.click();
    expect(handlers.onNavigate).not.toHaveBeenCalled();

    enterQuery(panel, 'one');
    panel.setResults(results('one', 1, true));
    expect(panel.root.querySelector('[data-search-count]')?.textContent).toBe('1 result');
    panel.root.querySelector<HTMLButtonElement>('[data-action="next-result"]')?.click();
    expect(handlers.onNavigate).toHaveBeenLastCalledWith(hit(0), 0, 'next');

    panel.setResults({
      query: 'one',
      complete: true,
      hits: [{ ...hit(0), preview: 'Updated preview' }],
    });
    expect(panel.root.querySelector('[data-search-result]')?.getAttribute('aria-current')).toBe(
      'true',
    );

    enterQuery(panel, 'none');
    panel.setResults(results('none', 0, true));
    expect(panel.root.querySelector('[data-search-count]')?.textContent).toBe('0 results');
  });

  it('reveals the selected result when next navigation crosses the render limit', () => {
    const handlers = callbacks();
    const panel = new SearchPanel(createDiv(), handlers);
    enterQuery(panel, 'many');
    panel.setResults(results('many', 75, true));
    const next = panel.root.querySelector<HTMLButtonElement>('[data-action="next-result"]');
    for (let index = 0; index < 50; index += 1) next?.click();

    expect(panel.root.querySelectorAll('[data-search-result]')).toHaveLength(51);
    expect(
      panel.root.querySelectorAll('[data-search-result]')[50]?.getAttribute('aria-current'),
    ).toBe('true');
  });
});
