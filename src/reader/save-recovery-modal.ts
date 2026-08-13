import { Modal, type App } from 'obsidian';
import { ownerWindow } from './owner-dom.js';

export class SaveRecoveryModal extends Modal {
  private choice: boolean | null = null;
  private resolveChoice: ((choice: boolean) => void) | null = null;
  private choicePromise: Promise<boolean> | null = null;

  constructor(
    app: App,
    private readonly documentName: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle('PDF save could not be verified');
    this.contentEl.empty();
    const owner = ownerWindow(this.contentEl);
    const message = owner.createEl('p');
    message.textContent =
      `Obsidian could not determine which bytes are currently stored for ${this.documentName}. ` +
      'Restoring the last verified copy will overwrite the current PDF and may discard external changes.';
    const actions = owner.createDiv();
    actions.className = 'modal-button-container';
    const restore = this.button('Restore last verified copy', true, false);
    const cancel = this.button('Cancel', false, true);
    actions.append(restore, cancel);
    this.contentEl.append(message, actions);
    cancel.focus();
  }

  override onClose(): void {
    this.finish(this.choice ?? false);
    this.contentEl.empty();
  }

  waitForChoice(): Promise<boolean> {
    this.choicePromise ??= new Promise<boolean>((resolve) => {
      this.resolveChoice = resolve;
    });
    return this.choicePromise;
  }

  private button(label: string, warning: boolean, autofocus: boolean): HTMLButtonElement {
    const button = ownerWindow(this.contentEl).createEl('button');
    button.type = 'button';
    button.textContent = label;
    button.autofocus = autofocus;
    if (warning) button.classList.add('mod-warning');
    button.addEventListener('click', () => {
      this.choice = warning;
      this.finish(warning);
      this.close();
    });
    return button;
  }

  private finish(choice: boolean): void {
    this.resolveChoice?.(choice);
    this.resolveChoice = null;
  }
}
