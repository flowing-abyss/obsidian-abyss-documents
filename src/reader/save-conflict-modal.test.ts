import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { SaveConflictModal } from './save-conflict-modal.js';

describe('SaveConflictModal', () => {
  it('offers explicit destructive choices without claiming unsupported rebase semantics', async () => {
    const modal = new SaveConflictModal(App.createConfigured__().asOriginalType__(), 'Guide.pdf');
    document.body.append(modal.containerEl);
    modal.onOpen();
    const buttons = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button'));

    expect(buttons.map((button) => button.textContent)).toEqual([
      'Reload and discard changes',
      'Overwrite anyway',
      'Cancel',
    ]);
    expect(buttons[0]?.autofocus).toBe(false);
    expect(buttons[0]?.classList.contains('mod-warning')).toBe(true);
    expect(buttons[1]?.autofocus).toBe(false);
    expect(buttons[1]?.classList.contains('mod-warning')).toBe(true);
    expect(buttons[2]?.autofocus).toBe(true);
    expect(modal.contentEl.ownerDocument.activeElement).toBe(buttons[2]);

    const choice = modal.waitForChoice();
    buttons[0]?.click();
    await expect(choice).resolves.toBe('reload-discard');
    modal.containerEl.remove();
  });

  it('resolves close-without-action as cancel', async () => {
    const modal = new SaveConflictModal(App.createConfigured__().asOriginalType__(), 'Guide.pdf');
    const choice = modal.waitForChoice();
    modal.onClose();
    await expect(choice).resolves.toBe('cancel');
  });
});
