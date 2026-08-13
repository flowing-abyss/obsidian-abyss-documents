import {
  parseFrontMatterAliases,
  type FileManager,
  type MetadataCache,
  type TFile,
  type Vault,
} from 'obsidian';
export { parseAnnotationTokens } from '../annotation-tokens.js';

export interface LinkSuggestion {
  readonly display: string;
  readonly path: string;
  readonly insertion: string;
}

export interface AnnotationLinkSuggestionProvider {
  suggest(query: string, sourcePath: string): readonly LinkSuggestion[];
}

export class LinkSuggestionService implements AnnotationLinkSuggestionProvider {
  private candidates: readonly IndexedLinkCandidate[] | null = null;

  constructor(
    private readonly vault: Pick<Vault, 'getMarkdownFiles'>,
    private readonly metadataCache: Pick<MetadataCache, 'getFileCache'>,
    private readonly fileManager: Pick<FileManager, 'generateMarkdownLink'>,
  ) {}

  suggest(query: string, sourcePath: string): readonly LinkSuggestion[] {
    const key = normalize(query.trim());
    const suggestions: LinkSuggestion[] = [];
    for (const candidate of this.index()) {
      const display = candidate.names.find((name) => normalize(name).includes(key));
      if (display === undefined) continue;
      const alias = display === candidate.file.basename ? undefined : display;
      suggestions.push({
        display,
        path: candidate.file.path,
        insertion: this.fileManager.generateMarkdownLink(
          candidate.file,
          sourcePath,
          undefined,
          alias,
        ),
      });
    }
    suggestions.sort((left, right) => left.display.localeCompare(right.display));
    return suggestions.slice(0, 50);
  }

  invalidate(): void {
    this.candidates = null;
  }

  private index(): readonly IndexedLinkCandidate[] {
    this.candidates ??= this.vault.getMarkdownFiles().flatMap((file) => {
      const cache = this.metadataCache.getFileCache(file);
      if (cache === null) return [];
      const aliases = parseFrontMatterAliases(cache.frontmatter ?? null) ?? [];
      return [{ file, names: [file.basename, ...aliases] }];
    });
    return this.candidates;
  }
}

interface IndexedLinkCandidate {
  readonly file: TFile;
  readonly names: readonly string[];
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}
