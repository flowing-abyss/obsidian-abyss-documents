import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings.js';

describe('DEFAULT_SETTINGS', () => {
  it('defaults PDF reading, layout, and annotation metadata independently', () => {
    expect(DEFAULT_SETTINGS.reading).toStrictEqual({
      defaultProfile: 'default',
      rememberPerDocument: false,
      custom: {
        background: '#202020',
        foreground: '#dddddd',
        brightness: 1,
        contrast: 1,
        imageDim: 0,
      },
    });
    expect(DEFAULT_SETTINGS.layout).toStrictEqual({
      default: { pages: 'single', scrolling: 'continuous' },
      rememberPerDocument: false,
    });
    expect(DEFAULT_SETTINGS.annotations).toMatchObject({
      author: '',
      markdownTemplate: '> {{quote}}\n\n{{comment}}\n\n[Open annotation]({{link}})',
      palette: [
        { name: 'Yellow', color: '#ffd400', meaning: '' },
        { name: 'Red', color: '#ff6666', meaning: '' },
        { name: 'Green', color: '#5fb236', meaning: '' },
        { name: 'Blue', color: '#2ea8e5', meaning: '' },
        { name: 'Purple', color: '#a28ae5', meaning: '' },
        { name: 'Magenta', color: '#e56eee', meaning: '' },
        { name: 'Orange', color: '#f19837', meaning: '' },
        { name: 'Gray', color: '#aaaaaa', meaning: '' },
      ],
    });
  });
});
