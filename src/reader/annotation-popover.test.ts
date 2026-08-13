import { describe, expect, it, vi } from 'vitest';
import { AnnotationPopover } from './annotation-popover.js';

describe('AnnotationPopover', () => {
  it('edits ordinary comment text and inserts tags and wiki links without conversion controls', () => {
    const host = document.body.createDiv();
    const save = vi.fn();
    const popover = new AnnotationPopover(host);
    popover.open({
      comment: 'Idea',
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      onSave: save,
      x: 10,
      y: 20,
    });
    const input = host.querySelector<HTMLTextAreaElement>('textarea');
    if (input === null) throw new Error('Expected annotation comment input.');
    input.setSelectionRange(input.value.length, input.value.length);
    host.querySelector<HTMLButtonElement>('[data-action="insert-tag"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="insert-link"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="save-comment"]')?.click();

    expect(save).toHaveBeenCalledWith('Idea #tag [[Link]]');
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
      onDeleteAnnotation: onDelete,
      onDeleteComment: vi.fn(),
      onSave: vi.fn(),
      x: 0,
      y: 0,
    });
    expect(popover.element.ownerDocument).toBe(host.ownerDocument);
    popover.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(invoker);

    popover.open({
      comment: '',
      onDeleteAnnotation: onDelete,
      onDeleteComment: vi.fn(),
      onSave: vi.fn(),
      x: 0,
      y: 0,
    });
    host.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(onDelete).toHaveBeenCalledOnce();
    popover.destroy();
    host.remove();
  });

  it('clamps position, cancels, ignores non-element clicks, and rejects reopening after destroy', () => {
    const host = document.body.createDiv();
    const popover = new AnnotationPopover(host);
    const request = {
      comment: '',
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      onSave: vi.fn(),
      x: -2,
      y: -3,
    };
    popover.open(request);
    expect(popover.element.style.left).toBe('0px');
    expect(popover.element.style.top).toBe('0px');
    popover.element.append(document.createTextNode('text target'));
    popover.element.lastChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-action="cancel-comment"]')?.click();
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
      onColor,
      onDeleteAnnotation,
      onDeleteComment: vi.fn(),
      onSave: vi.fn(),
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
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      onSave: vi.fn(),
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
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      onSave: vi.fn(),
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
      onDeleteAnnotation: vi.fn(),
      onDeleteComment: vi.fn(),
      onSave: vi.fn(),
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
      onDeleteAnnotation: () => false,
      onDeleteComment: () => false,
      onSave: () => false,
      x: 0,
      y: 0,
    });

    host.querySelector<HTMLButtonElement>('[data-action="save-comment"]')?.click();

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
