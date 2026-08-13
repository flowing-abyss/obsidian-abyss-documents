import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { SaveRecoveryModal } from './save-recovery-modal.js';

describe('SaveRecoveryModal', () => {
  it('requires explicit confirmation before restoring the last verified PDF copy', async () => {
    const modal = new SaveRecoveryModal(App.createConfigured__().asOriginalType__(), 'Guide.pdf');
    document.body.append(modal.containerEl);
    modal.onOpen();
    const buttons = Array.from(modal.contentEl.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Restore last verified copy',
      'Cancel',
    ]);
    expect(buttons[0]?.classList.contains('mod-warning')).toBe(true);
    expect(modal.contentEl.ownerDocument.activeElement).toBe(buttons[1]);
    const choice = modal.waitForChoice();
    buttons[0]?.click();
    await expect(choice).resolves.toBe(true);
    modal.containerEl.remove();
  });

  it('treats closing the modal without an action as cancellation', async () => {
    const modal = new SaveRecoveryModal(App.createConfigured__().asOriginalType__(), 'Guide.pdf');
    const choice = modal.waitForChoice();
    modal.onClose();
    await expect(choice).resolves.toBe(false);
  });
});
