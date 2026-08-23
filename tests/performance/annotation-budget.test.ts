import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generatePdfFixtures,
  PDF_FIXTURE_NAMES,
  type PdfFixtureManifest,
} from '../fixtures/pdf-fixtures.mjs';

const HIGH_ANNOTATION_FIXTURE = 'annotations-10000.pdf';
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'abyss-annotation-budget-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(manifest: PdfFixtureManifest, name: string) {
  const metadata = manifest.files.find((entry) => entry.name === name);
  if (metadata === undefined) throw new Error(`Missing fixture metadata for ${name}.`);
  return metadata;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('annotation performance fixture', () => {
  it(
    'publishes one portable 10,000-annotation PDF with exact byte metadata',
    {
      timeout: 15_000,
    },
    async () => {
      const directory = await temporaryDirectory();
      const manifest = await generatePdfFixtures(directory);
      const metadata = fixture(manifest, HIGH_ANNOTATION_FIXTURE);
      const bytes = await readFile(path.join(directory, HIGH_ANNOTATION_FIXTURE));

      expect(PDF_FIXTURE_NAMES).toContain(HIGH_ANNOTATION_FIXTURE);
      expect(metadata).toMatchObject({
        annotations: 10_000,
        name: HIGH_ANNOTATION_FIXTURE,
        pages: 100,
      });
      expect(metadata.bytes).toBe(bytes.byteLength);
      expect(metadata.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    },
  );
});
