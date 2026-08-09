import type { ReadingProfileId, ResolvedReadingColors } from '../document-core/reading.js';

export type ObsidianTheme = 'dark' | 'light';

type BuiltinProfileId = Exclude<ReadingProfileId, 'auto' | 'custom'>;

const DEFAULT_CUSTOM_PROFILE: ResolvedReadingColors = {
  background: '#202020',
  foreground: '#dddddd',
  brightness: 1,
  contrast: 1,
  imageDim: 0,
};

export const BUILTIN_PROFILES: Readonly<Record<BuiltinProfileId, ResolvedReadingColors>> = {
  light: {
    background: '#f7f7f5',
    foreground: '#202020',
    brightness: 1,
    contrast: 1,
    imageDim: 0,
  },
  sepia: {
    background: '#f4ecd8',
    foreground: '#433422',
    brightness: 0.98,
    contrast: 0.96,
    imageDim: 0.08,
  },
  dark: {
    background: '#202020',
    foreground: '#e6e1d8',
    brightness: 0.86,
    contrast: 0.95,
    imageDim: 0.18,
  },
};

export class ReadingProfileService {
  private custom: ResolvedReadingColors;

  constructor(custom: ResolvedReadingColors = DEFAULT_CUSTOM_PROFILE) {
    this.custom = custom;
  }

  setCustom(custom: ResolvedReadingColors): void {
    this.custom = custom;
  }

  resolve(profile: ReadingProfileId, obsidianTheme: ObsidianTheme): ResolvedReadingColors {
    if (profile === 'auto') return BUILTIN_PROFILES[obsidianTheme];
    if (profile === 'custom') return bounded(this.custom);
    return BUILTIN_PROFILES[profile];
  }
}

function bounded(colors: ResolvedReadingColors): ResolvedReadingColors {
  return {
    background: colors.background,
    foreground: colors.foreground,
    brightness: clamp(colors.brightness, 0.5, 1.5, 1),
    contrast: clamp(colors.contrast, 0.5, 1.5, 1),
    imageDim: clamp(colors.imageDim, 0, 0.8, 0),
  };
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
