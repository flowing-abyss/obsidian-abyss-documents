import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type { SearchHit, SearchResultSet } from '../../document-core/document.js';

const MAX_PREVIEW_LENGTH = 120;

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

function makePreview(text: string, matchStart: number, matchLength: number): string {
  const prefixLength = Math.max(0, Math.floor((MAX_PREVIEW_LENGTH - matchLength - 2) / 2));
  let start = Math.max(0, matchStart - prefixLength);
  let end = Math.min(text.length, start + MAX_PREVIEW_LENGTH - 2);
  if (end - start < MAX_PREVIEW_LENGTH - 2) {
    start = Math.max(0, end - (MAX_PREVIEW_LENGTH - 2));
  }

  const hasPrefix = start > 0;
  const hasSuffix = end < text.length;
  const markerLength = Number(hasPrefix) + Number(hasSuffix);
  const contentLimit = MAX_PREVIEW_LENGTH - markerLength;
  if (end - start > contentLimit) end = start + contentLimit;

  const normalized = text.slice(start, end).replace(/\s+/gu, ' ').trim();
  return `${hasPrefix ? '…' : ''}${normalized}${hasSuffix ? '…' : ''}`;
}

function immutableResults(
  query: string,
  hits: readonly SearchHit[],
  complete: boolean,
): SearchResultSet {
  const snapshot = hits.map((hit) => Object.freeze({ ...hit }));
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
    const normalizedQuery = query.trim();
    const hits: SearchHit[] = [];
    if (normalizedQuery.length === 0) {
      const empty = immutableResults(query, hits, true);
      emit(empty);
      return empty;
    }

    const needle = normalizedQuery.toLocaleLowerCase();
    for (let pageIndex = 0; pageIndex < this.pdf.numPages; pageIndex += 1) {
      const text = await waitFor(this.getPageText(pageIndex), [signal, this.lifecycle.signal]);
      this.appendPageHits(hits, text, {
        matchLength: normalizedQuery.length,
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
    match: { readonly needle: string; readonly matchLength: number; readonly pageIndex: number },
  ): void {
    const { matchLength, needle, pageIndex } = match;
    const haystack = text.toLocaleLowerCase();
    let position = 0;
    let matchIndex = 0;
    while (position <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, position);
      if (found < 0) return;
      hits.push({
        id: `page-${pageIndex}-match-${matchIndex}`,
        pageIndex,
        matchIndex,
        preview: makePreview(text, found, matchLength),
      });
      matchIndex += 1;
      position = found + Math.max(needle.length, 1);
    }
  }
}
