import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateReaderBudget,
  parseMeasuredSamples,
  parseObsidianEval,
  parsePluginRuntimeState,
  pluginRestartCommands,
  summarizeSamples,
} from './benchmark-reader.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function runBenchmark(environment: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'abyss-reader-benchmark-'));
  temporaryDirectories.push(directory);
  const output = path.join(directory, 'reader-benchmark.json');
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'scripts', 'benchmark-reader.mts')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], ABYSS_BENCHMARK_OUTPUT: output, ...environment },
    },
  );
}

describe('reader benchmark summaries', () => {
  it('restarts a loaded plugin through bounded disable and enable commands, never reload', () => {
    expect(
      pluginRestartCommands({ enabled: true, loaded: true, manifestVersion: '0.1.0' }),
    ).toEqual([
      ['plugin:disable', 'id=abyss-documents'],
      ['plugin:enable', 'id=abyss-documents'],
    ]);
    expect(pluginRestartCommands({ enabled: false, loaded: false, manifestVersion: null })).toEqual(
      [['plugin:enable', 'id=abyss-documents']],
    );
  });

  it('fails closed when the Obsidian readiness probe does not return a valid plugin state', () => {
    expect(
      parsePluginRuntimeState(
        JSON.stringify({ enabled: true, loaded: true, manifestVersion: '0.1.0' }),
      ),
    ).toEqual({ enabled: true, loaded: true, manifestVersion: '0.1.0' });
    expect(() => parsePluginRuntimeState('null')).toThrow('plugin runtime state');
    expect(() =>
      parsePluginRuntimeState(JSON.stringify({ enabled: 'yes', loaded: false })),
    ).toThrow('plugin runtime state');
  });

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

  it('exits nonzero when a benchmark environment is unavailable even if a legacy override is set', () => {
    const canonical = path.join(repoRoot, 'artifacts', 'performance', 'reader-benchmark.json');
    const before = existsSync(canonical) ? readFileSync(canonical, 'utf8') : null;
    const required = runBenchmark();
    const diagnostic = runBenchmark({ ABYSS_ALLOW_UNAVAILABLE_BENCHMARK: '1' });

    expect(required.status).toBe(1);
    expect(required.stdout).toContain('Reader benchmark unavailable:');
    expect(diagnostic.status).toBe(1);
    expect(diagnostic.stdout).toContain('Reader benchmark unavailable:');
    expect(existsSync(canonical) ? readFileSync(canonical, 'utf8') : null).toBe(before);
  });

  it('fails measured desktop samples at either activation or first-page budget', () => {
    expect(
      evaluateReaderBudget({
        activationMs: [90, 91, 92, 93, 101],
        available: true,
        firstUsablePageMs: [1_500, 1_600, 1_700, 1_800, 2_001],
        pdfWorkDuringActivation: [0, 0, 0, 0, 0],
        platform: 'desktop',
      }),
    ).toMatchObject({ status: 'failed' });
  });

  it.each([
    {
      name: 'fewer than five samples',
      samples: [1, 2, 3, 4],
    },
    {
      name: 'a negative sample',
      samples: [1, 2, 3, 4, -1],
    },
    {
      name: 'a non-finite sample',
      samples: [1, 2, 3, 4, Number.NaN],
    },
  ])('rejects $name before evaluating a measured budget', ({ samples }) => {
    expect(() =>
      evaluateReaderBudget({
        activationMs: samples,
        available: true,
        firstUsablePageMs: [1, 2, 3, 4, 5],
        pdfWorkDuringActivation: [0, 0, 0, 0, 0],
        platform: 'desktop',
      }),
    ).toThrow(/at least five|finite non-negative/u);
  });

  it('validates the complete Android sample schema instead of trusting parsed JSON', () => {
    const fixtureHashes = {
      'annotation-qualification.pdf': '0'.repeat(64),
      'annotations-10000.pdf': 'f'.repeat(64),
      'invalid.pdf': 'a'.repeat(64),
      'outline-20-pages.pdf': 'b'.repeat(64),
      'permission-restricted.pdf': '1'.repeat(64),
      'raster-heavy-24-pages.pdf': 'c'.repeat(64),
      'signed-document.pdf': '2'.repeat(64),
      'text-12-pages.pdf': 'd'.repeat(64),
      'text-700-pages.pdf': 'e'.repeat(64),
      'unicode-annotations.pdf': '3'.repeat(64),
    };
    const valid = {
      environment: { device: 'Pixel reference', os: 'Android 16' },
      fixtureHashes,
      iterationCount: 5,
      samples: {
        activationMs: [1, 2, 3, 4, 5],
        coldFirstUsablePageMs: [101, 102, 103, 104, 105],
        warmFirstUsablePageMs: [51, 52, 53, 54, 55],
        pdfWorkDuringActivation: [0, 0, 0, 0, 0],
      },
      versions: { obsidian: '1.13.4', pdfjs: '6.2.108', plugin: '0.1.0' },
    };

    expect(parseMeasuredSamples(valid, fixtureHashes)).toEqual(valid);
    expect(() =>
      parseMeasuredSamples({
        ...valid,
        iterationCount: 6,
      }),
    ).toThrow('iterationCount');
    expect(() =>
      parseMeasuredSamples({
        ...valid,
        versions: { obsidian: '1.13.4', pdfjs: '', plugin: '0.1.0' },
      }),
    ).toThrow('versions.pdfjs');
    expect(() => parseMeasuredSamples(null)).toThrow('object');
  });

  it.each([
    {
      name: 'an empty environment',
      mutate: (valid: Record<string, unknown>) => ({ ...valid, environment: {} }),
      message: 'environment.device',
    },
    {
      name: 'a missing operating system',
      mutate: (valid: Record<string, unknown>) => ({
        ...valid,
        environment: { device: 'Pixel reference', os: '   ' },
      }),
      message: 'environment.os',
    },
    {
      name: 'an empty fixture map',
      mutate: (valid: Record<string, unknown>) => ({ ...valid, fixtureHashes: {} }),
      message: 'fixtureHashes',
    },
    {
      name: 'an unexpected fixture name',
      mutate: (valid: Record<string, unknown>) => ({
        ...valid,
        fixtureHashes: {
          'annotation-qualification.pdf': '0'.repeat(64),
          'annotations-10000.pdf': 'f'.repeat(64),
          'invalid.pdf': 'a'.repeat(64),
          'outline-20-pages.pdf': 'b'.repeat(64),
          'permission-restricted.pdf': '1'.repeat(64),
          'raster-heavy-24-pages.pdf': 'c'.repeat(64),
          'signed-document.pdf': '2'.repeat(64),
          'text-12-pages.pdf': 'd'.repeat(64),
          'wrong.pdf': 'e'.repeat(64),
          'unicode-annotations.pdf': '3'.repeat(64),
        },
      }),
      message: 'fixture name',
    },
    {
      name: 'a malformed SHA-256',
      mutate: (valid: Record<string, unknown>) => ({
        ...valid,
        fixtureHashes: {
          'annotation-qualification.pdf': '0'.repeat(64),
          'annotations-10000.pdf': 'f'.repeat(64),
          'invalid.pdf': 'not-a-sha',
          'outline-20-pages.pdf': 'b'.repeat(64),
          'permission-restricted.pdf': '1'.repeat(64),
          'raster-heavy-24-pages.pdf': 'c'.repeat(64),
          'signed-document.pdf': '2'.repeat(64),
          'text-12-pages.pdf': 'd'.repeat(64),
          'text-700-pages.pdf': 'e'.repeat(64),
          'unicode-annotations.pdf': '3'.repeat(64),
        },
      }),
      message: 'SHA-256',
    },
  ])('rejects Android input with $name', ({ mutate, message }) => {
    const valid: Record<string, unknown> = {
      environment: { device: 'Pixel reference', os: 'Android 16' },
      fixtureHashes: {
        'annotation-qualification.pdf': '0'.repeat(64),
        'annotations-10000.pdf': 'f'.repeat(64),
        'invalid.pdf': 'a'.repeat(64),
        'outline-20-pages.pdf': 'b'.repeat(64),
        'permission-restricted.pdf': '1'.repeat(64),
        'raster-heavy-24-pages.pdf': 'c'.repeat(64),
        'signed-document.pdf': '2'.repeat(64),
        'text-12-pages.pdf': 'd'.repeat(64),
        'text-700-pages.pdf': 'e'.repeat(64),
        'unicode-annotations.pdf': '3'.repeat(64),
      },
      iterationCount: 5,
      samples: {
        activationMs: [1, 2, 3, 4, 5],
        coldFirstUsablePageMs: [101, 102, 103, 104, 105],
        warmFirstUsablePageMs: [51, 52, 53, 54, 55],
        pdfWorkDuringActivation: [0, 0, 0, 0, 0],
      },
      versions: { obsidian: '1.13.4', pdfjs: '6.2.108', plugin: '0.1.0' },
    };

    expect(() => parseMeasuredSamples(mutate(valid))).toThrow(message);
  });

  it('rejects portable Android samples measured against a different fixture revision', () => {
    const fixtureHashes = {
      'annotation-qualification.pdf': '0'.repeat(64),
      'annotations-10000.pdf': 'f'.repeat(64),
      'invalid.pdf': 'a'.repeat(64),
      'outline-20-pages.pdf': 'b'.repeat(64),
      'permission-restricted.pdf': '1'.repeat(64),
      'raster-heavy-24-pages.pdf': 'c'.repeat(64),
      'signed-document.pdf': '2'.repeat(64),
      'text-12-pages.pdf': 'd'.repeat(64),
      'text-700-pages.pdf': 'e'.repeat(64),
      'unicode-annotations.pdf': '3'.repeat(64),
    };
    const input = {
      environment: { device: 'Pixel reference', os: 'Android 16' },
      fixtureHashes,
      iterationCount: 5,
      samples: {
        activationMs: [1, 2, 3, 4, 5],
        coldFirstUsablePageMs: [101, 102, 103, 104, 105],
        warmFirstUsablePageMs: [51, 52, 53, 54, 55],
        pdfWorkDuringActivation: [0, 0, 0, 0, 0],
      },
      versions: { obsidian: '1.13.4', pdfjs: '6.2.108', plugin: '0.1.0' },
    };

    expect(() =>
      parseMeasuredSamples(input, { ...fixtureHashes, 'text-12-pages.pdf': 'f'.repeat(64) }),
    ).toThrow('current fixture metadata');
  });

  it('rejects portable Android samples measured with a different plugin or PDF.js build', () => {
    const fixtureHashes = {
      'annotation-qualification.pdf': '0'.repeat(64),
      'annotations-10000.pdf': 'f'.repeat(64),
      'invalid.pdf': 'a'.repeat(64),
      'outline-20-pages.pdf': 'b'.repeat(64),
      'permission-restricted.pdf': '1'.repeat(64),
      'raster-heavy-24-pages.pdf': 'c'.repeat(64),
      'signed-document.pdf': '2'.repeat(64),
      'text-12-pages.pdf': 'd'.repeat(64),
      'text-700-pages.pdf': 'e'.repeat(64),
      'unicode-annotations.pdf': '3'.repeat(64),
    };
    const input = {
      environment: { device: 'Pixel reference', os: 'Android 16' },
      fixtureHashes,
      iterationCount: 5,
      samples: {
        activationMs: [1, 2, 3, 4, 5],
        coldFirstUsablePageMs: [101, 102, 103, 104, 105],
        warmFirstUsablePageMs: [51, 52, 53, 54, 55],
        pdfWorkDuringActivation: [0, 0, 0, 0, 0],
      },
      versions: { obsidian: '1.13.4', pdfjs: '6.2.108', plugin: '0.1.0' },
    };
    const expectedVersions = { pdfjs: '6.2.108', plugin: '0.1.0' };

    expect(parseMeasuredSamples(input, fixtureHashes, expectedVersions)).toEqual(input);
    expect(() =>
      parseMeasuredSamples(
        { ...input, versions: { ...input.versions, plugin: 'stale-plugin' } },
        fixtureHashes,
        expectedVersions,
      ),
    ).toThrow('versions.plugin does not match');
    expect(() =>
      parseMeasuredSamples(
        { ...input, versions: { ...input.versions, pdfjs: 'stale-pdfjs' } },
        fixtureHashes,
        expectedVersions,
      ),
    ).toThrow('versions.pdfjs does not match');
    expect(() =>
      parseMeasuredSamples({
        ...input,
        versions: { ...input.versions, obsidian: 'not-a-version' },
      }),
    ).toThrow('Obsidian version evidence is unavailable');
  });
});
