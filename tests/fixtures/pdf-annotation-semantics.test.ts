import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileStats, TFile, Vault } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { PdfWriteBoundary, baseTokenFor } from '../../src/adapters/pdf/pdf-write-boundary.js';
import {
  DocumentSaveCoordinator,
  type BaseToken,
} from '../../src/document-core/save-coordinator.js';

interface SemanticResult {
  readonly deletedReopen: ReadonlyArray<Record<string, unknown>>;
  readonly editedReopen: ReadonlyArray<Record<string, unknown>>;
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
  it('keeps a disposable file hash unchanged when the real save boundary rejects or aborts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'abyss-pdf-write-'));
    const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
    const sourceFile = app.vault.getAbstractFileByPath('Books/Guide.pdf');
    if (!(sourceFile instanceof MockTFile)) throw new Error('Expected a disposable PDF fixture.');
    Object.assign(sourceFile, {
      stat: { ctime: 1, mtime: 10, size: 6 } satisfies FileStats,
    });
    const source = sourceFile.asOriginalType2__();
    const diskPath = path.join(directory, source.path);
    const original = new Uint8Array([37, 80, 68, 70, 45, 49]);
    const prepared = new Uint8Array([37, 80, 68, 70, 45, 50]);
    const digest = async (): Promise<string> =>
      createHash('sha256')
        .update(await readFile(diskPath))
        .digest('hex');
    try {
      await mkdir(path.dirname(diskPath), { recursive: true });
      await writeFile(diskPath, original);
      const vault = {
        getFileByPath: (requested: string) => (requested === source.path ? source : null),
        readBinary: async () => {
          const bytes = await readFile(diskPath);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        modifyBinary: async (_file: TFile, bytes: ArrayBuffer) => {
          await writeFile(diskPath, new Uint8Array(bytes));
          source.stat.mtime += 1;
          source.stat.size = bytes.byteLength;
        },
      } as Pick<Vault, 'getFileByPath' | 'readBinary' | 'modifyBinary'>;
      const verifyPdf = async (bytes: Uint8Array): Promise<void> => {
        if (bytes[bytes.byteLength - 1] === 50) throw new Error('parser rejected prepared bytes');
      };
      const coordinator = new DocumentSaveCoordinator(new PdfWriteBoundary(vault), verifyPdf);
      const before = await digest();
      const rejectedBaseToken: BaseToken = await baseTokenFor(original, source.stat.mtime);
      const rejectedSource = {
        commit: () => undefined,
        prepare: async () => ({ revision: 1, baseToken: rejectedBaseToken, bytes: prepared }),
      };

      await expect(
        coordinator.save(
          {
            path: source.path,
            baseToken: rejectedBaseToken,
            revision: 1,
            source: rejectedSource,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ stage: 'parser-reopen', restored: true });
      expect(await digest()).toBe(before);

      const abortedBaseToken = await baseTokenFor(original, source.stat.mtime);
      const abort = new AbortController();
      const abortedSource = {
        commit: () => undefined,
        prepare: async () => {
          abort.abort(new DOMException('cancelled before write', 'AbortError'));
          return { revision: 2, baseToken: abortedBaseToken, bytes: prepared };
        },
      };
      await expect(
        coordinator.save(
          {
            path: source.path,
            baseToken: abortedBaseToken,
            revision: 2,
            source: abortedSource,
          },
          abort.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(await digest()).toBe(before);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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
