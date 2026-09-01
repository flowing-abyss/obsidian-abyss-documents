import { describe, expect, it, vi } from 'vitest';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import { asAnnotationId, type DocumentAnnotation } from '../document-core/annotations.js';
import type { AnnotationEditorPopoverRequest } from './annotation-editor-popover.js';
import { ReaderShell } from './reader-shell.js';

function selection(): PdfTextSelection {
  return {
    clientRect: { bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 },
    clientRects: [{ bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 }],
    input: 'pointer',
    pageIndex: 0,
    text: 'Selected text',
    token: 'selection-token',
  };
}

function annotation(id: string): DocumentAnnotation {
  return {
    identity: { id: asAnnotationId(id), kind: 'stable' },
    type: 'highlight',
    anchor: {
      kind: 'fixed-page',
      pageIndex: 0,
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 10, y: 20 } },
    },
    color: '#ffd400',
    selectedText: id,
    author: '',
    createdAt: null,
    modifiedAt: null,
    comment: '',
    tags: [],
    links: [],
    capabilities: {} as DocumentAnnotation['capabilities'],
  };
}

function annotationEditorRequest(
  target: DocumentAnnotation,
  onClose: AnnotationEditorPopoverRequest['onClose'] = vi.fn(),
): AnnotationEditorPopoverRequest {
  return {
    onClose,
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onUpdate: vi.fn(),
    palette: [],
    position: { x: 40, y: 132 },
    target: { annotation: target, kind: 'annotation' },
  };
}

function openAnnotationSidebar(shell: ReaderShell, annotations: readonly DocumentAnnotation[]) {
  const sidebar = shell.openSidebar('annotations', {
    onClose: vi.fn(),
    onOutlineNavigate: vi.fn(),
    onSearchNavigate: vi.fn(),
    onSearchQuery: vi.fn(),
    onTabChange: vi.fn(),
  });
  sidebar.annotationsPanel.setProjectedAnnotations(
    annotations.map((value, index) => ({
      annotation: value,
      key: `row-${String(index + 1)}`,
      nativeId: `native-${String(index + 1)}`,
      writable: true,
    })),
  );
  return sidebar;
}

function openFromSidebar(
  shell: ReaderShell,
  request: AnnotationEditorPopoverRequest,
  rowId: string,
): boolean {
  return shell.openAnnotationEditor(request, {
    preserveResolvedRow: true,
    sidebarInvokerRowId: rowId,
  });
}

describe('ReaderShell', () => {
  it('uses horizontal arrow keys for page navigation only in paged reading mode', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.setLayout({ pages: 'single', scrolling: 'page-by-page' });

    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight' }),
    );
    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowLeft' }),
    );

    expect(intents).toEqual([{ type: 'next-page' }, { type: 'previous-page' }]);
    intents.length = 0;
    shell.setLayout({ pages: 'single', scrolling: 'continuous' });
    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight' }),
    );
    expect(intents).toEqual([]);
    shell.destroy();
    host.remove();
  });

  it('injects comment suggestions with the current PDF source path', () => {
    const host = document.body.createDiv();
    const suggest = vi.fn(() => [
      { display: 'Note', insertion: '[[Note]]', path: 'Notes/Note.md' },
    ]);
    const shell = new ReaderShell(host, () => undefined, {
      annotationSuggestions: { suggest },
      sourcePath: 'Books/Current.pdf',
    });
    const annotation = {
      ...({} as DocumentAnnotation),
      color: '#ffd400',
      comment: 'See [[No',
      identity: { id: asAnnotationId('suggestion'), kind: 'stable' as const },
      links: [],
      tags: [],
    };
    shell.openAnnotationEditor({
      onClose: vi.fn(),
      onCreate: vi.fn(),
      onDelete: vi.fn(),
      onUpdate: vi.fn(),
      palette: [],
      target: { annotation, kind: 'annotation' },
    });
    const comment = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected comment field.');
    comment.setSelectionRange(comment.value.length, comment.value.length);
    comment.dispatchEvent(new Event('select', { bubbles: true }));

    expect(suggest).toHaveBeenCalledWith('link', 'No', 'Books/Current.pdf');
    expect(host.querySelector('[role="listbox"]')?.textContent).toBe('Note');
    shell.destroy();
    host.remove();
  });

  it('synchronizes one sidebar row when PDF focus opens the unified editor', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const annotation: DocumentAnnotation = {
      identity: { id: asAnnotationId('native-focused'), kind: 'stable' },
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 10, y: 20 } },
      },
      color: '#ffd400',
      selectedText: 'Focused',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: 'Edit me',
      tags: [],
      links: [],
      capabilities: {} as DocumentAnnotation['capabilities'],
    };
    const sidebar = shell.openSidebar('annotations', {
      onClose: vi.fn(),
      onOutlineNavigate: vi.fn(),
      onSearchNavigate: vi.fn(),
      onSearchQuery: vi.fn(),
      onTabChange: vi.fn(),
    });
    sidebar.annotationsPanel.setAnnotations([annotation]);

    shell.openAnnotationEditor({
      onClose: vi.fn(),
      onCreate: vi.fn(),
      onDelete: vi.fn(),
      onUpdate: vi.fn(),
      palette: [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      target: { annotation, kind: 'annotation' },
    });

    expect(
      sidebar.annotationsPanel.root.querySelectorAll('.abyss-annotation-card[aria-current="true"]'),
    ).toHaveLength(1);
    shell.closeAnnotationEditor();
    expect(
      sidebar.annotationsPanel.root.querySelectorAll('.abyss-annotation-card[aria-current="true"]'),
    ).toHaveLength(0);
    shell.destroy();
    host.remove();
  });

  it('synchronizes native read-only focus unless a resolved row is explicitly preserved', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const annotation: DocumentAnnotation = {
      identity: { id: asAnnotationId('native-readonly-focused'), kind: 'stable' },
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 10, y: 20 } },
      },
      color: '#ffd400',
      selectedText: 'Read-only focus',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: 'Native read-only details',
      tags: [],
      links: [],
      capabilities: {} as DocumentAnnotation['capabilities'],
    };
    const sidebar = shell.openSidebar('annotations', {
      onClose: vi.fn(),
      onOutlineNavigate: vi.fn(),
      onSearchNavigate: vi.fn(),
      onSearchQuery: vi.fn(),
      onTabChange: vi.fn(),
    });
    sidebar.annotationsPanel.setAnnotations([annotation]);

    shell.openAnnotationEditor({
      onClose: vi.fn(),
      onCreate: vi.fn(),
      onDelete: vi.fn(),
      onUpdate: vi.fn(),
      palette: [],
      target: { annotation, kind: 'readonly' },
    });

    expect(
      sidebar.annotationsPanel.root.querySelectorAll('.abyss-annotation-card[aria-current="true"]'),
    ).toHaveLength(1);
    shell.destroy();
    host.remove();
  });

  it('keeps the resolved duplicate row selected when opening read-only details', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const first: DocumentAnnotation = {
      identity: { id: asAnnotationId('duplicate-public-id'), kind: 'stable' },
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 10, y: 20 } },
      },
      color: '#ffd400',
      selectedText: 'First duplicate',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: 'First details',
      tags: [],
      links: [],
      capabilities: {} as DocumentAnnotation['capabilities'],
    };
    const second: DocumentAnnotation = {
      ...first,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 1,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 10, y: 20 } },
      },
      comment: 'Second details',
      selectedText: 'Second duplicate',
    };
    const sidebar = shell.openSidebar('annotations', {
      onClose: vi.fn(),
      onOutlineNavigate: vi.fn(),
      onSearchNavigate: vi.fn(),
      onSearchQuery: vi.fn(),
      onTabChange: vi.fn(),
    });
    sidebar.annotationsPanel.setProjectedAnnotations([
      { annotation: first, key: 'duplicate-first', nativeId: 'native-first', writable: false },
      { annotation: second, key: 'duplicate-second', nativeId: 'native-second', writable: false },
    ]);
    const secondCard = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '.abyss-annotation-card[data-annotation-row-id="duplicate-second"]',
    );
    if (secondCard === null) throw new Error('Expected the second duplicate card.');
    vi.spyOn(secondCard, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 60, 180, 72));

    const activation = shell.resolveAnnotationActivation('duplicate-second');
    if (activation === null) throw new Error('Expected the second duplicate activation.');
    shell.openAnnotationEditor(
      {
        onClose: vi.fn(),
        onCreate: vi.fn(),
        onDelete: vi.fn(),
        onUpdate: vi.fn(),
        palette: [],
        position: activation.clientPosition,
        target: { annotation: activation.annotation, kind: 'readonly' },
      },
      { preserveResolvedRow: true },
    );

    expect(
      sidebar.annotationsPanel.root
        .querySelector('.abyss-annotation-card[aria-current="true"]')
        ?.getAttribute('data-annotation-row-id'),
    ).toBe('duplicate-second');
    expect(
      host.querySelector<HTMLElement>('.abyss-annotation-editor-readonly-metadata')?.textContent,
    ).toContain('Second details');
    shell.destroy();
    host.remove();
  });

  it('returns focus to the resolved sidebar row after closing its editor', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const annotation: DocumentAnnotation = {
      identity: { id: asAnnotationId('sidebar-focus-return'), kind: 'stable' },
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 10, y: 20 } },
      },
      color: '#ffd400',
      selectedText: 'Focused from sidebar',
      author: '',
      createdAt: null,
      modifiedAt: null,
      comment: '',
      tags: [],
      links: [],
      capabilities: {} as DocumentAnnotation['capabilities'],
    };
    const sidebar = shell.openSidebar('annotations', {
      onClose: vi.fn(),
      onOutlineNavigate: vi.fn(),
      onSearchNavigate: vi.fn(),
      onSearchQuery: vi.fn(),
      onTabChange: vi.fn(),
    });
    sidebar.annotationsPanel.setProjectedAnnotations([
      { annotation, key: 'sidebar-focus-row', nativeId: 'native-focus', writable: true },
    ]);
    const card = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '.abyss-annotation-card[data-annotation-row-id="sidebar-focus-row"]',
    );
    if (card === null) throw new Error('Expected a sidebar annotation row.');
    expect(sidebar.annotationsPanel.selectAnnotation('native-focus', false)).toBe(true);
    card.focus();
    openFromSidebar(shell, annotationEditorRequest(annotation), 'sidebar-focus-row');

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.activeElement).toBe(card);
    shell.destroy();
    host.remove();
  });

  it('does not replace a newer Escape focus target with the sidebar invoker', () => {
    const host = document.body.createDiv();
    const newerFocus = document.body.createEl('button');
    const shell = new ReaderShell(host);
    const focused = annotation('escape-newer-focus');
    const sidebar = openAnnotationSidebar(shell, [focused]);
    const card = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '[data-annotation-row-id="row-1"]',
    );
    if (card === null) throw new Error('Expected a sidebar invoker.');
    sidebar.annotationsPanel.selectAnnotation('native-1', false);
    newerFocus.focus();
    openFromSidebar(shell, annotationEditorRequest(focused), 'row-1');

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.activeElement).toBe(newerFocus);
    expect(card.getAttribute('aria-current')).toBeNull();
    shell.destroy();
    newerFocus.remove();
    host.remove();
  });

  it('does not return PDF-origin editor focus to an incidental synchronized sidebar row', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const focused = annotation('pdf-origin-focus');
    const sidebar = openAnnotationSidebar(shell, [focused]);
    const card = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '[data-annotation-row-id="row-1"]',
    );
    if (card === null) throw new Error('Expected a synchronized sidebar row.');
    shell.documentHost.focus();

    shell.openAnnotationEditor(annotationEditorRequest(focused));
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.activeElement).not.toBe(card);
    expect(card.getAttribute('aria-current')).toBeNull();
    shell.destroy();
    host.remove();
  });

  it('keeps an external click-away target focused while clearing only the owning row', () => {
    const host = document.body.createDiv();
    const external = document.body.createEl('button');
    const shell = new ReaderShell(host);
    const focused = annotation('click-away-focus');
    const sidebar = openAnnotationSidebar(shell, [focused]);
    const card = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '[data-annotation-row-id="row-1"]',
    );
    if (card === null) throw new Error('Expected a sidebar invoker.');
    sidebar.annotationsPanel.selectAnnotation('native-1', false);
    openFromSidebar(shell, annotationEditorRequest(focused), 'row-1');
    external.focus();

    external.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

    expect(document.activeElement).toBe(external);
    expect(card.getAttribute('aria-current')).toBeNull();
    shell.destroy();
    external.remove();
    host.remove();
  });

  it('does not focus or clear a newer selected row when the owned sidebar row changes', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const first = annotation('changed-row-first');
    const second = annotation('changed-row-second');
    const sidebar = openAnnotationSidebar(shell, [first, second]);
    const secondCard = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '[data-annotation-row-id="row-2"]',
    );
    if (secondCard === null) throw new Error('Expected the newer selected row.');
    sidebar.annotationsPanel.selectAnnotation('native-1', false);
    shell.documentHost.focus();
    openFromSidebar(shell, annotationEditorRequest(first), 'row-1');
    sidebar.annotationsPanel.selectAnnotation('native-2', false);
    expect(
      sidebar.annotationsPanel.root
        .querySelector('.abyss-annotation-card[aria-current="true"]')
        ?.getAttribute('data-annotation-row-id'),
    ).toBe('row-2');

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.activeElement).not.toBe(secondCard);
    expect(
      sidebar.annotationsPanel.root
        .querySelector('.abyss-annotation-card[aria-current="true"]')
        ?.getAttribute('data-annotation-row-id'),
    ).toBe('row-2');
    shell.destroy();
    host.remove();
  });

  it('does not let a closing sidebar editor disturb a synchronously opened newer sidebar editor', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const first = annotation('sidebar-generation-first');
    const second = annotation('sidebar-generation-second');
    const sidebar = openAnnotationSidebar(shell, [first, second]);
    const secondCard = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '[data-annotation-row-id="row-2"]',
    );
    if (secondCard === null) throw new Error('Expected the newer sidebar invoker.');
    sidebar.annotationsPanel.selectAnnotation('native-1', false);
    shell.documentHost.focus();
    openFromSidebar(
      shell,
      annotationEditorRequest(first, () => {
        sidebar.annotationsPanel.selectAnnotation('native-2', false);
        openFromSidebar(shell, annotationEditorRequest(second), 'row-2');
      }),
      'row-1',
    );

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(shell.annotationEditorOpen).toBe(true);
    expect(document.activeElement).not.toBe(secondCard);
    expect(
      sidebar.annotationsPanel.root
        .querySelector('.abyss-annotation-card[aria-current="true"]')
        ?.getAttribute('data-annotation-row-id'),
    ).toBe('row-2');
    shell.destroy();
    host.remove();
  });

  it('does not let a closing sidebar editor disturb a synchronously opened PDF editor', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const first = annotation('sidebar-to-pdf-first');
    const second = annotation('sidebar-to-pdf-second');
    const sidebar = openAnnotationSidebar(shell, [first, second]);
    const secondCard = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '[data-annotation-row-id="row-2"]',
    );
    if (secondCard === null) throw new Error('Expected the PDF-synchronized row.');
    sidebar.annotationsPanel.selectAnnotation('native-1', false);
    shell.documentHost.focus();
    openFromSidebar(
      shell,
      annotationEditorRequest(first, () => {
        shell.openAnnotationEditor(annotationEditorRequest(second));
      }),
      'row-1',
    );

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(shell.annotationEditorOpen).toBe(true);
    expect(document.activeElement).not.toBe(secondCard);
    expect(
      sidebar.annotationsPanel.root
        .querySelector('.abyss-annotation-card[aria-current="true"]')
        ?.getAttribute('data-annotation-row-id'),
    ).toBe('row-2');
    shell.destroy();
    host.remove();
  });

  it('does not restore a removed sidebar invoker after its editor closes', () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const removed = annotation('removed-sidebar-row');
    const sidebar = openAnnotationSidebar(shell, [removed]);
    const card = sidebar.annotationsPanel.root.querySelector<HTMLButtonElement>(
      '[data-annotation-row-id="row-1"]',
    );
    if (card === null) throw new Error('Expected the removable sidebar invoker.');
    sidebar.annotationsPanel.selectAnnotation('native-1', false);
    shell.documentHost.focus();
    openFromSidebar(shell, annotationEditorRequest(removed), 'row-1');
    sidebar.annotationsPanel.setProjectedAnnotations([]);

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(card.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(card);
    expect((document.activeElement as HTMLElement | null)?.isConnected).toBe(true);
    shell.destroy();
    host.remove();
  });

  it('does not steal focus chosen after a sidebar editor opened', () => {
    const host = document.body.createDiv();
    const newerFocus = document.body.createEl('button');
    const shell = new ReaderShell(host);
    const focused = annotation('newer-focus-target');
    const sidebar = openAnnotationSidebar(shell, [focused]);
    sidebar.annotationsPanel.selectAnnotation('native-1', false);
    openFromSidebar(shell, annotationEditorRequest(focused), 'row-1');
    newerFocus.focus();

    shell.closeAnnotationEditor();

    expect(document.activeElement).toBe(newerFocus);
    shell.destroy();
    newerFocus.remove();
    host.remove();
  });

  it('keeps a dismissed selection draft visible and retryable in the unified editor', async () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const onCreate = vi
      .fn<AnnotationEditorPopoverRequest['onCreate']>()
      .mockResolvedValueOnce('dismissed')
      .mockResolvedValueOnce('created');
    const request: AnnotationEditorPopoverRequest = {
      onClose: vi.fn(),
      onCreate,
      onDelete: vi.fn(),
      onUpdate: vi.fn(),
      palette: [
        { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
        { color: '#5fb236', meaning: 'Definition', name: 'Green' },
      ],
      target: { kind: 'selection', selection: selection() },
    };
    const opened = shell.openAnnotationEditor(request);

    expect(opened).toBe(true);
    const comment = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected the unified comment field.');
    comment.value = 'Keep this draft';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      expect(onCreate).toHaveBeenCalledOnce();
    });
    expect(comment.value).toBe('Keep this draft');
    const editor = host.querySelector<HTMLElement>('[data-annotation-editor-popover]');
    expect(editor).not.toBeNull();

    host.querySelector<HTMLButtonElement>('[data-editor-color="#5fb236"]')?.click();
    await vi.waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(2);
    });
    expect(onCreate.mock.calls[1]?.[0]).toMatchObject({
      color: '#5fb236',
      comment: 'Keep this draft',
    });
    expect(host.querySelector<HTMLElement>('[data-annotation-editor-popover]')).toBe(editor);
    expect(editor?.isConnected).toBe(true);
    expect(editor?.hidden).toBe(false);

    shell.destroy();
    host.remove();
  });

  it('adds a minimal annotation toolbar only after document capabilities are known', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    expect(shell.annotationToolbar).toBeNull();
    shell.setQuickHighlightState({ armed: true, color: '#5fb236' });

    shell.configureAnnotationToolbar(
      [
        { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
        { color: '#5fb236', meaning: 'Definition', name: 'Green' },
      ],
      null,
    );
    expect(shell.annotationToolbar).toMatchObject({ color: '#5fb236', tool: 'highlight' });
    shell.annotationToolbar?.root
      .querySelector<HTMLButtonElement>('[data-annotation-tool="ink"]')
      ?.click();

    expect(intents).toContainEqual({ color: '#ffd400', type: 'set-annotation-tool', tool: 'ink' });
    shell.destroy();
    host.remove();
  });

  it('keeps undo and redo reader-scoped and ignores focused text controls', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar([], null);
    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'z' }),
    );
    const input = shell.root.createEl('textarea');
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'z' }));
    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Z', shiftKey: true }),
    );
    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'f' }),
    );

    expect(intents).toEqual([
      { type: 'undo-annotation' },
      { type: 'redo-annotation' },
      { tab: 'search', type: 'open-sidebar' },
    ]);
    shell.destroy();
    host.remove();
  });

  it('hosts the unified selection editor and gives its Escape handling precedence', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const closeReasons: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar(
      [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      null,
    );
    shell.openAnnotationEditor({
      onClose: (reason) => closeReasons.push(reason),
      onCreate: vi.fn(),
      onDelete: vi.fn(),
      onUpdate: vi.fn(),
      palette: [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      target: { kind: 'selection', selection: selection() },
    });

    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );

    expect(closeReasons).toEqual(['escape']);
    expect(intents).toEqual([]);
    shell.destroy();
    host.remove();
  });

  it('reflects Quick Highlight state and lets Escape disarm it', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar(
      [{ color: '#ffd400', meaning: 'Key idea', name: 'Yellow' }],
      null,
    );

    shell.setQuickHighlightState({ armed: true, color: '#ffd400' });
    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );

    expect(
      shell.annotationToolbar?.root
        .querySelector('[data-annotation-tool="highlight"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(intents).toEqual([{ tool: 'select', type: 'set-annotation-tool' }]);
    shell.destroy();
    host.remove();
  });

  it('lets a descendant comment surface consume Escape before Quick Highlight', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar([], null);
    shell.setQuickHighlightState({ armed: true, color: '#ffd400' });
    const comment = shell.root.createDiv({ cls: 'abyss-annotation-editor-popover' });
    const textarea = comment.createEl('textarea');
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      comment.remove();
    });

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );

    expect(comment.isConnected).toBe(false);
    expect(intents).toEqual([]);
    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(intents).toEqual([{ tool: 'select', type: 'set-annotation-tool' }]);
    shell.destroy();
    host.remove();
  });

  it('leaves Escape available to an open Obsidian menu before disarming Quick Highlight', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar([], null);
    shell.setQuickHighlightState({ armed: true, color: '#ffd400' });
    const menu = document.body.createDiv({ cls: 'menu' });
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({
      bottom: 80,
      height: 40,
      left: 40,
      right: 120,
      top: 40,
      width: 80,
      x: 40,
      y: 40,
      toJSON: () => undefined,
    });
    const trigger = shell.root.createEl('button');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-haspopup', 'menu');
    const escape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    trigger.addEventListener('keydown', () => {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.dataset['abyssMenuClosing'] = '';
      menu.remove();
    });

    trigger.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(false);
    expect(intents).toEqual([]);
    shell.destroy();
    host.remove();
  });

  it('keeps Quick Highlight armed for Escape dispatched at the reader while its owned menu is open', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar([], null);
    shell.setQuickHighlightState({ armed: true, color: '#ffd400' });
    const trigger = shell.root.createEl('button');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-haspopup', 'menu');
    const menu = document.body.createDiv({ cls: 'menu' });
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({
      bottom: 80,
      height: 40,
      left: 40,
      right: 120,
      top: 40,
      width: 80,
      x: 40,
      y: 40,
      toJSON: () => undefined,
    });
    const escape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });

    shell.documentHost.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(false);
    expect(intents).toEqual([]);
    menu.remove();
    shell.destroy();
    host.remove();
  });

  it('disarms Quick Highlight when only a hidden stale Obsidian menu remains', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar([], null);
    shell.setQuickHighlightState({ armed: true, color: '#ffd400' });
    const menu = document.body.createDiv({ cls: 'menu' });
    menu.hidden = true;

    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );

    expect(intents).toEqual([{ tool: 'select', type: 'set-annotation-tool' }]);
    menu.remove();
    shell.destroy();
    host.remove();
  });

  it('disarms Quick Highlight while an unrelated visible Obsidian menu is open', () => {
    const host = document.body.createDiv();
    const intents: unknown[] = [];
    const shell = new ReaderShell(host, (intent) => intents.push(intent));
    shell.configureAnnotationToolbar([], null);
    shell.setQuickHighlightState({ armed: true, color: '#ffd400' });
    const unrelatedMenu = document.body.createDiv({ cls: 'menu' });
    vi.spyOn(unrelatedMenu, 'getBoundingClientRect').mockReturnValue({
      bottom: 80,
      height: 40,
      left: 40,
      right: 120,
      top: 40,
      width: 80,
      x: 40,
      y: 40,
      toJSON: () => undefined,
    });

    shell.documentHost.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );

    expect(intents).toEqual([{ tool: 'select', type: 'set-annotation-tool' }]);
    unrelatedMenu.remove();
    shell.destroy();
    host.remove();
  });
  it('starts with the sidebar absent from layout', () => {
    const host = createDiv();

    const shell = new ReaderShell(host);

    expect(shell.root.hasAttribute('data-abyss-document')).toBe(true);
    expect(shell.root.getAttribute('data-reading-profile')).toBe('default');
    expect(shell.root.querySelector('[data-region="toolbar"]')).not.toBeNull();
    expect(shell.root.querySelector('[data-region="document"]')).toBe(shell.documentHost);
    expect(shell.root.querySelector('[data-region="sidebar"]')).toBeNull();
    shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]')?.click();
  });

  it('inserts the lazy sidebar before the PDF document when it is first opened', () => {
    const shell = new ReaderShell(createDiv());
    const callbacks = {
      onClose: () => undefined,
      onOutlineNavigate: () => undefined,
      onSearchNavigate: () => undefined,
      onSearchQuery: () => undefined,
      onTabChange: () => undefined,
    };

    const firstSidebar = shell.openSidebar('outline', callbacks);
    const reopenedSidebar = shell.openSidebar('annotations', callbacks);

    const body = shell.root.querySelector('.abyss-reader-body');
    expect(reopenedSidebar).toBe(firstSidebar);
    expect(
      Array.from(body?.children ?? []).map((node) => (node as HTMLElement).dataset['region']),
    ).toEqual(['sidebar', 'document']);
    shell.destroy();
  });

  it('removes only its owned reader root when destroyed', () => {
    const host = createDiv();
    const sibling = createDiv();
    host.append(sibling);
    const shell = new ReaderShell(host);

    shell.destroy();
    shell.destroy();
    const cleanup = shell.onThemeChange(() => undefined);
    cleanup();

    expect(Array.from(host.children)).toEqual(expect.arrayContaining([sibling]));
    expect(host.contains(shell.root)).toBe(false);
  });

  it('observes theme changes in its owner document and disconnects on destroy', async () => {
    const host = createDiv();
    host.doc.body.addClass('theme-light');
    const shell = new ReaderShell(host);
    const onThemeChange = vi.fn();
    const cleanup = shell.onThemeChange(onThemeChange);
    cleanup();
    cleanup();
    shell.onThemeChange(onThemeChange);

    host.doc.body.addClass('task-6-unrelated-theme-marker');
    await new Promise((resolve) => host.win.setTimeout(resolve, 0));
    expect(onThemeChange).not.toHaveBeenCalled();

    host.doc.body.removeClass('theme-light');
    host.doc.body.addClass('theme-dark');
    await vi.waitFor(() => {
      expect(onThemeChange).toHaveBeenCalledWith('dark');
    });
    shell.destroy();
    onThemeChange.mockClear();
    host.doc.body.removeClass('theme-dark');
    host.doc.body.addClass('theme-light');
    await new Promise((resolve) => host.win.setTimeout(resolve, 0));

    expect(onThemeChange).not.toHaveBeenCalled();
  });

  it('returns focus to the invoking toolbar control after the sidebar closes', () => {
    const host = createDiv();
    host.doc.body.append(host);
    const shell = new ReaderShell(host, (intent) => {
      if (intent.type !== 'toggle-sidebar') return;
      shell.openSidebar('outline', {
        onClose: () => undefined,
        onOutlineNavigate: () => undefined,
        onSearchNavigate: () => undefined,
        onSearchQuery: () => undefined,
        onTabChange: () => undefined,
      });
    });
    const toggle = shell.root.querySelector<HTMLButtonElement>('[data-control="sidebar"]');
    if (toggle === null) throw new Error('Expected the sidebar toggle.');
    toggle.focus();
    toggle.click();
    const close = shell.sidebar?.root.querySelector<HTMLButtonElement>(
      '[data-action="close-sidebar"]',
    );
    if (close === undefined || close === null)
      throw new Error('Expected the sidebar close button.');
    close.focus();

    close.click();

    expect(shell.root.doc.activeElement).toBe(toggle);
    shell.destroy();
    host.remove();
  });

  it('announces reader changes through one polite live region', () => {
    vi.useFakeTimers();
    const shell = new ReaderShell(createDiv());

    shell.announce('Page 2 of 3');
    vi.advanceTimersByTime(200);

    const regions = shell.root.querySelectorAll('[role="status"][aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toBe('Page 2 of 3');
    shell.destroy();
    vi.useRealTimers();
  });

  it('applies a bounded stored desktop sidebar width without opening it', () => {
    const shell = new ReaderShell(createDiv(), () => undefined, { sidebarWidth: 900 });

    expect(shell.sidebar).toBeNull();
    expect(shell.root.style.getPropertyValue('--abyss-reader-sidebar-width')).toBe('480px');
    shell.destroy();
  });
});
