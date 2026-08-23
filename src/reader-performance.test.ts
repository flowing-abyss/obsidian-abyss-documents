import { describe, expect, it, vi } from 'vitest';
import {
  beginPluginActivation,
  beginReaderTimedOperation,
  endPluginActivation,
  incrementReaderCounter,
  markReaderPerformance,
  markReaderPerformanceOnce,
  readerPerformanceSnapshot,
  recordReaderPerformanceSample,
  recordSuccessfulAnnotationSave,
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
      annotationExtractionBatches: 0,
      annotationSaveFailures: 0,
      annotationSaveRecoveries: 0,
      annotationSaves: 0,
      maxAnnotationCards: 0,
      maxAnnotationPanelNodes: 0,
      maxConcurrentSerializations: 0,
      maxConcurrentWrites: 0,
      pdfRuntimeLoads: 1,
      pdfWorkDuringPluginOnload: 1,
    });
    expect(snapshot.samples).toEqual({
      annotationFilterMs: [],
      annotationSaveMs: [],
      annotationSearchMs: [],
      extractionBatchMs: [],
    });
    expect(snapshot.activationMs).toBeGreaterThanOrEqual(0);
    expect(mark).toHaveBeenCalledWith('abyss-documents:plugin-activation-start');
  });

  it('bounds high-volume marks while retaining lifecycle and first-event evidence', () => {
    beginPluginActivation();
    endPluginActivation();
    markReaderPerformanceOnce('first-text-layer');
    for (let index = 0; index < 600; index += 1) markReaderPerformance('text-layer');

    const marks = readerPerformanceSnapshot().marks;
    expect(marks.length).toBeLessThanOrEqual(512);
    expect(marks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'plugin-activation-start',
        'plugin-activation-end',
        'first-text-layer',
      ]),
    );
  });
});

describe('annotation qualification instrumentation', () => {
  it('retains non-vacuous samples and maximum overlapping serialization/write operations', () => {
    beginPluginActivation();
    endPluginActivation();
    const firstSerialization = beginReaderTimedOperation('annotation-serialization');
    const secondSerialization = beginReaderTimedOperation('annotation-serialization');
    const write = beginReaderTimedOperation('annotation-write');
    firstSerialization();
    secondSerialization();
    write();
    const failedSave = beginReaderTimedOperation('annotation-save');
    failedSave(false);
    const cancelledSave = beginReaderTimedOperation('annotation-save');
    cancelledSave(false);
    const successfulSave = beginReaderTimedOperation('annotation-save');
    successfulSave(true);
    successfulSave(true);
    recordSuccessfulAnnotationSave();
    recordReaderPerformanceSample('extractionBatchMs', 49.5);
    recordReaderPerformanceSample('annotationFilterMs', 12);
    recordReaderPerformanceSample('annotationSearchMs', 18);

    expect(readerPerformanceSnapshot()).toMatchObject({
      counters: {
        annotationExtractionBatches: 1,
        annotationSaveFailures: 0,
        annotationSaveRecoveries: 0,
        annotationSaves: 1,
        maxConcurrentSerializations: 2,
        maxConcurrentWrites: 1,
      },
      samples: {
        annotationFilterMs: [12],
        annotationSaveMs: [expect.any(Number)],
        annotationSearchMs: [18],
        extractionBatchMs: [49.5],
      },
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid retained duration %s instead of creating passing evidence',
    (duration) => {
      expect(() => {
        recordReaderPerformanceSample('annotationFilterMs', duration);
      }).toThrow('finite non-negative');
    },
  );
});
