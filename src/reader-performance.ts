export type ReaderPerformanceMark =
  | 'plugin-activation-start'
  | 'plugin-activation-end'
  | 'first-reader-intent'
  | 'reader-intent'
  | 'pdf-handoff-scheduled'
  | 'pdf-handoff-scan'
  | 'pdf-handoff-start'
  | 'pdf-handoff-ready'
  | 'pdf-handoff-cleanup'
  | 'pdf-imports-start'
  | 'pdf-imports-end'
  | 'gzip-decode-start'
  | 'gzip-decode-end'
  | 'blob-created'
  | 'worker-start'
  | 'worker-revoked'
  | 'first-text-layer'
  | 'text-layer'
  | 'first-usable-page'
  | 'usable-page';

export interface ReaderPerformanceCounters {
  annotationExtractionBatches: number;
  annotationSaveFailures: number;
  annotationSaveRecoveries: number;
  annotationSaves: number;
  blobsCreated: number;
  firstTextLayers: number;
  firstUsablePages: number;
  gzipDecodes: number;
  maxRenderedPagesDuringLongNavigation: number;
  maxAnnotationCards: number;
  maxAnnotationPanelNodes: number;
  maxConcurrentSerializations: number;
  maxConcurrentWrites: number;
  pdfImports: number;
  pdfRuntimeLoads: number;
  pdfWorkDuringPluginOnload: number;
  workerUrlsActive: number;
  workersStarted: number;
}

interface ReaderPerformanceSamples {
  annotationFilterMs: number[];
  annotationSaveMs: number[];
  annotationSearchMs: number[];
  extractionBatchMs: number[];
}

interface MutableReaderPerformanceState {
  schemaVersion: 1;
  activationInProgress: boolean;
  activationMs: number | null;
  activeAnnotationOperations: { serializations: number; writes: number };
  counters: ReaderPerformanceCounters;
  samples: ReaderPerformanceSamples;
  marks: Array<{ name: ReaderPerformanceMark; startTime: number }>;
  versions: { plugin: string | null; pdfjs: string | null };
}

export type ReaderTimedOperation =
  'annotation-save' | 'annotation-serialization' | 'annotation-write';

export type ReaderPerformanceSampleName = keyof ReaderPerformanceSamples;

const MAX_RETAINED_SAMPLES = 100;
const MAX_RETAINED_MARKS = 512;
const RETAINED_LIFECYCLE_MARKS: ReadonlySet<ReaderPerformanceMark> = new Set([
  'plugin-activation-start',
  'plugin-activation-end',
  'first-reader-intent',
  'first-text-layer',
  'first-usable-page',
]);

export interface ReaderPerformanceSnapshot {
  readonly schemaVersion: 1;
  readonly activationMs: number | null;
  readonly counters: Readonly<ReaderPerformanceCounters>;
  readonly samples: Readonly<ReaderPerformanceSamples>;
  readonly marks: ReadonlyArray<{
    readonly name: ReaderPerformanceMark;
    readonly startTime: number;
  }>;
  readonly versions: { readonly plugin: string | null; readonly pdfjs: string | null };
}

type PerformanceHost = Window & {
  __abyssDocumentsPerformance?: MutableReaderPerformanceState;
};

const PDF_WORK_COUNTERS: ReadonlySet<keyof ReaderPerformanceCounters> = new Set([
  'blobsCreated',
  'gzipDecodes',
  'pdfImports',
  'pdfRuntimeLoads',
  'workersStarted',
]);

export function beginPluginActivation(pluginVersion: string | null = null): void {
  const state = emptyState();
  state.activationInProgress = true;
  state.versions.plugin = pluginVersion;
  host().__abyssDocumentsPerformance = state;
  markReaderPerformance('plugin-activation-start');
}

export function endPluginActivation(): void {
  const state = currentState();
  markReaderPerformance('plugin-activation-end');
  const start = state.marks.find(({ name }) => name === 'plugin-activation-start')?.startTime;
  const end = state.marks[state.marks.length - 1]?.startTime;
  state.activationMs = start === undefined || end === undefined ? null : Math.max(0, end - start);
  state.activationInProgress = false;
}

export function markReaderPerformance(name: ReaderPerformanceMark): void {
  const state = currentState();
  const startTime = now();
  state.marks.push({ name, startTime });
  while (state.marks.length > MAX_RETAINED_MARKS) {
    const removable = state.marks.findIndex((mark) => !RETAINED_LIFECYCLE_MARKS.has(mark.name));
    if (removable < 0) break;
    state.marks.splice(removable, 1);
  }
  try {
    const performanceName = `abyss-documents:${name}`;
    window.performance.clearMarks(performanceName);
    window.performance.mark(performanceName);
  } catch {
    // Instrumentation must never make the reader unavailable on older WebViews.
  }
}

export function markReaderPerformanceOnce(name: ReaderPerformanceMark): void {
  if (currentState().marks.some((mark) => mark.name === name)) return;
  markReaderPerformance(name);
}

export function incrementReaderCounter(name: keyof ReaderPerformanceCounters): void {
  const state = currentState();
  state.counters[name] += 1;
  if (state.activationInProgress && PDF_WORK_COUNTERS.has(name)) {
    state.counters.pdfWorkDuringPluginOnload += 1;
  }
}

export function setReaderCounter(name: keyof ReaderPerformanceCounters, value: number): void {
  currentState().counters[name] = Math.max(0, Math.floor(value));
}

export function maximizeReaderCounter(name: keyof ReaderPerformanceCounters, value: number): void {
  const state = currentState();
  state.counters[name] = Math.max(state.counters[name], Math.max(0, Math.floor(value)));
}

export function recordReaderPerformanceSample(
  name: ReaderPerformanceSampleName,
  durationMs: number,
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new TypeError('A retained performance duration must be a finite non-negative number.');
  }
  const state = currentState();
  const samples = state.samples[name];
  samples.push(durationMs);
  if (samples.length > MAX_RETAINED_SAMPLES)
    samples.splice(0, samples.length - MAX_RETAINED_SAMPLES);
  if (name === 'extractionBatchMs') state.counters.annotationExtractionBatches += 1;
}

export function beginReaderTimedOperation(
  operation: ReaderTimedOperation,
): (successful?: boolean) => void {
  const state = currentState();
  const startedAt = now();
  if (operation === 'annotation-serialization') {
    state.activeAnnotationOperations.serializations += 1;
    state.counters.maxConcurrentSerializations = Math.max(
      state.counters.maxConcurrentSerializations,
      state.activeAnnotationOperations.serializations,
    );
  } else if (operation === 'annotation-write') {
    state.activeAnnotationOperations.writes += 1;
    state.counters.maxConcurrentWrites = Math.max(
      state.counters.maxConcurrentWrites,
      state.activeAnnotationOperations.writes,
    );
  }
  let finished = false;
  return (successful = false) => {
    if (finished) return;
    finished = true;
    if (operation === 'annotation-serialization') {
      state.activeAnnotationOperations.serializations = Math.max(
        0,
        state.activeAnnotationOperations.serializations - 1,
      );
    } else if (operation === 'annotation-write') {
      state.activeAnnotationOperations.writes = Math.max(
        0,
        state.activeAnnotationOperations.writes - 1,
      );
    } else if (successful) {
      recordReaderPerformanceSample('annotationSaveMs', Math.max(0, now() - startedAt));
    }
  };
}

export function setReaderPdfjsVersion(version: string): void {
  currentState().versions.pdfjs = version;
}

export function recordSuccessfulAnnotationSave(): void {
  currentState().counters.annotationSaves += 1;
}

export function readerPerformanceSnapshot(): ReaderPerformanceSnapshot {
  const state = currentState();
  return {
    schemaVersion: 1,
    activationMs: state.activationMs,
    counters: { ...state.counters },
    samples: {
      annotationFilterMs: [...state.samples.annotationFilterMs],
      annotationSaveMs: [...state.samples.annotationSaveMs],
      annotationSearchMs: [...state.samples.annotationSearchMs],
      extractionBatchMs: [...state.samples.extractionBatchMs],
    },
    marks: state.marks.map((mark) => ({ ...mark })),
    versions: { ...state.versions },
  };
}

function currentState(): MutableReaderPerformanceState {
  const performanceHost = host();
  const existing = performanceHost.__abyssDocumentsPerformance;
  if (existing !== undefined) return existing;
  const created = emptyState();
  performanceHost.__abyssDocumentsPerformance = created;
  return created;
}

function host(): PerformanceHost {
  return window;
}

function now(): number {
  return window.performance.now();
}

function emptyState(): MutableReaderPerformanceState {
  return {
    schemaVersion: 1,
    activationInProgress: false,
    activationMs: null,
    activeAnnotationOperations: { serializations: 0, writes: 0 },
    counters: {
      annotationExtractionBatches: 0,
      annotationSaveFailures: 0,
      annotationSaveRecoveries: 0,
      annotationSaves: 0,
      blobsCreated: 0,
      firstTextLayers: 0,
      firstUsablePages: 0,
      gzipDecodes: 0,
      maxRenderedPagesDuringLongNavigation: 0,
      maxAnnotationCards: 0,
      maxAnnotationPanelNodes: 0,
      maxConcurrentSerializations: 0,
      maxConcurrentWrites: 0,
      pdfImports: 0,
      pdfRuntimeLoads: 0,
      pdfWorkDuringPluginOnload: 0,
      workerUrlsActive: 0,
      workersStarted: 0,
    },
    samples: {
      annotationFilterMs: [],
      annotationSaveMs: [],
      annotationSearchMs: [],
      extractionBatchMs: [],
    },
    marks: [],
    versions: { pdfjs: null, plugin: null },
  };
}
