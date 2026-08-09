import { describe, expect, it, vi } from 'vitest';
import type { OutlineItem } from '../document-core/document.js';
import { OutlinePanel } from './outline-panel.js';

const outline: readonly OutlineItem[] = [
  {
    id: 'chapter-1',
    label: 'Chapter 1',
    target: { pageIndex: 0 },
    children: [
      {
        id: 'section-1',
        label: 'Section 1',
        target: { pageIndex: 2, x: 12, y: 24 },
        children: [],
      },
      { id: 'missing', label: 'Unresolved destination', target: null, children: [] },
    ],
  },
];

function press(panel: OutlinePanel, row: HTMLElement | undefined, key: string): void {
  if (row === undefined) throw new Error(`Expected an outline row for ${key}.`);
  const OwnerKeyboardEvent = (panel.root.win as Window & { KeyboardEvent: typeof KeyboardEvent })
    .KeyboardEvent;
  row.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key }));
}

describe('OutlinePanel', () => {
  it('renders a recursive native tree and never navigates unresolved destinations', () => {
    const host = createDiv();
    const navigate = vi.fn();
    const panel = new OutlinePanel(host, navigate);

    panel.render(outline);

    expect(panel.root.querySelector('[role="tree"]')).not.toBeNull();
    expect(panel.root.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
    expect(panel.root.querySelectorAll('details')).toHaveLength(1);
    panel.root.querySelector<HTMLElement>('[data-outline-id="chapter-1"]')?.click();
    expect(navigate).toHaveBeenCalledWith({ pageIndex: 0 });
    navigate.mockClear();
    const unresolved = panel.root.querySelector<HTMLElement>('[data-outline-id="missing"]');
    expect(unresolved?.getAttribute('aria-disabled')).toBe('true');
    unresolved?.click();
    const OwnerKeyboardEvent = (
      panel.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    unresolved?.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('uses roving tabindex and keyboard navigation for visible outline rows', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const panel = new OutlinePanel(host, vi.fn());
    panel.render(outline);
    const rows = Array.from(panel.root.querySelectorAll<HTMLElement>('[data-outline-row]'));
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    rows[0]?.focus();
    press(panel, rows[0], 'ArrowDown');

    expect(panel.root.doc.activeElement).toBe(rows[1]);
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);

    press(panel, rows[1], 'ArrowUp');
    expect(panel.root.doc.activeElement).toBe(rows[0]);
    press(panel, rows[0], 'End');
    expect(panel.root.doc.activeElement).toBe(rows[2]);
    press(panel, rows[2], 'Home');
    expect(panel.root.doc.activeElement).toBe(rows[0]);

    const branch = panel.root.querySelector<HTMLDetailsElement>('details');
    if (branch === null) throw new Error('Expected an outline branch.');
    press(panel, rows[0], 'ArrowLeft');
    expect(branch.open).toBe(false);
    press(panel, rows[0], 'ArrowRight');
    expect(branch.open).toBe(true);
    press(panel, rows[0], 'ArrowRight');
    expect(panel.root.doc.activeElement).toBe(rows[1]);
    press(panel, rows[1], 'ArrowLeft');
    expect(panel.root.doc.activeElement).toBe(rows[0]);
  });

  it('renders an explicit empty state and navigates resolved leaves by click', () => {
    const navigate = vi.fn();
    const panel = new OutlinePanel(createDiv(), navigate);
    panel.render(outline);

    panel.root.querySelector<HTMLElement>('[data-outline-id="section-1"]')?.click();
    expect(navigate).toHaveBeenCalledWith({ pageIndex: 2, x: 12, y: 24 });

    panel.render([]);
    expect(panel.root.textContent).toContain('No outline available.');
    expect(panel.root.querySelectorAll('[data-outline-row]')).toHaveLength(0);
  });

  it('navigates resolved rows on Enter and marks the current location', () => {
    const navigate = vi.fn();
    const panel = new OutlinePanel(createDiv(), navigate);
    panel.render(outline);
    panel.setCurrentPage(2);
    const section = panel.root.querySelector<HTMLElement>('[data-outline-id="section-1"]');

    const OwnerKeyboardEvent = (
      panel.root.win as Window & {
        KeyboardEvent: typeof KeyboardEvent;
      }
    ).KeyboardEvent;
    section?.dispatchEvent(
      new OwnerKeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
      }),
    );

    expect(navigate).toHaveBeenCalledWith({ pageIndex: 2, x: 12, y: 24 });
    expect(section?.getAttribute('aria-current')).toBe('location');
    expect(
      panel.root.querySelector('[data-outline-id="chapter-1"]')?.hasAttribute('aria-current'),
    ).toBe(false);
  });
});
