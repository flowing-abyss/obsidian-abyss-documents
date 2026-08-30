import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DocumentLocation } from './document.js';

describe('DocumentLocation coordinate space', () => {
  it('discriminates page-only locations from positioned coordinate space locations', () => {
    const pageOnly = { pageIndex: 2 } satisfies DocumentLocation;
    const topLeft = {
      coordinateSpace: 'page-points-top-left',
      pageIndex: 0,
      x: 20,
      y: 49,
    } satisfies DocumentLocation;
    const bottomLeft = {
      coordinateSpace: 'pdf-points-bottom-left',
      pageIndex: 1,
      x: 12,
    } satisfies DocumentLocation;

    expect([pageOnly, topLeft, bottomLeft]).toEqual([
      { pageIndex: 2 },
      { coordinateSpace: 'page-points-top-left', pageIndex: 0, x: 20, y: 49 },
      { coordinateSpace: 'pdf-points-bottom-left', pageIndex: 1, x: 12 },
    ]);
    expectTypeOf<DocumentLocation>().toEqualTypeOf<
      | {
          readonly coordinateSpace?: never;
          readonly pageIndex: number;
          readonly x?: never;
          readonly y?: never;
        }
      | {
          readonly coordinateSpace: 'page-points-top-left' | 'pdf-points-bottom-left';
          readonly pageIndex: number;
          readonly x?: number;
          readonly y?: number;
        }
    >();
  });
});
