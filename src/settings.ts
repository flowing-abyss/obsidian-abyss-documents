import {
  DEFAULT_READER_LAYOUT,
  type ReaderLayout,
  type ReadingProfileId,
  type ResolvedReadingColors,
} from './document-core/reading.js';

export interface AnnotationPaletteEntry {
  readonly name: string;
  readonly color: string;
  readonly meaning: string;
}

export interface PluginSettings {
  readonly reading: {
    readonly defaultProfile: ReadingProfileId;
    readonly rememberPerDocument: boolean;
    readonly custom: ResolvedReadingColors;
  };
  readonly layout: {
    readonly default: ReaderLayout;
    readonly rememberPerDocument: boolean;
  };
  readonly annotations: {
    readonly author: string;
    readonly palette: readonly AnnotationPaletteEntry[];
    readonly markdownTemplate: string;
  };
  readonly debugLogging: boolean;
}

export const LEGACY_ANNOTATION_MARKDOWN_TEMPLATE =
  '> {{quote}}\n\n{{comment}}\n\n[Open annotation]({{link}})';
export const DEFAULT_ANNOTATION_MARKDOWN_TEMPLATE = '> {{quote}}\n\n{{comment}}\n\n{{link}}';

export const DEFAULT_SETTINGS: PluginSettings = {
  reading: {
    defaultProfile: 'default',
    rememberPerDocument: false,
    custom: {
      background: '#202020',
      foreground: '#dddddd',
      brightness: 1,
      contrast: 1,
      imageDim: 0,
    },
  },
  layout: {
    default: DEFAULT_READER_LAYOUT,
    rememberPerDocument: false,
  },
  annotations: {
    author: '',
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
    markdownTemplate: DEFAULT_ANNOTATION_MARKDOWN_TEMPLATE,
  },
  debugLogging: false,
};
