import { Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import type { ReadingProfileId, ResolvedReadingColors } from './document-core/reading.js';
import type { PluginDataStore } from './plugin-data.js';
import { normalizeCustomReadingColors } from './reader/reading-profiles.js';
import type { PluginSettings } from './settings.js';

type SettingsChanged = (settings: PluginSettings) => void | Promise<void>;

interface CollapsibleSection {
  readonly body: HTMLElement;
}

type SettingFieldId =
  | 'debugLogging'
  | 'reading.custom.background'
  | 'reading.custom.brightness'
  | 'reading.custom.contrast'
  | 'reading.custom.foreground'
  | 'reading.custom.imageDim'
  | 'reading.defaultProfile'
  | 'reading.rememberPerDocument';

interface CustomReadingSettingOptions<Value> {
  readonly change: (value: Value) => Partial<ResolvedReadingColors>;
  readonly field: SettingFieldId;
  readonly read: (colors: ResolvedReadingColors) => Value;
}

interface NumericSettingOptions extends CustomReadingSettingOptions<number> {
  readonly maximum: number;
  readonly minimum: number;
}

interface FieldSynchronization {
  readonly field: SettingFieldId;
  readonly synchronize: (settings: PluginSettings) => void;
}

interface FailedFieldSynchronization extends FieldSynchronization {
  readonly generation: number;
}

const PROFILE_OPTIONS: Readonly<Record<ReadingProfileId, string>> = {
  auto: 'Auto',
  light: 'Light',
  sepia: 'Sepia',
  dark: 'Dark',
  custom: 'Custom',
};

export class AbyssDocumentsSettingTab extends PluginSettingTab {
  private readonly failedFields = new Map<SettingFieldId, FailedFieldSynchronization>();
  private readonly latestFieldGenerations = new Map<SettingFieldId, number>();
  private readonly synchronizingFields = new Set<SettingFieldId>();
  private latestSettledGeneration = 0;
  private pendingUpdates = 0;
  private updateGeneration = 0;

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
            this.updateSettings(
              (settings) => ({
                ...settings,
                reading: { ...settings.reading, defaultProfile: value },
              }),
              {
                field: 'reading.defaultProfile',
                synchronize: (settings) => {
                  dropdown.setValue(settings.reading.defaultProfile);
                },
              },
            );
          });
      });
    new Setting(container)
      .setName('Remember profile per document')
      .setDesc('Restores the last profile selected for each PDF.')
      .addToggle((toggle) => {
        toggle.setValue(reading.rememberPerDocument).onChange((value) => {
          this.updateSettings(
            (settings) => ({
              ...settings,
              reading: { ...settings.reading, rememberPerDocument: value },
            }),
            {
              field: 'reading.rememberPerDocument',
              synchronize: (settings) => {
                toggle.setValue(settings.reading.rememberPerDocument);
              },
            },
          );
        });
      });
    this.colorSetting(container, 'Foreground', reading.custom.foreground, {
      change: (value) => ({ foreground: value }),
      field: 'reading.custom.foreground',
      read: (colors) => colors.foreground,
    });
    this.colorSetting(container, 'Page tint', reading.custom.background, {
      change: (value) => ({ background: value }),
      field: 'reading.custom.background',
      read: (colors) => colors.background,
    });
    this.numericSetting(container, 'Brightness', reading.custom.brightness, {
      change: (value) => ({ brightness: value }),
      field: 'reading.custom.brightness',
      maximum: 1.5,
      minimum: 0.5,
      read: (colors) => colors.brightness,
    });
    this.numericSetting(container, 'Contrast', reading.custom.contrast, {
      change: (value) => ({ contrast: value }),
      field: 'reading.custom.contrast',
      maximum: 1.5,
      minimum: 0.5,
      read: (colors) => colors.contrast,
    });
    this.numericSetting(container, 'Image dim', reading.custom.imageDim, {
      change: (value) => ({ imageDim: value }),
      field: 'reading.custom.imageDim',
      maximum: 0.8,
      minimum: 0,
      read: (colors) => colors.imageDim,
    });
  }

  private renderAdvanced(container: HTMLElement): void {
    new Setting(container)
      .setName('Debug logging')
      .setDesc('Writes additional reader diagnostics to the developer console.')
      .addToggle((toggle) => {
        toggle.setValue(this.store.snapshot.settings.debugLogging).onChange((debugLogging) => {
          this.updateSettings((settings) => ({ ...settings, debugLogging }), {
            field: 'debugLogging',
            synchronize: (settings) => {
              toggle.setValue(settings.debugLogging);
            },
          });
        });
      });
  }

  private colorSetting(
    container: HTMLElement,
    name: string,
    value: string,
    options: CustomReadingSettingOptions<string>,
  ): void {
    new Setting(container).setName(name).addColorPicker((picker) => {
      picker.setValue(value).onChange((next) => {
        this.updateCustomReading(options.change(next), {
          field: options.field,
          synchronize: (settings) => {
            picker.setValue(options.read(settings.reading.custom));
          },
        });
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
          this.updateCustomReading(options.change(next), {
            field: options.field,
            synchronize: (settings) => {
              slider.setValue(options.read(settings.reading.custom));
            },
          });
        });
    });
  }

  private updateCustomReading(
    change: Partial<ResolvedReadingColors>,
    synchronization: FieldSynchronization,
  ): void {
    this.updateSettings(
      (settings) => ({
        ...settings,
        reading: {
          ...settings.reading,
          custom: normalizeCustomReadingColors({ ...settings.reading.custom, ...change }),
        },
      }),
      synchronization,
    );
  }

  private updateSettings(
    mutator: (settings: PluginSettings) => PluginSettings,
    synchronization: FieldSynchronization,
  ): void {
    if (this.synchronizingFields.has(synchronization.field)) return;
    const generation = ++this.updateGeneration;
    this.pendingUpdates += 1;
    this.latestFieldGenerations.set(synchronization.field, generation);
    void this.store
      .update((data) => ({ ...data, settings: mutator(data.settings) }))
      .then(() => this.onSettingsChanged(this.store.snapshot.settings))
      .catch((cause: unknown) => {
        const previousFailure = this.failedFields.get(synchronization.field);
        if (previousFailure === undefined || previousFailure.generation < generation) {
          this.failedFields.set(synchronization.field, { ...synchronization, generation });
        }
        const reason = cause instanceof Error ? cause.message : String(cause);
        new Notice(`Could not save document settings: ${reason}`);
        console.error('[abyss-documents] Failed to save document settings', { cause });
      })
      .finally(() => {
        this.pendingUpdates -= 1;
        this.latestSettledGeneration = Math.max(this.latestSettledGeneration, generation);
        if (this.pendingUpdates === 0 && this.latestSettledGeneration === this.updateGeneration) {
          this.synchronizeFailedFields();
        }
      });
  }

  private synchronizeFailedFields(): void {
    const settings = this.store.snapshot.settings;
    for (const [field, failure] of this.failedFields) {
      if (this.latestFieldGenerations.get(field) === failure.generation) {
        this.synchronizingFields.add(field);
        try {
          failure.synchronize(settings);
        } finally {
          this.synchronizingFields.delete(field);
        }
      }
    }
    this.failedFields.clear();
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
