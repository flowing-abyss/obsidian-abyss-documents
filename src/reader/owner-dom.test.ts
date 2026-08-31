import { describe, expect, it } from 'vitest';
import { focusableTarget, ownerWindow } from './owner-dom.js';

describe('owner DOM focus targets', () => {
  it('rejects non-elements before resolving a focusable ancestor', () => {
    const host = createDiv();
    const owner = ownerWindow(host);
    expect(focusableTarget(null, owner)).toBeNull();
    expect(focusableTarget(new EventTarget(), owner)).toBeNull();
  });
});
