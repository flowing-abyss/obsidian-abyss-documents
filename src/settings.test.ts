import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings.js';

describe('DEFAULT_SETTINGS', () => {
  it('defaults PDF reading to the automatic profile', () => {
    expect(DEFAULT_SETTINGS.reading).toStrictEqual({
      defaultProfile: 'auto',
      rememberPerDocument: false,
      custom: {
        background: '#202020',
        foreground: '#dddddd',
        brightness: 1,
        contrast: 1,
        imageDim: 0,
      },
    });
  });
});
