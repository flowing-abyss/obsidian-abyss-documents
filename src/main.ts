import { Plugin } from 'obsidian';
import { PluginDataStore, type PluginDataV1 } from './plugin-data.js';

export const PLUGIN_ID = 'abyss-documents';

export default class AbyssDocumentsPlugin extends Plugin {
  data!: PluginDataV1;

  override async onload(): Promise<void> {
    const store = new PluginDataStore(this);
    this.data = await store.load();
  }

  override onunload(): void {}
}
