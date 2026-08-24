import type * as ObsidianModule from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { createIconButton, updateIconButtonLabel } from './icon-button.js';

const mocks = vi.hoisted(() => ({ setTooltip: vi.fn() }));

vi.mock('obsidian', async (importOriginal) => {
  const original: typeof ObsidianModule = await importOriginal();
  return { ...original, setTooltip: mocks.setTooltip };
});

describe('createIconButton', () => {
  it('uses setTooltip and matching aria labels', () => {
    const host = createDiv();

    const button = createIconButton(host, {
      control: 'sample',
      icon: 'highlighter',
      label: 'Quick Highlight',
    });

    expect(button.getAttribute('aria-label')).toBe('Quick Highlight');
    expect(mocks.setTooltip).toHaveBeenCalledWith(button, 'Quick Highlight', { delay: 250 });
    updateIconButtonLabel(button, 'Quick Highlight — Key idea');
    expect(button.getAttribute('aria-label')).toBe('Quick Highlight — Key idea');
    expect(mocks.setTooltip).toHaveBeenLastCalledWith(button, 'Quick Highlight — Key idea', {
      delay: 250,
    });
  });
});
