import { describe, expect, it, vi } from 'vitest';
import type { ViewportEvent } from './document.js';
import { TypedEventSource } from './events.js';

describe('TypedEventSource', () => {
  it('unsubscribe prevents later viewport delivery', () => {
    const events = new TypedEventSource<ViewportEvent>();
    const listener = vi.fn();
    const unsubscribe = events.subscribe(listener);

    unsubscribe();
    events.emit({ type: 'page-change', pageIndex: 4 });

    expect(listener).not.toHaveBeenCalled();
  });

  it('clear prevents later viewport delivery to every listener', () => {
    const events = new TypedEventSource<ViewportEvent>();
    const first = vi.fn();
    const second = vi.fn();
    events.subscribe(first);
    events.subscribe(second);

    events.clear();
    events.emit({ type: 'page-change', pageIndex: 4 });

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
