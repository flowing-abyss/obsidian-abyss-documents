import type { TFile } from 'obsidian';
import type { DocumentAdapter } from './document.js';
import { DocumentOpenError } from './errors.js';

export class DocumentAdapterRegistry {
  constructor(private readonly adapters: readonly DocumentAdapter[]) {}

  requireFor(file: TFile): DocumentAdapter {
    const adapter = this.adapters.find((candidate) => candidate.supports(file));
    if (adapter === undefined) {
      throw new DocumentOpenError(file.path, 'No reader supports this file.');
    }
    return adapter;
  }
}
