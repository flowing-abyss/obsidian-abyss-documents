import { Modal, type App } from 'obsidian';
import { ownerWindow } from './owner-dom.js';

export type SaveConflictAction = 'reload-discard' | 'overwrite' | 'cancel';

export class SaveConflictModal extends Modal {
  private choice: SaveConflictAction | null = null;
  private resolveChoice: ((choice: SaveConflictAction) => void) | null = null;
  private choicePromise: Promise<SaveConflictAction> | null = null;

  constructor(
    app: App,
    private readonly documentName: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle('PDF changed outside Obsidian');
    this.contentEl.empty();
    const owner = ownerWindow(this.contentEl);
    const message = owner.createEl('p');
    message.textContent = `${this.documentName} changed after it was opened. Choose how to continue.`;
    const actions = owner.createDiv();
    actions.className = 'modal-button-container';
    const cancel = this.button('Cancel', 'cancel', true);
    actions.append(
      this.button('Reload and discard changes', 'reload-discard', false, true),
      this.button('Overwrite anyway', 'overwrite', false, true),
      cancel,
    );
    this.contentEl.append(message, actions);
    cancel.focus();
  }

  override onClose(): void {
    this.finish(this.choice ?? 'cancel');
    this.contentEl.empty();
  }

  waitForChoice(): Promise<SaveConflictAction> {
    this.choicePromise ??= new Promise<SaveConflictAction>((resolve) => {
      this.resolveChoice = resolve;
    });
    return this.choicePromise;
  }

  private button(
    label: string,
    action: SaveConflictAction,
    autofocus = false,
    warning = false,
  ): HTMLButtonElement {
    const button = ownerWindow(this.contentEl).createEl('button');
    button.type = 'button';
    button.textContent = label;
    button.autofocus = autofocus;
    if (warning) button.classList.add('mod-warning');
    button.addEventListener('click', () => {
      this.choice = action;
      this.finish(action);
      this.close();
    });
    return button;
  }

  private finish(choice: SaveConflictAction): void {
    this.resolveChoice?.(choice);
    this.resolveChoice = null;
  }
}
