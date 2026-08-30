import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface SemanticResult {
  readonly deletedReopen: ReadonlyArray<Record<string, unknown>>;
  readonly editedReopen: ReadonlyArray<Record<string, unknown>>;
  readonly failures: ReadonlyArray<{
    readonly after: string;
    readonly before: string;
    readonly kind: 'abort' | 'reject';
    readonly rejected: boolean;
  }>;
  readonly firstHash: string;
  readonly firstReopen: ReadonlyArray<Record<string, unknown>>;
  readonly originalHash: string;
  readonly repeatedReopen: ReadonlyArray<Record<string, unknown>>;
  readonly repeatFirstReopen: ReadonlyArray<Record<string, unknown>>;
}

interface SemanticProcessOptions {
  readonly arguments?: readonly string[];
  readonly watchdogMs?: number;
}

function runSemanticProcess(options: SemanticProcessOptions = {}): Promise<string> {
  const runner = path.join(import.meta.dirname, 'pdf-annotation-semantics-runner.mts');
  const watchdogMs = options.watchdogMs ?? 20_000;
  const child = spawn(
    process.execPath,
    options.arguments === undefined ? ['--import', 'tsx', runner] : [...options.arguments],
    {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    let watchdogFailure: Error | null = null;
    const watchdog = setTimeout(() => {
      watchdogFailure = new Error(
        `The semantic runner exceeded its ${String(watchdogMs)} ms watchdog and was terminated.`,
      );
      child.kill('SIGKILL');
    }, watchdogMs);
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', (cause) => {
      clearTimeout(watchdog);
      reject(cause);
    });
    child.once('close', (code, signal) => {
      clearTimeout(watchdog);
      if (watchdogFailure !== null) {
        reject(watchdogFailure);
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const stderrSuffix = stderr.length === 0 ? '' : `\n${stderr}`;
      reject(
        new Error(
          `The semantic runner exited with code ${String(code)} and signal ${String(signal)}.${stderrSuffix}`,
        ),
      );
    });
  });
}

async function realPdfJsSemantics(options: SemanticProcessOptions = {}): Promise<SemanticResult> {
  const stdout = await runSemanticProcess(options);
  const prefix = 'ABYSS_SEMANTIC_RESULT=';
  const resultLine = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .pop();
  const serialized = resultLine?.slice(prefix.length);
  if (serialized === undefined) throw new Error('The semantic runner returned no result.');
  return JSON.parse(serialized) as SemanticResult;
}

describe('real PDF.js annotation semantic bytes oracle', () => {
  it(
    'preserves page, quadPoints, fill, comment, edit, delete, hash, and repeat semantics',
    { timeout: 30_000 },
    async () => {
      const result = await realPdfJsSemantics();
      const first = result.firstReopen;

      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        annotationType: 9,
        color: [255, 212, 0],
        contentsObj: { str: 'First [[Idea]] #draft' },
        pageIndex: 0,
      });
      expect(first[0]?.['quadPoints']).toEqual([72, 590, 220, 590, 72, 568, 220, 568]);
      expect(result.firstHash).not.toBe(result.originalHash);

      expect(result.editedReopen).toHaveLength(1);
      expect(result.editedReopen[0]).toMatchObject({
        annotationType: 9,
        color: [100, 216, 203],
        contentsObj: { str: 'Revised [[Idea]] #verified' },
        pageIndex: 0,
      });
      expect(result.editedReopen[0]?.['quadPoints']).toEqual(first[0]?.['quadPoints']);

      expect(result.failures).toEqual([
        expect.objectContaining({ kind: 'abort', rejected: true }),
        expect.objectContaining({ kind: 'reject', rejected: true }),
      ]);
      for (const failure of result.failures) expect(failure.after).toBe(failure.before);

      expect(result.deletedReopen).toHaveLength(0);
      expect(result.repeatFirstReopen).toHaveLength(1);
      expect(result.repeatedReopen).toHaveLength(2);
      expect(result.repeatedReopen.map((annotation) => annotation['color'])).toEqual([
        [255, 212, 0],
        [100, 216, 203],
      ]);
    },
  );

  it('terminates a child that never reaches a lifecycle result', async () => {
    await expect(
      realPdfJsSemantics({
        arguments: ['--eval', 'setTimeout(() => process.exit(0), 100)'],
        watchdogMs: 20,
      }),
    ).rejects.toThrow('The semantic runner exceeded its 20 ms watchdog and was terminated.');
  });
});
