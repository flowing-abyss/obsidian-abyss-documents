import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFObject } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_MANIFEST_FILE,
  generatePdfFixtures,
  type PdfFixtureManifest,
} from './pdf-fixtures.mjs';

const temporaryDirectories: string[] = [];
const standardFontDataUrl = `${path.join(
  path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))),
  'standard_fonts',
)}/`;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'abyss-pdf-fixtures-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

function pageText(file: string): string[] {
  const script = `
    import { readFile } from 'node:fs/promises';
    import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
    const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(process.argv[1])), standardFontDataUrl: process.argv[2] });
    const document = await task.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      pages.push(content.items.flatMap((item) => 'str' in item ? [item.str] : []).join(' ').trim());
    }
    await task.destroy();
    process.stdout.write(JSON.stringify(pages));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', script, file, standardFontDataUrl],
      {
        cwd: path.resolve(import.meta.dirname, '..', '..'),
        encoding: 'utf8',
      },
    ),
  ) as string[];
}

function fixture(manifest: PdfFixtureManifest, name: string) {
  const value = manifest.files.find((candidate) => candidate.name === name);
  if (value === undefined) throw new Error(`Missing fixture metadata for ${name}.`);
  return value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('generatePdfFixtures', () => {
  it('produces byte-identical PDFs and versioned metadata on repeated runs', async () => {
    const firstDirectory = await temporaryDirectory();
    const secondDirectory = await temporaryDirectory();

    const first = await generatePdfFixtures(firstDirectory);
    const second = await generatePdfFixtures(secondDirectory);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      generator: { name: 'pdf-lib', version: '1.17.1' },
      files: [
        { name: 'text-12-pages.pdf', pages: 12 },
        { name: 'outline-20-pages.pdf', pages: 20 },
        { name: 'text-700-pages.pdf', pages: 700 },
        { name: 'raster-heavy-24-pages.pdf', pages: 24 },
        { name: 'invalid.pdf', pages: null },
      ],
    });
    for (const entry of first.files) {
      expect(await sha256(path.join(firstDirectory, entry.name))).toBe(entry.sha256);
      expect(await sha256(path.join(secondDirectory, entry.name))).toBe(entry.sha256);
    }
    expect(
      JSON.parse(await readFile(path.join(firstDirectory, FIXTURE_MANIFEST_FILE), 'utf8')),
    ).toEqual(first);
  });

  it('writes fixture paths containing URL-reserved characters as filesystem paths', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'abyss fixtures # ? %-'));
    temporaryDirectories.push(directory);

    const manifest = await generatePdfFixtures(directory);

    expect(await sha256(path.join(directory, 'text-12-pages.pdf'))).toBe(
      fixture(manifest, 'text-12-pages.pdf').sha256,
    );
    expect(JSON.parse(await readFile(path.join(directory, FIXTURE_MANIFEST_FILE), 'utf8'))).toEqual(
      manifest,
    );
  });

  it('places the known search term only on pages 2, 7, and 11 of the search fixture', async () => {
    const directory = await temporaryDirectory();
    await generatePdfFixtures(directory);

    const pages = pageText(path.join(directory, 'text-12-pages.pdf'));

    expect(
      pages.flatMap((text, index) =>
        text.toLocaleLowerCase().includes('gradient') ? [index + 1] : [],
      ),
    ).toEqual([2, 7, 11]);
  });

  it('writes a linked two-level outline dictionary with explicit page destinations', async () => {
    const directory = await temporaryDirectory();
    await generatePdfFixtures(directory);
    const document = await PDFDocument.load(
      Uint8Array.from(await readFile(path.join(directory, 'outline-20-pages.pdf'))),
    );

    const outlines = document.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const firstChapter = outlines.lookup(PDFName.of('First'), PDFDict);
    const firstSection = firstChapter.lookup(PDFName.of('First'), PDFDict);

    expect(outlines.lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(12);
    expect(firstChapter.get(PDFName.of('Parent'))).toBe(
      document.catalog.get(PDFName.of('Outlines')),
    );
    expect(firstSection.get(PDFName.of('Parent'))).toBe(outlines.get(PDFName.of('First')));
    const destination = firstSection.lookup(PDFName.of('Dest')) as PDFObject;
    expect(destination.toString()).toMatch(/^\[ \d+ 0 R \/Fit \]$/u);
  });

  it('embeds one raster image and reuses it across all 24 pages', async () => {
    const directory = await temporaryDirectory();
    const manifest = await generatePdfFixtures(directory);
    const bytes = await readFile(path.join(directory, 'raster-heavy-24-pages.pdf'));
    const document = await PDFDocument.load(Uint8Array.from(bytes));
    const images = document.context
      .enumerateIndirectObjects()
      .filter(([, object]) =>
        object instanceof PDFRawStream
          ? object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
          : false,
      );

    expect(document.getPageCount()).toBe(24);
    expect(images).toHaveLength(1);
    expect(fixture(manifest, 'raster-heavy-24-pages.pdf').purpose).toContain('reused');
  });

  it('writes fixed invalid bytes instead of a parseable PDF', async () => {
    const directory = await temporaryDirectory();
    await generatePdfFixtures(directory);

    const bytes = await readFile(path.join(directory, 'invalid.pdf'));

    expect(bytes.toString('utf8')).toBe('ABYSS-DOCUMENTS INVALID PDF FIXTURE v1\n');
    await expect(PDFDocument.load(Uint8Array.from(bytes))).rejects.toThrow();
  });
});
