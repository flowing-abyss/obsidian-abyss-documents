import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DATA,
  migratePluginData,
  PluginDataStore,
  type PluginDataV1,
} from './plugin-data.js';
import { DEFAULT_SETTINGS } from './settings.js';

const RELEASED_V1_DEFAULT_DATA: PluginDataV1 = {
  schemaVersion: 1,
  settings: {
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
  },
  view: {
    sidebar: { open: false },
    selectedTab: 'outline',
    sidebarWidth: 320,
    profileByFingerprint: {},
  },
};

function loadWithReleasedV1Behavior(saved: unknown): PluginDataV1 {
  return typeof saved === 'object' &&
    saved !== null &&
    'schemaVersion' in saved &&
    saved.schemaVersion === 1
    ? (saved as PluginDataV1)
    : RELEASED_V1_DEFAULT_DATA;
}

function createStore() {
  const persistence = {
    loadData: vi.fn().mockResolvedValue(null),
    saveData: vi.fn().mockResolvedValue(undefined),
  };
  return { persistence, store: new PluginDataStore(persistence) };
}

describe('PluginDataStore', () => {
  it('migrates only the unchanged broken transfer default to a complete native link template', () => {
    const oldDefault = '> {{quote}}\n\n{{comment}}\n\n[Open annotation]({{link}})';
    const migrated = migratePluginData({
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        annotations: { ...DEFAULT_DATA.settings.annotations, markdownTemplate: oldDefault },
      },
    });
    expect(migrated.data.settings.annotations.markdownTemplate).toBe(
      '> {{quote}}\n\n{{comment}}\n\n{{link}}',
    );
    const custom = migratePluginData({
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        annotations: {
          ...DEFAULT_DATA.settings.annotations,
          markdownTemplate: `${oldDefault}\ncustom`,
        },
      },
    });
    expect(custom.data.settings.annotations.markdownTemplate).toBe(`${oldDefault}\ncustom`);
  });
  it('migrates every valid V1 automatic profile to Follow Obsidian', () => {
    const v1Auto = {
      schemaVersion: 1,
      settings: {
        reading: {
          defaultProfile: 'auto',
          rememberPerDocument: true,
          custom: {
            background: '#202020',
            foreground: '#dddddd',
            brightness: 1,
            contrast: 1,
            imageDim: 0,
          },
        },
        debugLogging: false,
      },
      view: {
        sidebar: { open: false },
        selectedTab: 'outline',
        sidebarWidth: 320,
        profileByFingerprint: { fp: 'auto' },
      },
    };

    const result = migratePluginData(v1Auto);

    expect(result.sourceVersion).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.data.settings.reading.defaultProfile).toBe('follow-obsidian');
    expect(result.data.view.profileByFingerprint['fp']).toBe('follow-obsidian');
    expect(result.data.settings.layout.default).toEqual({
      pages: 'single',
      scrolling: 'continuous',
    });
  });

  it('repairs malformed nested V1 fields without discarding the readable snapshot', () => {
    const malformedV1 = {
      schemaVersion: 1,
      settings: {
        reading: { defaultProfile: 'not-a-profile', rememberPerDocument: 'yes', custom: null },
        debugLogging: 'yes',
      },
      view: {
        sidebar: { open: true },
        selectedTab: 'annotations',
        sidebarWidth: 'wide',
        profileByFingerprint: { valid: 'dark', invalid: 'not-a-profile' },
      },
    };

    const result = migratePluginData(malformedV1);

    expect(result.sourceVersion).toBe(1);
    expect(result.data.settings.layout.default).toEqual({
      pages: 'single',
      scrolling: 'continuous',
    });
    expect(result.data.view.profileByFingerprint).toEqual({ valid: 'dark' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: 'settings.reading.defaultProfile' }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: 'view.profileByFingerprint.invalid' }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: 'view.sidebar.open' }),
    );
  });

  it('does not mistake a schema version alone for a V1 snapshot', () => {
    const result = migratePluginData({ schemaVersion: 1 });

    expect(result.sourceVersion).toBe('unknown');
    expect(result.data).toBe(DEFAULT_DATA);
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects V2-only profile ids in a V1 snapshot instead of silently preserving them', () => {
    const result = migratePluginData({
      schemaVersion: 1,
      settings: {
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
        debugLogging: false,
      },
      view: {
        sidebar: { open: false },
        selectedTab: 'outline',
        sidebarWidth: 320,
        profileByFingerprint: { fp: 'follow-obsidian' },
      },
    });

    expect(result.data.settings.reading.defaultProfile).toBe('default');
    expect(result.data.view.profileByFingerprint).toEqual({});
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'settings.reading.defaultProfile' }),
        expect.objectContaining({ path: 'view.profileByFingerprint.fp' }),
      ]),
    );
  });

  it('rolls a persisted V2 snapshot back to released V1 defaults without PDF writes', async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70]);
    const pdfVault = { modifyBinary: vi.fn() };
    const persistence = {
      loadData: vi.fn().mockResolvedValue(null),
      pdfVault,
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const store = new PluginDataStore(persistence);
    await store.load();
    await store.update((data) => ({
      ...data,
      view: { ...data.view, selectedTab: 'search' },
    }));
    const persistedV2: unknown = persistence.saveData.mock.calls[0]?.[0] as unknown;

    expect(persistedV2).toMatchObject({ schemaVersion: 2, view: { selectedTab: 'search' } });
    expect(loadWithReleasedV1Behavior(persistedV2)).toEqual(RELEASED_V1_DEFAULT_DATA);
    expect(pdfVault.modifyBinary).not.toHaveBeenCalled();
    expect(pdfBytes).toEqual(new Uint8Array([37, 80, 68, 70]));
  });

  it('preserves valid V2 layout and annotation fields', () => {
    const result = migratePluginData({
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        annotations: {
          ...DEFAULT_DATA.settings.annotations,
          author: 'Ada',
          palette: DEFAULT_DATA.settings.annotations.palette.map((entry, index) =>
            index === 0 ? { ...entry, meaning: 'Important' } : entry,
          ),
        },
        layout: {
          default: { pages: 'facing', scrolling: 'page-by-page' },
          rememberPerDocument: true,
        },
      },
      view: {
        ...DEFAULT_DATA.view,
        layoutByFingerprint: { fp: { pages: 'facing', scrolling: 'continuous' } },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.data.settings).toMatchObject({
      annotations: { author: 'Ada' },
      layout: { default: { pages: 'facing', scrolling: 'page-by-page' } },
    });
    expect(result.data.settings.annotations.palette[0]).toMatchObject({ meaning: 'Important' });
    expect(result.data.view.layoutByFingerprint).toEqual({
      fp: { pages: 'facing', scrolling: 'continuous' },
    });
  });

  it('preserves customized palette names and valid arbitrary colors', () => {
    const palette = DEFAULT_DATA.settings.annotations.palette.map((entry, index) =>
      index === 0 ? { color: '#123456', meaning: 'Central claim', name: 'Thesis' } : entry,
    );
    const result = migratePluginData({
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        annotations: { ...DEFAULT_DATA.settings.annotations, palette },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.data.settings.annotations.palette[0]).toEqual({
      color: '#123456',
      meaning: 'Central claim',
      name: 'Thesis',
    });
  });

  it('repairs malformed V2 layout maps and palette entries independently', () => {
    const result = migratePluginData({
      ...DEFAULT_DATA,
      settings: {
        ...DEFAULT_DATA.settings,
        layout: { default: { pages: 'broken', scrolling: 'broken' }, rememberPerDocument: 'yes' },
        annotations: {
          ...DEFAULT_DATA.settings.annotations,
          palette: [{ name: 'Yellow', color: '#bad', meaning: 'bad' }],
        },
      },
      view: { ...DEFAULT_DATA.view, layoutByFingerprint: { invalid: 'not-a-layout' } },
    });

    expect(result.data.settings.layout).toEqual(DEFAULT_SETTINGS.layout);
    expect(result.data.settings.annotations.palette).toEqual(DEFAULT_SETTINGS.annotations.palette);
    expect(result.data.view.layoutByFingerprint).toEqual({});
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'settings.layout.default.pages' }),
        expect.objectContaining({ path: 'settings.annotations.palette' }),
        expect.objectContaining({ path: 'view.layoutByFingerprint.invalid' }),
      ]),
    );
  });

  it('loads migration results without rewriting stored V1 data', async () => {
    const { persistence, store } = createStore();
    persistence.loadData.mockResolvedValue({
      schemaVersion: 1,
      settings: {
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
      },
      view: {
        sidebar: { open: false },
        selectedTab: 'outline',
        sidebarWidth: 320,
        profileByFingerprint: {},
      },
    });

    await store.load();

    expect(store.snapshot.schemaVersion).toBe(2);
    expect(persistence.saveData).not.toHaveBeenCalled();
  });

  it('serializes concurrent updates through one save queue', async () => {
    const { persistence, store } = createStore();
    await store.load();
    let resolveFirstSave: (() => void) | undefined;
    persistence.saveData.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveFirstSave = resolve)),
    );

    const first = store.update((data) => ({
      ...data,
      view: { ...data.view, selectedTab: 'search' },
    }));
    const second = store.update((data) => ({
      ...data,
      view: { ...data.view, sidebarWidth: 340 },
    }));

    await Promise.resolve();
    expect(persistence.saveData).toHaveBeenCalledTimes(1);
    resolveFirstSave?.();
    await Promise.all([first, second]);

    expect(store.snapshot.view).toMatchObject({
      selectedTab: 'search',
      sidebarWidth: 340,
    });
    expect(persistence.saveData).toHaveBeenLastCalledWith(store.snapshot);
  });

  it('keeps the committed snapshot when a save fails and continues later updates', async () => {
    const { persistence, store } = createStore();
    await store.load();
    persistence.saveData.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      store.update((data) => ({ ...data, view: { ...data.view, sidebarWidth: 340 } })),
    ).rejects.toThrow('disk full');
    await store.update((data) => ({ ...data, view: { ...data.view, selectedTab: 'search' } }));

    expect(store.snapshot.view).toMatchObject({ sidebarWidth: 320, selectedTab: 'search' });
  });
});
