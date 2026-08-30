import type * as ObsidianModule from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { OutlineItem } from '../document-core/document.js';
import { OutlinePanel } from './outline-panel.js';

const mocks = vi.hoisted(() => ({ setIcon: vi.fn(), setTooltip: vi.fn() }));

vi.mock('obsidian', async (importOriginal) => {
  const original: typeof ObsidianModule = await importOriginal();
  return { ...original, setIcon: mocks.setIcon, setTooltip: mocks.setTooltip };
});

const outline: readonly OutlineItem[] = [
  {
    id: 'chapter-1',
    label: 'Chapter 1',
    target: { pageIndex: 0 },
    children: [
      {
        id: 'section-1',
        label: 'Section 1',
        target: {
          coordinateSpace: 'pdf-points-bottom-left',
          pageIndex: 2,
          x: 12,
          y: 24,
        },
        children: [],
      },
      { id: 'missing', label: 'Unresolved destination', target: null, children: [] },
    ],
  },
];

const searchableOutline: readonly OutlineItem[] = [
  {
    id: 'knowledge',
    label: 'База знаний',
    target: { pageIndex: 0 },
    children: [
      {
        id: 'writing',
        label: 'Пиши своими словами',
        target: { pageIndex: 3 },
        children: [
          {
            id: 'links',
            label: 'Internal Links',
            target: { pageIndex: 5 },
            children: [],
          },
        ],
      },
      {
        id: 'tools',
        label: 'Инструмент не важен',
        target: { pageIndex: 8 },
        children: [],
      },
    ],
  },
  {
    id: 'appendix',
    label: 'Appendix',
    target: { pageIndex: 11 },
    children: [],
  },
];

function search(panel: OutlinePanel, query: string): void {
  const input = panel.root.querySelector<HTMLInputElement>('[data-outline-search]');
  if (input === null) throw new Error('Expected an outline search field.');
  input.value = query;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function press(panel: OutlinePanel, row: HTMLElement | undefined, key: string): void {
  if (row === undefined) throw new Error(`Expected an outline row for ${key}.`);
  const OwnerKeyboardEvent = (panel.root.win as Window & { KeyboardEvent: typeof KeyboardEvent })
    .KeyboardEvent;
  row.dispatchEvent(new OwnerKeyboardEvent('keydown', { bubbles: true, key }));
}

describe('OutlinePanel', () => {
  it('isolates heading search from PDF.js global Backspace and clipboard handlers', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const panel = new OutlinePanel(host, vi.fn());
    const input = panel.root.querySelector<HTMLInputElement>('[data-outline-search]');
    if (input === null) throw new Error('Expected an outline search field.');
    const annotation = { color: '#ffd400', count: 1 };
    const documentMutation = vi.fn(() => {
      annotation.count = 0;
      annotation.color = '#ff0000';
    });
    const windowMutation = vi.fn(() => {
      annotation.count = 0;
      annotation.color = '#ff0000';
    });
    const owner = panel.root.win as Window & {
      Event: typeof Event;
      KeyboardEvent: typeof KeyboardEvent;
    };
    const keyEvents: KeyboardEventInit[] = [
      { key: 'Backspace' },
      { key: 'Delete' },
      { ctrlKey: true, key: 'a' },
      { metaKey: true, key: 'a' },
      { ctrlKey: true, key: 'z' },
      { metaKey: true, key: 'z' },
      { ctrlKey: true, key: 'y' },
      { metaKey: true, key: 'y' },
      { ctrlKey: true, key: 'Z', shiftKey: true },
      { metaKey: true, key: 'Z', shiftKey: true },
      { key: 'Enter' },
      { key: ' ' },
      { key: 'ArrowDown' },
      { key: 'ArrowLeft' },
      { key: 'ArrowRight' },
      { key: 'ArrowUp' },
    ];
    const events: Event[] = [];
    host.doc.addEventListener('keydown', documentMutation);
    host.doc.addEventListener('copy', documentMutation);
    host.doc.addEventListener('cut', documentMutation);
    host.doc.addEventListener('paste', documentMutation);
    owner.addEventListener('keydown', windowMutation);
    owner.addEventListener('copy', windowMutation);
    owner.addEventListener('cut', windowMutation);
    owner.addEventListener('paste', windowMutation);

    try {
      input.value = 'Keep this heading query intact';
      for (const init of keyEvents) {
        const event = new owner.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        input.dispatchEvent(event);
        events.push(event);
      }
      for (const type of ['copy', 'cut', 'paste'] as const) {
        const event = new owner.Event(type, { bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        events.push(event);
      }

      expect({
        annotation,
        defaultPrevented: events.map((event) => event.defaultPrevented),
        documentMutations: documentMutation.mock.calls.length,
        input: {
          autocomplete: input.autocomplete,
          role: input.getAttribute('role'),
          spellcheck: input.spellcheck,
          type: input.type,
          value: input.value,
        },
        windowMutations: windowMutation.mock.calls.length,
      }).toEqual({
        annotation: { color: '#ffd400', count: 1 },
        defaultPrevented: Array.from({ length: 19 }, () => false),
        documentMutations: 0,
        input: {
          autocomplete: 'off',
          role: 'searchbox',
          spellcheck: false,
          type: 'text',
          value: 'Keep this heading query intact',
        },
        windowMutations: 0,
      });
    } finally {
      host.doc.removeEventListener('keydown', documentMutation);
      host.doc.removeEventListener('copy', documentMutation);
      host.doc.removeEventListener('cut', documentMutation);
      host.doc.removeEventListener('paste', documentMutation);
      owner.removeEventListener('keydown', windowMutation);
      owner.removeEventListener('copy', windowMutation);
      owner.removeEventListener('cut', windowMutation);
      owner.removeEventListener('paste', windowMutation);
      host.remove();
    }
  });

  it('keeps one heading search always visible before the native tree', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const panel = new OutlinePanel(host, vi.fn());
    panel.render(searchableOutline);

    const searchInput = panel.root.querySelector<HTMLInputElement>('[data-outline-search]');
    const searchInputs = panel.root.querySelectorAll<HTMLInputElement>('[data-outline-search]');
    const branch = panel.root.querySelector<HTMLElement>('[data-outline-id="knowledge"]');

    expect(searchInputs).toHaveLength(1);
    expect(searchInput?.hidden).toBe(false);
    expect(searchInput?.getAttribute('role')).toBe('searchbox');
    expect(
      searchInput?.compareDocumentPosition(panel.root.querySelector('[role="tree"]') as Node),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(panel.root.querySelector('[data-action="toggle-outline-search"]')).toBeNull();
    expect(branch?.classList.contains('tree-item')).toBe(true);
    expect(branch?.querySelector('[data-outline-row]')?.classList.contains('tree-item-self')).toBe(
      true,
    );
    expect(branch?.querySelector('[role="group"]')?.classList.contains('tree-item-children')).toBe(
      true,
    );

    host.remove();
  });

  it('uses native Obsidian navigation tokens for branches and leaves', () => {
    const host = createDiv();
    const panel = new OutlinePanel(host, vi.fn());
    panel.render(searchableOutline);
    const branch = panel.root.querySelector<HTMLElement>('[data-outline-id="knowledge"]');
    const leaf = panel.root.querySelector<HTMLElement>('[data-outline-id="appendix"]');

    expect({
      branch: branch?.classList.contains('nav-folder'),
      branchTitle: branch
        ?.querySelector('[data-outline-row]')
        ?.classList.contains('nav-folder-title'),
      children: branch?.querySelector('[role="group"]')?.classList.contains('nav-folder-children'),
      collapse: branch
        ?.querySelector('[data-outline-chevron]')
        ?.classList.contains('nav-folder-collapse-indicator'),
      leaf: leaf?.classList.contains('nav-file'),
      leafTitle: leaf?.querySelector('[data-outline-row]')?.classList.contains('nav-file-title'),
    }).toEqual({
      branch: true,
      branchTitle: true,
      children: true,
      collapse: true,
      leaf: true,
      leafTitle: true,
    });
  });

  it('clears heading search on Escape but never hides its always visible field', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const panel = new OutlinePanel(host, vi.fn());
    panel.render(searchableOutline);
    const input = panel.root.querySelector<HTMLInputElement>('[data-outline-search]');
    if (input === null) throw new Error('Expected an outline search field.');
    search(panel, 'internal');
    const OwnerKeyboardEvent = (panel.root.win as Window & { KeyboardEvent: typeof KeyboardEvent })
      .KeyboardEvent;

    input.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(input.value).toBe('');
    expect(input.hidden).toBe(false);
    expect(panel.root.querySelectorAll('[data-outline-row]')).toHaveLength(5);

    input.dispatchEvent(
      new OwnerKeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(input.hidden).toBe(false);
    expect(panel.root.doc.activeElement).toBe(input);
    host.remove();
  });

  it('restores the complete tree when heading search is cleared', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    panel.render(searchableOutline);
    search(panel, 'internal');
    expect(panel.root.querySelectorAll('[data-outline-row]')).toHaveLength(3);

    search(panel, '');

    expect(panel.root.querySelector<HTMLInputElement>('[data-outline-search]')?.value).toBe('');
    expect(panel.root.querySelectorAll('[data-outline-row]')).toHaveLength(5);
  });

  it('filters headings and retains ancestors', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    panel.render(searchableOutline);

    search(panel, 'INTERNAL');

    expect(
      Array.from(panel.root.querySelectorAll<HTMLElement>('[data-outline-id]')).map(
        (row) => row.dataset['outlineId'],
      ),
    ).toEqual(['knowledge', 'writing', 'links']);
    expect(
      panel.root.querySelector('[data-outline-item="knowledge"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      panel.root.querySelector('[data-outline-item="writing"]')?.getAttribute('aria-expanded'),
    ).toBe('true');

    search(panel, 'ИНСТРУМЕНТ');
    expect(panel.root.querySelector('[data-outline-id="tools"]')).not.toBeNull();
    expect(panel.root.querySelector('[data-outline-id="appendix"]')).toBeNull();

    search(panel, 'not present');
    expect(panel.root.textContent).toContain('No matching headings');
    expect(panel.root.querySelectorAll('[data-outline-row]')).toHaveLength(0);
  });

  it('highlights every safe matching label fragment', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    const label = 'Ссылка [Link] и [link] <script>alert(1)</script>';
    panel.render([{ id: 'special', label, target: { pageIndex: 0 }, children: [] }]);

    search(panel, '[LINK]');

    const row = panel.root.querySelector<HTMLElement>('[data-outline-id="special"]');
    const renderedLabel = row?.querySelector<HTMLElement>('[data-outline-label]');
    expect(
      Array.from(renderedLabel?.querySelectorAll('[data-outline-match]') ?? []).map(
        (match) => match.textContent,
      ),
    ).toEqual(['[Link]', '[link]']);
    expect(renderedLabel?.textContent).toBe(label);
    expect(row?.getAttribute('aria-label')).toBe(label);
    expect(renderedLabel?.querySelector('script')).toBeNull();

    panel.render(searchableOutline);
    search(panel, 'инструмент');
    expect(
      panel.root.querySelector('[data-outline-id="tools"] [data-outline-match]')?.textContent,
    ).toBe('Инструмент');
  });

  it('maps case-folded matches back to their original Unicode offsets', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    const label = 'İX and İx';
    panel.render([{ id: 'unicode', label, target: { pageIndex: 0 }, children: [] }]);

    search(panel, 'x');
    const row = panel.root.querySelector<HTMLElement>('[data-outline-id="unicode"]');
    const renderedLabel = row?.querySelector<HTMLElement>('[data-outline-label]');
    expect(
      Array.from(renderedLabel?.querySelectorAll('[data-outline-match]') ?? []).map(
        (match) => match.textContent,
      ),
    ).toEqual(['X', 'x']);
    expect(renderedLabel?.textContent).toBe(label);
    expect(row?.getAttribute('aria-label')).toBe(label);

    search(panel, 'i');
    expect(
      Array.from(
        panel.root.querySelectorAll<HTMLElement>(
          '[data-outline-id="unicode"] [data-outline-match]',
        ),
      ).map((match) => match.textContent),
    ).toEqual(['İ', 'İ']);

    panel.render([{ id: 'adjacent', label: 'XX', target: { pageIndex: 0 }, children: [] }]);
    search(panel, 'x');
    expect(
      Array.from(panel.root.querySelectorAll<HTMLElement>('[data-outline-match]')).map(
        (match) => match.textContent,
      ),
    ).toEqual(['X', 'X']);

    panel.render([{ id: 'casefold', label: 'Straße', target: { pageIndex: 0 }, children: [] }]);
    search(panel, 'STRASSE');
    expect(panel.root.querySelector('[data-outline-match]')?.textContent).toBe('Straße');
  });

  it('matches canonical Unicode forms in both directions without changing source labels', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());

    panel.render([{ id: 'composed', label: 'Café', target: { pageIndex: 0 }, children: [] }]);
    search(panel, 'Cafe\u0301');
    expect(
      panel.root.querySelector('[data-outline-id="composed"] [data-outline-match]')?.textContent,
    ).toBe('Café');

    panel.render([
      { id: 'decomposed', label: 'Cafe\u0301', target: { pageIndex: 0 }, children: [] },
    ]);
    search(panel, 'Café');
    expect(
      panel.root.querySelector('[data-outline-id="decomposed"] [data-outline-match]')?.textContent,
    ).toBe('Cafe\u0301');
    expect(panel.root.querySelector('[data-outline-label]')?.textContent).toBe('Cafe\u0301');
  });

  it('restores expansion after clearing search', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    panel.render(searchableOutline);
    const knowledge = panel.root.querySelector<HTMLElement>('[data-outline-id="knowledge"]');

    press(panel, knowledge ?? undefined, 'ArrowLeft');
    expect(
      panel.root.querySelector('[data-outline-item="knowledge"]')?.getAttribute('aria-expanded'),
    ).toBe('false');

    search(panel, 'Internal Links');
    expect(
      panel.root.querySelector('[data-outline-item="knowledge"]')?.getAttribute('aria-expanded'),
    ).toBe('true');

    search(panel, '');
    expect(
      panel.root.querySelector('[data-outline-item="knowledge"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(panel.root.querySelector('[data-outline-id="links"]')).not.toBeNull();
  });

  it('keeps roving tree keyboard navigation', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const panel = new OutlinePanel(host, vi.fn());
    panel.render(searchableOutline);
    search(panel, 'internal');
    const rows = Array.from(panel.root.querySelectorAll<HTMLElement>('[role="treeitem"]'));

    rows[0]?.focus();
    press(panel, rows[0], 'End');
    expect(panel.root.doc.activeElement).toBe(rows[2]);
    press(panel, rows[2], 'ArrowUp');
    expect(panel.root.doc.activeElement).toBe(rows[1]);
    press(panel, rows[1], 'ArrowLeft');
    expect(panel.root.doc.activeElement).toBe(rows[0]);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    host.remove();
  });

  it('marks the current heading', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    panel.render(searchableOutline);

    panel.setCurrentPage(7);
    expect(
      panel.root.querySelector('[data-outline-id="links"]')?.getAttribute('aria-current'),
    ).toBe('location');
    panel.setCurrentPage(5);
    panel.setCurrentPage(8);
    panel.setCurrentPage(3);

    expect(panel.root.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
    expect(
      panel.root.querySelector('[data-outline-id="writing"]')?.getAttribute('aria-current'),
    ).toBe('location');
  });

  it('moves roving focus to a branch before pointer collapse hides its child', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const panel = new OutlinePanel(host, vi.fn());
    panel.render(searchableOutline);
    const branch = panel.root.querySelector<HTMLElement>('[data-outline-id="knowledge"]');
    const child = panel.root.querySelector<HTMLElement>('[data-outline-id="writing"]');
    const chevron = branch?.querySelector<HTMLElement>('[data-outline-chevron]');
    child?.focus();

    chevron?.click();

    expect(panel.root.doc.activeElement).toBe(branch);
    expect(branch?.getAttribute('aria-expanded')).toBe('false');
    host.remove();
  });

  it('renders explicit chevron and label rows', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    panel.render(searchableOutline);
    const branch = panel.root.querySelector<HTMLElement>('[data-outline-id="knowledge"]');
    const leaf = panel.root.querySelector<HTMLElement>('[data-outline-id="appendix"]');

    expect(panel.root.querySelector<HTMLInputElement>('[data-outline-search]')?.placeholder).toBe(
      'Find a heading…',
    );
    const branchChevron = branch?.querySelector<HTMLElement>('[data-outline-chevron]');
    expect(branchChevron).not.toBeNull();
    expect(mocks.setIcon).toHaveBeenCalledWith(branchChevron, 'chevron-down');
    expect(branch?.querySelector('[data-outline-label]')?.textContent).toBe('База знаний');
    expect(leaf?.querySelector('[data-outline-chevron]')?.childElementCount).toBe(0);
    expect(leaf?.querySelector('[data-outline-label]')?.textContent).toBe('Appendix');
  });

  it('renders a recursive native tree and never navigates unresolved destinations', () => {
    const host = createDiv();
    const navigate = vi.fn();
    const panel = new OutlinePanel(host, navigate);

    panel.render(outline);

    expect(panel.root.querySelector('[role="tree"]')).not.toBeNull();
    expect(panel.root.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
    expect(panel.root.querySelectorAll('[role="group"]')).toHaveLength(1);
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
    const rows = Array.from(panel.root.querySelectorAll<HTMLElement>('[role="treeitem"]'));
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

    const branch = panel.root.querySelector<HTMLElement>('[data-outline-item="chapter-1"]');
    if (branch === null) throw new Error('Expected an outline branch.');
    press(panel, rows[0], 'ArrowLeft');
    expect(branch.getAttribute('aria-expanded')).toBe('false');
    press(panel, rows[0], 'ArrowRight');
    expect(branch.getAttribute('aria-expanded')).toBe('true');
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
    expect(navigate).toHaveBeenCalledWith({
      coordinateSpace: 'pdf-points-bottom-left',
      pageIndex: 2,
      x: 12,
      y: 24,
    });

    panel.render([]);
    expect(panel.root.textContent).toContain('No outline available.');
    expect(panel.root.querySelectorAll('[data-outline-row]')).toHaveLength(0);
  });

  it('keeps empty and filtered status outside the semantic tree and recovers content', () => {
    const panel = new OutlinePanel(createDiv(), vi.fn());
    panel.render([]);
    const tree = panel.root.querySelector<HTMLElement>('[role="tree"]');
    const status = panel.root.querySelector<HTMLElement>('[data-outline-status]');

    expect(tree?.children).toHaveLength(0);
    expect(tree?.hidden).toBe(true);
    expect(status?.parentElement).toBe(panel.root);
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe('No outline available.');

    panel.render(searchableOutline);
    expect(tree?.hidden).toBe(false);
    expect(status?.hidden).toBe(true);
    expect(
      Array.from(tree?.children ?? []).every((child) => child.getAttribute('role') === 'treeitem'),
    ).toBe(true);

    search(panel, 'missing heading');
    expect(tree?.children).toHaveLength(0);
    expect(tree?.hidden).toBe(true);
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBe('No matching headings');

    search(panel, 'appendix');
    expect(tree?.hidden).toBe(false);
    expect(status?.hidden).toBe(true);
    expect(panel.root.querySelector('[data-outline-id="appendix"]')).not.toBeNull();
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

    expect(navigate).toHaveBeenCalledWith({
      coordinateSpace: 'pdf-points-bottom-left',
      pageIndex: 2,
      x: 12,
      y: 24,
    });
    expect(section?.getAttribute('aria-current')).toBe('location');
    expect(
      panel.root.querySelector('[data-outline-id="chapter-1"]')?.hasAttribute('aria-current'),
    ).toBe(false);
  });
});
