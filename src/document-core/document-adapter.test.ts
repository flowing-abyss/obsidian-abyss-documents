import { App, TFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { DocumentAdapterRegistry } from './document-adapter.js';
import type { DocumentAdapter } from './document.js';
import { DocumentOpenError } from './errors.js';

const app = App.createConfigured__({ files: { 'Research/paper.pdf': '' } });
const file = app.vault.getAbstractFileByPath('Research/paper.pdf');
if (!(file instanceof TFile)) throw new Error('Expected the test fixture to create a PDF file.');
const pdfFile = file.asOriginalType2__();

const unsupported: DocumentAdapter = {
  id: 'unsupported',
  supports: () => false,
  open: async () => {
    throw new Error('This adapter must not open files in this test.');
  },
};

const pdf: DocumentAdapter = {
  id: 'pdf',
  supports: (file) => file.path.endsWith('.pdf'),
  open: async () => {
    throw new Error('This adapter must not open files in this test.');
  },
};

describe('DocumentAdapterRegistry', () => {
  it('selects exactly one adapter by registration order', () => {
    const registry = new DocumentAdapterRegistry([unsupported, pdf]);

    expect(registry.requireFor(pdfFile)).toBe(pdf);
  });

  it('reports an unsupported file as a typed open error', () => {
    const registry = new DocumentAdapterRegistry([unsupported]);

    expect(() => registry.requireFor(pdfFile)).toThrow(DocumentOpenError);
  });
});
