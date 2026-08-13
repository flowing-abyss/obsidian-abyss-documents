import {
  DEFAULT_READER_LAYOUT,
  type ReaderLayout,
  type ReaderPages,
  type ReaderScrolling,
  type ReadingProfileId,
  type ResolvedReadingColors,
} from './document-core/reading.js';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings.js';

type V1ReadingProfileId = 'auto' | 'light' | 'sepia' | 'dark' | 'custom';

interface PluginSettingsV1 {
  readonly reading: {
    readonly defaultProfile: V1ReadingProfileId;
    readonly rememberPerDocument: boolean;
    readonly custom: ResolvedReadingColors;
  };
  readonly debugLogging: boolean;
}

export interface PluginDataV1 {
  readonly schemaVersion: 1;
  readonly settings: PluginSettingsV1;
  readonly view: {
    readonly sidebar: { readonly open: false };
    readonly selectedTab: 'outline' | 'search';
    readonly sidebarWidth: number;
    readonly profileByFingerprint: Readonly<Record<string, V1ReadingProfileId>>;
  };
}

export interface PluginDataV2 {
  readonly schemaVersion: 2;
  readonly settings: PluginSettings;
  readonly view: {
    readonly sidebar: { readonly open: false };
    readonly selectedTab: 'outline' | 'search';
    readonly sidebarWidth: number;
    readonly profileByFingerprint: Readonly<Record<string, ReadingProfileId>>;
    readonly layoutByFingerprint: Readonly<Record<string, ReaderLayout>>;
  };
}

export interface MigrationDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface MigrationResult {
  readonly data: PluginDataV2;
  readonly diagnostics: readonly MigrationDiagnostic[];
  readonly sourceVersion: 1 | 2 | 'absent' | 'unknown';
}

export const DEFAULT_DATA: PluginDataV2 = {
  schemaVersion: 2,
  settings: DEFAULT_SETTINGS,
  view: {
    sidebar: { open: false },
    selectedTab: 'outline',
    sidebarWidth: 320,
    profileByFingerprint: {},
    layoutByFingerprint: {},
  },
};

interface PluginDataPersistence {
  loadData(): Promise<unknown>;
  saveData(data: PluginDataV2): Promise<void>;
}

export class PluginDataStore {
  private writeQueue: Promise<void> = Promise.resolve();

  private currentSnapshot: PluginDataV2 = DEFAULT_DATA;
  private lastMigrationResult: MigrationResult = {
    data: DEFAULT_DATA,
    diagnostics: [],
    sourceVersion: 'absent',
  };

  constructor(private readonly persistence: PluginDataPersistence) {}

  get snapshot(): PluginDataV2 {
    return this.currentSnapshot;
  }

  get migrationResult(): MigrationResult {
    return this.lastMigrationResult;
  }

  async load(): Promise<PluginDataV2> {
    const saved = await this.persistence.loadData();
    this.lastMigrationResult = migratePluginData(saved);
    this.currentSnapshot = this.lastMigrationResult.data;
    return this.snapshot;
  }

  update(mutator: (data: PluginDataV2) => PluginDataV2): Promise<void> {
    const update = this.writeQueue.then(async () => {
      const next = mutator(this.snapshot);
      await this.persistence.saveData(next);
      this.currentSnapshot = next;
    });
    this.writeQueue = update.catch(() => undefined);
    return update;
  }
}

export function migratePluginData(saved: unknown): MigrationResult {
  if (saved === null || saved === undefined) {
    return { data: DEFAULT_DATA, diagnostics: [], sourceVersion: 'absent' };
  }
  if (!isRecord(saved) || !isRecord(saved['settings']) || !isRecord(saved['view'])) {
    return { data: DEFAULT_DATA, diagnostics: [], sourceVersion: 'unknown' };
  }
  if (saved['schemaVersion'] === 1) return migrateV1(saved);
  if (saved['schemaVersion'] === 2) return migrateV2(saved);
  return { data: DEFAULT_DATA, diagnostics: [], sourceVersion: 'unknown' };
}

function migrateV1(saved: Record<string, unknown>): MigrationResult {
  const diagnostics: MigrationDiagnostic[] = [];
  const settings = migrateSettings(saved['settings'], diagnostics, true);
  const view = migrateView(saved['view'], diagnostics, true);
  return { data: { schemaVersion: 2, settings, view }, diagnostics, sourceVersion: 1 };
}

function migrateV2(saved: Record<string, unknown>): MigrationResult {
  const diagnostics: MigrationDiagnostic[] = [];
  const settings = migrateSettings(saved['settings'], diagnostics, false);
  const view = migrateView(saved['view'], diagnostics, false);
  return { data: { schemaVersion: 2, settings, view }, diagnostics, sourceVersion: 2 };
}

function migrateSettings(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
  fromV1: boolean,
): PluginSettings {
  const settings = isRecord(value) ? value : {};
  return {
    reading: migrateReading(settings['reading'], diagnostics, fromV1),
    layout: migrateLayout(settings['layout'], diagnostics, fromV1),
    annotations: migrateAnnotations(settings['annotations'], diagnostics, fromV1),
    debugLogging: boolean(
      settings['debugLogging'],
      DEFAULT_SETTINGS.debugLogging,
      'settings.debugLogging',
      diagnostics,
    ),
  };
}

function migrateReading(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
  fromV1: boolean,
): PluginSettings['reading'] {
  const reading = isRecord(value) ? value : {};
  return {
    defaultProfile: profile(
      reading['defaultProfile'],
      'settings.reading.defaultProfile',
      diagnostics,
      fromV1,
    ),
    rememberPerDocument: boolean(
      reading['rememberPerDocument'],
      DEFAULT_SETTINGS.reading.rememberPerDocument,
      'settings.reading.rememberPerDocument',
      diagnostics,
    ),
    custom: migrateCustomReading(reading['custom'], diagnostics),
  };
}

function migrateCustomReading(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
): ResolvedReadingColors {
  const custom = isRecord(value) ? value : {};
  return {
    background: string(
      custom['background'],
      DEFAULT_SETTINGS.reading.custom.background,
      'settings.reading.custom.background',
      diagnostics,
    ),
    foreground: string(
      custom['foreground'],
      DEFAULT_SETTINGS.reading.custom.foreground,
      'settings.reading.custom.foreground',
      diagnostics,
    ),
    brightness: number(
      custom['brightness'],
      DEFAULT_SETTINGS.reading.custom.brightness,
      'settings.reading.custom.brightness',
      diagnostics,
    ),
    contrast: number(
      custom['contrast'],
      DEFAULT_SETTINGS.reading.custom.contrast,
      'settings.reading.custom.contrast',
      diagnostics,
    ),
    imageDim: number(
      custom['imageDim'],
      DEFAULT_SETTINGS.reading.custom.imageDim,
      'settings.reading.custom.imageDim',
      diagnostics,
    ),
  };
}

function migrateLayout(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
  fromV1: boolean,
): PluginSettings['layout'] {
  if (fromV1) return DEFAULT_SETTINGS.layout;
  const layout = isRecord(value) ? value : {};
  return {
    default: layoutValue(
      isRecord(layout['default']) ? layout['default'] : {},
      'settings.layout.default',
      diagnostics,
    ),
    rememberPerDocument: boolean(
      layout['rememberPerDocument'],
      DEFAULT_SETTINGS.layout.rememberPerDocument,
      'settings.layout.rememberPerDocument',
      diagnostics,
    ),
  };
}

function migrateAnnotations(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
  fromV1: boolean,
): PluginSettings['annotations'] {
  if (fromV1) return DEFAULT_SETTINGS.annotations;
  const annotations = isRecord(value) ? value : {};
  return {
    author: string(
      annotations['author'],
      DEFAULT_SETTINGS.annotations.author,
      'settings.annotations.author',
      diagnostics,
    ),
    palette: palette(annotations['palette'], diagnostics),
    markdownTemplate: string(
      annotations['markdownTemplate'],
      DEFAULT_SETTINGS.annotations.markdownTemplate,
      'settings.annotations.markdownTemplate',
      diagnostics,
    ),
  };
}

function migrateView(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
  fromV1: boolean,
): PluginDataV2['view'] {
  const view = isRecord(value) ? value : {};
  const sidebar = isRecord(view['sidebar']) ? view['sidebar'] : {};
  return {
    sidebar: {
      open:
        sidebar['open'] === false
          ? false
          : invalid('view.sidebar.open', DEFAULT_DATA.view.sidebar.open, diagnostics),
    },
    selectedTab:
      view['selectedTab'] === 'outline' || view['selectedTab'] === 'search'
        ? view['selectedTab']
        : invalid('view.selectedTab', DEFAULT_DATA.view.selectedTab, diagnostics),
    sidebarWidth: number(
      view['sidebarWidth'],
      DEFAULT_DATA.view.sidebarWidth,
      'view.sidebarWidth',
      diagnostics,
    ),
    profileByFingerprint: profileMap(view['profileByFingerprint'], diagnostics, fromV1),
    layoutByFingerprint: layoutMap(view['layoutByFingerprint'], diagnostics),
  };
}

function profile(
  value: unknown,
  path: string,
  diagnostics: MigrationDiagnostic[],
  fromV1: boolean,
): ReadingProfileId {
  const migrated = fromV1 ? migrateV1Profile(value) : v2Profile(value);
  if (migrated !== undefined) return migrated;
  return invalid(path, DEFAULT_SETTINGS.reading.defaultProfile, diagnostics);
}

function migrateV1Profile(value: unknown): ReadingProfileId | undefined {
  if (value === 'auto') return 'follow-obsidian';
  if (value === 'light' || value === 'sepia' || value === 'dark' || value === 'custom') {
    return value;
  }
  return undefined;
}

function v2Profile(value: unknown): ReadingProfileId | undefined {
  return isV2Profile(value) ? value : undefined;
}

function profileMap(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
  fromV1: boolean,
): Readonly<Record<string, ReadingProfileId>> {
  if (!isRecord(value))
    return invalid(
      'view.profileByFingerprint',
      DEFAULT_DATA.view.profileByFingerprint,
      diagnostics,
    );
  const result: Record<string, ReadingProfileId> = {};
  for (const [fingerprint, profileValue] of Object.entries(value)) {
    const migrated = profile(
      profileValue,
      `view.profileByFingerprint.${fingerprint}`,
      diagnostics,
      fromV1,
    );
    if ((fromV1 && isV1Profile(profileValue)) || (!fromV1 && isV2Profile(profileValue))) {
      result[fingerprint] = migrated;
    }
  }
  return result;
}

function layoutMap(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
): Readonly<Record<string, ReaderLayout>> {
  if (value === undefined) return {};
  if (!isRecord(value))
    return invalid('view.layoutByFingerprint', DEFAULT_DATA.view.layoutByFingerprint, diagnostics);
  const result: Record<string, ReaderLayout> = {};
  for (const [fingerprint, layout] of Object.entries(value)) {
    if (!isRecord(layout)) {
      diagnostics.push({
        path: `view.layoutByFingerprint.${fingerprint}`,
        message: 'Expected a layout object.',
      });
      continue;
    }
    result[fingerprint] = layoutValue(
      layout,
      `view.layoutByFingerprint.${fingerprint}`,
      diagnostics,
    );
  }
  return result;
}

function layoutValue(
  value: Record<string, unknown>,
  path: string,
  diagnostics: MigrationDiagnostic[],
): ReaderLayout {
  const pages: ReaderPages =
    value['pages'] === 'single' || value['pages'] === 'facing'
      ? value['pages']
      : invalid(`${path}.pages`, DEFAULT_READER_LAYOUT.pages, diagnostics);
  const scrolling: ReaderScrolling =
    value['scrolling'] === 'continuous' || value['scrolling'] === 'page-by-page'
      ? value['scrolling']
      : invalid(`${path}.scrolling`, DEFAULT_READER_LAYOUT.scrolling, diagnostics);
  return { pages, scrolling };
}

function palette(
  value: unknown,
  diagnostics: MigrationDiagnostic[],
): PluginSettings['annotations']['palette'] {
  if (value === undefined) return DEFAULT_SETTINGS.annotations.palette;
  if (!Array.isArray(value) || value.length !== DEFAULT_SETTINGS.annotations.palette.length) {
    return invalid(
      'settings.annotations.palette',
      DEFAULT_SETTINGS.annotations.palette,
      diagnostics,
    );
  }
  return DEFAULT_SETTINGS.annotations.palette.map((fallback, index) => {
    const entry: unknown = value[index];
    if (!isRecord(entry)) {
      diagnostics.push({
        path: `settings.annotations.palette.${index}`,
        message: 'Expected an annotation palette entry.',
      });
      return fallback;
    }
    const colorValue = entry['color'];
    const color =
      typeof colorValue === 'string' && /^#[\da-f]{6}$/iu.test(colorValue)
        ? colorValue.toLocaleLowerCase()
        : invalid(`settings.annotations.palette.${index}.color`, fallback.color, diagnostics);
    return {
      color,
      meaning: string(
        entry['meaning'],
        fallback.meaning,
        `settings.annotations.palette.${index}.meaning`,
        diagnostics,
      ),
      name: string(
        entry['name'],
        fallback.name,
        `settings.annotations.palette.${index}.name`,
        diagnostics,
      ),
    };
  });
}

function boolean(
  value: unknown,
  fallback: boolean,
  path: string,
  diagnostics: MigrationDiagnostic[],
): boolean {
  return typeof value === 'boolean' ? value : invalid(path, fallback, diagnostics);
}

function number(
  value: unknown,
  fallback: number,
  path: string,
  diagnostics: MigrationDiagnostic[],
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : invalid(path, fallback, diagnostics);
}

function string(
  value: unknown,
  fallback: string,
  path: string,
  diagnostics: MigrationDiagnostic[],
): string {
  return typeof value === 'string' ? value : invalid(path, fallback, diagnostics);
}

function invalid<T>(path: string, fallback: T, diagnostics: MigrationDiagnostic[]): T {
  diagnostics.push({ path, message: 'Invalid value; using the default.' });
  return fallback;
}

function isV2Profile(value: unknown): value is ReadingProfileId {
  return (
    value === 'default' ||
    value === 'follow-obsidian' ||
    value === 'light' ||
    value === 'sepia' ||
    value === 'dark' ||
    value === 'custom'
  );
}

function isV1Profile(value: unknown): value is V1ReadingProfileId {
  return (
    value === 'auto' ||
    value === 'light' ||
    value === 'sepia' ||
    value === 'dark' ||
    value === 'custom'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
