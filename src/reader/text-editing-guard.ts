const TEXT_EDITING_EVENTS = ['keydown', 'copy', 'cut', 'paste'] as const;

export function configureTextSearchInput(input: HTMLInputElement): void {
  input.type = 'text';
  input.setAttribute('role', 'searchbox');
  input.autocomplete = 'off';
  input.spellcheck = false;
}

export function isolateTextEditing(element: HTMLElement): void {
  for (const type of TEXT_EDITING_EVENTS) element.addEventListener(type, stopPropagation);
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}
