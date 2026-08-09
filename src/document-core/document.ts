import type { TFile } from 'obsidian';
import type { ResolvedReadingColors } from './reading.js';

export type DocumentCapability =
  'outline' | 'text-search' | 'existing-annotations' | 'annotation-write' | 'ocr';

export interface DocumentDescriptor {
  readonly path: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly pageCount: number;
}

export interface OutlineItem {
  readonly id: string;
  readonly label: string;
  readonly target: DocumentLocation | null;
  readonly children: readonly OutlineItem[];
}

export interface DocumentLocation {
  readonly pageIndex: number;
  readonly x?: number;
  readonly y?: number;
}

export interface SearchHit {
  readonly id: string;
  readonly pageIndex: number;
  readonly matchIndex: number;
  readonly preview: string;
}

export interface SearchResultSet {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly complete: boolean;
}

export type ViewportEvent =
  | { readonly type: 'page-change'; readonly pageIndex: number }
  | { readonly type: 'scale-change'; readonly scale: number | 'page-width' | 'page-fit' }
  | { readonly type: 'search-results'; readonly results: SearchResultSet }
  | { readonly type: 'render-error'; readonly pageIndex: number; readonly cause: unknown };

export interface DocumentViewport {
  readonly pageCount: number;
  mount(host: HTMLElement): Promise<void>;
  goTo(location: DocumentLocation): Promise<void>;
  setScale(scale: number | 'page-width' | 'page-fit'): void;
  setReadingColors(colors: ResolvedReadingColors): void;
  search(query: string): void;
  searchAgain(direction: 'next' | 'previous'): void;
  onEvent(listener: (event: ViewportEvent) => void): () => void;
  focus(): void;
  destroy(): Promise<void>;
}

export interface DocumentSession {
  readonly descriptor: DocumentDescriptor;
  readonly capabilities: ReadonlySet<DocumentCapability>;
  getOutline(): Promise<readonly OutlineItem[]>;
  createViewport(): Promise<DocumentViewport>;
  close(): Promise<void>;
}

export interface DocumentAdapter {
  readonly id: string;
  supports(file: TFile): boolean;
  open(file: TFile, signal: AbortSignal): Promise<DocumentSession>;
}
