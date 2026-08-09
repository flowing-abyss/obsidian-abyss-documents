import type { ReadingProfileId, ResolvedReadingColors } from './document-core/reading.js';

export interface PluginSettings {
  readonly reading: {
    readonly defaultProfile: ReadingProfileId;
    readonly rememberPerDocument: boolean;
    readonly custom: ResolvedReadingColors;
  };
  readonly debugLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  reading: {
    defaultProfile: 'auto',
    rememberPerDocument: false,
    custom: {
      background: '#202020',
      foreground: '#dddddd',
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    },
  },
  debugLogging: false,
};
