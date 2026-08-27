import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type {
  PreviewMatchRange,
  SearchHit,
  SearchResultSet,
} from '../../document-core/document.js';

const MAX_PREVIEW_LENGTH = 120;

interface NormalizedSource {
  readonly ends: readonly number[];
  readonly hasDiacritics: boolean;
  readonly starts: readonly number[];
  readonly text: string;
}

interface SearchPreview {
  readonly matches: readonly PreviewMatchRange[];
  readonly text: string;
}

interface SourceMatchRange {
  readonly end: number;
  readonly start: number;
}

interface MappedUnit {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

const CHARACTERS_TO_NORMALIZE = new Map<string, string>([
  ['\u2010', '-'],
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201a', "'"],
  ['\u201b', "'"],
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u201e', '"'],
  ['\u201f', '"'],
  ['\u00bc', '1/4'],
  ['\u00bd', '1/2'],
  ['\u00be', '3/4'],
]);
const DIACRITICS_EXCEPTION = new Set([
  0x3099, 0x309a, 0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d3b, 0x0d3c,
  0x0d4d, 0x0dca, 0x0e3a, 0x0eba, 0x0f84, 0x1039, 0x103a, 0x1714, 0x1734, 0x17d2, 0x1a60, 0x1b44,
  0x1baa, 0x1bab, 0x1bf2, 0x1bf3, 0x2d7f, 0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed,
  0x0c56, 0x0f71, 0x0f72, 0x0f7a, 0x0f7b, 0x0f7c, 0x0f7d, 0x0f80, 0x0f74,
]);
const DIACRITICS_EXCEPTION_PATTERN = String.fromCodePoint(...DIACRITICS_EXCEPTION);
const SPECIAL_QUERY_CHARACTERS = /([+^$|])|(\p{P}+)|(\s+)|(\p{M})|(\p{L})/gu;

function cancelled(): DOMException {
  return new DOMException('PDF text search was cancelled.', 'AbortError');
}

export interface PdfTextContent {
  readonly items: ReadonlyArray<PdfTextItem | PdfTextMarkedContent>;
  readonly styles: Readonly<Record<string, unknown>>;
  readonly lang: string | null;
}

interface PdfTextItem {
  readonly str: string;
  readonly hasEOL: boolean;
}

interface PdfTextMarkedContent {
  readonly type: string;
}

function textFromContent(content: PdfTextContent): string {
  return content.items.map(textFromItem).join('');
}

function textFromItem(item: PdfTextItem | PdfTextMarkedContent): string {
  if (!('str' in item)) return '';
  return `${item.str}${item.hasEOL ? '\n' : ''}`;
}

function mappedUnits(text: string): MappedUnit[] {
  const units: MappedUnit[] = [];
  let sourceOffset = 0;
  for (const symbol of text) {
    const sourceEnd = sourceOffset + symbol.length;
    const compatibility =
      CHARACTERS_TO_NORMALIZE.get(symbol) ??
      (symbol.length === 1 && !/^\p{M}$/u.test(symbol) ? symbol.normalize('NFKC') : symbol);
    const normalized = compatibility.normalize('NFD');
    for (let index = 0; index < normalized.length; index += 1)
      units.push({ end: sourceEnd, start: sourceOffset, text: normalized[index] ?? '' });
    sourceOffset = sourceEnd;
  }
  return units;
}

function normalizeSource(text: string): NormalizedSource {
  const normalized = normalizeLineEndings(mappedUnits(text));
  return {
    ends: normalized.map((unit) => unit.end),
    hasDiacritics: normalized.some((unit) => /^\p{M}$/u.test(unit.text)),
    starts: normalized.map((unit) => unit.start),
    text: normalized.map((unit) => unit.text).join(''),
  };
}

function normalizeLineEndings(units: readonly MappedUnit[]): MappedUnit[] {
  const normalized: MappedUnit[] = [];
  for (const [index, unit] of units.entries()) {
    if (unit.text !== '\n') {
      normalized.push(unit);
      continue;
    }
    appendNormalizedLineEnding(normalized, unit, {
      beforePrevious: units[index - 2],
      next: units[index + 1],
      previous: units[index - 1],
    });
  }
  return normalized;
}

function appendNormalizedLineEnding(
  normalized: MappedUnit[],
  lineEnding: MappedUnit,
  original: {
    readonly beforePrevious: MappedUnit | undefined;
    readonly next: MappedUnit | undefined;
    readonly previous: MappedUnit | undefined;
  },
): void {
  if (original.previous?.text === '-') {
    const action = hyphenatedLineEndingAction(original.beforePrevious?.text, original.next?.text);
    if (action === 'drop-hyphen') normalized.pop();
    if (action !== 'space') return;
  }
  if (original.previous !== undefined && suppressesLineEnding(original.previous.text)) return;
  normalized.push({ ...lineEnding, text: ' ' });
}

function hyphenatedLineEndingAction(
  previous: string | undefined,
  next: string | undefined,
): 'drop-hyphen' | 'drop-line-ending' | 'space' {
  if (previous === undefined || /^\s$/u.test(previous)) return 'space';
  if (/^\p{M}$/u.test(previous) || (next !== undefined && joinsBrokenWord(previous, next)))
    return 'drop-hyphen';
  return 'drop-line-ending';
}

function joinsBrokenWord(previous: string, next: string): boolean {
  return (
    (/^\p{Ll}$/u.test(previous) && /^\p{Ll}$/u.test(next)) ||
    (/^\p{Lu}$/u.test(previous) && /^\p{L}$/u.test(next))
  );
}

function suppressesLineEnding(previous: string): boolean {
  return /^(?:\p{Ideographic}|[\u3040-\u30ff]|\p{M})$/u.test(previous);
}

function normalizeText(text: string): string {
  return normalizeSource(text).text;
}

function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function queryPattern(query: string): string {
  let pattern = '';
  let cursor = 0;
  for (const occurrence of query.matchAll(SPECIAL_QUERY_CHARACTERS)) {
    pattern += query.slice(cursor, occurrence.index);
    pattern += queryTokenPattern(query, occurrence);
    cursor = occurrence.index + occurrence[0].length;
  }
  return pattern + query.slice(cursor);
}

function queryTokenPattern(query: string, occurrence: RegExpMatchArray): string {
  const [, operator, punctuation, whitespace, mark] = occurrence;
  if (operator !== undefined) return spacedPunctuation(query, operator);
  if (punctuation !== undefined) return spacedPunctuation(query, punctuation);
  if (whitespace !== undefined) return '[ ]+';
  return mark ?? occurrence[0];
}

function spacedPunctuation(query: string, punctuation: string): string {
  const escaped = literalPattern(punctuation);
  if (punctuation === query) return escaped;
  if (query.startsWith(punctuation)) return `${escaped}[ ]*`;
  if (query.endsWith(punctuation)) return `[ ]*${escaped}`;
  return `[ ]*${escaped}[ ]*`;
}

function makePreview(
  text: string,
  activeMatch: SourceMatchRange,
  sourceMatches: readonly SourceMatchRange[],
): SearchPreview {
  const matchLength = activeMatch.end - activeMatch.start;
  const prefixLength = Math.max(0, Math.floor((MAX_PREVIEW_LENGTH - matchLength - 2) / 2));
  let start = Math.max(0, activeMatch.start - prefixLength);
  let end = Math.min(text.length, start + MAX_PREVIEW_LENGTH - 2);
  if (end - start < MAX_PREVIEW_LENGTH - 2) {
    start = Math.max(0, end - (MAX_PREVIEW_LENGTH - 2));
  }

  let hasPrefix = start > 0;
  let hasSuffix = end < text.length;
  const markerLength = Number(hasPrefix) + Number(hasSuffix);
  const contentLimit = MAX_PREVIEW_LENGTH - markerLength;
  if (end - start > contentLimit) end = start + contentLimit;
  start = alignCodePointStart(text, start);
  if (end - start > contentLimit) end = start + contentLimit;
  end = alignCodePointEnd(text, end, activeMatch.end);
  hasPrefix = start > 0;
  hasSuffix = end < text.length;

  const normalized = normalizePreview(text, start, end);
  const prefix = hasPrefix ? '…' : '';
  return {
    matches: sourceMatches.flatMap((sourceMatch) => {
      if (sourceMatch.end <= start || sourceMatch.start >= end) return [];
      const output = normalized.ranges.reduce(
        (range, source, outputOffset) => {
          if (source.end <= sourceMatch.start || source.start >= sourceMatch.end) return range;
          return {
            start: Math.min(range.start, outputOffset),
            end: Math.max(range.end, outputOffset + 1),
          };
        },
        { start: Number.POSITIVE_INFINITY, end: -1 },
      );
      if (!Number.isFinite(output.start) || output.end < 0) return [];
      return [{ start: output.start + prefix.length, end: output.end + prefix.length }];
    }),
    text: `${prefix}${normalized.text}${hasSuffix ? '…' : ''}`,
  };
}

function alignCodePointStart(text: string, offset: number): number {
  if (
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  )
    return offset - 1;
  return offset;
}

function alignCodePointEnd(text: string, offset: number, requiredEnd: number): number {
  if (
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  )
    return offset - 1 >= requiredEnd ? offset - 1 : offset + 1;
  return offset;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function normalizePreview(
  text: string,
  start: number,
  end: number,
): {
  readonly ranges: ReadonlyArray<{ readonly end: number; readonly start: number }>;
  readonly text: string;
} {
  const ranges: Array<{ end: number; start: number }> = [];
  let normalized = '';
  let pendingWhitespace: { end: number; start: number } | null = null;
  let offset = start;
  for (const symbol of text.slice(start, end)) {
    const symbolEnd = offset + symbol.length;
    if (/\s/u.test(symbol)) {
      pendingWhitespace ??= { start: offset, end: symbolEnd };
      pendingWhitespace.end = symbolEnd;
      offset = symbolEnd;
      continue;
    }
    if (pendingWhitespace !== null && normalized.length > 0) {
      normalized += ' ';
      ranges.push(pendingWhitespace);
    }
    pendingWhitespace = null;
    normalized += symbol;
    for (let index = 0; index < symbol.length; index += 1)
      ranges.push({ start: offset, end: symbolEnd });
    offset = symbolEnd;
  }
  return { ranges, text: normalized };
}

function immutableResults(
  query: string,
  hits: readonly SearchHit[],
  complete: boolean,
): SearchResultSet {
  const snapshot = hits.map((hit) =>
    Object.freeze({
      ...hit,
      previewMatches: Object.freeze(hit.previewMatches.map((range) => Object.freeze({ ...range }))),
    }),
  );
  return Object.freeze({ query, hits: Object.freeze(snapshot), complete });
}

function waitFor<T>(promise: Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted !== undefined) return Promise.reject(cancelled());

  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(cancelled());
    };
    const cleanup = (): void => {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    };
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error('Unknown PDF text extraction failure.'));
      },
    );
  });
}

export class PdfTextSearch {
  private readonly extractedText = new Map<number, string>();
  private readonly lifecycle = new AbortController();
  private disposed = false;

  constructor(private readonly pdf: PDFDocumentProxy) {}

  get cachedPageCount(): number {
    return this.extractedText.size;
  }

  async search(
    query: string,
    signal: AbortSignal,
    emit: (results: SearchResultSet) => void,
  ): Promise<SearchResultSet> {
    if (this.disposed) throw cancelled();
    signal.throwIfAborted();
    this.lifecycle.signal.throwIfAborted();
    const normalizedQuery = query.trim();
    const hits: SearchHit[] = [];
    if (normalizedQuery.length === 0) {
      const empty = immutableResults(query, hits, true);
      emit(empty);
      return empty;
    }

    const needle = normalizeText(normalizedQuery);
    for (let pageIndex = 0; pageIndex < this.pdf.numPages; pageIndex += 1) {
      signal.throwIfAborted();
      this.lifecycle.signal.throwIfAborted();
      const extraction = this.getPageText(pageIndex);
      const text = await waitFor(extraction, [signal, this.lifecycle.signal]);
      this.appendPageHits(hits, text, {
        needle,
        pageIndex,
      });
      const update = immutableResults(query, hits, pageIndex === this.pdf.numPages - 1);
      emit(update);
      if (update.complete) return update;
    }

    const complete = immutableResults(query, hits, true);
    emit(complete);
    return complete;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    this.extractedText.clear();
  }

  private async getPageText(pageIndex: number): Promise<string> {
    const cached = this.extractedText.get(pageIndex);
    if (cached !== undefined) return cached;
    const page = await this.pdf.getPage(pageIndex + 1);
    const content: PdfTextContent = await page.getTextContent();
    const text = textFromContent(content);
    if (!this.disposed) this.extractedText.set(pageIndex, text);
    return text;
  }

  private appendPageHits(
    hits: SearchHit[],
    text: string,
    match: { readonly needle: string; readonly pageIndex: number },
  ): void {
    const { needle, pageIndex } = match;
    const normalized = normalizeSource(text);
    const haystack = normalized.text;
    const sourceMatches: SourceMatchRange[] = [];
    const diacriticBoundary = normalized.hasDiacritics
      ? `(?=[${DIACRITICS_EXCEPTION_PATTERN}]|[^\\p{M}]|$)`
      : '';
    const matcher = new RegExp(`${queryPattern(needle)}${diacriticBoundary}`, 'giu');
    for (const occurrence of haystack.matchAll(matcher)) {
      const found = occurrence.index;
      const sourceStart = normalized.starts[found];
      const sourceEnd = normalized.ends[found + occurrence[0].length - 1];
      if (sourceStart === undefined || sourceEnd === undefined) break;
      sourceMatches.push({ end: sourceEnd, start: sourceStart });
    }
    for (const [matchIndex, sourceMatch] of sourceMatches.entries()) {
      const preview = makePreview(text, sourceMatch, sourceMatches);
      hits.push({
        id: `page-${pageIndex}-match-${matchIndex}`,
        pageIndex,
        matchIndex,
        preview: preview.text,
        previewMatches: preview.matches,
      });
    }
  }
}
