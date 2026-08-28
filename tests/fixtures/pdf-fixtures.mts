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
import { PDF_FIXTURE_NAMES } from './pdf-fixture-names.mjs';

export const FIXTURE_MANIFEST_FILE = 'fixtures.v1.json';
export { PDF_FIXTURE_NAMES } from './pdf-fixture-names.mjs';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const PAGE_SIZE: [number, number] = [612, 792];
const INVALID_BYTES = Buffer.from('ABYSS-DOCUMENTS INVALID PDF FIXTURE v1\n', 'utf8');

export interface PdfFixtureMetadata {
  readonly name: string;
  readonly pages: number | null;
  readonly annotations?: number;
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
    fixture(PDF_FIXTURE_NAMES[0], 12, 'Known search matches on pages 2, 7, and 11.', textFixture()),
    fixture(PDF_FIXTURE_NAMES[1], 20, 'Two-level linked outline dictionaries.', outlineFixture()),
    fixture(
      PDF_FIXTURE_NAMES[2],
      700,
      'Long page-numbered text with repeated search terms.',
      longTextFixture(),
    ),
    fixture(
      PDF_FIXTURE_NAMES[3],
      24,
      'One deterministic raster image embedded once and reused on every page.',
      rasterFixture(),
    ),
    fixture(
      PDF_FIXTURE_NAMES[4],
      null,
      'Deterministic invalid bytes for retry coverage.',
      INVALID_BYTES,
    ),
    fixture(
      PDF_FIXTURE_NAMES[5],
      100,
      'Ten thousand deterministic native highlight annotations for bounded extraction and list qualification.',
      highAnnotationFixture(),
      10_000,
    ),
    fixture(
      PDF_FIXTURE_NAMES[6],
      1,
      'Existing native Underline and Text Note annotations for read-only interoperability qualification.',
      createReadonlyAnnotationFixture(true),
      2,
    ),
    fixture(
      PDF_FIXTURE_NAMES[7],
      1,
      'Structurally signed PDF opened read-only to preserve its signature.',
      signedDocumentFixture(),
      1,
    ),
    fixture(
      PDF_FIXTURE_NAMES[8],
      1,
      'Standard Security Handler permissions deny content and annotation modification.',
      permissionRestrictedFixture(),
      1,
    ),
    fixture(
      PDF_FIXTURE_NAMES[9],
      1,
      'WinAnsi Unicode search text and one native highlight annotation.',
      unicodeAnnotationFixture(),
      1,
    ),
  ]);
  const files: PdfFixtureMetadata[] = [];
  for (const entry of generated) {
    await writeFile(path.join(outputDirectory, entry.name), entry.bytes);
    files.push({
      name: entry.name,
      pages: entry.pages,
      ...(entry.annotations === undefined ? {} : { annotations: entry.annotations }),
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
  annotations?: number,
) {
  return { name, pages, purpose, bytes: await bytes, annotations };
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

export async function createReadonlyAnnotationFixture(
  includeReadOnlyAnnotations: boolean,
): Promise<Uint8Array> {
  const { document, font } = await createDocument('Native annotation qualification fixture');
  const page = document.addPage(PAGE_SIZE);
  drawPage(
    page,
    font,
    'Native annotation qualification',
    'This page exercises PDF.js incremental annotation saves.',
  );
  if (includeReadOnlyAnnotations) {
    const underline = document.context.register(
      document.context.obj({
        Type: 'Annot',
        Subtype: 'Underline',
        Rect: [72, 540, 240, 562],
        QuadPoints: [72, 562, 240, 562, 72, 540, 240, 540],
        C: [0.1, 0.6, 0.9],
        Contents: PDFHexString.fromText('Existing underline'),
        NM: PDFHexString.fromText('readonly-underline'),
        P: page.ref,
      }),
    );
    const textNote = document.context.register(
      document.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [260, 520, 284, 544],
        C: [0.9, 0.7, 0.1],
        Contents: PDFHexString.fromText('Existing text note'),
        NM: PDFHexString.fromText('readonly-text-note'),
        Name: 'Comment',
        Open: false,
        P: page.ref,
      }),
    );
    page.node.set(PDFName.of('Annots'), document.context.obj([underline, textNote]));
  }
  return document.save({ addDefaultPage: false, useObjectStreams: false });
}

async function signedDocumentFixture(): Promise<Uint8Array> {
  const { document, font } = await createDocument('Signed document qualification fixture');
  const page = document.addPage(PAGE_SIZE);
  drawPage(
    page,
    font,
    'Signed document fixture',
    'The signature metadata makes annotation editing read-only.',
  );
  const annotation = document.context.register(
    document.context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [72, 540, 240, 562],
      QuadPoints: [72, 562, 240, 562, 72, 540, 240, 540],
      C: [1, 0.831, 0],
      Contents: PDFHexString.fromText('Signed #secure'),
      NM: PDFHexString.fromText('signed-highlight'),
      P: page.ref,
    }),
  );
  page.node.set(PDFName.of('Annots'), document.context.obj([annotation]));
  const byteRangePlaceholder = 9_999_999_999;
  const signature = document.context.register(
    document.context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, byteRangePlaceholder, byteRangePlaceholder, byteRangePlaceholder],
      Contents: PDFHexString.of('a5'.repeat(256)),
      Name: PDFHexString.fromText('Fixture Signer'),
      Reason: PDFHexString.fromText('Read-only qualification'),
      M: 'D:20260101000000Z',
    }),
  );
  const field = document.context.register(
    document.context.obj({
      FT: 'Sig',
      T: PDFHexString.fromText('Fixture Signature'),
      V: signature,
    }),
  );
  const acroForm = document.context.register(
    document.context.obj({ Fields: [field], SigFlags: 3 }),
  );
  document.catalog.set(PDFName.of('AcroForm'), acroForm);
  const bytes = Uint8Array.from(
    await document.save({ addDefaultPage: false, useObjectStreams: false }),
  );
  const source = Buffer.from(bytes).toString('latin1');
  const placeholder = '[ 0 9999999999 9999999999 9999999999 ]';
  const byteRangeOffset = source.indexOf(placeholder);
  if (byteRangeOffset < 0) throw new Error('Signed fixture ByteRange placeholder is unavailable.');
  const contentsPrefix = '/Contents <';
  const contentsStart = source.indexOf(contentsPrefix, byteRangeOffset) + contentsPrefix.length;
  const contentsEnd = contentsStart + 512;
  if (contentsStart < contentsPrefix.length || source[contentsEnd] !== '>') {
    throw new Error('Signed fixture Contents placeholder is unavailable.');
  }
  const excludedStart = contentsStart - 1;
  const excludedEnd = contentsEnd + 1;
  const replacement = `[ 0 ${String(excludedStart).padStart(10)} ${String(excludedEnd).padStart(10)} ${String(bytes.byteLength - excludedEnd).padStart(10)} ]`;
  if (replacement.length !== placeholder.length) {
    throw new Error('Signed fixture ByteRange replacement changed the file length.');
  }
  Buffer.from(replacement, 'ascii').copy(bytes, byteRangeOffset);
  return bytes;
}

function permissionRestrictedFixture(): Uint8Array {
  const fileId = Buffer.from('00112233445566778899AABBCCDDEEFF', 'hex');
  const permissions = -44;
  const owner = paddedPassword('owner');
  const user = paddedPassword('');
  const ownerKey = md5(owner).subarray(0, 5);
  const ownerEntry = rc4(ownerKey, user);
  const permissionBytes = Buffer.alloc(4);
  permissionBytes.writeInt32LE(permissions);
  const fileKey = md5(Buffer.concat([user, ownerEntry, permissionBytes, fileId])).subarray(0, 5);
  const userEntry = rc4(fileKey, PDF_PASSWORD_PADDING);
  const encrypt = (objectNumber: number, bytes: Uint8Array): Buffer => {
    const objectSuffix = Buffer.from([
      objectNumber & 0xff,
      (objectNumber >>> 8) & 0xff,
      (objectNumber >>> 16) & 0xff,
      0,
      0,
    ]);
    const key = md5(Buffer.concat([fileKey, objectSuffix])).subarray(0, 10);
    return rc4(key, bytes);
  };
  const content = encrypt(
    5,
    Buffer.from(
      'BT /F1 20 Tf 54 724 Td (Permission restricted fixture) Tj 0 -44 Td /F1 12 Tf (Editing is disabled by standard PDF permissions.) Tj ET\n',
      'ascii',
    ),
  );
  const annotationContents = encrypt(6, Buffer.from('Restricted #secure', 'utf8'));
  const annotationName = encrypt(6, Buffer.from('restricted-highlight', 'utf8'));
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
      'ascii',
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii'),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('\nendstream', 'ascii'),
    ]),
    Buffer.from(
      `<< /Type /Annot /Subtype /Highlight /Rect [72 540 240 562] /QuadPoints [72 562 240 562 72 540 240 540] /C [1 0.831 0] /Contents <${annotationContents.toString('hex')}> /NM <${annotationName.toString('hex')}> /P 3 0 R >>`,
      'ascii',
    ),
    Buffer.from(
      `<< /Filter /Standard /V 1 /Length 40 /O <${ownerEntry.toString('hex')}> /U <${userEntry.toString('hex')}> /P ${permissions} /R 2 >>`,
      'ascii',
    ),
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
    chunks.push(
      Buffer.from(`${index + 1} 0 obj\n`, 'ascii'),
      object,
      Buffer.from('\nendobj\n', 'ascii'),
    );
  }
  const xrefOffset = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
  ].join('\n');
  chunks.push(
    Buffer.from(
      `${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 7 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'ascii',
    ),
  );
  return Uint8Array.from(Buffer.concat(chunks));
}

const PDF_PASSWORD_PADDING = Buffer.from(
  '28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A',
  'hex',
);

function paddedPassword(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'latin1'), PDF_PASSWORD_PADDING]).subarray(0, 32);
}

function md5(value: Uint8Array): Buffer {
  // eslint-disable-next-line sonarjs/hashing -- Test-only PDF R2 fixtures require the legacy Standard Security Handler algorithm.
  return createHash('md5').update(value).digest();
}

function rc4(key: Uint8Array, value: Uint8Array): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_unused, index) => index);
  let right = 0;
  for (let left = 0; left < state.length; left += 1) {
    right = (right + requiredByte(state, left) + requiredByte(key, left % key.length)) & 0xff;
    swapBytes(state, left, right);
  }
  const output = Buffer.alloc(value.byteLength);
  let left = 0;
  right = 0;
  for (const [index, byte] of value.entries()) {
    left = (left + 1) & 0xff;
    right = (right + requiredByte(state, left)) & 0xff;
    swapBytes(state, left, right);
    output[index] =
      byte ^ requiredByte(state, (requiredByte(state, left) + requiredByte(state, right)) & 0xff);
  }
  return output;
}

function requiredByte(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) throw new Error(`Missing byte at ${index}.`);
  return value;
}

function swapBytes(bytes: Uint8Array, left: number, right: number): void {
  const value = requiredByte(bytes, left);
  bytes[left] = requiredByte(bytes, right);
  bytes[right] = value;
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

async function unicodeAnnotationFixture(): Promise<Uint8Array> {
  const { document, font } = await createDocument('Unicode annotation and search fixture');
  const page = document.addPage(PAGE_SIZE);
  drawPage(page, font, 'Unicode annotation fixture', 'Résumé — Café déjà vu');
  const highlight = document.context.register(
    document.context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [54, 672, 205, 690],
      QuadPoints: [54, 690, 205, 690, 54, 672, 205, 672],
      C: [1, 0.831, 0],
      Contents: PDFHexString.fromText('Unicode annotation #résumé [[Café note]]'),
      NM: PDFHexString.fromText('unicode-annotation'),
      P: page.ref,
    }),
  );
  page.node.set(PDFName.of('Annots'), document.context.obj([highlight]));
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

async function highAnnotationFixture(): Promise<Uint8Array> {
  const { document, font } = await createDocument('Deterministic high annotation fixture');
  const colors = [
    [1, 0.831, 0],
    [1, 0.4, 0.4],
    [0.373, 0.698, 0.212],
    [0.18, 0.659, 0.898],
    [0.635, 0.541, 0.898],
    [0.898, 0.431, 0.933],
    [0.945, 0.596, 0.216],
    [0.667, 0.667, 0.667],
    [0.118, 0.565, 1],
    [0.196, 0.804, 0.196],
    [0.863, 0.078, 0.235],
    [0, 0.808, 0.82],
  ] as const;
  const longUnicodeTag = `قضية-重要事項-${'длинная-метка-'.repeat(10)}финал`;
  const longUnicodeLink = `Long multilingual reference ${'— section '.repeat(12)}قضية 重要事項`;
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = document.addPage(PAGE_SIZE);
    drawPage(
      page,
      font,
      `Annotation fixture page ${pageNumber} of 100`,
      'Ten rows by ten columns provide deterministic native highlight records.',
    );
    const annotations: PDFRef[] = [];
    for (let localIndex = 0; localIndex < 100; localIndex += 1) {
      const annotationNumber = (pageNumber - 1) * 100 + localIndex;
      const geometryIndex = annotationNumber === 1 ? 0 : localIndex;
      const column = geometryIndex % 10;
      const row = Math.floor(geometryIndex / 10);
      const left = 54 + column * 50;
      const bottom = 560 - row * 28;
      const right = left + 42;
      const top = bottom + 14;
      const color = colors[annotationNumber % colors.length] ?? colors[0];
      const contents =
        annotationNumber === 0
          ? `Annotation 00000 #${longUnicodeTag} [[${longUnicodeLink}]]`
          : `Annotation ${annotationNumber.toString().padStart(5, '0')} #topic-${annotationNumber % 25} [[Topic ${annotationNumber % 100}]]`;
      annotations.push(
        document.context.register(
          document.context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: [left - 1, bottom - 1, right + 1, top + 1],
            QuadPoints: [left, top, right, top, left, bottom, right, bottom],
            C: color,
            CA: 0.75,
            Contents: PDFHexString.fromText(contents),
            T: PDFHexString.fromText('Abyss Documents'),
            NM: PDFHexString.fromText(`high-annotation-${annotationNumber}`),
            M: 'D:20260101000000Z',
            P: page.ref,
          }),
        ),
      );
    }
    page.node.set(PDFName.of('Annots'), document.context.obj(annotations));
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
