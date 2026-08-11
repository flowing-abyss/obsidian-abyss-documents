import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { PDF_FIXTURE_NAMES } from '../tests/fixtures/pdf-fixture-names.mjs';

const execFileAsync = promisify(execFile);

export type ReaderBudgetInput =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly platform: 'android' | 'desktop';
      readonly activationMs: readonly number[];
      readonly firstUsablePageMs: readonly number[];
      readonly pdfWorkDuringActivation: readonly number[];
    };

export function summarizeSamples(samples: readonly number[]): {
  readonly p50: number;
  readonly p95: number;
} {
  if (samples.length === 0) throw new Error('Cannot summarize an empty sample set.');
  const sorted = [...samples].sort((left, right) => left - right);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? Number.NaN;
}

export function evaluateReaderBudget(input: ReaderBudgetInput):
  | { readonly status: 'unavailable'; readonly reason: string }
  | {
      readonly status: 'passed' | 'failed';
      readonly activation: { readonly p50: number; readonly p95: number };
      readonly firstUsablePage: { readonly p50: number; readonly p95: number };
      readonly limits: { readonly activationP95Ms: 100; readonly firstUsablePageP95Ms: number };
      readonly zeroPdfWorkDuringActivation: boolean;
    } {
  if (!input.available) return { status: 'unavailable', reason: input.reason };
  validateSamples('activationMs', input.activationMs);
  validateSamples('firstUsablePageMs', input.firstUsablePageMs);
  validateSamples('pdfWorkDuringActivation', input.pdfWorkDuringActivation);
  if (
    input.activationMs.length !== input.firstUsablePageMs.length ||
    input.activationMs.length !== input.pdfWorkDuringActivation.length
  ) {
    throw new Error('Measured benchmark sample arrays must have matching lengths.');
  }
  const activation = summarizeSamples(input.activationMs);
  const firstUsablePage = summarizeSamples(input.firstUsablePageMs);
  const firstUsablePageP95Ms = input.platform === 'android' ? 4_000 : 2_000;
  const zeroPdfWorkDuringActivation = input.pdfWorkDuringActivation.every((count) => count === 0);
  const passed =
    activation.p95 < 100 &&
    firstUsablePage.p95 < firstUsablePageP95Ms &&
    zeroPdfWorkDuringActivation;
  return {
    status: passed ? 'passed' : 'failed',
    activation,
    firstUsablePage,
    limits: { activationP95Ms: 100, firstUsablePageP95Ms },
    zeroPdfWorkDuringActivation,
  };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const outputDirectory = path.join(repoRoot, 'artifacts', 'performance');
  await mkdir(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, 'reader-benchmark.json');
  const device = process.env['ABYSS_BENCHMARK_DEVICE'];
  if (device !== 'desktop' && device !== 'android') {
    await writeUnavailable(
      output,
      'No designated reference-device runner was configured. Set ABYSS_BENCHMARK_DEVICE=desktop or android in the real Obsidian harness.',
    );
    return;
  }
  try {
    const raw =
      device === 'desktop'
        ? await measureDesktop(repoRoot)
        : await readAndroidSamples(
            process.env['ABYSS_BENCHMARK_RAW_INPUT'],
            await currentFixtureHashes(repoRoot),
          );
    const evaluation = evaluateReaderBudget({
      activationMs: raw.samples.activationMs,
      available: true,
      firstUsablePageMs: raw.samples.coldFirstUsablePageMs,
      pdfWorkDuringActivation: raw.samples.pdfWorkDuringActivation,
      platform: device,
    });
    const report = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      status: evaluation.status,
      conditions: {
        cold: 'Plugin reload followed by the first PDF open.',
        warm: 'Second PDF open with the same loaded PDF.js runtime and worker.',
      },
      ...raw,
      summary: {
        activation: summarizeSamples(raw.samples.activationMs),
        coldFirstUsablePage: summarizeSamples(raw.samples.coldFirstUsablePageMs),
        warmFirstUsablePage: summarizeSamples(raw.samples.warmFirstUsablePageMs),
      },
      evaluation,
    };
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.info(
      `Reader benchmark ${evaluation.status}: activation p95 ${report.summary.activation.p95.toFixed(1)} ms; ` +
        `cold first usable page p95 ${report.summary.coldFirstUsablePage.p95.toFixed(1)} ms; raw samples: ${output}`,
    );
    if (evaluation.status === 'failed') process.exitCode = 1;
  } catch (error) {
    await writeUnavailable(output, reason(error));
  }
}

export interface MeasuredSamples {
  readonly environment: Record<string, unknown>;
  readonly fixtureHashes: Record<string, string>;
  readonly iterationCount: number;
  readonly samples: {
    readonly activationMs: readonly number[];
    readonly coldFirstUsablePageMs: readonly number[];
    readonly warmFirstUsablePageMs: readonly number[];
    readonly pdfWorkDuringActivation: readonly number[];
  };
  readonly versions: { readonly obsidian: string; readonly plugin: string; readonly pdfjs: string };
}

interface RuntimeSnapshot {
  readonly activationMs: number | null;
  readonly counters: { readonly pdfWorkDuringPluginOnload: number };
  readonly marks: ReadonlyArray<{ readonly name: string; readonly startTime: number }>;
  readonly versions: { readonly pdfjs: string | null; readonly plugin: string | null };
}

async function measureDesktop(repoRoot: string): Promise<MeasuredSamples> {
  const vaultPath = path.join(repoRoot, 'dev-documents-vault');
  const vaultName = await registeredVaultName(vaultPath);
  const iterations = integerEnvironment('ABYSS_BENCHMARK_ITERATIONS', 10, 5);
  const activationMs: number[] = [];
  const coldFirstUsablePageMs: number[] = [];
  const warmFirstUsablePageMs: number[] = [];
  const pdfWorkDuringActivation: number[] = [];
  let pdfjsVersion = '';
  let pluginVersion = '';

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await closeReaders(vaultName);
    await obsidian(vaultName, ['plugin:reload', 'id=abyss-documents']);
    const activation = await snapshot(vaultName);
    if (activation.activationMs === null) throw new Error('Plugin activation mark did not settle.');
    activationMs.push(activation.activationMs);
    pdfWorkDuringActivation.push(activation.counters.pdfWorkDuringPluginOnload);
    pluginVersion = activation.versions.plugin ?? pluginVersion;
    coldFirstUsablePageMs.push(await measureOpen(vaultName));
    const coldRuntime = await snapshot(vaultName);
    pdfjsVersion = coldRuntime.versions.pdfjs ?? pdfjsVersion;
    await closeReaders(vaultName);
    warmFirstUsablePageMs.push(await measureOpen(vaultName));
  }

  const fixtureManifest = JSON.parse(
    await readFile(path.join(vaultPath, 'Documents', 'fixtures.v1.json'), 'utf8'),
  ) as { readonly files: ReadonlyArray<{ readonly name: string; readonly sha256: string }> };
  const obsidianVersion = (
    await execFileAsync('obsidian', ['version'], { timeout: 5_000 })
  ).stdout.trim();
  return {
    environment: hardwareEnvironment(),
    fixtureHashes: Object.fromEntries(
      fixtureManifest.files.map(({ name, sha256 }) => [name, sha256]),
    ),
    iterationCount: iterations,
    samples: {
      activationMs,
      coldFirstUsablePageMs,
      warmFirstUsablePageMs,
      pdfWorkDuringActivation,
    },
    versions: { obsidian: obsidianVersion, pdfjs: pdfjsVersion, plugin: pluginVersion },
  };
}

async function measureOpen(vaultName: string): Promise<number> {
  const before = await snapshot(vaultName);
  const previousMarks = before.marks.length;
  await evaluateInObsidian(
    vaultName,
    `(async () => { await app.workspace.openLinkText('Documents/text-12-pages.pdf', '', false); return true; })()`,
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = await snapshot(vaultName);
    const marks = current.marks.slice(previousMarks);
    const intent = [...marks].reverse().find((mark) => mark.name === 'reader-intent');
    const usable =
      intent === undefined
        ? undefined
        : marks.find((mark) => mark.name === 'usable-page' && mark.startTime >= intent.startTime);
    if (intent !== undefined && usable !== undefined) return usable.startTime - intent.startTime;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('First usable page mark did not arrive within 15 seconds.');
}

async function closeReaders(vaultName: string): Promise<void> {
  await evaluateInObsidian(
    vaultName,
    `(async () => { const leaves = app.workspace.getLeavesOfType('abyss-document-view'); await Promise.all(leaves.map((leaf) => leaf.setViewState({ type: 'empty' }))); return true; })()`,
  );
}

async function snapshot(vaultName: string): Promise<RuntimeSnapshot> {
  const value = await evaluateInObsidian(
    vaultName,
    `JSON.stringify(globalThis.__abyssDocumentsPerformance ?? null)`,
  );
  const parsed = JSON.parse(value) as RuntimeSnapshot | null;
  if (parsed === null) throw new Error('Reader instrumentation is unavailable in Obsidian.');
  return parsed;
}

async function evaluateInObsidian(vaultName: string, code: string): Promise<string> {
  return parseObsidianEval(await obsidian(vaultName, ['eval', `code=${code}`]));
}

export function parseObsidianEval(output: string): string {
  const trimmed = output.trim();
  return trimmed.startsWith('=> ') ? trimmed.slice(3).trim() : trimmed;
}

async function obsidian(vaultName: string, arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync('obsidian', [`vault=${vaultName}`, ...arguments_], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function registeredVaultName(expectedPath: string): Promise<string> {
  const { stdout } = await execFileAsync('obsidian', ['vaults', 'verbose'], { timeout: 5_000 });
  for (const line of stdout.split(/\r?\n/u)) {
    const [name, candidate] = line.split('\t');
    if (name !== undefined && candidate !== undefined && path.resolve(candidate) === expectedPath)
      return name;
  }
  throw new Error(`Development vault is not registered at ${expectedPath}. Run pnpm dev:vault.`);
}

async function readAndroidSamples(
  input: string | undefined,
  expectedFixtureHashes: Readonly<Record<string, string>>,
): Promise<MeasuredSamples> {
  if (input === undefined) {
    throw new Error(
      'Android reference device did not provide ABYSS_BENCHMARK_RAW_INPUT; Appium measurements are unavailable.',
    );
  }
  return parseMeasuredSamples(
    JSON.parse(await readFile(path.resolve(input), 'utf8')),
    expectedFixtureHashes,
  );
}

export function parseMeasuredSamples(
  input: unknown,
  expectedFixtureHashes?: Readonly<Record<string, string>>,
): MeasuredSamples {
  const root = requiredRecord(input, 'Android benchmark input');
  const environment = requiredRecord(root['environment'], 'environment');
  requireNonEmptyString(environment['device'], 'environment.device');
  requireNonEmptyString(environment['os'], 'environment.os');
  const fixtureHashes = validatedFixtureHashes(root['fixtureHashes'], 'fixtureHashes');
  if (expectedFixtureHashes !== undefined) {
    const expected = validatedFixtureHashes(expectedFixtureHashes, 'current fixture metadata');
    for (const name of PDF_FIXTURE_NAMES) {
      if (fixtureHashes[name]?.toLocaleLowerCase() !== expected[name]?.toLocaleLowerCase()) {
        throw new Error(
          `fixtureHashes.${name} does not match the current fixture metadata. Regenerate or remeasure the portable Android sample.`,
        );
      }
    }
  }
  const iterationCount = root['iterationCount'];
  if (!Number.isInteger(iterationCount) || (iterationCount as number) < 5) {
    throw new Error('iterationCount must be an integer of at least five.');
  }
  const samplesInput = requiredRecord(root['samples'], 'samples');
  const samples = {
    activationMs: sampleArray(samplesInput['activationMs'], 'samples.activationMs'),
    coldFirstUsablePageMs: sampleArray(
      samplesInput['coldFirstUsablePageMs'],
      'samples.coldFirstUsablePageMs',
    ),
    warmFirstUsablePageMs: sampleArray(
      samplesInput['warmFirstUsablePageMs'],
      'samples.warmFirstUsablePageMs',
    ),
    pdfWorkDuringActivation: sampleArray(
      samplesInput['pdfWorkDuringActivation'],
      'samples.pdfWorkDuringActivation',
    ),
  };
  for (const [name, values] of Object.entries(samples)) {
    if (values.length !== iterationCount) {
      throw new Error(`${name} length must match iterationCount.`);
    }
  }
  const versionsInput = requiredRecord(root['versions'], 'versions');
  const version = (name: 'obsidian' | 'pdfjs' | 'plugin'): string => {
    const value = versionsInput[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`versions.${name} must be a non-empty string.`);
    }
    return value;
  };
  return {
    environment,
    fixtureHashes,
    iterationCount: iterationCount as number,
    samples,
    versions: { obsidian: version('obsidian'), pdfjs: version('pdfjs'), plugin: version('plugin') },
  };
}

async function currentFixtureHashes(repoRoot: string): Promise<Record<string, string>> {
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
  return Object.fromEntries(
    files.map((entry, index) => {
      const record = requiredRecord(entry, `current fixture manifest.files[${index}]`);
      return [
        requireNonEmptyString(record['name'], `current fixture manifest.files[${index}].name`),
        requireNonEmptyString(record['sha256'], `current fixture manifest.files[${index}].sha256`),
      ];
    }),
  );
}

function validatedFixtureHashes(value: unknown, label: string): Record<string, string> {
  const input = requiredRecord(value, label);
  const actualNames = Object.keys(input).sort((left, right) => left.localeCompare(right));
  const expectedNames = [...PDF_FIXTURE_NAMES].sort((left, right) => left.localeCompare(right));
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `${label} must contain every expected fixture name exactly once: ${expectedNames.join(', ')}.`,
    );
  }
  return Object.fromEntries(
    actualNames.map((name) => {
      const hash = input[name];
      if (typeof hash !== 'string' || !/^[A-Fa-f\d]{64}$/u.test(hash)) {
        throw new Error(`${label}.${name} must be a 64-character SHA-256 hexadecimal digest.`);
      }
      return [name, hash];
    }),
  );
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function sampleArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  validateSamples(name, value);
  return value as number[];
}

function validateSamples(name: string, samples: readonly unknown[]): void {
  if (samples.length < 5) throw new Error(`${name} must contain at least five samples.`);
  if (
    !samples.every((sample) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0)
  ) {
    throw new Error(`${name} samples must be finite non-negative numbers.`);
  }
}

function integerEnvironment(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return value;
}

async function writeUnavailable(output: string, unavailableReason: string): Promise<void> {
  const unavailable = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    status: 'unavailable',
    reason: unavailableReason,
    environment: hardwareEnvironment(),
  };
  await writeFile(output, `${JSON.stringify(unavailable, null, 2)}\n`);
  console.info(`Reader benchmark unavailable: ${unavailable.reason} Raw status: ${output}`);
  process.exitCode = process.env['ABYSS_ALLOW_UNAVAILABLE_BENCHMARK'] === '1' ? 0 : 1;
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
