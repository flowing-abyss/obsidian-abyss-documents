import type { ReadingProfileId } from './document-core/reading.js';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings.js';

export interface PluginDataV1 {
  readonly schemaVersion: 1;
  readonly settings: PluginSettings;
  readonly view: {
    readonly sidebar: { readonly open: false };
    readonly selectedTab: 'outline' | 'search';
    readonly sidebarWidth: number;
    readonly profileByFingerprint: Readonly<Record<string, ReadingProfileId>>;
  };
}

export const DEFAULT_DATA: PluginDataV1 = {
  schemaVersion: 1,
  settings: DEFAULT_SETTINGS,
  view: {
    sidebar: { open: false },
    selectedTab: 'outline',
    sidebarWidth: 320,
    profileByFingerprint: {},
  },
};

interface PluginDataPersistence {
  loadData(): Promise<unknown>;
  saveData(data: PluginDataV1): Promise<void>;
}

export class PluginDataStore {
  private writeQueue: Promise<void> = Promise.resolve();

  private currentSnapshot: PluginDataV1 = DEFAULT_DATA;

  constructor(private readonly persistence: PluginDataPersistence) {}

  get snapshot(): PluginDataV1 {
    return this.currentSnapshot;
  }

  async load(): Promise<PluginDataV1> {
    const saved = await this.persistence.loadData();
    this.currentSnapshot = isPluginDataV1(saved) ? saved : DEFAULT_DATA;
    return this.snapshot;
  }

  update(mutator: (data: PluginDataV1) => PluginDataV1): Promise<void> {
    const update = this.writeQueue.then(async () => {
      const next = mutator(this.snapshot);
      await this.persistence.saveData(next);
      this.currentSnapshot = next;
    });
    this.writeQueue = update.catch(() => undefined);
    return update;
  }
}

function isPluginDataV1(data: unknown): data is PluginDataV1 {
  return (
    typeof data === 'object' && data !== null && 'schemaVersion' in data && data.schemaVersion === 1
  );
}
