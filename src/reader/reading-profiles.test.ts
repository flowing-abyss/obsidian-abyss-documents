import { describe, expect, it } from 'vitest';
import type { ResolvedReadingColors } from '../document-core/reading.js';
import {
  BUILTIN_PROFILES,
  ReadingProfileService,
  resolveReadingProfile,
} from './reading-profiles.js';

function resolved(colors: ResolvedReadingColors) {
  return {
    pageColors: { background: colors.background, foreground: colors.foreground },
    brightness: colors.brightness,
    contrast: colors.contrast,
    imageDim: colors.imageDim,
  };
}

describe('ReadingProfileService', () => {
  it('lets Follow Obsidian follow the theme without changing the selected profile', () => {
    const service = new ReadingProfileService();

    expect(service.resolve('follow-obsidian', 'dark')).toEqual(resolved(BUILTIN_PROFILES.dark));
    expect(service.resolve('follow-obsidian', 'light')).toEqual(resolved(BUILTIN_PROFILES.light));
  });

  it('leaves Default page colors authored by the PDF', () => {
    const custom: ResolvedReadingColors = {
      background: '#123456',
      foreground: '#fedcba',
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    };

    expect(resolveReadingProfile('default', 'dark', custom)).toMatchObject({
      pageColors: null,
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    });
  });

  it('resolves each explicit built-in independently of the Obsidian theme', () => {
    const service = new ReadingProfileService();

    expect(service.resolve('light', 'dark')).toEqual(resolved(BUILTIN_PROFILES.light));
    expect(service.resolve('sepia', 'dark')).toEqual(resolved(BUILTIN_PROFILES.sepia));
    expect(service.resolve('dark', 'light')).toEqual(resolved(BUILTIN_PROFILES.dark));
  });

  it('bounds custom rendering variables without mutating the saved profile', () => {
    const custom: ResolvedReadingColors = Object.freeze({
      background: '#123456',
      foreground: '#fedcba',
      brightness: 9,
      contrast: -2,
      imageDim: 4,
    });
    const service = new ReadingProfileService(custom);

    expect(service.resolve('custom', 'dark')).toEqual({
      pageColors: { background: '#123456', foreground: '#fedcba' },
      brightness: 1.5,
      contrast: 0.5,
      imageDim: 0.8,
    });
    expect(custom).toEqual({
      background: '#123456',
      foreground: '#fedcba',
      brightness: 9,
      contrast: -2,
      imageDim: 4,
    });
  });
});
