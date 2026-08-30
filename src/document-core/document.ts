import type { TFile } from 'obsidian';
import type { DocumentAnnotation } from './annotations.js';
import type { ReaderLayout, ReaderScale, ReadingAppearance } from './reading.js';

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

export type DocumentLocation =
  | {
      readonly coordinateSpace?: never;
      readonly pageIndex: number;
      readonly x?: never;
      readonly y?: never;
    }
  | {
      readonly coordinateSpace: 'page-points-top-left' | 'pdf-points-bottom-left';
      readonly pageIndex: number;
      readonly x?: number;
      readonly y?: number;
    };

export interface PdfPageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportAnnotationSnapshot {
  readonly nativeId: string;
  readonly runtimeId?: string;
  readonly provisionalId?: string;
  readonly pageIndex: number;
  readonly type: DocumentAnnotation['type'];
  readonly rects: readonly PdfPageRect[];
  readonly selectedText?: string;
  readonly color?: string;
  readonly comment?: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly writable?: boolean;
}

export type ViewportAnnotationChange =
  | { readonly operation: 'upsert'; readonly annotation: ViewportAnnotationSnapshot }
  | {
      readonly operation: 'remove';
      readonly nativeId: string;
      readonly provisionalId?: string;
    };

export interface PreviewMatchRange {
  readonly end: number;
  readonly start: number;
}

export interface SearchHit {
  readonly id: string;
  readonly pageIndex: number;
  readonly matchIndex: number;
  readonly preview: string;
  readonly previewMatches: readonly PreviewMatchRange[];
}

export interface SearchResultSet {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly complete: boolean;
}

export type ViewportEvent =
  | { readonly type: 'page-change'; readonly pageIndex: number }
  | { readonly type: 'scale-change'; readonly scale: ReaderScale }
  | { readonly type: 'search-results'; readonly results: SearchResultSet }
  | { readonly type: 'annotation-change'; readonly change: ViewportAnnotationChange }
  | {
      readonly type: 'annotation-snapshot';
      readonly annotations: readonly ViewportAnnotationSnapshot[];
    }
  | {
      readonly type: 'annotation-mutation-error';
      readonly action:
        | 'change-color'
        | 'delete-annotation'
        | 'delete-comment'
        | 'open-annotation'
        | 'save-comment';
      readonly cause: unknown;
    }
  | { readonly type: 'render-error'; readonly pageIndex: number; readonly cause: unknown };

export interface DocumentViewport {
  readonly pageCount: number;
  mount(host: HTMLElement): Promise<void>;
  goTo(location: DocumentLocation): Promise<void>;
  setScale(scale: ReaderScale): void;
  stepScale(direction: -1 | 1): void;
  setLayout(layout: ReaderLayout): void;
  setReadingColors(appearance: ReadingAppearance): void;
  search(query: string): void;
  searchAgain(direction: 'next' | 'previous'): void;
  selectSearchHit(hit: SearchHit, query: string): Promise<void>;
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
