import { spawnSync } from 'node:child_process';
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
  const setupStatus = runCommand('pnpm', ['dev:vault', '--', '--no-launch']);
  if (setupStatus !== 0) return setupStatus;
  return runCommand('wdio', [
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
