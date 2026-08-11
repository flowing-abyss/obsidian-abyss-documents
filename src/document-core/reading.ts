export type ReaderScale = number | 'page-width' | 'page-fit' | 'page-height';

export type ReaderPages = 'single' | 'facing';

export type ReaderScrolling = 'continuous' | 'page-by-page';

export interface ReaderLayout {
  readonly pages: ReaderPages;
  readonly scrolling: ReaderScrolling;
}

export const DEFAULT_READER_LAYOUT: ReaderLayout = {
  pages: 'single',
  scrolling: 'continuous',
};

export type ReadingProfileId =
  'default' | 'follow-obsidian' | 'light' | 'sepia' | 'dark' | 'custom';

export interface ResolvedReadingProfile {
  readonly pageColors: { readonly background: string; readonly foreground: string } | null;
  readonly brightness: number;
  readonly contrast: number;
  readonly imageDim: number;
}

export interface ResolvedReadingColors {
  readonly background: string;
  readonly foreground: string;
  readonly brightness: number;
  readonly contrast: number;
  readonly imageDim: number;
}

export type ReadingAppearance = ResolvedReadingColors | ResolvedReadingProfile;
