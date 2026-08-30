import { execFileSync } from 'node:child_process';
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

function realPdfJsSemantics(): SemanticResult {
  const runner = path.join(import.meta.dirname, 'pdf-annotation-semantics-runner.mts');
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', runner], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
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
    () => {
      const result = realPdfJsSemantics();
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
});
