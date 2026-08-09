import type { PluginManifest } from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import AbyssDocumentsPlugin from './main.js';

const manifest: PluginManifest = {
  id: 'abyss-documents',
  name: 'Abyss Documents',
  author: 'test',
  version: '0.0.0-test',
  minAppVersion: '1.7.2',
  description: 'Test manifest',
};

function createPlugin(): AbyssDocumentsPlugin {
  const app = App.createConfigured__();
  return new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
}

describe('AbyssDocumentsPlugin', () => {
  it('loads version 1 data with a PDF-only view default', async () => {
    const loadRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'load');
    const createObjectURL = vi.fn();
    const createWorker = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal('Worker', createWorker);
    const plugin = createPlugin();
    await plugin.onload();

    expect(plugin.data.settings.reading.defaultProfile).toBe('auto');
    expect(plugin.data.view.sidebar.open).toBe(false);
    expect(plugin).toHaveProperty('runtimeLoader', expect.any(PdfRuntimeLoader));
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();

    plugin.onunload();
  });
});
