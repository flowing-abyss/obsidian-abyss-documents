import type { PDFPageProxy } from 'pdfjs-dist/build/pdf.mjs';
import { parseAnnotationTokens } from '../../annotation-tokens.js';
import type {
  AnnotationCapabilities,
  AnnotationGeometry,
  AnnotationPoint,
  AnnotationType,
  DocumentAnnotation,
  UtcTimestamp,
} from '../../document-core/annotations.js';
import { asAnnotationId, asUtcTimestamp } from '../../document-core/annotations.js';

type AnnotationBatch = (batch: readonly DocumentAnnotation[]) => void;

interface PdfAnnotationData {
  readonly annotationType?: unknown;
  readonly color?: unknown;
  readonly contentsObj?: unknown;
  readonly creationDate?: unknown;
  readonly id?: unknown;
  readonly inkLists?: unknown;
  readonly modificationDate?: unknown;
  readonly overlaidText?: unknown;
  readonly quadPoints?: unknown;
  readonly rect?: unknown;
  readonly textContent?: unknown;
  readonly titleObj?: unknown;
}

const READ_ONLY = Object.freeze({
  available: false as const,
  reason: Object.freeze({
    code: 'document-read-only' as const,
    message: 'Browse annotations are a read-only projection of PDF bytes.',
  }),
});

const NO_CONVERSION = Object.freeze({
  available: false as const,
  reason: Object.freeze({
    code: 'lossy-conversion' as const,
    message: 'Annotation browsing never converts PDF annotations.',
  }),
});

const READ_ONLY_CAPABILITIES: AnnotationCapabilities = Object.freeze({
  geometry: READ_ONLY,
  comment: READ_ONLY,
  color: READ_ONLY,
  deletion: READ_ONLY,
  metadata: READ_ONLY,
  conversions: Object.freeze({ highlight: NO_CONVERSION, underline: NO_CONVERSION }),
});

class PdfAnnotationExtractionError extends Error {
  override readonly name = 'PdfAnnotationExtractionError';

  constructor(
    readonly pageNumber: number,
    readonly cause: unknown,
  ) {
    super(`Could not extract annotations from PDF page ${pageNumber}.`);
  }
}

export async function extractAnnotations(
  pdf: {
    readonly numPages: number;
    getPage(pageNumber: number): Promise<Pick<PDFPageProxy, 'getAnnotations' | 'view'>>;
  },
  signal: AbortSignal,
  onBatch: AnnotationBatch,
): Promise<void> {
  let deadline = performance.now() + 50;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    try {
      deadline = await extractPageAnnotations(pdf, pageNumber, {
        deadline,
        onBatch,
        signal,
      });
    } catch (cause) {
      if (signal.aborted || isAbortFailure(cause)) throw cause;
      if (cause instanceof PdfAnnotationExtractionError) throw cause;
      throw new PdfAnnotationExtractionError(pageNumber, cause);
    }
  }
}

async function extractPageAnnotations(
  pdf: Parameters<typeof extractAnnotations>[0],
  pageNumber: number,
  context: {
    readonly deadline: number;
    readonly onBatch: AnnotationBatch;
    readonly signal: AbortSignal;
  },
): Promise<number> {
  const { onBatch, signal } = context;
  let nextDeadline = context.deadline;
  throwIfAborted(signal);
  const page = await pdf.getPage(pageNumber);
  throwIfAborted(signal);
  const raw = (await page.getAnnotations({ intent: 'display' })) as PdfAnnotationData[];
  let batch: DocumentAnnotation[] = [];
  for (const [index, annotation] of raw.entries()) {
    throwIfAborted(signal);
    batch.push(mapPdfAnnotation(annotation, page, pageNumber - 1, index));
    if (performance.now() < nextDeadline) continue;
    onBatch(batch);
    batch = [];
    await yieldToMainThread(signal);
    nextDeadline = performance.now() + 50;
  }
  if (batch.length > 0) onBatch(batch);
  throwIfAborted(signal);
  if (performance.now() < nextDeadline) return nextDeadline;
  await yieldToMainThread(signal);
  return performance.now() + 50;
}

function mapPdfAnnotation(
  source: PdfAnnotationData,
  page: Pick<PDFPageProxy, 'view'>,
  pageIndex: number,
  annotationIndex: number,
): DocumentAnnotation {
  const type = annotationType(source.annotationType);
  const comment = objectString(source.contentsObj);
  const tokens = parseAnnotationTokens(comment);
  return Object.freeze({
    identity:
      typeof source.id === 'string' && source.id.length > 0
        ? Object.freeze({ kind: 'stable' as const, id: asAnnotationId(source.id) })
        : Object.freeze({
            kind: 'legacy' as const,
            fingerprint: `${pageIndex}:${annotationIndex}:${JSON.stringify(source.rect ?? null)}`,
          }),
    type,
    ...(type === 'unsupported' ? { externalType: externalType(source.annotationType) } : {}),
    anchor: Object.freeze({
      kind: 'fixed-page' as const,
      pageIndex,
      coordinateSpace: 'page-points-top-left' as const,
      geometry: geometry(source, page.view),
    }),
    color: color(source.color),
    selectedText: selectedText(source.overlaidText ?? source.textContent),
    author: objectString(source.titleObj),
    createdAt: pdfDate(source.creationDate),
    modifiedAt: pdfDate(source.modificationDate),
    comment,
    tags: Object.freeze(tokens.tags.map(({ display }) => display)),
    links: Object.freeze(tokens.links),
    capabilities: READ_ONLY_CAPABILITIES,
  });
}

function annotationType(value: unknown): AnnotationType {
  switch (value) {
    case 1:
      return 'text-note';
    case 3:
      return 'free-text';
    case 9:
      return 'highlight';
    case 10:
      return 'underline';
    case 15:
      return 'ink';
    default:
      return 'unsupported';
  }
}

function geometry(source: PdfAnnotationData, view: readonly number[]): AnnotationGeometry {
  const top = finite(view[3]) ?? 0;
  const quadPoints = numericArray(source.quadPoints);
  if (quadPoints.length >= 8 && quadPoints.length % 8 === 0) {
    return {
      kind: 'quadrilaterals',
      quadrilaterals: Array.from({ length: quadPoints.length / 8 }, (_, index) => {
        const offset = index * 8;
        return {
          topLeft: point(quadPoints[offset], top - (quadPoints[offset + 1] ?? 0)),
          topRight: point(quadPoints[offset + 2], top - (quadPoints[offset + 3] ?? 0)),
          bottomLeft: point(quadPoints[offset + 4], top - (quadPoints[offset + 5] ?? 0)),
          bottomRight: point(quadPoints[offset + 6], top - (quadPoints[offset + 7] ?? 0)),
        };
      }),
    };
  }
  const inkLists = numericLists(source.inkLists);
  if (inkLists.length > 0) {
    return {
      kind: 'ink',
      paths: inkLists.map((values) => {
        const points: AnnotationPoint[] = [];
        for (let index = 0; index + 1 < values.length; index += 2)
          points.push(point(values[index], top - (values[index + 1] ?? 0)));
        return points;
      }),
    };
  }
  const rect = numericArray(source.rect);
  const left = rect[0] ?? 0;
  const bottom = rect[1] ?? 0;
  const right = rect[2] ?? left;
  const rectTop = rect[3] ?? bottom;
  if (source.annotationType === 1) return { kind: 'point', point: point(left, top - rectTop) };
  return {
    kind: 'rectangle',
    rectangle: { x: left, y: top - rectTop, width: right - left, height: rectTop - bottom },
  };
}

function point(x: number | undefined, y: number): AnnotationPoint {
  return { x: x ?? 0, y };
}

function color(value: unknown): string | null {
  const values = numericArray(value);
  if (values.length < 3) return null;
  return `#${values
    .slice(0, 3)
    .map((channel) =>
      Math.min(255, Math.max(0, Math.round(channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function selectedText(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (!Array.isArray(value)) return null;
  const text = value
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .trim();
  return text.length > 0 ? text : null;
}

function objectString(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const candidate = (value as { readonly str?: unknown }).str;
  return typeof candidate === 'string' ? candidate : '';
}

function externalType(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : 'unknown';
}

function pdfDate(value: unknown): UtcTimestamp | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  if ([year, month, day, hour, minute, second].some((part) => part === undefined)) return null;
  try {
    return asUtcTimestamp(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  } catch {
    return null;
  }
}

function numericArray(value: unknown): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return [];
  return Array.from(value as ArrayLike<unknown>).flatMap((item) =>
    typeof item === 'number' && Number.isFinite(item) ? [item] : [],
  );
}

function numericLists(value: unknown): number[][] {
  return Array.isArray(value) ? value.map(numericArray).filter((list) => list.length >= 2) : [];
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Annotation extraction was cancelled.', 'AbortError');
}

function isAbortFailure(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
  );
}

async function yieldToMainThread(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  throwIfAborted(signal);
}
