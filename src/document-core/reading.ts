export type ReadingProfileId = 'auto' | 'light' | 'sepia' | 'dark' | 'custom';

export interface ResolvedReadingColors {
  readonly background: string;
  readonly foreground: string;
  readonly brightness: number;
  readonly contrast: number;
  readonly imageDim: number;
}
