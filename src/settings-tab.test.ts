import type {
  ColorComponent,
  DropdownComponent,
  PluginManifest,
  SliderComponent,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
} from 'obsidian';
import { Setting, SettingGroup } from 'obsidian';
import { App, Notice } from 'obsidian-test-mocks/obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AbyssDocumentsPlugin from './main.js';
import { PluginDataStore } from './plugin-data.js';
import { AbyssDocumentsSettingTab } from './settings-tab.js';
import { DEFAULT_SETTINGS } from './settings.js';

const manifest: PluginManifest = {
  id: 'abyss-documents',
  name: 'Abyss Documents',
  author: 'test',
  version: '0.0.0-test',
  minAppVersion: '1.7.2',
  description: 'Test manifest',
};

function fixture(useDefaultCallback = false) {
  const app = App.createConfigured__();
  const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
  const persistence = {
    loadData: vi.fn().mockResolvedValue(null),
    saveData: vi.fn().mockResolvedValue(undefined),
  };
  const store = new PluginDataStore(persistence);
  const onSettingsChange = vi.fn();
  const tab = useDefaultCallback
    ? new AbyssDocumentsSettingTab(app.asOriginalType__(), plugin, store)
    : new AbyssDocumentsSettingTab(app.asOriginalType__(), plugin, store, onSettingsChange);
  return { onSettingsChange, persistence, store, tab };
}

interface CapturedControls {
  readonly colors: Map<string, ColorComponent>;
  readonly dropdowns: Map<string, DropdownComponent>;
  readonly sliders: Map<string, SliderComponent>;
  readonly textAreas: Map<string, TextAreaComponent>;
  readonly texts: Map<string, TextComponent>;
  readonly toggles: Map<string, ToggleComponent>;
}

function captureControls(): CapturedControls {
  const colors = new Map<string, ColorComponent>();
  const dropdowns = new Map<string, DropdownComponent>();
  const sliders = new Map<string, SliderComponent>();
  const textAreas = new Map<string, TextAreaComponent>();
  const texts = new Map<string, TextComponent>();
  const toggles = new Map<string, ToggleComponent>();
  captureSettingComponent('addColorPicker', colors);
  captureSettingComponent('addDropdown', dropdowns);
  captureSettingComponent('addSlider', sliders);
  captureSettingComponent('addText', texts);
  captureSettingComponent('addTextArea', textAreas);
  captureSettingComponent('addToggle', toggles);
  return { colors, dropdowns, sliders, textAreas, texts, toggles };
}

type ComponentSettingMethod =
  'addColorPicker' | 'addDropdown' | 'addSlider' | 'addText' | 'addTextArea' | 'addToggle';

function captureSettingComponent<Component>(
  method: ComponentSettingMethod,
  captured: Map<string, Component>,
): void {
  type ComponentAdder = (this: Setting, callback: (component: Component) => unknown) => Setting;
  const methods = Setting.prototype as unknown as Record<ComponentSettingMethod, ComponentAdder>;
  const original = methods[method];
  vi.spyOn(methods, method).mockImplementation(function (
    this: Setting,
    callback: (component: Component) => unknown,
  ) {
    return Reflect.apply(original, this, [
      (component: Component) => {
        captured.set(this.nameEl.textContent, component);
        callback(component);
      },
    ]);
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function requiredControl<Component>(controls: Map<string, Component>, name: string): Component {
  const control = controls.get(name);
  if (control === undefined) throw new Error(`Expected ${name} control.`);
  return control;
}

function enterText(component: TextComponent | TextAreaComponent, value: string): void {
  component.inputEl.value = value;
  component.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

function chooseOption(component: DropdownComponent, value: string): void {
  component.selectEl.value = value;
  component.selectEl.dispatchEvent(new Event('change', { bubbles: true }));
}

function sectionControls(
  tab: AbyssDocumentsSettingTab,
  title: string,
): {
  readonly body: HTMLElement;
  readonly button: HTMLButtonElement;
} {
  const button = requiredSectionButton(tab, title);
  return { body: controlledRegion(tab, button), button };
}

function expandSection(
  tab: AbyssDocumentsSettingTab,
  title: string,
): ReturnType<typeof sectionControls> {
  const section = sectionControls(tab, title);
  section.button.click();
  return section;
}

function sectionButtons(tab: AbyssDocumentsSettingTab): HTMLButtonElement[] {
  return Array.from(
    tab.containerEl.querySelectorAll<HTMLButtonElement>('button.abyss-documents-settings-header'),
  );
}

function requiredSectionButton(tab: AbyssDocumentsSettingTab, title: string): HTMLButtonElement {
  const button = sectionButtons(tab).find(
    (candidate) =>
      candidate.querySelector('.abyss-documents-settings-header-label')?.textContent === title,
  );
  if (button === undefined) throw new Error(`Expected ${title} section button.`);
  return button;
}

function controlledRegion(tab: AbyssDocumentsSettingTab, button: HTMLButtonElement): HTMLElement {
  const id = button.getAttribute('aria-controls');
  if (id === null) throw new Error('Expected a controlled settings region.');
  const region = tab.containerEl.querySelector<HTMLElement>(`#${id}`);
  if (region === null) throw new Error(`Expected settings region ${id}.`);
  return region;
}

function expectLabelsExactlyOnce(region: HTMLElement, labels: readonly string[]): void {
  for (const label of labels) {
    expect(region.textContent.split(label)).toHaveLength(2);
  }
}

describe('AbyssDocumentsSettingTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Reading appearance, Page layout, Annotations, and Advanced collapsed', () => {
    const { tab } = fixture();

    tab.render();

    const expanders = Array.from(tab.containerEl.querySelectorAll<HTMLElement>('[aria-expanded]'));
    expect(expanders).toHaveLength(4);
    expect(expanders.every((element) => element.getAttribute('aria-expanded') === 'false')).toBe(
      true,
    );
    expect(tab.containerEl.textContent).toContain('Reading appearance');
    expect(tab.containerEl.textContent).toContain('Page layout');
    expect(tab.containerEl.textContent).toContain('Annotations');
    expect(tab.containerEl.textContent).toContain('Advanced');
    expect(tab.containerEl.textContent).not.toMatch(/ocr/iu);
    expect(tab.containerEl.classList.contains('abyss-documents-settings')).toBe(true);
  });

  it('renders the existing sections through the declarative settings row and cleans its handlers', () => {
    const { tab } = fixture();
    const definition = tab.getSettingDefinitions()[0];
    if (definition === undefined)
      throw new Error('The declarative settings renderer is unavailable.');
    const setting = new Setting(tab.containerEl);
    const cleanup = definition.render(setting, new SettingGroup(tab.containerEl));

    expect(setting.settingEl.querySelectorAll('.abyss-documents-settings-group')).toHaveLength(4);
    expect(setting.settingEl.textContent).toContain('Reading appearance');
    const button = setting.settingEl.querySelector<HTMLButtonElement>('[aria-expanded]');
    button?.click();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    if (typeof cleanup !== 'function')
      throw new Error('The settings renderer must release handlers.');
    cleanup();
    button?.click();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders four ordered semantic section buttons with native icons and unique ARIA regions', () => {
    const { tab } = fixture();

    tab.render();

    const buttons = sectionButtons(tab);
    expect(
      buttons.map(
        (button) => button.querySelector('.abyss-documents-settings-header-label')?.textContent,
      ),
    ).toEqual(['Reading appearance', 'Page layout', 'Annotations', 'Advanced']);
    const regionIds = buttons.map((button) => button.getAttribute('aria-controls'));
    expect(new Set(regionIds).size).toBe(4);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(
        button
          .querySelector('.abyss-documents-settings-header-icon')
          ?.getAttribute('data-icon-name'),
      ).toBeTruthy();
      expect(
        button
          .querySelector('.abyss-documents-settings-header-chevron')
          ?.getAttribute('data-icon-name'),
      ).toBe('chevron-right');
      const region = controlledRegion(tab, button);
      expect(region.hidden).toBe(true);
      expect(region.getAttribute('role')).toBe('region');
      expect(region.getAttribute('aria-labelledby')).toBe(button.id);
    }
  });

  it('toggles a section once per click, Enter, or Space and returns focus on collapse', () => {
    const { tab } = fixture();
    tab.containerEl.doc.body.append(tab.containerEl);
    tab.render();
    const button = requiredSectionButton(tab, 'Reading appearance');
    const region = controlledRegion(tab, button);

    button.click();
    expect(region.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(region.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');

    button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
    expect(region.hidden).toBe(false);
    button.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', repeat: true }),
    );
    expect(region.hidden).toBe(false);
    const firstControl = region.querySelector<HTMLElement>('input, select, textarea, button');
    expect(firstControl).not.toBeNull();
    firstControl?.focus();
    expect(tab.containerEl.doc.activeElement).toBe(firstControl);

    button.click();
    expect(region.hidden).toBe(true);
    expect(tab.containerEl.doc.activeElement).toBe(button);
  });

  it('starts freshly collapsed without duplicate groups after every display', () => {
    const { tab } = fixture();
    tab.render();

    const previousButton = requiredSectionButton(tab, 'Annotations');
    previousButton.click();
    expect(previousButton.getAttribute('aria-expanded')).toBe('true');

    tab.render();

    const buttons = sectionButtons(tab);
    expect(buttons).toHaveLength(4);
    expect(tab.containerEl.querySelectorAll('.abyss-documents-settings-group')).toHaveLength(4);
    expect(buttons.every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(buttons).not.toContain(previousButton);
    expect(previousButton.isConnected).toBe(false);
    previousButton.click();
    expect(previousButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('aborts section listeners while hidden and installs fresh listeners on redisplay', () => {
    const { tab } = fixture();
    tab.render();
    const hiddenButton = requiredSectionButton(tab, 'Reading appearance');

    (tab as unknown as { hide(): void }).hide();
    hiddenButton.click();
    hiddenButton.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(hiddenButton.getAttribute('aria-expanded')).toBe('false');

    tab.render();
    const activeButton = requiredSectionButton(tab, 'Reading appearance');
    activeButton.click();
    expect(activeButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('maps every persisted setting exactly once and groups each fixed palette entry', () => {
    const controls = captureControls();
    const { tab } = fixture();
    tab.render();

    expectLabelsExactlyOnce(
      controlledRegion(tab, requiredSectionButton(tab, 'Reading appearance')),
      [
        'Default profile',
        'Remember profile per document',
        'Foreground',
        'Page tint',
        'Brightness',
        'Contrast',
        'Image dim',
      ],
    );
    expectLabelsExactlyOnce(controlledRegion(tab, requiredSectionButton(tab, 'Page layout')), [
      'Default pages',
      'Default scrolling',
      'Remember layout per document',
    ]);
    expectLabelsExactlyOnce(controlledRegion(tab, requiredSectionButton(tab, 'Annotations')), [
      'Annotation author',
      'Yellow color',
      'Yellow name',
      'Yellow meaning',
      'Red color',
      'Red name',
      'Red meaning',
      'Green color',
      'Green name',
      'Green meaning',
      'Blue color',
      'Blue name',
      'Blue meaning',
      'Purple color',
      'Purple name',
      'Purple meaning',
      'Magenta color',
      'Magenta name',
      'Magenta meaning',
      'Orange color',
      'Orange name',
      'Orange meaning',
      'Gray color',
      'Gray name',
      'Gray meaning',
      'Annotation transfer template',
    ]);
    expectLabelsExactlyOnce(controlledRegion(tab, requiredSectionButton(tab, 'Advanced')), [
      'Debug logging',
    ]);

    expect(Array.from(controls.dropdowns.keys())).toEqual([
      'Default profile',
      'Default pages',
      'Default scrolling',
    ]);
    expect(Array.from(controls.sliders.keys())).toEqual(['Brightness', 'Contrast', 'Image dim']);
    expect(Array.from(controls.toggles.keys())).toEqual([
      'Remember profile per document',
      'Remember layout per document',
      'Debug logging',
    ]);
    expect(controls.colors).toHaveLength(10);
    expect(controls.texts).toHaveLength(17);
    expect(Array.from(controls.textAreas.keys())).toEqual(['Annotation transfer template']);

    const paletteEntries = tab.containerEl.querySelectorAll<HTMLElement>(
      '.abyss-documents-settings-palette-entry',
    );
    expect(paletteEntries).toHaveLength(8);
    paletteEntries.forEach((entry, index) => {
      expect(entry.getAttribute('role')).toBe('group');
      expect(entry.getAttribute('data-palette-index')).toBe(String(index));
      expect(entry.children).toHaveLength(3);
    });
  });

  it('hydrates long Unicode and RTL palette text into accessible direction-safe controls', async () => {
    const longName = 'ראיה מרכזית — Очень длинное пользовательское название цвета';
    const longMeaning =
      'משמעות משפטית מפורטת — Длинное семантическое описание, которое должно переноситься безопасно';
    const { persistence, store, tab } = fixture();
    await store.update((data) => ({
      ...data,
      settings: {
        ...data.settings,
        annotations: {
          ...data.settings.annotations,
          palette: data.settings.annotations.palette.map((entry, index) =>
            index === 0 ? { ...entry, meaning: longMeaning, name: longName } : entry,
          ),
        },
      },
    }));
    persistence.saveData.mockClear();
    const controls = captureControls();

    tab.render();

    const entry = tab.containerEl.querySelector<HTMLElement>(
      '.abyss-documents-settings-palette-entry[data-palette-index="0"]',
    );
    expect(entry).not.toBeNull();
    expect(entry?.getAttribute('aria-label')).toBe(`${longName} annotation palette entry`);
    expect(entry?.querySelector('input[type="color"]')?.getAttribute('aria-label')).toBe(
      `${longName} color`,
    );
    const name = requiredControl(controls.texts, `${longName} name`);
    const meaning = requiredControl(controls.texts, `${longName} meaning`);
    expect(name.getValue()).toBe(longName);
    expect(name.inputEl.getAttribute('aria-label')).toBe(`${longName} name`);
    expect(name.inputEl.getAttribute('dir')).toBe('auto');
    expect(meaning.getValue()).toBe(longMeaning);
    expect(meaning.inputEl.getAttribute('aria-label')).toBe(`${longName} meaning`);
    expect(meaning.inputEl.getAttribute('dir')).toBe('auto');
    expect(persistence.saveData).not.toHaveBeenCalled();
  });

  it('shows and persists functional default layout controls independently from profiles', async () => {
    const controls = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    tab.render();
    const { body } = expandSection(tab, 'Page layout');

    expect(body.textContent).toContain('Default pages');
    expect(body.textContent).toContain('Default scrolling');
    expect(body.textContent).toContain('Remember layout per document');
    chooseOption(requiredControl(controls.dropdowns, 'Default pages'), 'unknown');
    chooseOption(requiredControl(controls.dropdowns, 'Default scrolling'), 'unknown');
    expect(persistence.saveData).not.toHaveBeenCalled();

    chooseOption(requiredControl(controls.dropdowns, 'Default pages'), 'facing');
    chooseOption(requiredControl(controls.dropdowns, 'Default scrolling'), 'page-by-page');
    controls.toggles.get('Remember layout per document')?.setValue(true);
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(3);
    });

    expect(store.snapshot.settings.layout).toEqual({
      default: { pages: 'facing', scrolling: 'page-by-page' },
      rememberPerDocument: true,
    });
    expect(onSettingsChange).toHaveBeenCalledTimes(3);
  });

  it('does not claim that PDF.js applies the reserved annotation author preference', () => {
    const { tab } = fixture();
    tab.render();
    const { body } = expandSection(tab, 'Annotations');

    expect(body.textContent).toContain('Used when a document format supports annotation authors.');
    expect(body.textContent).not.toContain('Stored as the author for new PDF annotations.');
  });

  it('expands and collapses every native settings section', () => {
    const { tab } = fixture();
    tab.render();

    for (const button of sectionButtons(tab)) {
      const title = button.querySelector('.abyss-documents-settings-header-label')?.textContent;
      if (title === undefined) throw new Error('Expected a section title.');
      const body = controlledRegion(tab, button);
      button.click();
      expect(body.hidden).toBe(false);
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.hasAttribute('aria-label')).toBe(false);
      expect(button.querySelector('.abyss-documents-settings-header-label')?.textContent).toBe(
        title,
      );
      button.click();
      expect(body.hidden).toBe(true);
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('persists every native profile, color, and toggle control', async () => {
    const controls = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    tab.render();

    chooseOption(requiredControl(controls.dropdowns, 'Default profile'), 'unknown');
    expect(persistence.saveData).not.toHaveBeenCalled();
    chooseOption(requiredControl(controls.dropdowns, 'Default profile'), 'dark');
    controls.toggles.get('Remember profile per document')?.setValue(true);
    controls.colors.get('Foreground')?.setValue('#112233');
    controls.colors.get('Page tint')?.setValue('#fefefe');
    controls.toggles.get('Debug logging')?.setValue(true);
    enterText(requiredControl(controls.texts, 'Annotation author'), 'Ada');
    enterText(requiredControl(controls.texts, 'Yellow meaning'), 'Important');
    enterText(requiredControl(controls.textAreas, 'Annotation transfer template'), '> {{quote}}');
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(8);
    });

    expect(store.snapshot.settings).toMatchObject({
      debugLogging: true,
      reading: {
        defaultProfile: 'dark',
        rememberPerDocument: true,
        custom: { background: '#fefefe', foreground: '#112233' },
      },
      annotations: {
        author: 'Ada',
        markdownTemplate: '> {{quote}}',
      },
    });
    expect(store.snapshot.settings.annotations.palette[0]).toMatchObject({
      name: 'Yellow',
      meaning: 'Important',
    });
    expect(onSettingsChange).toHaveBeenCalledTimes(8);
  });

  it('persists an arbitrary annotation palette color, name, and meaning', async () => {
    const controls = captureControls();
    const { persistence, store, tab } = fixture();
    tab.render();
    expandSection(tab, 'Annotations');

    requiredControl(controls.colors, 'Yellow color').setValue('#123456');
    enterText(requiredControl(controls.texts, 'Yellow name'), 'Thesis');
    enterText(requiredControl(controls.texts, 'Yellow meaning'), 'Central claim');

    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(3);
    });
    expect(store.snapshot.settings.annotations.palette[0]).toEqual({
      color: '#123456',
      meaning: 'Central claim',
      name: 'Thesis',
    });
  });

  it('restores failed arbitrary palette color, name, and meaning fields in place', async () => {
    const controls = captureControls();
    const { persistence, store, tab } = fixture();
    persistence.saveData.mockRejectedValue(new Error('palette failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.render();

    const color = requiredControl(controls.colors, 'Yellow color');
    const name = requiredControl(controls.texts, 'Yellow name');
    const meaning = requiredControl(controls.texts, 'Yellow meaning');
    color.setValue('#123456');
    enterText(name, 'Thesis');
    enterText(meaning, 'Central claim');
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(3);
      expect(color.getValue()).toBe('#ffd400');
      expect(name.getValue()).toBe('Yellow');
      expect(meaning.getValue()).toBe('');
    });
    expect(store.snapshot.settings.annotations.palette[0]).toEqual(
      DEFAULT_SETTINGS.annotations.palette[0],
    );
  });

  it('persists renderer-bounded custom appearance values and updates live readers', async () => {
    const { sliders } = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    tab.render();

    sliders.get('Brightness')?.setValue(9);
    sliders.get('Contrast')?.setValue(-2);
    sliders.get('Image dim')?.setValue(1);
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(3);
    });

    expect(store.snapshot.settings.reading.custom).toMatchObject({
      brightness: 1.5,
      contrast: 0.5,
      imageDim: 0.8,
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith(store.snapshot.settings);
  });

  it('keeps an expanded section and its controls stable after successful writes', async () => {
    const controls = captureControls();
    const { onSettingsChange, store, tab } = fixture();
    tab.render();
    const { body, button } = expandSection(tab, 'Reading appearance');
    const toggle = requiredControl(controls.toggles, 'Remember profile per document');
    const slider = requiredControl(controls.sliders, 'Brightness');

    toggle.setValue(true);
    slider.setValue(1.25);
    await vi.waitFor(() => {
      expect(onSettingsChange).toHaveBeenCalledTimes(2);
    });

    expect(store.snapshot.settings.reading).toMatchObject({
      rememberPerDocument: true,
      custom: { brightness: 1.25 },
    });
    expect(body.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(requiredControl(controls.toggles, 'Remember profile per document').toggleEl).toBe(
      toggle.toggleEl,
    );
    expect(requiredControl(controls.sliders, 'Brightness').sliderEl).toBe(slider.sliderEl);
  });

  it('contains a failed settings write at one visible and diagnostic boundary', async () => {
    const controls = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    const cause = new Error('disk full');
    persistence.saveData.mockRejectedValueOnce(cause);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.render();

    controls.toggles.get('Debug logging')?.setValue(true);

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith('Could not save document settings: disk full', undefined);
    });
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to save document settings', {
      cause,
    });
    expect(store.snapshot.settings.debugLogging).toBe(false);
    expect(requiredControl(controls.toggles, 'Debug logging').getValue()).toBe(false);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('restores a failed color field in its existing control', async () => {
    const controls = captureControls();
    const { persistence, store, tab } = fixture();
    persistence.saveData.mockRejectedValueOnce(new Error('color failed'));
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.render();
    const foreground = requiredControl(controls.colors, 'Foreground');

    foreground.setValue('#112233');
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledTimes(1);
    });

    expect(store.snapshot.settings.reading.custom.foreground).toBe('#dddddd');
    expect(requiredControl(controls.colors, 'Foreground')).toBe(foreground);
    expect(foreground.getValue()).toBe('#dddddd');
  });

  it('restores failed annotation fields through their existing controls', async () => {
    const controls = captureControls();
    const { persistence, store, tab } = fixture();
    persistence.saveData.mockRejectedValue(new Error('disk full'));
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.render();

    enterText(requiredControl(controls.texts, 'Annotation author'), 'Ada');
    enterText(requiredControl(controls.texts, 'Yellow meaning'), 'Important');
    enterText(requiredControl(controls.textAreas, 'Annotation transfer template'), '> Quote');

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledTimes(3);
    });
    expect(store.snapshot.settings.annotations).toMatchObject({
      author: '',
      markdownTemplate: '> {{quote}}\n\n{{comment}}\n\n{{link}}',
    });
    expect(store.snapshot.settings.annotations.palette[0]).toMatchObject({
      name: 'Yellow',
      meaning: '',
    });
    expect(requiredControl(controls.texts, 'Annotation author').getValue()).toBe('');
    expect(requiredControl(controls.texts, 'Yellow meaning').getValue()).toBe('');
    expect(requiredControl(controls.textAreas, 'Annotation transfer template').getValue()).toBe(
      '> {{quote}}\n\n{{comment}}\n\n{{link}}',
    );
  });

  it('handles a non-error save rejection with the default live-update callback', async () => {
    const controls = captureControls();
    const { persistence, store, tab } = fixture(true);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.render();
    controls.toggles.get('Debug logging')?.setValue(true);
    await vi.waitFor(() => {
      expect(store.snapshot.settings.debugLogging).toBe(true);
    });
    persistence.saveData.mockRejectedValueOnce('storage offline');

    controls.toggles.get('Debug logging')?.setValue(false);

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Could not save document settings: storage offline',
        undefined,
      );
    });
    expect(store.snapshot.settings.debugLogging).toBe(true);
  });

  it('does not rerender a stale failed write over a newer successful write', async () => {
    const controls = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    const first = deferred();
    const second = deferred();
    persistence.saveData.mockImplementationOnce(() => first.promise);
    persistence.saveData.mockImplementationOnce(() => second.promise);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.render();
    const { button } = expandSection(tab, 'Reading appearance');
    const originalBrightness = requiredControl(controls.sliders, 'Brightness');
    const originalContrast = requiredControl(controls.sliders, 'Contrast');

    originalBrightness.setValue(9);
    originalContrast.setValue(0.75);
    first.reject(new Error('first failed'));
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(2);
    });

    expect(requiredControl(controls.sliders, 'Brightness')).toBe(originalBrightness);
    second.resolve();
    await vi.waitFor(() => {
      expect(onSettingsChange).toHaveBeenCalledOnce();
    });

    expect(store.snapshot.settings.reading.custom).toMatchObject({ brightness: 1, contrast: 0.75 });
    expect(requiredControl(controls.sliders, 'Brightness').sliderEl).toBe(
      originalBrightness.sliderEl,
    );
    expect(requiredControl(controls.sliders, 'Contrast').sliderEl).toBe(originalContrast.sliderEl);
    expect(originalBrightness.getValue()).toBe(1);
    expect(originalContrast.getValue()).toBe(0.75);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('does not roll back a failed field after a newer same-field write succeeds', async () => {
    const controls = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    const first = deferred();
    const second = deferred();
    persistence.saveData.mockImplementationOnce(() => first.promise);
    persistence.saveData.mockImplementationOnce(() => second.promise);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.render();
    const brightness = requiredControl(controls.sliders, 'Brightness');

    brightness.setValue(9);
    brightness.setValue(1.25);
    first.reject(new Error('first failed'));
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(2);
    });
    second.resolve();
    await vi.waitFor(() => {
      expect(onSettingsChange).toHaveBeenCalledOnce();
    });

    expect(store.snapshot.settings.reading.custom.brightness).toBe(1.25);
    expect(requiredControl(controls.sliders, 'Brightness').sliderEl).toBe(brightness.sliderEl);
    expect(brightness.getValue()).toBe(1.25);
  });

  it('renders the committed first write after the newer write fails', async () => {
    const controls = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    const first = deferred();
    const second = deferred();
    persistence.saveData.mockImplementationOnce(() => first.promise);
    persistence.saveData.mockImplementationOnce(() => second.promise);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tab.containerEl.doc.body.append(tab.containerEl);
    tab.render();
    const { body } = expandSection(tab, 'Reading appearance');
    const originalBrightness = requiredControl(controls.sliders, 'Brightness');
    const originalContrast = requiredControl(controls.sliders, 'Contrast');

    originalBrightness.setValue(1.25);
    originalContrast.setValue(-2);
    first.resolve();
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(2);
    });

    expect(requiredControl(controls.sliders, 'Brightness')).toBe(originalBrightness);
    originalContrast.sliderEl.focus();
    second.reject(new Error('second failed'));
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledTimes(1);
    });

    expect(store.snapshot.settings.reading.custom).toMatchObject({ brightness: 1.25, contrast: 1 });
    expect(body.isConnected).toBe(true);
    expect(body.hidden).toBe(false);
    expect(requiredControl(controls.sliders, 'Brightness')).toBe(originalBrightness);
    expect(requiredControl(controls.sliders, 'Contrast')).toBe(originalContrast);
    expect(originalBrightness.getValue()).toBe(1.25);
    expect(originalContrast.getValue()).toBe(1);
    expect(tab.containerEl.doc.activeElement).toBe(originalContrast.sliderEl);
    expect(onSettingsChange).toHaveBeenCalledOnce();
  });
});
