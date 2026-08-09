import { describe, expect, it } from 'vitest';
import { ReaderShell } from './reader-shell.js';

describe('ReaderShell', () => {
  it('starts with the sidebar absent from layout', () => {
    const host = createDiv();

    const shell = new ReaderShell(host);

    expect(shell.root.querySelector('[data-region="toolbar"]')).not.toBeNull();
    expect(shell.root.querySelector('[data-region="document"]')).toBe(shell.documentHost);
    expect(shell.root.querySelector('[data-region="sidebar"]')).toBeNull();
  });

  it('removes only its owned reader root when destroyed', () => {
    const host = createDiv();
    const sibling = createDiv();
    host.append(sibling);
    const shell = new ReaderShell(host);

    shell.destroy();
    shell.destroy();

    expect(Array.from(host.children)).toEqual(expect.arrayContaining([sibling]));
    expect(host.contains(shell.root)).toBe(false);
  });
});
