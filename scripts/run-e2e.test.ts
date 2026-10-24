import path from 'node:path';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { runE2e } from './run-e2e.mjs';

describe('E2E process launching', () => {
  it('runs JavaScript entrypoints through Node and preserves literal forwarded arguments', () => {
    vi.stubEnv('npm_execpath', '/tools/pnpm.cjs');
    const run = vi.fn(() => 0);

    expect(
      runE2e(['--', '--', '--spec', 'tests/a file.e2e.ts', '--grep', 'a "quoted" case'], run),
    ).toBe(0);

    expect(run.mock.calls).toEqual([
      [process.execPath, ['/tools/pnpm.cjs', 'dev:vault', '--', '--no-launch']],
      [
        process.execPath,
        [
          path.resolve(import.meta.dirname, '../node_modules/@wdio/cli/bin/wdio.js'),
          'run',
          'tests/e2e/wdio.conf.mts',
          '--spec',
          'tests/a file.e2e.ts',
          '--grep',
          'a "quoted" case',
        ],
      ],
    ]);
  });

  it.each([undefined, ''])('explains how to supply a missing package manager: %s', (entrypoint) => {
    vi.stubEnv('npm_execpath', entrypoint);

    expect(() => runE2e([], vi.fn())).toThrow('pnpm run test:e2e');
  });
});
