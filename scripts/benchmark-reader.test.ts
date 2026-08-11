import { describe, expect, it } from 'vitest';
import { evaluateReaderBudget, parseObsidianEval, summarizeSamples } from './benchmark-reader.mjs';

describe('reader benchmark summaries', () => {
  it('removes the Obsidian CLI eval marker before parsing serialized instrumentation', () => {
    expect(parseObsidianEval('=> {"schemaVersion":1}\n')).toBe('{"schemaVersion":1}');
  });

  it('reports hand-checked p50 and p95 values from sorted samples', () => {
    expect(
      summarizeSamples([9, 1, 5, 3, 7, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39]),
    ).toEqual({
      p50: 19,
      p95: 37,
    });
  });

  it('does not turn an unavailable reference environment into a passing benchmark', () => {
    expect(
      evaluateReaderBudget({ available: false, reason: 'Obsidian CLI is not running.' }),
    ).toEqual({
      status: 'unavailable',
      reason: 'Obsidian CLI is not running.',
    });
  });

  it('fails measured desktop samples at either activation or first-page budget', () => {
    expect(
      evaluateReaderBudget({
        activationMs: [90, 101],
        available: true,
        firstUsablePageMs: [1_500, 2_001],
        pdfWorkDuringActivation: [0, 0],
        platform: 'desktop',
      }),
    ).toMatchObject({ status: 'failed' });
  });
});
