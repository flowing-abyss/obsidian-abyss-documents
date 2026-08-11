import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import {
  evaluateReaderBudget,
  parseMeasuredSamples,
  parseObsidianEval,
  summarizeSamples,
} from './benchmark-reader.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function runBenchmark(environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'scripts', 'benchmark-reader.mts')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], ...environment },
    },
  );
}

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

  it('exits nonzero when a benchmark environment is unavailable unless explicitly allowed', () => {
    const required = runBenchmark();
    const diagnostic = runBenchmark({ ABYSS_ALLOW_UNAVAILABLE_BENCHMARK: '1' });

    expect(required.status).toBe(1);
    expect(required.stdout).toContain('Reader benchmark unavailable:');
    expect(diagnostic.status).toBe(0);
    expect(diagnostic.stdout).toContain('Reader benchmark unavailable:');
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
      'invalid.pdf': 'a'.repeat(64),
      'outline-20-pages.pdf': 'b'.repeat(64),
      'raster-heavy-24-pages.pdf': 'c'.repeat(64),
      'text-12-pages.pdf': 'd'.repeat(64),
      'text-700-pages.pdf': 'e'.repeat(64),
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
          'invalid.pdf': 'a'.repeat(64),
          'outline-20-pages.pdf': 'b'.repeat(64),
          'raster-heavy-24-pages.pdf': 'c'.repeat(64),
          'text-12-pages.pdf': 'd'.repeat(64),
          'wrong.pdf': 'e'.repeat(64),
        },
      }),
      message: 'fixture name',
    },
    {
      name: 'a malformed SHA-256',
      mutate: (valid: Record<string, unknown>) => ({
        ...valid,
        fixtureHashes: {
          'invalid.pdf': 'not-a-sha',
          'outline-20-pages.pdf': 'b'.repeat(64),
          'raster-heavy-24-pages.pdf': 'c'.repeat(64),
          'text-12-pages.pdf': 'd'.repeat(64),
          'text-700-pages.pdf': 'e'.repeat(64),
        },
      }),
      message: 'SHA-256',
    },
  ])('rejects Android input with $name', ({ mutate, message }) => {
    const valid: Record<string, unknown> = {
      environment: { device: 'Pixel reference', os: 'Android 16' },
      fixtureHashes: {
        'invalid.pdf': 'a'.repeat(64),
        'outline-20-pages.pdf': 'b'.repeat(64),
        'raster-heavy-24-pages.pdf': 'c'.repeat(64),
        'text-12-pages.pdf': 'd'.repeat(64),
        'text-700-pages.pdf': 'e'.repeat(64),
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
      'invalid.pdf': 'a'.repeat(64),
      'outline-20-pages.pdf': 'b'.repeat(64),
      'raster-heavy-24-pages.pdf': 'c'.repeat(64),
      'text-12-pages.pdf': 'd'.repeat(64),
      'text-700-pages.pdf': 'e'.repeat(64),
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
});
