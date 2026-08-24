import { setIcon, setTooltip, type IconName } from 'obsidian';

export interface IconButtonOptions {
  readonly classes?: readonly string[];
  readonly control?: string;
  readonly icon: IconName;
  readonly label: string;
}

export function createIconButton(
  parent: HTMLElement,
  options: IconButtonOptions,
): HTMLButtonElement {
  const button = parent.createEl('button', {
    cls: ['clickable-icon', 'abyss-reader-icon-button', ...(options.classes ?? [])],
    attr: {
      'aria-label': options.label,
      ...(options.control === undefined ? {} : { 'data-control': options.control }),
      'data-toolbar-control': '',
    },
    type: 'button',
  });
  setIcon(button, options.icon);
  setTooltip(button, options.label, { delay: 250 });
  return button;
}

export function updateIconButtonLabel(button: HTMLButtonElement, label: string): void {
  button.setAttribute('aria-label', label);
  setTooltip(button, label, { delay: 250 });
}
