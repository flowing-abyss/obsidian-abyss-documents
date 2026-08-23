import { describe, expect, it, vi } from 'vitest';
import { AnnotationPopover } from './annotation-popover.js';

describe('AnnotationPopover', () => {
  it('offers metadata-backed wiki-link suggestions after [[ with keyboard selection', () => {
    const host = document.body.createDiv();
    const provider = {
      suggest: (query: string) =>
        query === 'con'
          ? [{ display: 'Concept', path: 'Notes/Concept.md', insertion: '[[Concept|Idea]]' }]
          : [],
    };
    const popover = new AnnotationPopover(host, provider, 'Books/Book.pdf');
    const change = vi.fn();
    popover.open({
      comment: 'See [[con',
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      onChange: change,
      onClose: vi.fn(),
      x: 0,
      y: 0,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected comment input.');
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector('[role="listbox"]')?.textContent).toContain('Concept');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe(host.querySelector('[role="listbox"]')?.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(
      host.querySelector('[role="option"][aria-selected="true"]')?.id,
    );
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(change).toHaveBeenLastCalledWith('See [[Concept|Idea]]');
    popover.destroy();
    host.remove();
  });

  it('replaces only a closed wiki-link target while preserving brackets and alias suffix', () => {
    const host = document.body.createDiv();
    const suggest = vi.fn(() => [
      { display: 'Concept', path: 'Notes/Concept.md', insertion: '[[Concept]]' },
    ]);
    const popover = new AnnotationPopover(host, { suggest }, 'Books/Book.pdf');
    popover.open({
      comment: 'See [[con|Existing alias]] later',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected input.');
    input.setSelectionRange(9, 9);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[role="option"]')?.click();
    expect(input.value).toBe('See [[Concept|Existing alias]] later');
    expect(suggest).toHaveBeenCalledWith('con', 'Books/Book.pdf');
    popover.destroy();
  });

  it('replaces the whole closed wiki token when Obsidian generates Markdown links', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(
      host,
      {
        suggest: () => [
          {
            display: 'Concept',
            path: 'Notes/Concept.md',
            insertion: '[Concept](Notes/Concept.md)',
          },
        ],
      },
      'Books/Book.pdf',
    );
    popover.open({
      comment: 'See [[con|Old alias]] later',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected input.');
    input.setSelectionRange(9, 9);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLElement>('[role="option"]')?.click();
    expect(input.value).toBe('See [Concept](Notes/Concept.md) later');
    popover.destroy();
  });

  it('ignores closed tokens outside the cursor and cannot accept a stale selection', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(
      host,
      { suggest: () => [{ display: 'Concept', path: 'Concept.md', insertion: '[[Concept]]' }] },
      'Books/Book.pdf',
    );
    popover.open({
      comment: '[[closed]] prose',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected input.');
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);
    input.value = '[[con]] elsewhere';
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(false);
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(input.value).toBe('[[con]] elsewhere');
    popover.destroy();
  });
  it('hides suggestions for non-collapsed selections and rejects a range crossing the token', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(
      host,
      { suggest: () => [{ display: 'Concept', path: 'Concept.md', insertion: '[[Concept]]' }] },
      'Books/Book.pdf',
    );
    popover.open({
      comment: 'See [[con]] later',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected input.');
    input.setSelectionRange(7, 7);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(false);

    input.setSelectionRange(4, 9);
    input.dispatchEvent(new Event('select', { bubbles: true }));
    expect(host.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(input.value).toBe('See [[con]] later');
    popover.destroy();
  });
  it('edits ordinary comment text and inserts tags and wiki links without conversion controls', () => {
    const host = document.body.createDiv();
    const change = vi.fn();
    const popover = new AnnotationPopover(host);
    popover.open({
      comment: 'Idea',
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      onChange: change,
      onClose: vi.fn(),
      x: 10,
      y: 20,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected annotation comment input.');
    input.setSelectionRange(input.value.length, input.value.length);
    host.querySelector<HTMLButtonElement>('[data-action="insert-tag"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="insert-link"]')?.click();
    expect(change).toHaveBeenLastCalledWith('Idea #tag [[Link]]');
    expect(host.querySelector('[data-action="convert-annotation"]')).toBeNull();
    popover.destroy();
    expect(host.childElementCount).toBe(0);
    host.remove();
  });

  it('uses the owner document, restores focus, handles Escape, and deletes explicitly', () => {
    const host = document.body.createDiv();
    const invoker = host.createEl('button');
    invoker.focus();
    const onDelete = vi.fn();
    const popover = new AnnotationPopover(host);
    popover.open({
      comment: '',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: onDelete,
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });
    expect(popover.element.ownerDocument).toBe(host.ownerDocument);
    popover.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(invoker);

    popover.open({
      comment: '',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: onDelete,
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });
    host.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(onDelete).toHaveBeenCalledOnce();
    popover.destroy();
    host.remove();
  });

  it('fires one close reason for blur Escape delete and external close', () => {
    const cases = [
      ['blur', 'blur'],
      ['Escape', 'escape'],
      ['delete-comment', 'delete-comment'],
      ['delete-annotation', 'delete-annotation'],
      ['external', 'external'],
    ] as const;

    for (const [action, reason] of cases) {
      const host = document.body.createDiv();
      const onClose = vi.fn();
      const popover = new AnnotationPopover(host);
      popover.open({
        comment: 'Live comment',
        onChange: vi.fn(),
        onClose,
        onDeleteAnnotation: vi.fn(),
        onDeleteComment: vi.fn(),
        x: 0,
        y: 0,
      });

      if (action === 'blur') {
        host
          .querySelector<HTMLTextAreaElement>('textarea')
          ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      } else if (action === 'Escape') {
        popover.element.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
        );
      } else if (action === 'external') {
        popover.close(false);
      } else {
        host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click();
      }
      popover.close(false);
      popover.destroy();

      expect(onClose).toHaveBeenCalledExactlyOnceWith(reason);
      host.remove();
    }
  });

  it('closes a replaced comment exactly once as external', () => {
    const host = document.body.createDiv();
    const onClose = vi.fn();
    const popover = new AnnotationPopover(host);
    popover.open({
      comment: 'First',
      onChange: vi.fn(),
      onClose,
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });

    popover.open({
      comment: 'Second',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });

    expect(onClose).toHaveBeenCalledExactlyOnceWith('external');
    popover.destroy();
    host.remove();
  });

  it('clamps position, cancels, ignores non-element clicks, and rejects reopening after destroy', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(host);
    const request = {
      comment: '',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: -2,
      y: -3,
    };
    popover.open(request);
    expect(popover.element.style.left).toBe('0px');
    expect(popover.element.style.top).toBe('0px');
    popover.element.append(document.createTextNode('text target'));
    popover.element.lastChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    popover.close();
    popover.destroy();
    popover.destroy();
    expect(() => {
      popover.open(request);
    }).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
    host.remove();
  });

  it('routes color and annotation deletion through explicit native callbacks', () => {
    const host = document.body.createDiv();
    const onColor = vi.fn();
    const onDeleteAnnotation = vi.fn();
    const popover = new AnnotationPopover(host);
    popover.open({
      color: '#ffd400',
      comment: 'Supported highlight',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onColor,
      onDeleteAnnotation,
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });

    const color = host.querySelector<HTMLInputElement>('[data-action="annotation-color"]');
    expect(color?.value).toBe('#ffd400');
    if (color === null) throw new Error('Expected annotation color input.');
    color.value = '#112233';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();

    expect(onColor).toHaveBeenCalledWith('#112233');
    expect(onDeleteAnnotation).toHaveBeenCalledOnce();
    popover.destroy();
    host.remove();
  });

  it('renders a stable read-only reason with no mutation controls', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(host);
    popover.open({
      comment: 'Imported note',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      readOnlyReason: 'Underline annotations are read-only in this PDF.js version.',
      x: 0,
      y: 0,
    });

    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.readOnly).toBe(true);
    expect(
      host.querySelector('[data-region="annotation-read-only-reason"]')?.textContent,
    ).toContain('Underline annotations');
    expect(host.querySelector('[data-action="save-comment"]')).toBeNull();
    expect(host.querySelector('[data-action="delete-comment"]')).toBeNull();
    expect(host.querySelector('[data-action="delete-annotation"]')).toBeNull();
    expect(host.querySelector('[data-action="annotation-color"]')).toBeNull();
    popover.destroy();
    host.remove();
  });

  it('clamps the popover to the owner visual viewport on the right and bottom', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(host);
    Object.defineProperty(popover.element, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 240, 180),
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 600, offsetLeft: 0, offsetTop: 0, width: 800 },
    });
    popover.open({
      comment: '',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 780,
      y: 590,
    });

    expect(popover.element.style.left).toBe('560px');
    expect(popover.element.style.top).toBe('420px');
    Reflect.deleteProperty(window, 'visualViewport');
    popover.destroy();
    host.remove();
  });

  it('dispatches inserted text input in the owner Event realm', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(host);
    const events: Event[] = [];
    popover.open({
      comment: '',
      onChange: vi.fn(),
      onClose: vi.fn(),
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      x: 0,
      y: 0,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    input?.addEventListener('input', (event) => events.push(event));
    const OwnerEvent = class OwnerEvent extends Event {};
    const owner = host.ownerDocument.defaultView as Window & { Event: typeof Event };
    const original = owner.Event;
    Object.defineProperty(owner, 'Event', { configurable: true, value: OwnerEvent });

    host.querySelector<HTMLButtonElement>('[data-action="insert-tag"]')?.click();

    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(OwnerEvent);
    Object.defineProperty(owner, 'Event', { configurable: true, value: original });
    popover.destroy();
    host.remove();
  });

  it('keeps the popover open when a mutation callback reports failure', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(host);
    popover.open({
      comment: 'Retry me',
      onChange: () => false,
      onClose: vi.fn(),
      onDeleteAnnotation: () => false,
      onDeleteComment: () => false,
      x: 0,
      y: 0,
    });

    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected annotation comment input.');
    input.value = 'Retry changed';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(popover.element.hidden).toBe(false);
    popover.destroy();
    host.remove();
  });

  it('keeps hover content passive without focus or edit controls', () => {
    const host = document.body.createDiv();
    const invoker = host.createEl('button');
    invoker.focus();
    const popover = new AnnotationPopover(host);

    popover.openPassive({ comment: 'Hover preview', selected: false, x: 0, y: 0 });

    expect(host.ownerDocument.activeElement).toBe(invoker);
    expect(host.querySelector('[data-action="edit-comment"]')).toBeNull();
    expect(host.querySelector('[data-action="cancel-comment"]')).toBeNull();
    popover.destroy();
    host.remove();
  });

  it('focuses selected popup actions, activates Edit with the keyboard, and dismisses with Escape', () => {
    const host = document.body.createDiv();
    const invoker = host.createEl('button');
    invoker.focus();
    const onEdit = vi.fn();
    const popover = new AnnotationPopover(host);

    popover.openPassive({ comment: 'Selected', onEdit, selected: true, x: 0, y: 0 });
    const edit = host.querySelector<HTMLButtonElement>('[data-action="edit-comment"]');
    expect(host.ownerDocument.activeElement).toBe(edit);
    edit?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(onEdit).toHaveBeenCalledOnce();

    popover.close(false);
    invoker.focus();
    popover.openPassive({ comment: 'Selected', onEdit, selected: true, x: 0, y: 0 });
    popover.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(popover.element.hidden).toBe(true);
    expect(host.ownerDocument.activeElement).toBe(invoker);
    popover.destroy();
    host.remove();
  });

  it('focuses a Close action for a selected read-only popup without offering Edit', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(host);

    popover.openPassive({
      comment: 'Imported',
      readOnlyReason: 'This imported annotation is read-only.',
      selected: true,
      x: 0,
      y: 0,
    });

    expect(host.querySelector('[data-action="edit-comment"]')).toBeNull();
    expect(host.ownerDocument.activeElement).toBe(
      host.querySelector('[data-action="cancel-comment"]'),
    );
    popover.destroy();
    host.remove();
  });
});
