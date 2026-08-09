import type {
  ColorComponent,
  DropdownComponent,
  ExtraButtonComponent,
  PluginManifest,
  SliderComponent,
  ToggleComponent,
} from 'obsidian';
import { Setting } from 'obsidian';
import { App, Notice } from 'obsidian-test-mocks/obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AbyssDocumentsPlugin from './main.js';
import { PluginDataStore } from './plugin-data.js';
import { AbyssDocumentsSettingTab } from './settings-tab.js';

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
  readonly expanders: Map<string, ExtraButtonComponent & { simulateClick__(): void }>;
  readonly sliders: Map<string, SliderComponent>;
  readonly toggles: Map<string, ToggleComponent>;
}

function captureControls(): CapturedControls {
  const colors = new Map<string, ColorComponent>();
  const dropdowns = new Map<string, DropdownComponent>();
  const expanders = new Map<string, ExtraButtonComponent & { simulateClick__(): void }>();
  const sliders = new Map<string, SliderComponent>();
  const toggles = new Map<string, ToggleComponent>();
  captureSettingComponent('addColorPicker', colors);
  captureSettingComponent('addDropdown', dropdowns);
  captureSettingComponent('addExtraButton', expanders);
  captureSettingComponent('addSlider', sliders);
  captureSettingComponent('addToggle', toggles);
  return { colors, dropdowns, expanders, sliders, toggles };
}

type ComponentSettingMethod =
  'addColorPicker' | 'addDropdown' | 'addExtraButton' | 'addSlider' | 'addToggle';

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

describe('AbyssDocumentsSettingTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Reading appearance and Advanced collapsed without future sections', () => {
    const { tab } = fixture();

    tab.render();

    const expanders = Array.from(tab.containerEl.querySelectorAll<HTMLElement>('[aria-expanded]'));
    expect(expanders).toHaveLength(2);
    expect(expanders.every((element) => element.getAttribute('aria-expanded') === 'false')).toBe(
      true,
    );
    expect(tab.containerEl.textContent).toContain('Reading appearance');
    expect(tab.containerEl.textContent).toContain('Advanced');
    expect(tab.containerEl.textContent).not.toMatch(/annotation|ocr/iu);
    expect(tab.containerEl.classList.contains('abyss-documents-settings')).toBe(true);
    expect(tab.getSettingDefinitions()).toEqual([]);
    (tab as unknown as { display(): void }).display();
  });

  it('expands and collapses both native settings sections', () => {
    const controls = captureControls();
    const { tab } = fixture();
    tab.render();

    for (const [title, expander] of controls.expanders) {
      const bodyId = expander.extraSettingsEl.getAttribute('aria-controls');
      if (bodyId === null) throw new Error(`Expected ${title} section controls.`);
      const body = tab.containerEl.querySelector<HTMLElement>(`#${bodyId}`);
      expander.simulateClick__();
      expect(body?.hidden).toBe(false);
      expect(expander.extraSettingsEl.getAttribute('aria-expanded')).toBe('true');
      expect(expander.extraSettingsEl.getAttribute('aria-label')).toBe(
        `Hide ${title.toLowerCase()}`,
      );
      expander.simulateClick__();
      expect(body?.hidden).toBe(true);
      expect(expander.extraSettingsEl.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('persists every native profile, color, and toggle control', async () => {
    const controls = captureControls();
    const { onSettingsChange, persistence, store, tab } = fixture();
    tab.render();

    controls.dropdowns.get('Default profile')?.setValue('unknown');
    expect(persistence.saveData).not.toHaveBeenCalled();
    controls.dropdowns.get('Default profile')?.setValue('dark');
    controls.toggles.get('Remember profile per document')?.setValue(true);
    controls.colors.get('Foreground')?.setValue('#112233');
    controls.colors.get('Page tint')?.setValue('#fefefe');
    controls.toggles.get('Debug logging')?.setValue(true);
    await vi.waitFor(() => {
      expect(persistence.saveData).toHaveBeenCalledTimes(5);
    });

    expect(store.snapshot.settings).toMatchObject({
      debugLogging: true,
      reading: {
        defaultProfile: 'dark',
        rememberPerDocument: true,
        custom: { background: '#fefefe', foreground: '#112233' },
      },
    });
    expect(onSettingsChange).toHaveBeenCalledTimes(5);
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
    expect(onSettingsChange).not.toHaveBeenCalled();
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
});
