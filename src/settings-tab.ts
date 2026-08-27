import { Notice, PluginSettingTab, Setting, setIcon, type App, type Plugin } from 'obsidian';
import type {
  ReaderPages,
  ReaderScrolling,
  ReadingProfileId,
  ResolvedReadingColors,
} from './document-core/reading.js';
import type { PluginDataStore } from './plugin-data.js';
import { normalizeCustomReadingColors } from './reader/reading-profiles.js';
import type { AnnotationPaletteEntry, PluginSettings } from './settings.js';

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
  | 'reading.rememberPerDocument'
  | 'layout.default.pages'
  | 'layout.default.scrolling'
  | 'layout.rememberPerDocument'
  | 'annotations.author'
  | 'annotations.markdownTemplate'
  | `annotations.palette.${number}.color`
  | `annotations.palette.${number}.meaning`
  | `annotations.palette.${number}.name`;

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
  default: 'Default',
  'follow-obsidian': 'Follow Obsidian',
  light: 'Light',
  sepia: 'Sepia',
  dark: 'Dark',
  custom: 'Custom',
};

let settingsTabInstanceSequence = 0;

export class AbyssDocumentsSettingTab extends PluginSettingTab {
  private readonly failedFields = new Map<SettingFieldId, FailedFieldSynchronization>();
  private readonly latestFieldGenerations = new Map<SettingFieldId, number>();
  private readonly synchronizingFields = new Set<SettingFieldId>();
  private latestSettledGeneration = 0;
  private pendingUpdates = 0;
  private readonly regionIdPrefix = `abyss-documents-settings-${String(++settingsTabInstanceSequence)}`;
  private sectionEvents: AbortController | null = null;
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

  override hide(): void {
    this.sectionEvents?.abort();
    this.sectionEvents = null;
  }

  render(): void {
    this.sectionEvents?.abort();
    const AbortControllerConstructor =
      this.containerEl.doc.defaultView?.AbortController ?? AbortController;
    this.sectionEvents = new AbortControllerConstructor();
    this.containerEl.empty();
    this.containerEl.addClass('abyss-documents-settings');
    const reading = this.collapsibleSection('Reading appearance', 'reading-appearance', 'palette');
    this.renderReadingAppearance(reading.body);
    const layout = this.collapsibleSection('Page layout', 'page-layout', 'layout-template');
    this.renderPageLayout(layout.body);
    const annotations = this.collapsibleSection('Annotations', 'annotations', 'highlighter');
    this.renderAnnotations(annotations.body);
    const advanced = this.collapsibleSection('Advanced', 'advanced', 'settings-2');
    this.renderAdvanced(advanced.body);
  }

  private collapsibleSection(title: string, id: string, icon: string): CollapsibleSection {
    if (this.sectionEvents === null) {
      throw new Error('Settings section events are not active.');
    }
    const { signal } = this.sectionEvents;
    const bodyId = `${this.regionIdPrefix}-${id}`;
    const headerId = `${bodyId}-header`;
    const section = this.containerEl.createDiv({ cls: 'abyss-documents-settings-group' });
    const header = section.createEl('button', {
      attr: {
        'aria-controls': bodyId,
        'aria-expanded': 'false',
        type: 'button',
      },
      cls: 'abyss-documents-settings-header',
    });
    header.id = headerId;
    const iconEl = header.createSpan({
      attr: { 'aria-hidden': 'true', 'data-icon-name': icon },
      cls: 'abyss-documents-settings-header-icon',
    });
    setIcon(iconEl, icon);
    header.createSpan({ cls: 'abyss-documents-settings-header-label', text: title });
    const chevron = header.createSpan({
      attr: { 'aria-hidden': 'true', 'data-icon-name': 'chevron-right' },
      cls: 'abyss-documents-settings-header-chevron',
    });
    setIcon(chevron, 'chevron-right');
    const body = section.createDiv({
      attr: { 'aria-labelledby': headerId, role: 'region' },
      cls: 'abyss-documents-settings-section',
    });
    body.id = bodyId;
    body.hidden = true;

    const setExpanded = (expanded: boolean): void => {
      if (!expanded && body.contains(this.containerEl.doc.activeElement)) header.focus();
      body.hidden = !expanded;
      section.toggleClass('is-expanded', expanded);
      header.setAttribute('aria-expanded', String(expanded));
    };
    header.addEventListener(
      'click',
      () => {
        setExpanded(body.hidden);
      },
      { signal },
    );
    header.addEventListener(
      'keydown',
      (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
          event.preventDefault();
          setExpanded(body.hidden);
        }
      },
      { signal },
    );
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

  private renderPageLayout(container: HTMLElement): void {
    const { layout } = this.store.snapshot.settings;
    new Setting(container)
      .setName('Default pages')
      .setDesc('Used when a document has no remembered page layout.')
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({ single: 'Single', facing: 'Facing' })
          .setValue(layout.default.pages)
          .onChange((value) => {
            if (!isReaderPages(value)) return;
            this.updateSettings(
              (settings) => ({
                ...settings,
                layout: {
                  ...settings.layout,
                  default: { ...settings.layout.default, pages: value },
                },
              }),
              {
                field: 'layout.default.pages',
                synchronize: (settings) => {
                  dropdown.setValue(settings.layout.default.pages);
                },
              },
            );
          });
      });
    new Setting(container)
      .setName('Default scrolling')
      .setDesc('Chooses continuous flow or discrete page navigation by default.')
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({ continuous: 'Continuous', 'page-by-page': 'Page by page' })
          .setValue(layout.default.scrolling)
          .onChange((value) => {
            if (!isReaderScrolling(value)) return;
            this.updateSettings(
              (settings) => ({
                ...settings,
                layout: {
                  ...settings.layout,
                  default: { ...settings.layout.default, scrolling: value },
                },
              }),
              {
                field: 'layout.default.scrolling',
                synchronize: (settings) => {
                  dropdown.setValue(settings.layout.default.scrolling);
                },
              },
            );
          });
      });
    new Setting(container)
      .setName('Remember layout per document')
      .setDesc('Restores the last page layout selected for each PDF.')
      .addToggle((toggle) => {
        toggle.setValue(layout.rememberPerDocument).onChange((value) => {
          this.updateSettings(
            (settings) => ({
              ...settings,
              layout: { ...settings.layout, rememberPerDocument: value },
            }),
            {
              field: 'layout.rememberPerDocument',
              synchronize: (settings) => {
                toggle.setValue(settings.layout.rememberPerDocument);
              },
            },
          );
        });
      });
  }

  private renderAnnotations(container: HTMLElement): void {
    const { annotations } = this.store.snapshot.settings;
    new Setting(container)
      .setName('Annotation author')
      .setDesc('Used when a document format supports annotation authors.')
      .addText((text) => {
        text.setValue(annotations.author).onChange((author) => {
          this.updateSettings(
            (settings) => ({ ...settings, annotations: { ...settings.annotations, author } }),
            {
              field: 'annotations.author',
              synchronize: (settings) => {
                text.setValue(settings.annotations.author);
              },
            },
          );
        });
      });
    this.renderAnnotationPalette(container, annotations.palette);
    new Setting(container)
      .setName('Annotation transfer template')
      .setDesc('Used when exporting annotation text.')
      .addTextArea((text) => {
        text.setValue(annotations.markdownTemplate).onChange((markdownTemplate) => {
          this.updateSettings(
            (settings) => ({
              ...settings,
              annotations: { ...settings.annotations, markdownTemplate },
            }),
            {
              field: 'annotations.markdownTemplate',
              synchronize: (settings) => {
                text.setValue(settings.annotations.markdownTemplate);
              },
            },
          );
        });
      });
  }

  private renderAnnotationPalette(
    container: HTMLElement,
    palette: readonly AnnotationPaletteEntry[],
  ): void {
    const paletteContainer = container.createDiv({
      attr: { 'aria-label': 'Annotation palette' },
      cls: 'abyss-documents-settings-palette',
    });
    for (const [index, entry] of palette.entries()) {
      this.renderPaletteEntry(paletteContainer, entry, index);
    }
  }

  private renderPaletteEntry(
    container: HTMLElement,
    entry: AnnotationPaletteEntry,
    index: number,
  ): void {
    const paletteEntry = container.createDiv({
      attr: {
        'aria-label': `${entry.name} annotation palette entry`,
        'data-palette-index': String(index),
        role: 'group',
      },
      cls: 'abyss-documents-settings-palette-entry',
    });
    const colorSetting = new Setting(paletteEntry)
      .setName(`${entry.name} color`)
      .setDesc('Color used by this annotation palette entry.')
      .setClass('abyss-documents-settings-palette-field')
      .setClass('is-color')
      .addColorPicker((picker) => {
        picker.setValue(entry.color).onChange((color) => {
          this.updateSettings((settings) => this.withPaletteEntry(settings, index, { color }), {
            field: `annotations.palette.${index}.color`,
            synchronize: (settings) => {
              picker.setValue(settings.annotations.palette[index]?.color ?? entry.color);
            },
          });
        });
      });
    const colorInput =
      colorSetting.controlEl.querySelector<HTMLInputElement>('input[type="color"]');
    colorInput?.addClass('abyss-documents-settings-palette-color');
    colorInput?.setAttribute('aria-label', `${entry.name} color`);
    new Setting(paletteEntry)
      .setName(`${entry.name} name`)
      .setDesc('Short label shown in annotation color tooltips.')
      .setClass('abyss-documents-settings-palette-field')
      .setClass('is-name')
      .addText((text) => {
        text.inputEl.addClass('abyss-documents-settings-palette-input');
        text.inputEl.setAttribute('aria-label', `${entry.name} name`);
        text.inputEl.setAttribute('dir', 'auto');
        text.setValue(entry.name).onChange((name) => {
          this.updateSettings((settings) => this.withPaletteEntry(settings, index, { name }), {
            field: `annotations.palette.${index}.name`,
            synchronize: (settings) => {
              text.setValue(settings.annotations.palette[index]?.name ?? entry.name);
            },
          });
        });
      });
    new Setting(paletteEntry)
      .setName(`${entry.name} meaning`)
      .setDesc(`${entry.color} annotation palette color.`)
      .setClass('abyss-documents-settings-palette-field')
      .setClass('is-meaning')
      .addText((text) => {
        text.inputEl.addClass('abyss-documents-settings-palette-input');
        text.inputEl.setAttribute('aria-label', `${entry.name} meaning`);
        text.inputEl.setAttribute('dir', 'auto');
        text.setValue(entry.meaning).onChange((meaning) => {
          this.updateSettings((settings) => this.withPaletteEntry(settings, index, { meaning }), {
            field: `annotations.palette.${index}.meaning`,
            synchronize: (settings) => {
              text.setValue(settings.annotations.palette[index]?.meaning ?? '');
            },
          });
        });
      });
  }

  private withPaletteEntry(
    settings: PluginSettings,
    index: number,
    change: Partial<AnnotationPaletteEntry>,
  ): PluginSettings {
    return {
      ...settings,
      annotations: {
        ...settings.annotations,
        palette: settings.annotations.palette.map((paletteEntry, paletteIndex) =>
          paletteIndex === index ? { ...paletteEntry, ...change } : paletteEntry,
        ),
      },
    };
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
    value === 'default' ||
    value === 'follow-obsidian' ||
    value === 'light' ||
    value === 'sepia' ||
    value === 'dark' ||
    value === 'custom'
  );
}

function isReaderPages(value: string): value is ReaderPages {
  return value === 'single' || value === 'facing';
}

function isReaderScrolling(value: string): value is ReaderScrolling {
  return value === 'continuous' || value === 'page-by-page';
}
