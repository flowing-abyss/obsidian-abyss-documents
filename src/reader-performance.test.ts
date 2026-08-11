import { describe, expect, it, vi } from 'vitest';
import {
  beginPluginActivation,
  endPluginActivation,
  incrementReaderCounter,
  markReaderPerformance,
  readerPerformanceSnapshot,
} from './reader-performance.js';

describe('reader performance instrumentation', () => {
  it('publishes named marks, activation duration, counters, and zero eager PDF work', () => {
    const mark = vi.spyOn(performance, 'mark').mockImplementation(() => ({}) as PerformanceMark);

    beginPluginActivation();
    incrementReaderCounter('pdfRuntimeLoads');
    markReaderPerformance('pdf-imports-start');
    endPluginActivation();

    const snapshot = readerPerformanceSnapshot();
    expect(snapshot.marks.map(({ name }) => name)).toEqual([
      'plugin-activation-start',
      'pdf-imports-start',
      'plugin-activation-end',
    ]);
    expect(snapshot.counters).toMatchObject({
      pdfRuntimeLoads: 1,
      pdfWorkDuringPluginOnload: 1,
    });
    expect(snapshot.activationMs).toBeGreaterThanOrEqual(0);
    expect(mark).toHaveBeenCalledWith('abyss-documents:plugin-activation-start');
  });
});
