import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  rgb,
  type PDFContext,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';

export const FIXTURE_MANIFEST_FILE = 'fixtures.v1.json';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const PAGE_SIZE: [number, number] = [612, 792];
const INVALID_BYTES = Buffer.from('ABYSS-DOCUMENTS INVALID PDF FIXTURE v1\n', 'utf8');

export interface PdfFixtureMetadata {
  readonly name: string;
  readonly pages: number | null;
  readonly purpose: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PdfFixtureManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: '2026-01-01T00:00:00.000Z';
  readonly generator: { readonly name: 'pdf-lib'; readonly version: '1.17.1' };
  readonly files: readonly PdfFixtureMetadata[];
}

interface OutlineEntry {
  readonly title: string;
  readonly pageIndex: number;
  readonly children: readonly OutlineEntry[];
}

export async function generatePdfFixtures(outputDirectory: string): Promise<PdfFixtureManifest> {
  await mkdir(outputDirectory, { recursive: true });
  const generated = await Promise.all([
    fixture('text-12-pages.pdf', 12, 'Known search matches on pages 2, 7, and 11.', textFixture()),
    fixture('outline-20-pages.pdf', 20, 'Two-level linked outline dictionaries.', outlineFixture()),
    fixture(
      'text-700-pages.pdf',
      700,
      'Long page-numbered text with repeated search terms.',
      longTextFixture(),
    ),
    fixture(
      'raster-heavy-24-pages.pdf',
      24,
      'One deterministic raster image embedded once and reused on every page.',
      rasterFixture(),
    ),
    fixture('invalid.pdf', null, 'Deterministic invalid bytes for retry coverage.', INVALID_BYTES),
  ]);
  const files: PdfFixtureMetadata[] = [];
  for (const entry of generated) {
    await writeFile(path.join(outputDirectory, entry.name), entry.bytes);
    files.push({
      name: entry.name,
      pages: entry.pages,
      purpose: entry.purpose,
      bytes: entry.bytes.byteLength,
      sha256: createHash('sha256').update(entry.bytes).digest('hex'),
    });
  }
  const manifest: PdfFixtureManifest = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    generator: { name: 'pdf-lib', version: '1.17.1' },
    files,
  };
  await writeFile(
    path.join(outputDirectory, FIXTURE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function fixture(
  name: string,
  pages: number | null,
  purpose: string,
  bytes: Uint8Array | Promise<Uint8Array>,
) {
  return { name, pages, purpose, bytes: await bytes };
}

async function createDocument(title: string): Promise<{ document: PDFDocument; font: PDFFont }> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle(title);
  document.setAuthor('Abyss Documents');
  document.setCreator('Abyss Documents deterministic fixture generator');
  document.setProducer('pdf-lib 1.17.1');
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
  document.setLanguage('en-US');
  const font = await document.embedFont(StandardFonts.Helvetica);
  return { document, font };
}

function drawPage(page: PDFPage, font: PDFFont, heading: string, body: string): void {
  page.drawText(heading, { color: rgb(0.1, 0.1, 0.1), font, size: 20, x: 54, y: 724 });
  page.drawText(body, {
    color: rgb(0.15, 0.15, 0.15),
    font,
    lineHeight: 22,
    maxWidth: 500,
    size: 12,
    x: 54,
    y: 680,
  });
}

async function textFixture(): Promise<Uint8Array> {
  const { document, font } = await createDocument('Deterministic search fixture');
  const matches = new Set([2, 7, 11]);
  for (let pageNumber = 1; pageNumber <= 12; pageNumber += 1) {
    const page = document.addPage(PAGE_SIZE);
    const phrase = matches.has(pageNumber)
      ? `The gradient marker appears on fixture page ${pageNumber}.`
      : `This is fixture page ${pageNumber} with ordinary searchable text.`;
    drawPage(page, font, `Search fixture page ${pageNumber}`, phrase);
  }
  return document.save({ addDefaultPage: false, useObjectStreams: false });
}

async function longTextFixture(): Promise<Uint8Array> {
  const { document, font } = await createDocument('Deterministic long document fixture');
  for (let pageNumber = 1; pageNumber <= 700; pageNumber += 1) {
    const page = document.addPage(PAGE_SIZE);
    drawPage(
      page,
      font,
      `Long document page ${pageNumber} of 700`,
      `Repeated long-document marker ${String(pageNumber).padStart(3, '0')}. ` +
        'This page exists to exercise distant navigation and bounded rendering.',
    );
  }
  return document.save({ addDefaultPage: false, useObjectStreams: false });
}

async function outlineFixture(): Promise<Uint8Array> {
  const { document, font } = await createDocument('Deterministic outline fixture');
  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const page = document.addPage(PAGE_SIZE);
    drawPage(
      page,
      font,
      `Outline fixture page ${pageNumber}`,
      `Chapter material on page ${pageNumber}.`,
    );
  }
  installTwoLevelOutline(document, [
    chapter('Chapter 1', 0, 1, 3),
    chapter('Chapter 2', 10, 11, 13),
    chapter('Chapter 3', 15, 16, 17),
    chapter('Appendix', 18, 18, 19),
  ]);
  return document.save({ addDefaultPage: false, useObjectStreams: false });
}

function chapter(
  title: string,
  pageIndex: number,
  firstChild: number,
  secondChild: number,
): OutlineEntry {
  return {
    title,
    pageIndex,
    children: [
      { title: `${title} · Section 1`, pageIndex: firstChild, children: [] },
      { title: `${title} · Section 2`, pageIndex: secondChild, children: [] },
    ],
  };
}

/**
 * pdf-lib has no high-level outline writer in 1.17.1, so this builds the PDF
 * 32000 outline linked lists directly: the catalog references one /Outlines
 * root; every sibling uses /Prev and /Next; every child uses /Parent; open
 * branch /Count values include visible descendants; and /Dest points at the
 * indirect page reference with /Fit. Tests load the saved bytes and verify
 * those links, guarding this deliberately low-level dictionary construction.
 */
export function installTwoLevelOutline(
  document: PDFDocument,
  entries: readonly OutlineEntry[],
): void {
  if (entries.length === 0) throw new Error('An outline requires at least one entry.');
  const { context } = document;
  const rootRef = context.nextRef();
  const chapterRefs = entries.map(() => context.nextRef());
  const childRefs = entries.map((entry) => entry.children.map(() => context.nextRef()));
  const pageRef = (pageIndex: number): PDFRef => {
    const page = document.getPage(pageIndex);
    return page.ref;
  };
  for (const [chapterIndex, entry] of entries.entries()) {
    const refs = childRefs[chapterIndex] ?? [];
    const chapterRef = requiredRef(chapterRefs, chapterIndex);
    assignChildren(context, pageRef, chapterRef, entry.children, refs);
    assignChapter(context, pageRef, rootRef, entry, chapterRef, chapterIndex, chapterRefs, refs);
  }
  context.assign(
    rootRef,
    context.obj({
      Type: 'Outlines',
      First: requiredRef(chapterRefs, 0),
      Last: requiredRef(chapterRefs, chapterRefs.length - 1),
      Count: entries.reduce((count, entry) => count + 1 + entry.children.length, 0),
    }),
  );
  document.catalog.set(PDFName.of('Outlines'), rootRef);
  document.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

function assignChildren(
  context: PDFContext,
  pageRef: (pageIndex: number) => PDFRef,
  parentRef: PDFRef,
  children: readonly OutlineEntry[],
  refs: readonly PDFRef[],
): void {
  for (const [index, child] of children.entries()) {
    const ref = requiredRef(refs, index);
    context.assign(
      ref,
      context.obj({
        Title: PDFHexString.fromText(child.title),
        Parent: parentRef,
        ...(index > 0 ? { Prev: requiredRef(refs, index - 1) } : {}),
        ...(index + 1 < refs.length ? { Next: requiredRef(refs, index + 1) } : {}),
        Dest: [pageRef(child.pageIndex), PDFName.of('Fit')],
      }),
    );
  }
}

function assignChapter(
  context: PDFContext,
  pageRef: (pageIndex: number) => PDFRef,
  rootRef: PDFRef,
  entry: OutlineEntry,
  chapterRef: PDFRef,
  index: number,
  chapterRefs: readonly PDFRef[],
  childRefs: readonly PDFRef[],
): void {
  context.assign(
    chapterRef,
    context.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: rootRef,
      ...(index > 0 ? { Prev: requiredRef(chapterRefs, index - 1) } : {}),
      ...(index + 1 < chapterRefs.length ? { Next: requiredRef(chapterRefs, index + 1) } : {}),
      ...(childRefs.length > 0
        ? {
            First: requiredRef(childRefs, 0),
            Last: requiredRef(childRefs, childRefs.length - 1),
            Count: childRefs.length,
          }
        : {}),
      Dest: [pageRef(entry.pageIndex), PDFName.of('Fit')],
    }),
  );
}

function requiredRef(refs: readonly PDFRef[], index: number): PDFRef {
  const ref = refs[index];
  if (ref === undefined) throw new Error(`Missing outline reference at index ${index}.`);
  return ref;
}

async function rasterFixture(): Promise<Uint8Array> {
  const { document, font } = await createDocument('Deterministic raster fixture');
  const image = await document.embedPng(deterministicPng(1024, 768));
  for (let pageNumber = 1; pageNumber <= 24; pageNumber += 1) {
    const page = document.addPage(PAGE_SIZE);
    page.drawImage(image, { height: 648, width: 512, x: 50, y: 90 });
    page.drawText(`Raster fixture page ${pageNumber}`, {
      color: rgb(0.1, 0.1, 0.1),
      font,
      size: 14,
      x: 50,
      y: 56,
    });
  }
  return document.save({ addDefaultPage: false, useObjectStreams: false });
}

function deterministicPng(width: number, height: number): Uint8Array {
  const rowBytes = width * 3 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      pixels[offset] = (x + y) % 256;
      pixels[offset + 1] = (x * 3 + y * 5) % 256;
      pixels[offset + 2] = (x * 7 + y * 11) % 256;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
