import { describe, expect, it, vi } from 'vitest';
import type { ViewportAnnotationSnapshot, ViewportEvent } from './document.js';
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

  it('delivers normalized annotation changes and mounted snapshots in source order', () => {
    const events = new TypedEventSource<ViewportEvent>();
    const delivered: ViewportEvent[] = [];
    events.subscribe((event) => delivered.push(event));
    const annotation: ViewportAnnotationSnapshot = {
      nativeId: 'native-1',
      pageIndex: 0,
      type: 'highlight' as const,
      rects: [{ x: 1, y: 2, width: 3, height: 4 }],
      tags: [],
      links: [],
    };

    events.emit({ type: 'annotation-change', change: { operation: 'upsert', annotation } });
    events.emit({ type: 'annotation-snapshot', annotations: [annotation] });

    expect(delivered.map((event) => event.type)).toEqual([
      'annotation-change',
      'annotation-snapshot',
    ]);
  });
});
