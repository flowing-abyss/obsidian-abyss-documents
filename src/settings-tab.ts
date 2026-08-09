import { Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import type { ReadingProfileId, ResolvedReadingColors } from './document-core/reading.js';
import type { PluginDataStore } from './plugin-data.js';
import { normalizeCustomReadingColors } from './reader/reading-profiles.js';
import type { PluginSettings } from './settings.js';

type SettingsChanged = (settings: PluginSettings) => void | Promise<void>;

interface CollapsibleSection {
  readonly body: HTMLElement;
}

interface NumericSettingOptions {
  readonly change: (value: number) => Partial<ResolvedReadingColors>;
  readonly maximum: number;
  readonly minimum: number;
}

const PROFILE_OPTIONS: Readonly<Record<ReadingProfileId, string>> = {
  auto: 'Auto',
  light: 'Light',
  sepia: 'Sepia',
  dark: 'Dark',
  custom: 'Custom',
};

export class AbyssDocumentsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly store: PluginDataStore,
    private readonly onSettingsChanged: SettingsChanged = () => undefined,
  ) {
    super(app, plugin);
  }

  override getSettingDefinitions(): [] {
    // An empty definition list keeps the imperative, collapsible UI active on
    // Obsidian 1.13+ while retaining compatibility with minAppVersion 1.7.2.
    return [];
  }

  override display(): void {
    this.render();
  }

  render(): void {
    this.containerEl.empty();
    this.containerEl.addClass('abyss-documents-settings');
    const reading = this.collapsibleSection('Reading appearance', 'reading-appearance');
    this.renderReadingAppearance(reading.body);
    const advanced = this.collapsibleSection('Advanced', 'advanced');
    this.renderAdvanced(advanced.body);
  }

  private collapsibleSection(title: string, id: string): CollapsibleSection {
    const bodyId = `abyss-documents-settings-${id}`;
    const section = this.containerEl.createDiv({ cls: 'abyss-documents-settings-group' });
    const body = section.createDiv({ cls: 'abyss-documents-settings-section' });
    const heading = new Setting(section)
      .setName(title)
      .setHeading()
      .setClass('abyss-documents-settings-heading')
      .addExtraButton((button) => {
        button
          .setIcon('chevron-right')
          .setTooltip(`Show ${title.toLowerCase()}`)
          .onClick(() => {
            const expanded = body.hidden;
            body.hidden = !expanded;
            button.extraSettingsEl.setAttribute('aria-expanded', String(expanded));
            button.setIcon(expanded ? 'chevron-down' : 'chevron-right');
            button.setTooltip(`${expanded ? 'Hide' : 'Show'} ${title.toLowerCase()}`);
          });
        button.extraSettingsEl.setAttribute('aria-controls', bodyId);
        button.extraSettingsEl.setAttribute('aria-expanded', 'false');
      });
    section.prepend(heading.settingEl);
    body.id = bodyId;
    body.hidden = true;
    return { body };
  }

  private renderReadingAppearance(container: HTMLElement): void {
    const { reading } = this.store.snapshot.settings;
    new Setting(container)
      .setName('Default profile')
      .setDesc('Used when a document has no remembered profile.')
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(PROFILE_OPTIONS)
          .setValue(reading.defaultProfile)
          .onChange((value) => {
            if (!isReadingProfileId(value)) return;
            this.updateSettings((settings) => ({
              ...settings,
              reading: { ...settings.reading, defaultProfile: value },
            }));
          });
      });
    new Setting(container)
      .setName('Remember profile per document')
      .setDesc('Restores the last profile selected for each PDF.')
      .addToggle((toggle) => {
        toggle.setValue(reading.rememberPerDocument).onChange((value) => {
          this.updateSettings((settings) => ({
            ...settings,
            reading: { ...settings.reading, rememberPerDocument: value },
          }));
        });
      });
    this.colorSetting(container, 'Foreground', reading.custom.foreground, (value) => ({
      foreground: value,
    }));
    this.colorSetting(container, 'Page tint', reading.custom.background, (value) => ({
      background: value,
    }));
    this.numericSetting(container, 'Brightness', reading.custom.brightness, {
      change: (value) => ({ brightness: value }),
      maximum: 1.5,
      minimum: 0.5,
    });
    this.numericSetting(container, 'Contrast', reading.custom.contrast, {
      change: (value) => ({ contrast: value }),
      maximum: 1.5,
      minimum: 0.5,
    });
    this.numericSetting(container, 'Image dim', reading.custom.imageDim, {
      change: (value) => ({ imageDim: value }),
      maximum: 0.8,
      minimum: 0,
    });
  }

  private renderAdvanced(container: HTMLElement): void {
    new Setting(container)
      .setName('Debug logging')
      .setDesc('Writes additional reader diagnostics to the developer console.')
      .addToggle((toggle) => {
        toggle.setValue(this.store.snapshot.settings.debugLogging).onChange((debugLogging) => {
          this.updateSettings((settings) => ({ ...settings, debugLogging }));
        });
      });
  }

  private colorSetting(
    container: HTMLElement,
    name: string,
    value: string,
    change: (value: string) => Partial<ResolvedReadingColors>,
  ): void {
    new Setting(container).setName(name).addColorPicker((picker) => {
      picker.setValue(value).onChange((next) => {
        this.updateCustomReading(change(next));
      });
    });
  }

  private numericSetting(
    container: HTMLElement,
    name: string,
    value: number,
    options: NumericSettingOptions,
  ): void {
    new Setting(container).setName(name).addSlider((slider) => {
      slider
        .setLimits(options.minimum, options.maximum, 0.05)
        .setValue(value)
        .onChange((next) => {
          this.updateCustomReading(options.change(next));
        });
    });
  }

  private updateCustomReading(change: Partial<ResolvedReadingColors>): void {
    this.updateSettings((settings) => ({
      ...settings,
      reading: {
        ...settings.reading,
        custom: normalizeCustomReadingColors({ ...settings.reading.custom, ...change }),
      },
    }));
  }

  private updateSettings(mutator: (settings: PluginSettings) => PluginSettings): void {
    void this.store
      .update((data) => ({ ...data, settings: mutator(data.settings) }))
      .then(() => this.onSettingsChanged(this.store.snapshot.settings))
      .catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        new Notice(`Could not save document settings: ${reason}`);
        console.error('[abyss-documents] Failed to save document settings', { cause });
        this.render();
      });
  }
}

function isReadingProfileId(value: string): value is ReadingProfileId {
  return (
    value === 'auto' ||
    value === 'light' ||
    value === 'sepia' ||
    value === 'dark' ||
    value === 'custom'
  );
}
