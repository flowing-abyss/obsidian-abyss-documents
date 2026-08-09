import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type { DocumentLocation, OutlineItem } from '../../document-core/document.js';
import {
  DocumentCancelledError,
  DocumentOpenError,
  DocumentPasswordError,
  InvalidDocumentError,
} from '../../document-core/errors.js';

const INCORRECT_PASSWORD = 2;

interface PdfReference {
  readonly num: number;
  readonly gen: number;
}

export interface PdfOutlineNode {
  readonly title: string;
  readonly dest: string | readonly unknown[] | null;
  readonly items: readonly PdfOutlineNode[];
}

interface NamedError {
  readonly name?: unknown;
  readonly code?: unknown;
}

function errorName(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const { name } = cause as NamedError;
  return typeof name === 'string' ? name : undefined;
}

function passwordCode(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const { code } = cause as NamedError;
  return typeof code === 'number' ? code : undefined;
}

function isAbortFailure(cause: unknown, name: string | undefined): boolean {
  if (name === 'AbortError' || name === 'AbortException') return true;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 20)
    return true;
  const rendered = String(cause);
  return rendered.startsWith('AbortError:') || rendered.startsWith('AbortException:');
}

export function mapPdfOpenFailure(
  path: string,
  cause: unknown,
  signal: AbortSignal,
): DocumentOpenError {
  const name = errorName(cause);
  if (signal.aborted || isAbortFailure(cause, name)) {
    return new DocumentCancelledError(path, 'Opening this PDF was cancelled.', cause);
  }
  if (name === 'PasswordException') {
    const message =
      passwordCode(cause) === INCORRECT_PASSWORD
        ? 'The PDF password was incorrect. Try again with the correct password.'
        : 'This PDF requires a password. Try again and enter the password.';
    return new DocumentPasswordError(path, message, cause);
  }
  if (name === 'InvalidPDFException') {
    return new InvalidDocumentError(path, 'This file is not a valid PDF. Try another file.', cause);
  }
  return new DocumentOpenError(path, 'Could not open this PDF. Try again.', cause);
}

function isReference(value: unknown): value is PdfReference {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PdfReference>;
  return Number.isInteger(candidate.num) && Number.isInteger(candidate.gen);
}

function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function destinationMode(destination: readonly unknown[]): string | undefined {
  const mode = destination[1];
  if (typeof mode !== 'object' || mode === null || !('name' in mode)) return undefined;
  const name = (mode as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

async function resolveDestination(
  pdf: PDFDocumentProxy,
  destination: PdfOutlineNode['dest'],
): Promise<DocumentLocation | null> {
  try {
    const explicit = await explicitDestination(pdf, destination);
    if (explicit === null || explicit.length === 0) return null;

    const pageIndex = await destinationPageIndex(pdf, explicit[0]);
    if (pageIndex === null) return null;

    return locationFromDestination(pageIndex, explicit);
  } catch {
    return null;
  }
}

async function explicitDestination(
  pdf: PDFDocumentProxy,
  destination: PdfOutlineNode['dest'],
): Promise<readonly unknown[] | null> {
  if (typeof destination !== 'string') return destination;
  return (await pdf.getDestination(destination)) as readonly unknown[] | null;
}

async function destinationPageIndex(pdf: PDFDocumentProxy, page: unknown): Promise<number | null> {
  if (typeof page === 'number' && Number.isInteger(page) && page >= 0) return page;
  if (!isReference(page)) return null;
  return pdf.getPageIndex(page);
}

function locationFromDestination(
  pageIndex: number,
  destination: readonly unknown[],
): DocumentLocation {
  if (destinationMode(destination) !== 'XYZ') return { pageIndex };
  const x = coordinate(destination[2]);
  const y = coordinate(destination[3]);
  return {
    pageIndex,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  };
}

async function mapOutlineItem(
  pdf: PDFDocumentProxy,
  item: PdfOutlineNode,
  id: string,
): Promise<OutlineItem> {
  const [target, children] = await Promise.all([
    resolveDestination(pdf, item.dest),
    Promise.all(
      item.items.map((child, childIndex) => mapOutlineItem(pdf, child, `${id}-${childIndex}`)),
    ),
  ]);
  return Object.freeze({
    id,
    label: item.title,
    target,
    children: Object.freeze(children),
  });
}

export async function mapPdfOutline(
  pdf: PDFDocumentProxy,
  outline: readonly PdfOutlineNode[] | null,
): Promise<readonly OutlineItem[]> {
  if (outline === null) return Object.freeze([]);
  return Object.freeze(
    await Promise.all(outline.map((item, index) => mapOutlineItem(pdf, item, `outline-${index}`))),
  );
}
