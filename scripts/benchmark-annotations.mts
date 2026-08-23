import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { PDF_FIXTURE_NAMES } from '../tests/fixtures/pdf-fixture-names.mjs';
import {
  readCurrentBuildVersions,
  requireMatchingBuildVersions,
} from './current-build-versions.mjs';
import {
  parseObsidianVersionEvidence,
  requireSuccessfulObsidianCliOutput,
} from './obsidian-version.mjs';

const execFileAsync = promisify(execFile);
const DESKTOP_SAVE_P95_MS = 2_000;
const ANDROID_SAVE_P95_MS = 4_000;
const FILTER_SEARCH_P95_MS = 100;
const EXTRACTION_BATCH_MAX_MS = 50;
const MAX_ANNOTATION_CARDS = 80;
const MAX_ANNOTATION_PANEL_NODES = 1_024;
const REQUIRED_ITERATIONS = 5;
const OBSIDIAN_CLI_TIMEOUT_MS = 10_000;

export function annotationCliExecOptions(timeoutMs = OBSIDIAN_CLI_TIMEOUT_MS) {
  return {
    killSignal: 'SIGKILL' as const,
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
  };
}

export interface AnnotationPluginRuntimeState {
  readonly activationEnd: number | null;
  readonly activationInProgress: boolean | null;
  readonly activationMs: number | null;
  readonly activationStart: number | null;
  readonly enabled: boolean;
  readonly leaves: number;
  readonly loaded: boolean;
  readonly workerUrlsActive: number | null;
}

export function isAnnotationPluginReady(
  state: AnnotationPluginRuntimeState,
  enabled: boolean,
  previousActivationStart: number | null = null,
): boolean {
  if (!enabled) {
    return !state.enabled && !state.loaded && state.leaves === 0 && state.workerUrlsActive === 0;
  }
  return (
    state.enabled &&
    state.loaded &&
    state.activationInProgress === false &&
    state.activationMs !== null &&
    Number.isFinite(state.activationMs) &&
    state.activationStart !== null &&
    state.activationEnd !== null &&
    state.activationEnd >= state.activationStart &&
    (previousActivationStart === null || state.activationStart !== previousActivationStart)
  );
}

export interface AnnotationBenchmarkSamples {
  readonly extractionBatchMs: readonly number[];
  readonly filterMs: readonly number[];
  readonly saveMs: readonly number[];
  readonly searchMs: readonly number[];
}

export interface AnnotationBenchmarkCounters {
  readonly annotationSaveFailures: number;
  readonly annotationSaveRecoveries: number;
  readonly externalNetworkAttempts: number;
  readonly maxAnnotationCards: number;
  readonly maxAnnotationPanelNodes: number;
  readonly maxConcurrentSerializations: number;
  readonly maxConcurrentWrites: number;
  readonly workerUrlsActiveAfterDisable: number;
  readonly workersStarted: number;
}

export interface AnnotationMemoryEvidence {
  readonly peakBytes: number | null;
  readonly recoverablePressureQualified: boolean;
  readonly source: 'performance.memory.usedJSHeapSize' | 'unavailable';
  readonly unavailableReason: string | null;
}

export type AnnotationBudgetInput =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly platform: 'android' | 'desktop';
      readonly memory: AnnotationMemoryEvidence;
      readonly samples: AnnotationBenchmarkSamples;
      readonly counters: AnnotationBenchmarkCounters;
    };

export interface AnnotationBenchmarkEvidence {
  readonly platform: 'android' | 'desktop';
  readonly environment: Record<string, unknown>;
  readonly fixtureHashes: Readonly<Record<string, string>>;
  readonly iterationCount: 5;
  readonly memory: AnnotationMemoryEvidence;
  readonly samples: AnnotationBenchmarkSamples;
  readonly counters: AnnotationBenchmarkCounters;
  readonly versions: { readonly obsidian: string; readonly pdfjs: string; readonly plugin: string };
}

export function summarizeAnnotationSamples(samples: readonly number[]): {
  readonly p50: number;
  readonly p95: number;
} {
  validateSamples('samples', samples);
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? Number.NaN,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN,
  };
}

export type AnnotationBudgetEvaluation =
  | { readonly status: 'unavailable'; readonly reason: string }
  | {
      readonly status: 'failed' | 'passed';
      readonly limits: {
        readonly extractionBatchMaxMs: 50;
        readonly filterP95Ms: 100;
        readonly maxAnnotationCards: 80;
        readonly maxAnnotationPanelNodes: 1_024;
        readonly maxConcurrentSerializations: 1;
        readonly maxConcurrentWrites: 1;
        readonly saveP95Ms: 2_000 | 4_000;
        readonly searchP95Ms: 100;
      };
      readonly summary: Readonly<
        Record<'extractionBatch' | 'filter' | 'save' | 'search', { p50: number; p95: number }>
      >;
    };

export function evaluateAnnotationBudget(input: AnnotationBudgetInput): AnnotationBudgetEvaluation {
  if (!input.available) return { status: 'unavailable' as const, reason: input.reason };
  validateMemoryEvidence(input.memory);
  validateSamples('samples.extractionBatchMs', input.samples.extractionBatchMs);
  validateSamples('samples.filterMs', input.samples.filterMs);
  validateSamples('samples.saveMs', input.samples.saveMs);
  validateSamples('samples.searchMs', input.samples.searchMs);
  const lengths = [
    input.samples.extractionBatchMs.length,
    input.samples.filterMs.length,
    input.samples.saveMs.length,
    input.samples.searchMs.length,
  ];
  if (lengths.some((length) => length !== REQUIRED_ITERATIONS)) {
    throw new Error(
      `Every annotation benchmark requires exactly ${REQUIRED_ITERATIONS} iterations.`,
    );
  }
  validateCounter('externalNetworkAttempts', input.counters.externalNetworkAttempts);
  validateCounter('annotationSaveFailures', input.counters.annotationSaveFailures);
  validateCounter('annotationSaveRecoveries', input.counters.annotationSaveRecoveries);
  validateCounter('maxAnnotationCards', input.counters.maxAnnotationCards);
  validateCounter('maxAnnotationPanelNodes', input.counters.maxAnnotationPanelNodes);
  validateCounter('maxConcurrentSerializations', input.counters.maxConcurrentSerializations);
  validateCounter('maxConcurrentWrites', input.counters.maxConcurrentWrites);
  validateCounter('workerUrlsActiveAfterDisable', input.counters.workerUrlsActiveAfterDisable);
  validateCounter('workersStarted', input.counters.workersStarted);
  const saveP95Ms = input.platform === 'android' ? ANDROID_SAVE_P95_MS : DESKTOP_SAVE_P95_MS;
  const summary = {
    extractionBatch: summarizeAnnotationSamples(input.samples.extractionBatchMs),
    filter: summarizeAnnotationSamples(input.samples.filterMs),
    save: summarizeAnnotationSamples(input.samples.saveMs),
    search: summarizeAnnotationSamples(input.samples.searchMs),
  };
  const passed =
    Math.max(...input.samples.extractionBatchMs) <= EXTRACTION_BATCH_MAX_MS &&
    summary.filter.p95 <= FILTER_SEARCH_P95_MS &&
    summary.save.p95 <= saveP95Ms &&
    summary.search.p95 <= FILTER_SEARCH_P95_MS &&
    input.counters.maxAnnotationCards <= MAX_ANNOTATION_CARDS &&
    input.counters.maxAnnotationPanelNodes <= MAX_ANNOTATION_PANEL_NODES &&
    input.counters.maxConcurrentSerializations === 1 &&
    input.counters.maxConcurrentWrites === 1 &&
    input.counters.workerUrlsActiveAfterDisable === 0 &&
    input.counters.workersStarted >= 1 &&
    input.counters.externalNetworkAttempts === 0 &&
    input.counters.annotationSaveFailures >= 1 &&
    input.counters.annotationSaveRecoveries >= 1 &&
    input.memory.recoverablePressureQualified;
  return {
    status: passed ? ('passed' as const) : ('failed' as const),
    limits: {
      extractionBatchMaxMs: EXTRACTION_BATCH_MAX_MS,
      filterP95Ms: FILTER_SEARCH_P95_MS,
      maxAnnotationCards: MAX_ANNOTATION_CARDS,
      maxAnnotationPanelNodes: MAX_ANNOTATION_PANEL_NODES,
      maxConcurrentSerializations: 1,
      maxConcurrentWrites: 1,
      saveP95Ms,
      searchP95Ms: FILTER_SEARCH_P95_MS,
    },
    summary,
  };
}

export function parseAnnotationBenchmarkInput(
  value: unknown,
  expectedPlatform: 'android' | 'desktop',
  expectedFixtureHashes?: Readonly<Record<string, string>>,
  expectedVersions?: Readonly<{ pdfjs: string; plugin: string }>,
): AnnotationBenchmarkEvidence {
  const root = requiredRecord(value, 'Annotation benchmark input');
  if (root['platform'] !== expectedPlatform) {
    throw new Error(`platform must be ${expectedPlatform}.`);
  }
  if (root['iterationCount'] !== REQUIRED_ITERATIONS) {
    throw new Error(`iterationCount must be exactly ${REQUIRED_ITERATIONS}.`);
  }
  const environment = requiredRecord(root['environment'], 'environment');
  requireText(environment['device'], 'environment.device');
  requireText(environment['os'], 'environment.os');
  const fixtureHashes = validateFixtureHashes(root['fixtureHashes']);
  if (expectedFixtureHashes !== undefined) {
    const currentFixtureHashes = validateFixtureHashes(expectedFixtureHashes);
    for (const name of PDF_FIXTURE_NAMES) {
      if (fixtureHashes[name]?.toLowerCase() !== currentFixtureHashes[name]?.toLowerCase()) {
        throw new Error(
          `fixtureHashes.${name} does not match the current fixture metadata. Regenerate or remeasure the portable Android sample.`,
        );
      }
    }
  }
  const sampleInput = requiredRecord(root['samples'], 'samples');
  const memory = validateMemoryEvidence(root['memory']);
  const samples = {
    extractionBatchMs: sampleArray(sampleInput['extractionBatchMs'], 'samples.extractionBatchMs'),
    filterMs: sampleArray(sampleInput['filterMs'], 'samples.filterMs'),
    saveMs: sampleArray(sampleInput['saveMs'], 'samples.saveMs'),
    searchMs: sampleArray(sampleInput['searchMs'], 'samples.searchMs'),
  };
  const counterInput = requiredRecord(root['counters'], 'counters');
  const counters = {
    annotationSaveFailures: counter(counterInput, 'annotationSaveFailures'),
    annotationSaveRecoveries: counter(counterInput, 'annotationSaveRecoveries'),
    externalNetworkAttempts: counter(counterInput, 'externalNetworkAttempts'),
    maxAnnotationCards: counter(counterInput, 'maxAnnotationCards'),
    maxAnnotationPanelNodes: counter(counterInput, 'maxAnnotationPanelNodes'),
    maxConcurrentSerializations: counter(counterInput, 'maxConcurrentSerializations'),
    maxConcurrentWrites: counter(counterInput, 'maxConcurrentWrites'),
    workerUrlsActiveAfterDisable: counter(counterInput, 'workerUrlsActiveAfterDisable'),
    workersStarted: counter(counterInput, 'workersStarted'),
  };
  const versionInput = requiredRecord(root['versions'], 'versions');
  const versions = {
    obsidian: parseObsidianVersionEvidence(
      requireText(versionInput['obsidian'], 'versions.obsidian'),
      '',
    ),
    pdfjs: requireText(versionInput['pdfjs'], 'versions.pdfjs'),
    plugin: requireText(versionInput['plugin'], 'versions.plugin'),
  };
  requireMatchingBuildVersions(versions, expectedVersions);
  return {
    platform: expectedPlatform,
    environment,
    fixtureHashes,
    iterationCount: REQUIRED_ITERATIONS,
    memory,
    samples,
    counters,
    versions,
  };
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const expectedPlatform = arguments_.includes('--platform=android') ? 'android' : 'desktop';
  const output = path.resolve(
    option(arguments_, '--output') ??
      `.superpowers/sdd/2026-08-11-annotation-editor-layout-controls/${expectedPlatform}-annotation-benchmark.json`,
  );
  await mkdir(path.dirname(output), { recursive: true });
  try {
    const evidence =
      expectedPlatform === 'android'
        ? await readPortableEvidence(option(arguments_, '--input'), expectedPlatform)
        : await measureDesktop();
    const evaluation = evaluateAnnotationBudget({
      available: true,
      counters: evidence.counters,
      memory: evidence.memory,
      platform: evidence.platform,
      samples: evidence.samples,
    });
    if (evaluation.status === 'unavailable') {
      throw new Error(evaluation.reason);
    }
    await writeFile(
      output,
      `${JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(), ...evidence, evaluation }, null, 2)}\n`,
    );
    console.info(
      `Annotation benchmark ${evaluation.status}: save p95 ${evaluation.summary.save.p95.toFixed(1)} ms; evidence: ${output}`,
    );
    if (evaluation.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    const unavailable = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      status: 'unavailable',
      reason: reason(error),
      environment: hardwareEnvironment(),
    };
    await writeFile(output, `${JSON.stringify(unavailable, null, 2)}\n`);
    console.info(`Annotation benchmark unavailable: ${unavailable.reason} Evidence: ${output}`);
    process.exitCode = 1;
  }
}

async function qualifyRecoverableAnnotationPressure(input: {
  readonly executable: string;
  readonly failuresBefore: number;
  readonly openedLeafId: string;
  readonly recoveriesBefore: number;
  readonly sampleHeap: () => Promise<void>;
  readonly vaultName: string;
  readonly workingPath: string;
}): Promise<number | null> {
  try {
    await waitFor(
      input.executable,
      input.vaultName,
      `(globalThis.__abyssDocumentsPerformance?.counters?.annotationSaveFailures??0)>=${String(input.failuresBefore + 1)}`,
      'Injected annotation save failure was not observed.',
      30_000,
    );
  } catch (cause) {
    const diagnostics = await evaluate(
      input.executable,
      input.vaultName,
      `JSON.stringify({counters:globalThis.__abyssDocumentsPerformance?.counters??null,pressureAttempts:globalThis.__abyssRecoverableMemoryPressure?.attempts??null,editor:!!document.querySelector('.highlightEditor'),notices:Array.from(document.querySelectorAll('.notice')).map(notice=>notice.textContent),tool:document.querySelector('[data-annotation-tool][aria-pressed="true"]')?.getAttribute('data-annotation-tool')??null})`,
    );
    throw new Error(`${reason(cause)} Diagnostics: ${diagnostics}`);
  }
  const pressure = requiredRecord(
    JSON.parse(
      await inspectRecoverableMemoryPressure(input.executable, input.vaultName),
    ) as unknown,
    'recoverable memory pressure state',
  );
  const pressuredPeak = pressure['peakBytes'];
  const peakBytes =
    typeof pressuredPeak === 'number' && Number.isFinite(pressuredPeak) ? pressuredPeak : null;
  const failuresAfter = (await performanceSnapshot(input.executable, input.vaultName)).counters
    .annotationSaveFailures;
  await evaluate(
    input.executable,
    input.vaultName,
    `(()=>{const state=globalThis.__abyssRecoverableMemoryPressure;if(!state)throw new Error('Recoverable pressure probe unavailable before Retry.');const matches=(${isNewRetryNoticeForAnnotationPath.toString()});const notice=Array.from(document.querySelectorAll('.notice')).find(candidate=>matches(candidate,state.notices,${JSON.stringify(input.workingPath)}));const retry=Array.from(notice?.querySelectorAll('button')??[]).find(button=>button.textContent?.trim()==='Retry');if(!(retry instanceof HTMLButtonElement))throw new Error('Product Retry action unavailable after save pressure.');retry.click();return true})()`,
  );
  await waitFor(
    input.executable,
    input.vaultName,
    `(globalThis.__abyssDocumentsPerformance?.counters?.annotationSaveRecoveries??0)>=${String(input.recoveriesBefore + 1)}`,
    'Product Retry did not recover the pressured annotation save.',
    30_000,
  );
  const recoveriesAfter = (await performanceSnapshot(input.executable, input.vaultName)).counters
    .annotationSaveRecoveries;
  const qualification = {
    attempts: pressure['attempts'],
    bytesUnchanged: pressure['bytesUnchanged'],
    failuresAfter,
    failuresBefore: input.failuresBefore,
    liveEditorPending: pressure['liveEditorPending'],
    recoveriesAfter,
    recoveriesBefore: input.recoveriesBefore,
  };
  if (!isRecoverableAnnotationPressureQualified(qualification)) {
    throw new Error(
      `Injected annotation save pressure did not qualify: ${JSON.stringify(qualification)}.`,
    );
  }
  await restoreRecoverableMemoryPressure(input.executable, input.vaultName);
  const reopenedLeafId = await evaluate(
    input.executable,
    input.vaultName,
    `(async()=>{const previousLeaf=app.workspace.getLeavesOfType('abyss-document-view').find(leaf=>String(leaf.id)===${JSON.stringify(input.openedLeafId)});const previousRoot=previousLeaf?.containerEl?.querySelector('[data-abyss-document]')??null;if(previousRoot===null)throw new Error('Prior annotation reader root unavailable.');globalThis.__abyssAnnotationBenchmarkPreviousRoot=previousRoot;for(const leaf of app.workspace.getLeavesOfType('abyss-document-view'))await leaf.setViewState({type:'empty',state:{}});const file=app.vault.getFileByPath(${JSON.stringify(input.workingPath)});if(!file)throw new Error('Recovered benchmark PDF unavailable.');const leaf=app.workspace.getLeaf(true);app.workspace.setActiveLeaf(leaf,{focus:true});await leaf.openFile(file);return String(leaf.id)})()`,
  );
  try {
    await waitFor(
      input.executable,
      input.vaultName,
      `(()=>{const ready=(${isAnnotationBenchmarkPageReady.toString()});const leaf=app.workspace.getLeavesOfType('abyss-document-view').find(candidate=>String(candidate.id)===${JSON.stringify(reopenedLeafId)});const root=leaf?.containerEl?.querySelector('[data-abyss-document]')??null;return ready({hasCanvas:Boolean(root?.querySelector('[data-page-number="1"] canvas')),hasErrorBoundary:Boolean(root?.querySelector('[data-reader-error]')),hasFreshReaderRoot:root!==globalThis.__abyssAnnotationBenchmarkPreviousRoot,hasReaderRoot:root!==null,leafId:String(leaf?.id??''),path:leaf?.getViewState()?.state?.file??null},${JSON.stringify(input.workingPath)},${JSON.stringify(reopenedLeafId)})})()`,
      'Recovered annotation PDF did not reopen to a usable page.',
      30_000,
    );
  } catch (cause) {
    const diagnostics = await evaluate(
      input.executable,
      input.vaultName,
      `JSON.stringify((()=>{const leaf=app.workspace.getLeavesOfType('abyss-document-view').find(candidate=>String(candidate.id)===${JSON.stringify(reopenedLeafId)});const root=leaf?.containerEl?.querySelector('[data-abyss-document]')??null;return{expectedLeafId:${JSON.stringify(reopenedLeafId)},actualLeafIds:app.workspace.getLeavesOfType('abyss-document-view').map(candidate=>String(candidate.id)),hasCanvas:Boolean(root?.querySelector('[data-page-number="1"] canvas')),hasErrorBoundary:Boolean(root?.querySelector('[data-reader-error]')),hasFreshReaderRoot:root!==globalThis.__abyssAnnotationBenchmarkPreviousRoot,hasReaderRoot:root!==null,path:leaf?.getViewState()?.state?.file??null}})())`,
    );
    throw new Error(`${reason(cause)} Diagnostics: ${diagnostics}`);
  }
  await evaluate(
    input.executable,
    input.vaultName,
    `(()=>{delete globalThis.__abyssAnnotationBenchmarkPreviousRoot;return true})()`,
  );
  await evaluate(
    input.executable,
    input.vaultName,
    `(()=>{document.querySelector('[data-control="sidebar"]')?.click();document.querySelector('[data-tab="annotations"]')?.click();return true})()`,
  );
  await waitFor(
    input.executable,
    input.vaultName,
    `document.querySelector('[data-sidebar-panel="annotations"]')?.textContent?.includes('10001 annotations')===true`,
    'Recovered annotation did not reindex from verified PDF bytes.',
    30_000,
  );
  await input.sampleHeap();
  return peakBytes;
}

async function measureDesktop(): Promise<AnnotationBenchmarkEvidence> {
  const executable = process.env['ABYSS_OBSIDIAN_CLI'] ?? 'obsidian';
  const vaultName = 'dev-documents-vault';
  const obsidianVersion = await readObsidianVersion(executable, vaultName);
  await execFileAsync('pnpm', ['dev:vault', '--', '--no-launch'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    killSignal: 'SIGKILL',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await waitFor(
    executable,
    vaultName,
    `Boolean(app?.plugins)`,
    'Obsidian CLI readiness probe failed.',
  );
  await evaluate(
    executable,
    vaultName,
    `(async()=>{await app.plugins.setEnable(true);return true})()`,
  );

  const fixtureManifest = JSON.parse(
    await readFile(
      path.resolve(
        import.meta.dirname,
        '..',
        'dev-documents-vault',
        'Documents',
        'fixtures.v1.json',
      ),
      'utf8',
    ),
  ) as { readonly files: ReadonlyArray<{ readonly name: string; readonly sha256: string }> };
  const fixtureHashes = validateFixtureHashes(
    Object.fromEntries(fixtureManifest.files.map(({ name, sha256 }) => [name, sha256])),
  );
  const samples: {
    extractionBatchMs: number[];
    filterMs: number[];
    saveMs: number[];
    searchMs: number[];
  } = {
    extractionBatchMs: [],
    filterMs: [],
    saveMs: [],
    searchMs: [],
  };
  const maxima = {
    annotationSaveFailures: 0,
    annotationSaveRecoveries: 0,
    maxAnnotationCards: 0,
    maxAnnotationPanelNodes: 0,
    maxConcurrentSerializations: 0,
    maxConcurrentWrites: 0,
    workersStarted: 0,
  };
  let externalNetworkAttempts = 0;
  let peakMemoryBytes: number | null = null;
  let memoryUnavailableReason: string | null = null;
  let recoverablePressureQualified = false;
  let pressureBaseline: {
    readonly failuresBefore: number;
    readonly recoveriesBefore: number;
  } | null = null;
  let workerUrlsActiveAfterDisable = 0;
  let versions: AnnotationBenchmarkEvidence['versions'] | null = null;
  const sampleHeap = async (): Promise<void> => {
    const memory = await rendererHeapSample(executable, vaultName);
    if (memory.bytes === null) memoryUnavailableReason ??= memory.reason;
    else peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, memory.bytes);
  };
  await sampleHeap();

  try {
    for (let iteration = 0; iteration < REQUIRED_ITERATIONS; iteration += 1) {
      await setPluginEnabled(executable, vaultName, false);
      await setPluginEnabled(executable, vaultName, true);
      await installNetworkProbe(executable, vaultName);
      const workingPath = `Documents/annotation-benchmark-${iteration + 1}.pdf`;
      const openedLeafId = await evaluate(
        executable,
        vaultName,
        `(async()=>{for(const leaf of app.workspace.getLeavesOfType('abyss-document-view'))await leaf.setViewState({type:'empty',state:{}});const bytes=await app.vault.adapter.readBinary('Documents/annotations-10000.pdf');const path=${JSON.stringify(workingPath)};const existing=app.vault.getFileByPath(path);if(existing)await app.vault.modifyBinary(existing,bytes);else await app.vault.createBinary(path,bytes);const file=app.vault.getFileByPath(path);if(!file)throw new Error('Annotation benchmark PDF unavailable.');const leaf=app.workspace.getLeaf(true);app.workspace.setActiveLeaf(leaf,{focus:true});await leaf.openFile(file);return String(leaf.id)})()`,
      );
      await waitFor(
        executable,
        vaultName,
        `(()=>{const ready=(${isAnnotationBenchmarkPageReady.toString()});const leaf=app.workspace.getMostRecentLeaf();const root=leaf?.containerEl?.querySelector('[data-abyss-document]')??null;return ready({hasCanvas:Boolean(root?.querySelector('[data-page-number="1"] canvas')),hasErrorBoundary:Boolean(root?.querySelector('[data-reader-error]')),hasFreshReaderRoot:true,hasReaderRoot:root!==null,leafId:String(leaf?.id??''),path:leaf?.getViewState()?.state?.file??null},${JSON.stringify(workingPath)},${JSON.stringify(openedLeafId)})})()`,
        'First annotation benchmark page did not become usable.',
      );
      await waitFor(
        executable,
        vaultName,
        `(globalThis.__abyssDocumentsPerformance?.counters?.firstUsablePages??0)>=1`,
        'First annotation benchmark page did not emit a usable-page measurement.',
      );
      await sampleHeap();
      await evaluate(
        executable,
        vaultName,
        `(()=>{document.querySelector('[data-control="sidebar"]')?.click();document.querySelector('[data-tab="annotations"]')?.click();return true})()`,
      );
      await waitFor(
        executable,
        vaultName,
        `document.querySelector('[data-sidebar-panel="annotations"]')?.textContent?.includes('10000 annotations')===true`,
        'Ten-thousand-annotation extraction did not complete.',
        30_000,
      );
      await sampleHeap();
      if (iteration === 0) {
        const baselineSnapshot = await performanceSnapshot(executable, vaultName);
        pressureBaseline = {
          failuresBefore: baselineSnapshot.counters.annotationSaveFailures,
          recoveriesBefore: baselineSnapshot.counters.annotationSaveRecoveries,
        };
        await installRecoverableMemoryPressure(executable, vaultName, workingPath);
      }
      await evaluate(
        executable,
        vaultName,
        `(()=>{const input=document.querySelector('[data-annotation-search]');if(!(input instanceof HTMLInputElement))throw new Error('Annotation search input unavailable.');input.value='Annotation 07500';input.dispatchEvent(new Event('input',{bubbles:true}));input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));const color=document.querySelector('[data-sidebar-panel="annotations"] input[data-annotation-color]');if(!(color instanceof HTMLInputElement))throw new Error('Annotation color facet unavailable.');color.click();const details=document.querySelector('.abyss-reader-annotations details');if(!(details instanceof HTMLDetailsElement))throw new Error('Annotation tag facets unavailable.');details.open=true;details.dispatchEvent(new Event('toggle'));const tag=document.querySelector('[data-annotation-tag="topic-0"]');if(!(tag instanceof HTMLInputElement))throw new Error('Annotation tag facet unavailable.');tag.click();document.querySelector('[data-control="sidebar"]')?.click();return true})()`,
      );
      await sampleHeap();
      await evaluate(
        executable,
        vaultName,
        `(()=>{const tool=document.querySelector('[data-annotation-tool="highlight"]');if(!(tool instanceof HTMLButtonElement))throw new Error('Highlight benchmark tool unavailable.');tool.click();return true})()`,
      );
      await waitFor(
        executable,
        vaultName,
        `document.querySelector('[data-annotation-tool="highlight"]')?.getAttribute('aria-pressed')==='true'`,
        'Highlight benchmark tool did not become active.',
      );
      await waitFor(
        executable,
        vaultName,
        `(()=>{const ready=(${isSelectableAnnotationBenchmarkPageReady.toString()});const leaf=app.workspace.getMostRecentLeaf();const root=leaf?.containerEl?.querySelector('[data-abyss-document]')??null;const textLayer=root?.querySelector('[data-page-number="1"] .textLayer')??null;const manager=leaf?.view?.controller?.viewport?.annotationEditorInstance?.manager;return ready({hasEditorLayer:Boolean(textLayer&&manager?.currentLayer?.hasTextLayer?.(textLayer)),hasErrorBoundary:Boolean(root?.querySelector('[data-reader-error]')),leafId:String(leaf?.id??''),path:leaf?.getViewState()?.state?.file??null,textCount:root?.querySelectorAll('[data-page-number="1"] .textLayer span').length??0},${JSON.stringify(workingPath)},${JSON.stringify(openedLeafId)})})()`,
        'Selectable benchmark text did not become ready.',
      );
      const annotationStorageBaseline = Number(
        await evaluate(
          executable,
          vaultName,
          `app.workspace.getMostRecentLeaf()?.view?.controller?.viewport?.annotationEditorInstance?.storage?.size??-1`,
        ),
      );
      validateCounter('annotationStorageBaseline', annotationStorageBaseline);
      await runAmbiguousMutation(
        executable,
        vaultName,
        `(()=>{const leaf=app.workspace.getMostRecentLeaf();const root=leaf?.containerEl?.querySelector('[data-abyss-document]');const text=root?.querySelectorAll('[data-page-number="1"] .textLayer span')[1];if(!(text instanceof Node))throw new Error('Selectable benchmark text unavailable.');const textLayer=text.parentElement?.closest('.textLayer')??null;const manager=leaf?.view?.controller?.viewport?.annotationEditorInstance?.manager;if(!textLayer||manager?.currentLayer?.hasTextLayer?.(textLayer)!==true)throw new Error('PDF.js current annotation layer is not bound to selectable benchmark text.');if(typeof manager.highlightSelection!=='function')throw new Error('PDF.js native highlight API is unavailable.');const range=document.createRange();range.selectNodeContents(text);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);manager.highlightSelection('benchmark');return true})()`,
      );
      await waitFor(
        executable,
        vaultName,
        `(${hasNativeAnnotationStorageGrowth.toString()})(app.workspace.getMostRecentLeaf()?.view?.controller?.viewport?.annotationEditorInstance?.storage?.size,${String(annotationStorageBaseline)})`,
        'Native highlight creation did not grow PDF.js annotation storage.',
      );
      await sampleHeap();
      if (iteration === 0) {
        if (pressureBaseline === null) {
          throw new Error('Annotation pressure baseline counters are unavailable.');
        }
        const pressuredPeak = await qualifyRecoverableAnnotationPressure({
          executable,
          failuresBefore: pressureBaseline.failuresBefore,
          openedLeafId,
          recoveriesBefore: pressureBaseline.recoveriesBefore,
          sampleHeap,
          vaultName,
          workingPath,
        });
        if (pressuredPeak !== null) {
          peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, pressuredPeak);
        }
        recoverablePressureQualified = true;
      } else {
        await waitFor(
          executable,
          vaultName,
          `(globalThis.__abyssDocumentsPerformance?.counters?.annotationSaves??0)>=1`,
          'Annotation benchmark save did not complete.',
          30_000,
        );
      }
      const snapshot = await performanceSnapshot(executable, vaultName);
      await sampleHeap();
      const extraction = snapshot.samples.extractionBatchMs;
      samples.extractionBatchMs.push(Math.max(...extraction));
      samples.filterMs.push(requiredLast(snapshot.samples.annotationFilterMs, 'filter'));
      samples.saveMs.push(requiredLast(snapshot.samples.annotationSaveMs, 'save'));
      samples.searchMs.push(requiredLast(snapshot.samples.annotationSearchMs, 'search'));
      maxima.maxAnnotationCards = Math.max(
        maxima.maxAnnotationCards,
        snapshot.counters.maxAnnotationCards,
      );
      maxima.maxAnnotationPanelNodes = Math.max(
        maxima.maxAnnotationPanelNodes,
        snapshot.counters.maxAnnotationPanelNodes,
      );
      maxima.annotationSaveFailures = Math.max(
        maxima.annotationSaveFailures,
        snapshot.counters.annotationSaveFailures,
      );
      maxima.annotationSaveRecoveries = Math.max(
        maxima.annotationSaveRecoveries,
        snapshot.counters.annotationSaveRecoveries,
      );
      maxima.maxConcurrentSerializations = Math.max(
        maxima.maxConcurrentSerializations,
        snapshot.counters.maxConcurrentSerializations,
      );
      maxima.maxConcurrentWrites = Math.max(
        maxima.maxConcurrentWrites,
        snapshot.counters.maxConcurrentWrites,
      );
      maxima.workersStarted = Math.max(maxima.workersStarted, snapshot.counters.workersStarted);
      versions ??= {
        obsidian: obsidianVersion,
        pdfjs: requireText(snapshot.versions.pdfjs, 'runtime versions.pdfjs'),
        plugin: requireText(snapshot.versions.plugin, 'runtime versions.plugin'),
      };
      externalNetworkAttempts += await removeNetworkProbe(executable, vaultName);
      await evaluate(
        executable,
        vaultName,
        `(async()=>{for(const leaf of app.workspace.getLeavesOfType('abyss-document-view'))await leaf.setViewState({type:'empty',state:{}});return true})()`,
      );
      await setPluginEnabled(executable, vaultName, false);
      await waitFor(
        executable,
        vaultName,
        `(globalThis.__abyssDocumentsPerformance?.counters?.workerUrlsActive??-1)===0`,
        'PDF worker URL remained active after plugin disable.',
      );
      const disabled = await performanceSnapshot(executable, vaultName);
      workerUrlsActiveAfterDisable = Math.max(
        workerUrlsActiveAfterDisable,
        disabled.counters.workerUrlsActive,
      );
    }
  } finally {
    await restoreRecoverableMemoryPressure(executable, vaultName).catch(() => undefined);
    await evaluate(
      executable,
      vaultName,
      `(()=>{delete globalThis.__abyssAnnotationBenchmarkPreviousRoot;return true})()`,
    ).catch(() => undefined);
    await removeNetworkProbe(executable, vaultName).catch(() => 0);
    await setPluginEnabled(executable, vaultName, true).catch(() => undefined);
  }
  if (versions === null) throw new Error('No desktop annotation benchmark iteration completed.');
  return {
    platform: 'desktop',
    environment: { device: cpus()[0]?.model ?? 'unknown', os: `${platform()} ${release()}` },
    fixtureHashes,
    iterationCount: REQUIRED_ITERATIONS,
    memory: {
      peakBytes: peakMemoryBytes,
      recoverablePressureQualified,
      source: peakMemoryBytes === null ? 'unavailable' : 'performance.memory.usedJSHeapSize',
      unavailableReason: peakMemoryBytes === null ? memoryUnavailableReason : null,
    },
    samples,
    counters: {
      annotationSaveFailures: maxima.annotationSaveFailures,
      annotationSaveRecoveries: maxima.annotationSaveRecoveries,
      externalNetworkAttempts,
      maxAnnotationCards: maxima.maxAnnotationCards,
      maxAnnotationPanelNodes: maxima.maxAnnotationPanelNodes,
      maxConcurrentSerializations: maxima.maxConcurrentSerializations,
      maxConcurrentWrites: maxima.maxConcurrentWrites,
      workerUrlsActiveAfterDisable,
      workersStarted: maxima.workersStarted,
    },
    versions,
  };
}

async function installRecoverableMemoryPressure(
  executable: string,
  vaultName: string,
  path: string,
): Promise<void> {
  await evaluate(
    executable,
    vaultName,
    `(async()=>{const h=globalThis;if(h.__abyssRecoverableMemoryPressure)throw new Error('Recoverable pressure probe already installed.');const path=${JSON.stringify(path)};const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');const before=await app.vault.adapter.readBinary(path);const original=app.vault.modifyBinary;const shouldInject=(${shouldInjectAnnotationBufferPressure.toString()});const state={attempts:0,beforeHash:await digest(before),interval:0,notices:new Set(document.querySelectorAll('.notice')),original,path,peakBytes:null};const sample=()=>{const value=performance.memory?.usedJSHeapSize;if(typeof value==='number'&&Number.isFinite(value))state.peakBytes=Math.max(state.peakBytes??0,value)};state.interval=setInterval(sample,10);sample();h.__abyssRecoverableMemoryPressure=state;app.vault.modifyBinary=async function(file,data,options){if(state.attempts===0&&shouldInject(data)){state.attempts+=1;sample();throw new RangeError('One-shot renderer allocation pressure at PDF vault transfer.')}return Reflect.apply(original,this,arguments)};return true})()`,
  );
}

export function shouldInjectAnnotationBufferPressure(source: unknown): boolean {
  return source instanceof ArrayBuffer && source.byteLength >= 1_000_000;
}

export function hasNativeAnnotationStorageGrowth(current: unknown, baseline: number): boolean {
  return (
    typeof current === 'number' &&
    Number.isSafeInteger(current) &&
    current >= 0 &&
    Number.isSafeInteger(baseline) &&
    baseline >= 0 &&
    current > baseline
  );
}

export function isRecoverableAnnotationPressureQualified(input: {
  readonly attempts: unknown;
  readonly bytesUnchanged: unknown;
  readonly failuresAfter: number;
  readonly failuresBefore: number;
  readonly liveEditorPending: unknown;
  readonly recoveriesAfter: number;
  readonly recoveriesBefore: number;
}): boolean {
  return (
    input.attempts === 1 &&
    input.bytesUnchanged === true &&
    input.liveEditorPending === true &&
    input.failuresAfter === input.failuresBefore + 1 &&
    input.recoveriesAfter === input.recoveriesBefore + 1
  );
}

export function isRetryNoticeForAnnotationPath(
  text: string | null | undefined,
  expectedPath: string,
): boolean {
  return typeof text === 'string' && text.trim().endsWith(`${expectedPath} Retry`);
}

export function isNewRetryNoticeForAnnotationPath(
  candidate: { readonly textContent?: string | null },
  existing: ReadonlySet<object>,
  expectedPath: string,
): boolean {
  const text = candidate.textContent;
  return (
    !existing.has(candidate) &&
    typeof text === 'string' &&
    text.trim().endsWith(`${expectedPath} Retry`)
  );
}

export function isAnnotationBenchmarkPageReady(
  status: {
    readonly hasCanvas: boolean;
    readonly hasErrorBoundary: boolean;
    readonly hasFreshReaderRoot: boolean;
    readonly hasReaderRoot: boolean;
    readonly leafId: string;
    readonly path: unknown;
  },
  expectedPath: string,
  expectedLeafId: string,
): boolean {
  const actualPath =
    typeof status.path === 'string'
      ? status.path
          .replaceAll('\\', '/')
          .split('/')
          .filter((segment) => segment.length > 0)
          .join('/')
          .normalize('NFC')
      : null;
  const normalizedExpectedPath = expectedPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/')
    .normalize('NFC');
  return (
    status.hasCanvas &&
    !status.hasErrorBoundary &&
    status.hasFreshReaderRoot &&
    status.hasReaderRoot &&
    status.leafId === expectedLeafId &&
    actualPath === normalizedExpectedPath
  );
}

export function isSelectableAnnotationBenchmarkPageReady(
  status: {
    readonly hasEditorLayer: boolean;
    readonly hasErrorBoundary: boolean;
    readonly leafId: string;
    readonly path: unknown;
    readonly textCount: number;
  },
  expectedPath: string,
  expectedLeafId: string,
): boolean {
  const actualPath =
    typeof status.path === 'string'
      ? status.path
          .replaceAll('\\', '/')
          .split('/')
          .filter((segment) => segment.length > 0)
          .join('/')
          .normalize('NFC')
      : null;
  const normalizedExpectedPath = expectedPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/')
    .normalize('NFC');
  return (
    status.hasEditorLayer &&
    !status.hasErrorBoundary &&
    status.leafId === expectedLeafId &&
    actualPath === normalizedExpectedPath &&
    status.textCount >= 2
  );
}

async function inspectRecoverableMemoryPressure(
  executable: string,
  vaultName: string,
): Promise<string> {
  return evaluateProbe(
    executable,
    vaultName,
    `(async()=>{const state=globalThis.__abyssRecoverableMemoryPressure;if(!state)throw new Error('Recoverable pressure probe unavailable.');const bytes=await app.vault.adapter.readBinary(state.path);const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');return JSON.stringify({attempts:state.attempts,bytesUnchanged:hash===state.beforeHash,liveEditorPending:document.querySelector('.highlightEditor')!==null,peakBytes:state.peakBytes})})()`,
  );
}

async function restoreRecoverableMemoryPressure(
  executable: string,
  vaultName: string,
): Promise<void> {
  await evaluate(
    executable,
    vaultName,
    `(()=>{const h=globalThis,state=h.__abyssRecoverableMemoryPressure;if(!state)return false;clearInterval(state.interval);app.vault.modifyBinary=state.original;delete h.__abyssRecoverableMemoryPressure;return true})()`,
  );
}

async function rendererHeapSample(
  executable: string,
  vaultName: string,
): Promise<{ readonly bytes: number | null; readonly reason: string }> {
  const output = await evaluateProbe(
    executable,
    vaultName,
    `JSON.stringify((()=>{const memory=performance.memory;const bytes=memory&&typeof memory.usedJSHeapSize==='number'&&Number.isFinite(memory.usedJSHeapSize)?memory.usedJSHeapSize:null;return{bytes,reason:bytes===null?'performance.memory.usedJSHeapSize is unavailable in this renderer.':''}})())`,
  );
  const value = requiredRecord(JSON.parse(output), 'renderer heap sample');
  const bytes = value['bytes'];
  if (bytes !== null && (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0)) {
    throw new Error('renderer heap sample.bytes must be finite non-negative or null.');
  }
  const reasonText = value['reason'];
  if (typeof reasonText !== 'string') throw new Error('renderer heap sample.reason must be text.');
  return { bytes, reason: reasonText };
}

interface LivePerformanceSnapshot {
  readonly counters: AnnotationBenchmarkCounters & { readonly workerUrlsActive: number };
  readonly samples: {
    readonly annotationFilterMs: readonly number[];
    readonly annotationSaveMs: readonly number[];
    readonly annotationSearchMs: readonly number[];
    readonly extractionBatchMs: readonly number[];
  };
  readonly versions: { readonly pdfjs: string | null; readonly plugin: string | null };
}

async function performanceSnapshot(
  executable: string,
  vaultName: string,
): Promise<LivePerformanceSnapshot> {
  const value = JSON.parse(
    await evaluateProbe(
      executable,
      vaultName,
      `JSON.stringify(globalThis.__abyssDocumentsPerformance??null)`,
    ),
  ) as LivePerformanceSnapshot | null;
  if (value === null) throw new Error('Reader instrumentation is unavailable in Obsidian.');
  return value;
}

async function waitFor(
  executable: string,
  vaultName: string,
  expression: string,
  failure: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastProbeTimeout = false;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(250, deadline - Date.now());
    try {
      if (
        (await evaluate(
          executable,
          vaultName,
          `Boolean(${expression})`,
          Math.min(OBSIDIAN_CLI_TIMEOUT_MS, remainingMs),
        )) === 'true'
      )
        return;
      lastProbeTimeout = false;
    } catch (error) {
      if (!isObsidianCliTimeout(error)) throw error;
      lastProbeTimeout = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${failure} Timed out after ${timeoutMs}ms.${lastProbeTimeout ? ' The last Obsidian CLI probe also timed out.' : ''}`,
  );
}

async function evaluate(
  executable: string,
  vaultName: string,
  code: string,
  timeoutMs = OBSIDIAN_CLI_TIMEOUT_MS,
): Promise<string> {
  const output = await cli(executable, vaultName, ['eval', `code=${code}`], timeoutMs);
  return parseObsidianEvalOutput(output);
}

async function runAmbiguousMutation(
  executable: string,
  vaultName: string,
  code: string,
): Promise<void> {
  try {
    await evaluate(executable, vaultName, code);
  } catch (error) {
    if (!isObsidianCliTimeout(error)) throw error;
  }
}

export function isObsidianCliTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as Record<string, unknown>;
  return failure['code'] === null && failure['killed'] === true && failure['signal'] === 'SIGKILL';
}

export async function retryObsidianCliProbe<T>(
  operation: (commandTimeoutMs: number) => Promise<T>,
  timeoutMs = 30_000,
  delay: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 200)),
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastTimeout: unknown = new Error('Obsidian CLI probe did not start.');
  while (Date.now() < deadline) {
    const remainingMs = Math.max(250, deadline - Date.now());
    try {
      return await operation(Math.min(OBSIDIAN_CLI_TIMEOUT_MS, remainingMs));
    } catch (error) {
      if (!isObsidianCliTimeout(error)) throw error;
      lastTimeout = error;
    }
    if (Date.now() < deadline) await delay();
  }
  throw lastTimeout;
}

async function evaluateProbe(
  executable: string,
  vaultName: string,
  code: string,
  timeoutMs = 30_000,
): Promise<string> {
  return retryObsidianCliProbe(
    (commandTimeoutMs) => evaluate(executable, vaultName, code, commandTimeoutMs),
    timeoutMs,
  );
}

export function parseObsidianEvalOutput(output: string): string {
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith('=> ')) return line.slice(3).trim();
  }
  return output;
}

async function cli(
  executable: string,
  vaultName: string,
  arguments_: string[],
  timeoutMs = OBSIDIAN_CLI_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync(executable, [`vault=${vaultName}`, ...arguments_], {
    ...annotationCliExecOptions(timeoutMs),
  });
  return requireSuccessfulObsidianCliOutput(stdout);
}

async function readObsidianVersion(executable: string, vaultName: string): Promise<string> {
  const documentedOutput = await cli(executable, vaultName, ['version'], 5_000).catch(() => '');
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(documentedOutput.trim())) {
    return parseObsidianVersionEvidence(documentedOutput, '');
  }
  const rendererUserAgent = await evaluate(executable, vaultName, 'navigator.userAgent');
  return parseObsidianVersionEvidence(documentedOutput, rendererUserAgent);
}

async function setPluginEnabled(
  executable: string,
  vaultName: string,
  enabled: boolean,
): Promise<void> {
  const before = await readAnnotationPluginRuntimeState(executable, vaultName);
  let commandFailure: Error | null = null;
  try {
    await cli(executable, vaultName, [
      enabled ? 'plugin:enable' : 'plugin:disable',
      'id=abyss-documents',
    ]);
  } catch (error) {
    commandFailure = error instanceof Error ? error : new Error(String(error));
  }
  try {
    await waitForAnnotationPluginState(
      executable,
      vaultName,
      enabled,
      before.activationStart,
      OBSIDIAN_CLI_TIMEOUT_MS,
    );
  } catch (stateError) {
    if (commandFailure === null) throw stateError;
    throw new Error(
      `Obsidian CLI plugin command did not return and its effect was not observed: ${commandFailure.message}; ${reason(stateError)}`,
    );
  }
}

async function waitForAnnotationPluginState(
  executable: string,
  vaultName: string,
  enabled: boolean,
  previousActivationStart: number | null,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: AnnotationPluginRuntimeState | null = null;
  while (Date.now() < deadline) {
    lastState = await readAnnotationPluginRuntimeState(executable, vaultName);
    if (isAnnotationPluginReady(lastState, enabled, previousActivationStart)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Plugin abyss-documents did not reach enabled=${String(enabled)} after ${timeoutMs}ms; ` +
      `last state: ${JSON.stringify(lastState)}.`,
  );
}

async function readAnnotationPluginRuntimeState(
  executable: string,
  vaultName: string,
): Promise<AnnotationPluginRuntimeState> {
  const output = await evaluate(
    executable,
    vaultName,
    `JSON.stringify((()=>{const p=globalThis.__abyssDocumentsPerformance,m=p?.marks??[];return{enabled:app.plugins.enabledPlugins.has('abyss-documents'),loaded:Boolean(app.plugins.plugins['abyss-documents']),leaves:app.workspace.getLeavesOfType('abyss-document-view').length,workerUrlsActive:p?.counters?.workerUrlsActive??null,activationInProgress:p?.activationInProgress??null,activationMs:p?.activationMs??null,activationStart:m.find(v=>v.name==='plugin-activation-start')?.startTime??null,activationEnd:[...m].reverse().find(v=>v.name==='plugin-activation-end')?.startTime??null}})())`,
  );
  const value = JSON.parse(output) as unknown;
  const state = requiredRecord(value, 'annotation plugin runtime state');
  const optionalNumber = (name: string): number | null => {
    const candidate = state[name];
    if (candidate === null) return null;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new Error(`annotation plugin runtime state.${name} must be finite or null.`);
    }
    return candidate;
  };
  if (
    typeof state['enabled'] !== 'boolean' ||
    typeof state['loaded'] !== 'boolean' ||
    !Number.isSafeInteger(state['leaves']) ||
    (state['activationInProgress'] !== null && typeof state['activationInProgress'] !== 'boolean')
  ) {
    throw new Error('annotation plugin runtime state has invalid fields.');
  }
  return {
    activationEnd: optionalNumber('activationEnd'),
    activationInProgress: state['activationInProgress'],
    activationMs: optionalNumber('activationMs'),
    activationStart: optionalNumber('activationStart'),
    enabled: state['enabled'],
    leaves: state['leaves'],
    loaded: state['loaded'],
    workerUrlsActive: optionalNumber('workerUrlsActive'),
  } as AnnotationPluginRuntimeState;
}

async function installNetworkProbe(executable: string, vaultName: string): Promise<void> {
  await evaluate(
    executable,
    vaultName,
    `(()=>{const h=globalThis;if(h.__abyssAnnotationNetworkProbe)return;const p={attempts:0,fetch:h.fetch,xhr:XMLHttpRequest.prototype.open,webSocket:h.WebSocket,eventSource:h.EventSource,beacon:navigator.sendBeacon};h.__abyssAnnotationNetworkProbe=p;const local=v=>['app:','blob:','data:','file:'].includes(new URL(String(v),location.href).protocol);h.fetch=(input,...rest)=>{const url=input instanceof Request?input.url:String(input);if(!local(url))p.attempts+=1;return p.fetch(input,...rest)};XMLHttpRequest.prototype.open=function(method,url,...rest){if(!local(url))p.attempts+=1;return p.xhr.call(this,method,url,...rest)};h.WebSocket=new Proxy(p.webSocket,{construct(t,a,n){if(!local(a[0]))p.attempts+=1;return Reflect.construct(t,a,n)}});h.EventSource=new Proxy(p.eventSource,{construct(t,a,n){if(!local(a[0]))p.attempts+=1;return Reflect.construct(t,a,n)}});navigator.sendBeacon=(url,data)=>{if(!local(url))p.attempts+=1;return p.beacon.call(navigator,url,data)};return true})()`,
  );
}

async function removeNetworkProbe(executable: string, vaultName: string): Promise<number> {
  const output = await evaluate(
    executable,
    vaultName,
    `(()=>{const h=globalThis,p=h.__abyssAnnotationNetworkProbe;if(!p)return 0;h.fetch=p.fetch;XMLHttpRequest.prototype.open=p.xhr;h.WebSocket=p.webSocket;h.EventSource=p.eventSource;navigator.sendBeacon=p.beacon;delete h.__abyssAnnotationNetworkProbe;return p.attempts})()`,
  );
  const value = Number(output);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid network probe count.');
  return value;
}

function requiredLast(samples: readonly number[], name: string): number {
  const value = samples[samples.length - 1];
  if (value === undefined) throw new Error(`Missing retained ${name} measurement.`);
  return value;
}

async function readPortableEvidence(
  input: string | undefined,
  platformName: 'android' | 'desktop',
): Promise<AnnotationBenchmarkEvidence> {
  if (input === undefined) throw new Error('Android benchmark requires --input=<path>.');
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const manifest = requiredRecord(
    JSON.parse(
      await readFile(
        path.join(repoRoot, 'dev-documents-vault', 'Documents', 'fixtures.v1.json'),
        'utf8',
      ),
    ),
    'current fixture manifest',
  );
  const files = manifest['files'];
  if (!Array.isArray(files)) throw new Error('current fixture manifest.files must be an array.');
  const expectedFixtureHashes = Object.fromEntries(
    files.map((entry, index) => {
      const metadata = requiredRecord(entry, `current fixture manifest.files[${index}]`);
      return [
        requireText(metadata['name'], `current fixture manifest.files[${index}].name`),
        requireText(metadata['sha256'], `current fixture manifest.files[${index}].sha256`),
      ];
    }),
  );
  return parseAnnotationBenchmarkInput(
    JSON.parse(await readFile(path.resolve(input), 'utf8')),
    platformName,
    expectedFixtureHashes,
    await readCurrentBuildVersions(repoRoot),
  );
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = arguments_.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function sampleArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  validateSamples(name, value);
  if (value.length !== REQUIRED_ITERATIONS) {
    throw new Error(`${name} must contain exactly ${REQUIRED_ITERATIONS} samples.`);
  }
  return value as number[];
}

function validateSamples(name: string, samples: readonly unknown[]): void {
  if (samples.length === 0) throw new Error(`${name} cannot be empty.`);
  if (
    !samples.every((sample) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0)
  ) {
    throw new Error(`${name} samples must be finite non-negative numbers.`);
  }
}

function counter(input: Record<string, unknown>, name: keyof AnnotationBenchmarkCounters): number {
  const value = input[name];
  validateCounter(name, value);
  return value as number;
}

function validateCounter(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`counters.${name} must be a non-negative integer.`);
  }
}

function validateMemoryEvidence(value: unknown): AnnotationMemoryEvidence {
  const input = requiredRecord(value, 'memory');
  const source = input['source'];
  const peakBytes = input['peakBytes'];
  const unavailableReason = input['unavailableReason'];
  if (typeof input['recoverablePressureQualified'] !== 'boolean') {
    throw new Error('memory.recoverablePressureQualified must be boolean.');
  }
  if (source === 'performance.memory.usedJSHeapSize') {
    if (typeof peakBytes !== 'number' || !Number.isFinite(peakBytes) || peakBytes < 0) {
      throw new Error('memory.peakBytes must be finite non-negative when memory is measurable.');
    }
    if (unavailableReason !== null) {
      throw new Error('memory.unavailableReason must be null when memory is measurable.');
    }
  } else if (source === 'unavailable') {
    if (peakBytes !== null)
      throw new Error('memory.peakBytes must be null when memory is unavailable.');
    requireText(unavailableReason, 'memory.unavailableReason');
  } else {
    throw new Error('memory.source must identify the renderer heap source or unavailable.');
  }
  return {
    peakBytes,
    recoverablePressureQualified: input['recoverablePressureQualified'],
    source,
    unavailableReason,
  } as AnnotationMemoryEvidence;
}

function validateFixtureHashes(value: unknown): Record<string, string> {
  const input = requiredRecord(value, 'fixtureHashes');
  const names = Object.keys(input).sort((left, right) => left.localeCompare(right));
  const expected = [...PDF_FIXTURE_NAMES].sort((left, right) => left.localeCompare(right));
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`fixtureHashes must contain exactly: ${expected.join(', ')}.`);
  }
  return Object.fromEntries(
    names.map((name) => {
      const hash = input[name];
      if (typeof hash !== 'string' || !/^[a-f\d]{64}$/iu.test(hash)) {
        throw new Error(`fixtureHashes.${name} must be a SHA-256 digest.`);
      }
      return [name, hash];
    }),
  );
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function hardwareEnvironment(): Record<string, unknown> {
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    freeMemoryBytes: freemem(),
    node: process.version,
    os: `${platform()} ${release()}`,
    totalMemoryBytes: totalmem(),
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
