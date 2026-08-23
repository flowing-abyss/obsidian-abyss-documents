import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import {
  annotationCliExecOptions,
  evaluateAnnotationBudget,
  hasNativeAnnotationStorageGrowth,
  isAnnotationBenchmarkPageReady,
  isAnnotationPluginReady,
  isNewRetryNoticeForAnnotationPath,
  isObsidianCliTimeout,
  isRecoverableAnnotationPressureQualified,
  isRetryNoticeForAnnotationPath,
  isSelectableAnnotationBenchmarkPageReady,
  parseAnnotationBenchmarkInput,
  parseObsidianEvalOutput,
  retryObsidianCliProbe,
  shouldInjectAnnotationBufferPressure,
  summarizeAnnotationSamples,
} from './benchmark-annotations.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function runBenchmark(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'scripts', 'benchmark-annotations.mts'), ...arguments_],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], ...environment },
    },
  );
}

function measuredInput(platform: 'android' | 'desktop') {
  return {
    available: true as const,
    platform,
    memory: {
      peakBytes: 128_000_000,
      recoverablePressureQualified: true,
      source: 'performance.memory.usedJSHeapSize' as const,
      unavailableReason: null,
    },
    samples: {
      extractionBatchMs: [45, 46, 47, 48, 50],
      filterMs: [60, 70, 80, 90, 100],
      saveMs: [1_200, 1_400, 1_600, 1_800, platform === 'android' ? 4_000 : 2_000],
      searchMs: [50, 60, 70, 80, 100],
    },
    counters: {
      annotationSaveFailures: 1,
      annotationSaveRecoveries: 1,
      externalNetworkAttempts: 0,
      maxAnnotationCards: 80,
      maxAnnotationPanelNodes: 800,
      maxConcurrentSerializations: 1,
      maxConcurrentWrites: 1,
      workerUrlsActiveAfterDisable: 0,
      workersStarted: 1,
    },
  };
}

function portableEvidence(platform: 'android' | 'desktop') {
  const measured = measuredInput(platform);
  return {
    platform,
    environment: { device: 'Pixel reference', os: 'Android 16' },
    fixtureHashes: Object.fromEntries(
      [
        'annotation-qualification.pdf',
        'annotations-10000.pdf',
        'invalid.pdf',
        'outline-20-pages.pdf',
        'permission-restricted.pdf',
        'raster-heavy-24-pages.pdf',
        'signed-document.pdf',
        'text-12-pages.pdf',
        'text-700-pages.pdf',
      ].map((name, index) => [name, String(index).repeat(64)]),
    ),
    iterationCount: 5,
    memory: measured.memory,
    samples: measured.samples,
    counters: measured.counters,
    versions: { obsidian: '1.13.4', pdfjs: '6.2.108', plugin: '0.1.0' },
  };
}

describe('annotation qualification budgets', () => {
  it('extracts the final eval result after non-fatal Obsidian CLI diagnostics', () => {
    expect(
      parseObsidianEvalOutput(
        '[error] offsetParent is not set -- cannot scroll\n=> 39a251bd153ff32f',
      ),
    ).toBe('39a251bd153ff32f');
    expect(parseObsidianEvalOutput('plain output')).toBe('plain output');
  });

  it('reopens into the exact returned leaf and awaits reader teardown between iterations', () => {
    const source = readFileSync(
      path.join(repoRoot, 'scripts', 'benchmark-annotations.mts'),
      'utf8',
    );
    const retryClick = source.indexOf('retry.click();return true');
    const reopenedLeaf = source.indexOf('const reopenedLeafId = await evaluate(');
    const actualLeafCreation = source.indexOf(
      'const leaf=app.workspace.getLeaf(true)',
      reopenedLeaf,
    );

    expect(retryClick).toBeGreaterThan(-1);
    expect(reopenedLeaf).toBeGreaterThan(retryClick);
    expect(actualLeafCreation).toBeGreaterThan(reopenedLeaf);
    expect(source).not.toContain('leaf.detach()');
    expect(source).toContain("await leaf.setViewState({type:'empty',state:{}})");
    expect(source).not.toContain('Recovered benchmark reused the prior leaf session.');
    expect(source).toContain('__abyssAnnotationBenchmarkPreviousRoot');
  });

  it('targets annotation-panel filter inputs instead of the toolbar color buttons', () => {
    const source = readFileSync(
      path.join(repoRoot, 'scripts', 'benchmark-annotations.mts'),
      'utf8',
    );
    expect(source).toContain('[data-sidebar-panel="annotations"] input[data-annotation-color]');
    expect(source).not.toContain('.abyss-annotation-colors [data-annotation-color]');
  });

  it('waits for selectable text in the exact reader root after sidebar relayout', () => {
    const source = readFileSync(
      path.join(repoRoot, 'scripts', 'benchmark-annotations.mts'),
      'utf8',
    );
    const readiness = source.indexOf('Selectable benchmark text did not become ready.');
    const selection = source.indexOf('Selectable benchmark text unavailable.');
    expect(readiness).toBeGreaterThan(-1);
    expect(selection).toBeGreaterThan(readiness);
    expect(source).toContain(
      'root?.querySelectorAll(\'[data-page-number="1"] .textLayer span\')[1]',
    );
  });

  it('accepts readiness only from the exact opened leaf, path, and active canvas', () => {
    const ready = {
      hasCanvas: true,
      hasErrorBoundary: false,
      hasFreshReaderRoot: true,
      hasReaderRoot: true,
      leafId: 'leaf-2',
      path: 'Documents/bench.pdf',
    };
    expect(isAnnotationBenchmarkPageReady(ready, 'Documents/bench.pdf', 'leaf-2')).toBe(true);
    expect(
      isAnnotationBenchmarkPageReady(
        { ...ready, leafId: 'leaf-1' },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
    expect(
      isAnnotationBenchmarkPageReady(
        { ...ready, path: 'Documents/old.pdf' },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
    expect(
      isAnnotationBenchmarkPageReady(
        { ...ready, hasCanvas: false },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
    expect(
      isAnnotationBenchmarkPageReady(
        { ...ready, hasErrorBoundary: true },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
    expect(
      isAnnotationBenchmarkPageReady(
        { ...ready, hasFreshReaderRoot: false },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
    expect(
      isAnnotationBenchmarkPageReady(
        { ...ready, hasReaderRoot: false },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
  });

  it('waits for a visible editor layer as well as selectable text after relayout', () => {
    const ready = {
      hasEditorLayer: true,
      hasErrorBoundary: false,
      leafId: 'leaf-2',
      path: 'Documents/bench.pdf',
      textCount: 2,
    };
    expect(isSelectableAnnotationBenchmarkPageReady(ready, 'Documents/bench.pdf', 'leaf-2')).toBe(
      true,
    );
    expect(
      isSelectableAnnotationBenchmarkPageReady(
        { ...ready, hasEditorLayer: false },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
    expect(
      isSelectableAnnotationBenchmarkPageReady(
        { ...ready, textCount: 1 },
        'Documents/bench.pdf',
        'leaf-2',
      ),
    ).toBe(false);
  });

  it('accepts annotation creation only after native storage grows beyond its baseline', () => {
    expect(hasNativeAnnotationStorageGrowth(1, 0)).toBe(true);
    expect(hasNativeAnnotationStorageGrowth(0, 0)).toBe(false);
    expect(hasNativeAnnotationStorageGrowth(10_000, 10_000)).toBe(false);
    expect(hasNativeAnnotationStorageGrowth('1', 0)).toBe(false);
  });

  it('serializes the renderer readiness predicate without build-runtime helpers', () => {
    const probe = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--eval',
        `import(${JSON.stringify(path.join(repoRoot, 'scripts', 'benchmark-annotations.mts'))}).then(module => process.stdout.write(module.isAnnotationBenchmarkPageReady.toString()))`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    const source = probe.stdout;
    expect(source).not.toContain('__name');
    const cleanRealm = spawnSync(
      process.execPath,
      [
        '--eval',
        `const predicate=(${source});process.stdout.write(String(predicate(${JSON.stringify({
          hasCanvas: true,
          hasErrorBoundary: false,
          hasFreshReaderRoot: true,
          hasReaderRoot: true,
          leafId: 'leaf-2',
          path: 'Documents/bench.pdf',
        })},'Documents/bench.pdf','leaf-2')))`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(cleanRealm.status).toBe(0);
    expect(cleanRealm.stdout).toBe('true');
  });

  it('serializes selectable-layer readiness without build-runtime helpers', () => {
    const probe = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--eval',
        `import(${JSON.stringify(path.join(repoRoot, 'scripts', 'benchmark-annotations.mts'))}).then(module => process.stdout.write(module.isSelectableAnnotationBenchmarkPageReady.toString()))`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).not.toContain('__name');
  });

  it('injects allocation pressure only at a large PDF vault-transfer buffer', () => {
    expect(shouldInjectAnnotationBufferPressure(new ArrayBuffer(999_999))).toBe(false);
    expect(shouldInjectAnnotationBufferPressure(new ArrayBuffer(1_000_000))).toBe(true);
    expect(shouldInjectAnnotationBufferPressure(new Uint8Array(1_000_000))).toBe(false);
    expect(shouldInjectAnnotationBufferPressure([1_000_000])).toBe(false);
  });

  it('qualifies only one injected failure and one recovery relative to the baseline', () => {
    const qualified = {
      attempts: 1,
      bytesUnchanged: true,
      failuresAfter: 4,
      failuresBefore: 3,
      liveEditorPending: true,
      recoveriesAfter: 6,
      recoveriesBefore: 5,
    };
    expect(isRecoverableAnnotationPressureQualified(qualified)).toBe(true);
    expect(isRecoverableAnnotationPressureQualified({ ...qualified, attempts: 0 })).toBe(false);
    expect(isRecoverableAnnotationPressureQualified({ ...qualified, attempts: 2 })).toBe(false);
    expect(isRecoverableAnnotationPressureQualified({ ...qualified, failuresAfter: 3 })).toBe(
      false,
    );
    expect(isRecoverableAnnotationPressureQualified({ ...qualified, recoveriesAfter: 5 })).toBe(
      false,
    );
  });

  it('targets the Retry notice for the current benchmark PDF only', () => {
    expect(
      isRetryNoticeForAnnotationPath(
        'Could not autosave PDF annotations: write failed: Documents/annotation-benchmark-1.pdf Retry',
        'Documents/annotation-benchmark-1.pdf',
      ),
    ).toBe(true);
    expect(
      isRetryNoticeForAnnotationPath(
        'Could not autosave PDF annotations: write failed: Documents/annotation-benchmark-5.pdf Retry',
        'Documents/annotation-benchmark-1.pdf',
      ),
    ).toBe(false);
    expect(isRetryNoticeForAnnotationPath(null, 'Documents/annotation-benchmark-1.pdf')).toBe(
      false,
    );
  });

  it('does not reuse a stale Retry notice from an earlier benchmark run', () => {
    const stale = {
      textContent:
        'Could not autosave PDF annotations: write failed: Documents/annotation-benchmark-1.pdf Retry',
    };
    const current = { ...stale };
    const baseline = new Set<object>([stale]);
    expect(
      isNewRetryNoticeForAnnotationPath(stale, baseline, 'Documents/annotation-benchmark-1.pdf'),
    ).toBe(false);
    expect(
      isNewRetryNoticeForAnnotationPath(current, baseline, 'Documents/annotation-benchmark-1.pdf'),
    ).toBe(true);
  });

  it('force-kills an unresponsive Obsidian CLI command at the strict deadline', () => {
    expect(annotationCliExecOptions()).toMatchObject({
      killSignal: 'SIGKILL',
      timeout: 10_000,
    });
  });

  it('retries only a CLI process killed by the configured timeout', () => {
    expect(isObsidianCliTimeout({ code: null, killed: true, signal: 'SIGKILL' })).toBe(true);
    expect(isObsidianCliTimeout(new Error('Evaluation error: bad probe'))).toBe(false);
    expect(isObsidianCliTimeout({ code: 1, killed: false, signal: null })).toBe(false);
  });

  it('retries an idempotent probe after CLI timeouts but not after evaluation failures', async () => {
    const timeout = Object.assign(new Error('CLI timeout'), {
      code: null,
      killed: true,
      signal: 'SIGKILL',
    });
    let attempts = 0;
    await expect(
      retryObsidianCliProbe(
        async () => {
          attempts += 1;
          if (attempts < 3) throw timeout;
          return 'ready';
        },
        1_000,
        async () => undefined,
      ),
    ).resolves.toBe('ready');
    expect(attempts).toBe(3);

    let failedAttempts = 0;
    await expect(
      retryObsidianCliProbe(
        async () => {
          failedAttempts += 1;
          throw new Error('Evaluation error: broken probe');
        },
        1_000,
        async () => undefined,
      ),
    ).rejects.toThrow('broken probe');
    expect(failedAttempts).toBe(1);
  });

  it('does not accept plugin map membership before async activation settles', () => {
    expect(
      isAnnotationPluginReady(
        {
          activationEnd: null,
          activationInProgress: true,
          activationMs: null,
          activationStart: 1,
          enabled: true,
          leaves: 0,
          loaded: true,
          workerUrlsActive: 0,
        },
        true,
      ),
    ).toBe(false);
    expect(
      isAnnotationPluginReady(
        {
          activationEnd: 2.2,
          activationInProgress: false,
          activationMs: 1.2,
          activationStart: 1,
          enabled: true,
          leaves: 0,
          loaded: true,
          workerUrlsActive: 0,
        },
        true,
      ),
    ).toBe(true);
    expect(
      isAnnotationPluginReady(
        {
          activationEnd: 2.2,
          activationInProgress: false,
          activationMs: 1.2,
          activationStart: 1,
          enabled: false,
          leaves: 0,
          loaded: false,
          workerUrlsActive: 0,
        },
        false,
      ),
    ).toBe(true);
  });

  it('accepts every exact desktop boundary with five designated iterations', () => {
    expect(evaluateAnnotationBudget(measuredInput('desktop'))).toMatchObject({
      status: 'passed',
      limits: {
        extractionBatchMaxMs: 50,
        filterP95Ms: 100,
        maxAnnotationCards: 80,
        maxAnnotationPanelNodes: 1_024,
        maxConcurrentSerializations: 1,
        maxConcurrentWrites: 1,
        saveP95Ms: 2_000,
        searchP95Ms: 100,
      },
    });
  });

  it('accepts the exact Android save boundary and no higher value', () => {
    expect(evaluateAnnotationBudget(measuredInput('android')).status).toBe('passed');
    const failing = measuredInput('android');
    expect(
      evaluateAnnotationBudget({
        ...failing,
        samples: { ...failing.samples, saveMs: [1, 2, 3, 4, 4_001] },
      }).status,
    ).toBe('failed');
  });

  it.each([
    {
      name: 'filter p95',
      mutate: () => ({ samples: { filterMs: [1, 2, 3, 4, 101] } }),
    },
    {
      name: 'search p95',
      mutate: () => ({ samples: { searchMs: [1, 2, 3, 4, 101] } }),
    },
    {
      name: 'extraction batch maximum',
      mutate: () => ({ samples: { extractionBatchMs: [1, 2, 3, 4, 50.01] } }),
    },
    {
      name: 'annotation card maximum',
      mutate: () => ({ counters: { maxAnnotationCards: 81 } }),
    },
    {
      name: 'annotation panel DOM maximum',
      mutate: () => ({ counters: { maxAnnotationPanelNodes: 1_025 } }),
    },
    {
      name: 'serialization overlap',
      mutate: () => ({ counters: { maxConcurrentSerializations: 2 } }),
    },
    {
      name: 'missing serialization work',
      mutate: () => ({ counters: { maxConcurrentSerializations: 0 } }),
    },
    {
      name: 'write overlap',
      mutate: () => ({ counters: { maxConcurrentWrites: 2 } }),
    },
    {
      name: 'missing write work',
      mutate: () => ({ counters: { maxConcurrentWrites: 0 } }),
    },
    {
      name: 'active worker after disable',
      mutate: () => ({ counters: { workerUrlsActiveAfterDisable: 1 } }),
    },
    {
      name: 'missing worker lifecycle',
      mutate: () => ({ counters: { workersStarted: 0 } }),
    },
    {
      name: 'external network attempt',
      mutate: () => ({ counters: { externalNetworkAttempts: 1 } }),
    },
    {
      name: 'unqualified recoverable memory pressure',
      mutate: () => ({ memory: { recoverablePressureQualified: false } }),
    },
  ] as ReadonlyArray<{
    readonly name: string;
    readonly mutate: () => {
      readonly counters?: Partial<ReturnType<typeof measuredInput>['counters']>;
      readonly memory?: Partial<ReturnType<typeof measuredInput>['memory']>;
      readonly samples?: Partial<ReturnType<typeof measuredInput>['samples']>;
    };
  }>)('fails closed when $name exceeds or vacuously misses its contract', ({ mutate }) => {
    const input = measuredInput('desktop');
    const change = mutate();
    expect(
      evaluateAnnotationBudget({
        ...input,
        counters: { ...input.counters, ...change.counters },
        memory: { ...input.memory, ...change.memory },
        samples: { ...input.samples, ...change.samples },
      }).status,
    ).toBe('failed');
  });

  it('summarizes hand-checked annotation samples without averaging away the tail', () => {
    expect(summarizeAnnotationSamples([1, 3, 5, 7, 9])).toEqual({ p50: 5, p95: 9 });
  });

  it('rejects unavailable and malformed portable evidence instead of reporting a pass', () => {
    expect(
      evaluateAnnotationBudget({ available: false, reason: 'Android SDK is unavailable.' }),
    ).toEqual({ status: 'unavailable', reason: 'Android SDK is unavailable.' });
    expect(() => parseAnnotationBenchmarkInput(null, 'android')).toThrow('object');
    expect(() =>
      parseAnnotationBenchmarkInput(
        {
          environment: { device: 'Pixel reference', os: 'Android 16' },
          fixtureHashes: {},
          iterationCount: 4,
          platform: 'android',
          samples: {},
          counters: {},
          versions: {},
        },
        'android',
      ),
    ).toThrow(/iterationCount|fixtureHashes/u);
  });

  it('rejects contradictory portable peak-memory evidence', () => {
    expect(() =>
      parseAnnotationBenchmarkInput(
        {
          counters: {
            externalNetworkAttempts: 0,
            maxAnnotationCards: 80,
            maxAnnotationPanelNodes: 800,
            maxConcurrentSerializations: 1,
            maxConcurrentWrites: 1,
            workerUrlsActiveAfterDisable: 0,
            workersStarted: 1,
          },
          environment: { device: 'Pixel reference', os: 'Android 16' },
          fixtureHashes: Object.fromEntries(
            [
              'annotation-qualification.pdf',
              'annotations-10000.pdf',
              'invalid.pdf',
              'outline-20-pages.pdf',
              'permission-restricted.pdf',
              'raster-heavy-24-pages.pdf',
              'signed-document.pdf',
              'text-12-pages.pdf',
              'text-700-pages.pdf',
            ].map((name) => [name, 'a'.repeat(64)]),
          ),
          iterationCount: 5,
          memory: {
            peakBytes: 1,
            recoverablePressureQualified: true,
            source: 'unavailable',
            unavailableReason: 'Renderer API missing.',
          },
          platform: 'android',
          samples: {
            extractionBatchMs: [1, 1, 1, 1, 1],
            filterMs: [1, 1, 1, 1, 1],
            saveMs: [1, 1, 1, 1, 1],
            searchMs: [1, 1, 1, 1, 1],
          },
          versions: { obsidian: '1', pdfjs: '1', plugin: '1' },
        },
        'android',
      ),
    ).toThrow('memory.peakBytes');
  });

  it('rejects portable Android evidence measured against a different fixture revision', () => {
    const current = portableEvidence('android');
    expect(parseAnnotationBenchmarkInput(current, 'android', current.fixtureHashes)).toEqual(
      current,
    );
    expect(() =>
      parseAnnotationBenchmarkInput(
        {
          ...current,
          fixtureHashes: {
            ...current.fixtureHashes,
            'text-12-pages.pdf': 'f'.repeat(64),
          },
        },
        'android',
        current.fixtureHashes,
      ),
    ).toThrow('current fixture metadata');
  });

  it('rejects portable Android evidence measured with a different plugin or PDF.js build', () => {
    const current = portableEvidence('android');
    const expectedVersions = { pdfjs: current.versions.pdfjs, plugin: current.versions.plugin };

    expect(
      parseAnnotationBenchmarkInput(current, 'android', current.fixtureHashes, expectedVersions),
    ).toEqual(current);
    expect(() =>
      parseAnnotationBenchmarkInput(
        { ...current, versions: { ...current.versions, plugin: 'stale-plugin' } },
        'android',
        current.fixtureHashes,
        expectedVersions,
      ),
    ).toThrow('versions.plugin does not match');
    expect(() =>
      parseAnnotationBenchmarkInput(
        { ...current, versions: { ...current.versions, pdfjs: 'stale-pdfjs' } },
        'android',
        current.fixtureHashes,
        expectedVersions,
      ),
    ).toThrow('versions.pdfjs does not match');
    expect(() =>
      parseAnnotationBenchmarkInput(
        {
          ...current,
          versions: { ...current.versions, obsidian: 'not-a-version' },
        },
        'android',
      ),
    ).toThrow('Obsidian version evidence is unavailable');
  });

  it('returns nonzero with an exact reason when desktop or Android evidence is unavailable', () => {
    const canonicalPaths = ['desktop', 'android'].map((platform) =>
      path.join(
        repoRoot,
        '.superpowers',
        'sdd',
        '2026-08-11-annotation-editor-layout-controls',
        `${platform}-annotation-benchmark.json`,
      ),
    );
    const canonicalBefore = canonicalPaths.map((file) =>
      existsSync(file) ? readFileSync(file, 'utf8') : null,
    );
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'abyss-annotation-benchmark-'));
    let desktop: SpawnSyncReturns<string>;
    let android: SpawnSyncReturns<string>;
    try {
      desktop = runBenchmark([`--output=${path.join(outputDirectory, 'desktop.json')}`], {
        ABYSS_OBSIDIAN_CLI: 'missing-obsidian-cli',
      });
      android = runBenchmark([
        '--platform=android',
        '--input=.superpowers/does-not-exist.json',
        `--output=${path.join(outputDirectory, 'android.json')}`,
      ]);
    } finally {
      rmSync(outputDirectory, { force: true, recursive: true });
    }

    expect(desktop.status).toBe(1);
    expect(`${desktop.stdout}${desktop.stderr}`).toContain('Annotation benchmark unavailable:');
    expect(android.status).toBe(1);
    expect(`${android.stdout}${android.stderr}`).toContain('Annotation benchmark unavailable:');
    expect(
      canonicalPaths.map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)),
    ).toEqual(canonicalBefore);
  });
});
