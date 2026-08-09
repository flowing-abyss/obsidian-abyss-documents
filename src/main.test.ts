import type { PluginManifest } from 'obsidian';
import { App, WorkspaceLeaf } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { PdfRuntimeLoader } from './adapters/pdf/pdf-runtime.js';
import AbyssDocumentsPlugin from './main.js';
import { AbyssDocumentView, DOCUMENT_VIEW_TYPE } from './reader/document-view.js';

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

  it('registers the deferred PDF FileView and runtime cleanup without loading PDF.js', async () => {
    const app = App.createConfigured__();
    const plugin = new AbyssDocumentsPlugin(app.asOriginalType__(), manifest);
    const registerView = vi.spyOn(plugin, 'registerView');
    const registerExtensions = vi.spyOn(plugin, 'registerExtensions');
    const register = vi.spyOn(plugin, 'register');
    const loadRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'load');
    const disposeRuntime = vi.spyOn(PdfRuntimeLoader.prototype, 'dispose');

    await plugin.onload();

    expect(registerExtensions).toHaveBeenCalledWith(['pdf'], DOCUMENT_VIEW_TYPE);
    const registration = registerView.mock.calls.find(([type]) => type === DOCUMENT_VIEW_TYPE);
    expect(registration).toBeDefined();
    const creator = registration?.[1];
    if (creator === undefined) throw new Error('Expected the document view creator.');
    const leaf = WorkspaceLeaf.create2__(app);
    expect(creator(leaf.asOriginalType3__())).toBeInstanceOf(AbyssDocumentView);
    expect(loadRuntime).not.toHaveBeenCalled();

    const cleanup = register.mock.calls[register.mock.calls.length - 1]?.[0];
    if (cleanup === undefined) throw new Error('Expected runtime cleanup registration.');
    cleanup();
    expect(disposeRuntime).toHaveBeenCalledOnce();
  });
});
