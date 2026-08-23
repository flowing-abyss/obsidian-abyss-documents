import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface CurrentBuildVersions {
  readonly pdfjs: string;
  readonly plugin: string;
}

export function requireMatchingBuildVersions(
  measured: CurrentBuildVersions,
  expected?: Readonly<CurrentBuildVersions>,
): void {
  if (expected === undefined) return;
  for (const name of ['pdfjs', 'plugin'] as const) {
    if (measured[name] !== expected[name]) {
      throw new Error(
        `versions.${name} does not match the current build metadata. Regenerate or remeasure the portable Android sample.`,
      );
    }
  }
}

export async function readCurrentBuildVersions(repoRoot: string): Promise<CurrentBuildVersions> {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'),
  );
  const packageJson: unknown = JSON.parse(
    await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  return parseCurrentBuildVersions(manifest, packageJson);
}

export function parseCurrentBuildVersions(
  manifestValue: unknown,
  packageValue: unknown,
): CurrentBuildVersions {
  const manifest = record(manifestValue, 'manifest.json');
  const packageJson = record(packageValue, 'package.json');
  const dependencies = record(packageJson['dependencies'], 'package.json dependencies');
  const plugin = text(manifest['version'], 'manifest.json version');
  const packageVersion = text(packageJson['version'], 'package.json version');
  if (plugin !== packageVersion) {
    throw new Error('manifest.json and package.json versions must match before benchmarking.');
  }
  return {
    pdfjs: text(dependencies['pdfjs-dist'], 'package.json dependencies.pdfjs-dist'),
    plugin,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}
