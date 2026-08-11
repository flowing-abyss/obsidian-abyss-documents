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
  blobsCreated: number;
  firstTextLayers: number;
  firstUsablePages: number;
  gzipDecodes: number;
  maxRenderedPagesDuringLongNavigation: number;
  pdfImports: number;
  pdfRuntimeLoads: number;
  pdfWorkDuringPluginOnload: number;
  workerUrlsActive: number;
  workersStarted: number;
}

interface MutableReaderPerformanceState {
  schemaVersion: 1;
  activationInProgress: boolean;
  activationMs: number | null;
  counters: ReaderPerformanceCounters;
  marks: Array<{ name: ReaderPerformanceMark; startTime: number }>;
  versions: { plugin: string | null; pdfjs: string | null };
}

export interface ReaderPerformanceSnapshot {
  readonly schemaVersion: 1;
  readonly activationMs: number | null;
  readonly counters: Readonly<ReaderPerformanceCounters>;
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
  try {
    window.performance.mark(`abyss-documents:${name}`);
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

export function setReaderPdfjsVersion(version: string): void {
  currentState().versions.pdfjs = version;
}

export function readerPerformanceSnapshot(): ReaderPerformanceSnapshot {
  const state = currentState();
  return {
    schemaVersion: 1,
    activationMs: state.activationMs,
    counters: { ...state.counters },
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
    counters: {
      blobsCreated: 0,
      firstTextLayers: 0,
      firstUsablePages: 0,
      gzipDecodes: 0,
      maxRenderedPagesDuringLongNavigation: 0,
      pdfImports: 0,
      pdfRuntimeLoads: 0,
      pdfWorkDuringPluginOnload: 0,
      workerUrlsActive: 0,
      workersStarted: 0,
    },
    marks: [],
    versions: { pdfjs: null, plugin: null },
  };
}
