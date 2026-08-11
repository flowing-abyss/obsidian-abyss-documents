import { describe, expect, it } from 'vitest';
import {
  asAnnotationId,
  asGeneratedAnnotationId,
  asUtcTimestamp,
  type AnnotationMutation,
  type AnnotationMutationTarget,
} from './annotations.js';
import { StaleGenerationError } from './errors.js';
import { MutationLedger } from './mutation-ledger.js';

const id = asAnnotationId('nm-1');
const target: AnnotationMutationTarget = { kind: 'stable', id };

function comment(comment = '[[Concept]] #tag'): AnnotationMutation {
  return { kind: 'set-comment', target, comment };
}

describe('MutationLedger', () => {
  it('keeps edits made during save in the next generation when the captured save fails', () => {
    const ledger = new MutationLedger();
    const first = ledger.append(comment());
    const captured = ledger.capture();
    const second = ledger.append({ kind: 'set-color', target, color: '#ffd400' });

    expect(captured.generation).toBe(first.generation);
    expect(second.generation).toBeGreaterThan(captured.generation);

    ledger.fail(captured, new Error('write'));

    expect(ledger.state).toBe('dirty');
    expect(ledger.pending()).toEqual([first.mutation, second.mutation]);
    expect(ledger.lastFailure).toMatchObject({ stage: 'serializing', generation: 1 });
  });

  it.each([
    ['serializing', () => undefined],
    [
      'writing',
      (ledger: MutationLedger, captured: ReturnType<MutationLedger['capture']>) => {
        ledger.markWriting(captured);
      },
    ],
    [
      'verifying',
      (ledger: MutationLedger, captured: ReturnType<MutationLedger['capture']>) => {
        ledger.markWriting(captured);
        ledger.markVerifying(captured);
      },
    ],
  ] as const)('retains the complete pending ledger after %s failure', (stage, advance) => {
    const ledger = new MutationLedger();
    const entry = ledger.append(comment(stage));
    const captured = ledger.capture();
    advance(ledger, captured);

    const cause = new Error(stage);
    ledger.fail(captured, cause);

    expect(ledger.pending()).toEqual([entry.mutation]);
    expect(ledger.lastFailure).toMatchObject({ stage, cause });
  });

  it('commits only the captured generation and leaves concurrent edits dirty', () => {
    const ledger = new MutationLedger();
    ledger.append(comment('captured'));
    const captured = ledger.capture();
    const next = ledger.append({ kind: 'set-color', target, color: '#00a2ff' });

    ledger.markWriting(captured);
    ledger.markVerifying(captured);
    ledger.commit(captured);

    expect(ledger.state).toBe('dirty');
    expect(ledger.pending()).toEqual([next.mutation]);
    expect(ledger.committedGeneration).toBe(captured.generation);
  });

  it('rejects stale async completions after failure and retry capture', () => {
    const ledger = new MutationLedger();
    ledger.append(comment());
    const stale = ledger.capture();
    ledger.fail(stale, new Error('serialize'));
    const retry = ledger.capture();

    expect(retry.generation).toBe(stale.generation);
    expect(retry.captureId).not.toBe(stale.captureId);
    expect(() => {
      ledger.markWriting(stale);
    }).toThrow(StaleGenerationError);
    expect(ledger.state).toBe('serializing');
  });

  it('rejects a second capture while serialization is active', () => {
    const ledger = new MutationLedger();
    ledger.append(comment());
    ledger.capture();

    expect(() => {
      ledger.capture();
    }).toThrow(/serializing/u);
  });

  it('can fail a clean capture without inventing a dirty generation', () => {
    const ledger = new MutationLedger();
    const captured = ledger.capture();

    expect(captured).toMatchObject({ generation: 0, mutations: [] });
    ledger.fail(captured, new Error('clean serialization'));

    expect(ledger.state).toBe('committed');
    expect(ledger.pending()).toEqual([]);
  });

  it('rejects a same-numbered capture from another ledger', () => {
    const first = new MutationLedger();
    const second = new MutationLedger();
    first.append(comment('first'));
    second.append(comment('second'));
    const foreign = first.capture();
    second.capture();

    expect(() => {
      second.markWriting(foreign);
    }).toThrow(StaleGenerationError);
    expect(second.state).toBe('serializing');
  });

  it('rejects a structurally copied capture with a forged generation', () => {
    const ledger = new MutationLedger();
    ledger.append(comment());
    const captured = ledger.capture();
    const forged = Object.freeze({ ...captured, generation: 999 });

    expect(() => {
      ledger.markWriting(forged);
    }).toThrow(StaleGenerationError);
    expect(ledger.state).toBe('serializing');
  });

  it('journals the UUID promotion needed to edit a legacy annotation', () => {
    const ledger = new MutationLedger();
    const promoteTo = asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08');

    const entry = ledger.append({
      kind: 'set-comment',
      target: { kind: 'legacy', fingerprint: 'page-2:quad-10-20', promoteTo },
      comment: 'First supported edit',
    });

    expect(entry.mutation).toMatchObject({
      target: { kind: 'legacy', fingerprint: 'page-2:quad-10-20', promoteTo },
    });
  });

  it('does not let callers mutate journaled entries or captured snapshots', () => {
    const input = comment('original');
    const ledger = new MutationLedger();
    const entry = ledger.append(input);
    const captured = ledger.capture();

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.mutation)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.mutations)).toBe(true);
    expect(() => {
      (input as { comment: string }).comment = 'changed outside';
    }).not.toThrow();
    expect(captured.mutations).toEqual([comment('original')]);
  });

  it('copies and deeply freezes nested geometry before journaling', () => {
    const sourcePoint = { x: 10, y: 20 };
    const input: AnnotationMutation = {
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 1,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'ink', paths: [[sourcePoint]] },
      },
    };
    const ledger = new MutationLedger();

    ledger.append(input);
    const captured = ledger.capture();
    sourcePoint.x = 999;

    expect(captured.mutations).toMatchObject([
      {
        anchor: { geometry: { paths: [[{ x: 10, y: 20 }]] } },
      },
    ]);
    const journaled = captured.mutations[0];
    if (journaled?.kind !== 'set-geometry') {
      throw new Error('Expected a geometry mutation.');
    }
    if (journaled.anchor.kind !== 'fixed-page') {
      throw new Error('Expected a fixed-page anchor.');
    }
    if (journaled.anchor.geometry.kind !== 'ink') {
      throw new Error('Expected ink geometry.');
    }
    expect(Object.isFrozen(journaled.anchor.geometry.paths[0]?.[0])).toBe(true);
  });

  it('isolates create payloads with quadrilateral geometry', () => {
    const sourcePoint = { x: 10, y: 20 };
    const generated = asGeneratedAnnotationId('01918f62-5c0b-7cc3-98ad-6f126f164f08');
    const ledger = new MutationLedger();
    ledger.append({
      kind: 'create',
      id: generated,
      type: 'highlight',
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: {
          kind: 'quadrilaterals',
          quadrilaterals: [
            {
              bottomLeft: sourcePoint,
              bottomRight: { x: 20, y: 20 },
              topLeft: { x: 10, y: 10 },
              topRight: { x: 20, y: 10 },
            },
          ],
        },
      },
      color: '#ffd400',
      selectedText: 'Created highlight',
      author: '',
      createdAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
      comment: '',
    });
    const captured = ledger.capture();
    sourcePoint.x = 999;

    expect(captured.mutations).toMatchObject([
      {
        kind: 'create',
        anchor: {
          geometry: { quadrilaterals: [{ bottomLeft: { x: 10, y: 20 } }] },
        },
      },
    ]);
  });

  it('isolates point, rectangle, and reflowable anchors', () => {
    const point = { x: 5, y: 6 };
    const rectangle = { x: 1, y: 2, width: 30, height: 40 };
    const selector = { exact: 'quoted text', prefix: 'before ', suffix: ' after' };
    const ledger = new MutationLedger();
    ledger.append({
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 1,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point },
      },
    });
    ledger.append({
      kind: 'set-geometry',
      target,
      anchor: {
        kind: 'fixed-page',
        pageIndex: 2,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'rectangle', rectangle },
      },
    });
    ledger.append({
      kind: 'set-geometry',
      target,
      anchor: { kind: 'reflowable-text', selector, progression: 0.3 },
    });
    const captured = ledger.capture();
    point.x = 500;
    rectangle.width = 300;
    selector.exact = 'changed';

    expect(captured.mutations).toMatchObject([
      { anchor: { geometry: { point: { x: 5, y: 6 } } } },
      { anchor: { geometry: { rectangle: { width: 30, height: 40 } } } },
      { anchor: { selector: { exact: 'quoted text' }, progression: 0.3 } },
    ]);
  });

  it('isolates metadata patches from later caller changes', () => {
    const metadata = {
      author: 'Ada',
      modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
    };
    const ledger = new MutationLedger();
    ledger.append({ kind: 'set-metadata', target, metadata });
    const captured = ledger.capture();
    metadata.author = 'Changed';

    expect(captured.mutations).toEqual([
      {
        kind: 'set-metadata',
        target,
        metadata: {
          author: 'Ada',
          modifiedAt: asUtcTimestamp('2026-08-11T10:00:00.000Z'),
        },
      },
    ]);
  });

  it('captures conversion and deletion targets without collapsing their identity', () => {
    const ledger = new MutationLedger();
    const conversion = ledger.append({
      kind: 'convert-type',
      target,
      type: 'underline',
    });
    const deletion = ledger.append({ kind: 'delete', target });

    expect(ledger.pending()).toEqual([conversion.mutation, deletion.mutation]);
    expect(ledger.pending()).toMatchObject([
      { kind: 'convert-type', target: { kind: 'stable', id: 'nm-1' }, type: 'underline' },
      { kind: 'delete', target: { kind: 'stable', id: 'nm-1' } },
    ]);
  });

  it('enforces the serialization, write, verification, commit order', () => {
    const ledger = new MutationLedger();
    ledger.append(comment());
    const captured = ledger.capture();

    expect(() => {
      ledger.markVerifying(captured);
    }).toThrow(/serializing/u);
    expect(() => {
      ledger.commit(captured);
    }).toThrow(/serializing/u);
    ledger.markWriting(captured);
    expect(() => {
      ledger.commit(captured);
    }).toThrow(/writing/u);
  });

  it('reaches committed after a fully verified generation with no later edits', () => {
    const ledger = new MutationLedger();
    ledger.append(comment());
    const captured = ledger.capture();
    ledger.markWriting(captured);
    ledger.markVerifying(captured);

    ledger.commit(captured);

    expect(ledger.state).toBe('committed');
    expect(ledger.pending()).toEqual([]);
  });
});
