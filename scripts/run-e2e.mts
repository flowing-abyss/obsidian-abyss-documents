import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function normalizeForwardedE2eArguments(arguments_: readonly string[]): string[] {
  let first = 0;
  while (arguments_[first] === '--') first += 1;
  return arguments_.slice(first);
}

function run(command: string, arguments_: readonly string[]): number {
  const result = spawnSync(command, arguments_, { stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

export function runE2e(
  arguments_: readonly string[],
  runCommand: (command: string, arguments_: readonly string[]) => number = run,
): number {
  const pnpmEntrypoint = process.env['npm_execpath'];
  if (pnpmEntrypoint === undefined || pnpmEntrypoint.length === 0) {
    throw new Error('Run E2E with `pnpm run test:e2e` so its pinned package manager is available.');
  }
  // Use pnpm's actual native executable or its JS entrypoint, rather than a
  // Windows .cmd shim. Keep arguments separate from shell interpretation.
  const pnpmIsScript = /\.[cm]?js$/iu.test(pnpmEntrypoint);
  const setupStatus = runCommand(pnpmIsScript ? process.execPath : pnpmEntrypoint, [
    ...(pnpmIsScript ? [pnpmEntrypoint] : []),
    'dev:vault',
    '--',
    '--no-launch',
  ]);
  if (setupStatus !== 0) return setupStatus;
  return runCommand(process.execPath, [
    path.resolve(import.meta.dirname, '../node_modules/@wdio/cli/bin/wdio.js'),
    'run',
    'tests/e2e/wdio.conf.mts',
    ...normalizeForwardedE2eArguments(arguments_),
  ]);
}

function main(): void {
  process.exitCode = runE2e(process.argv.slice(2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
