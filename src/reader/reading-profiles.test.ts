import { describe, expect, it } from 'vitest';
import type { ResolvedReadingColors } from '../document-core/reading.js';
import { BUILTIN_PROFILES, ReadingProfileService } from './reading-profiles.js';

describe('ReadingProfileService', () => {
  it('lets Auto follow Obsidian without changing the selected profile', () => {
    const service = new ReadingProfileService();

    expect(service.resolve('auto', 'dark')).toEqual(BUILTIN_PROFILES.dark);
    expect(service.resolve('auto', 'light')).toEqual(BUILTIN_PROFILES.light);
  });

  it('resolves each explicit built-in independently of the Obsidian theme', () => {
    const service = new ReadingProfileService();

    expect(service.resolve('light', 'dark')).toEqual(BUILTIN_PROFILES.light);
    expect(service.resolve('sepia', 'dark')).toEqual(BUILTIN_PROFILES.sepia);
    expect(service.resolve('dark', 'light')).toEqual(BUILTIN_PROFILES.dark);
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
      background: '#123456',
      foreground: '#fedcba',
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
