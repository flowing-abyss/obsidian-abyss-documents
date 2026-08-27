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

export interface AnnotationLinkToken {
  readonly close: number | null;
  readonly open: number;
  readonly query: string;
  readonly targetEnd: number;
}

export interface AnnotationLinkReplacement {
  readonly cursor: number;
  readonly value: string;
}

export function annotationLinkTokenAtCursor(
  value: string,
  cursor: number,
): AnnotationLinkToken | null {
  const open = value.lastIndexOf('[[', cursor);
  if (open < 0 || cursor < open + 2) return null;
  const closeIndex = value.indexOf(']]', open + 2);
  const close = closeIndex < 0 ? null : closeIndex;
  if (close !== null && cursor > close) return null;
  const alias = value.indexOf('|', open + 2);
  const targetEnd = alias >= 0 && (close === null || alias < close) ? alias : (close ?? cursor);
  return { close, open, query: value.slice(open + 2, targetEnd), targetEnd };
}

export function replaceAnnotationLinkSuggestion(
  value: string,
  cursor: number,
  insertion: string,
): AnnotationLinkReplacement | null {
  const token = annotationLinkTokenAtCursor(value, cursor);
  if (token === null) return null;
  if (token.close !== null && isWikiLink(insertion)) {
    const target = wikiLinkTarget(insertion);
    return {
      cursor: token.open + 2 + target.length,
      value: value.slice(0, token.open + 2) + target + value.slice(token.targetEnd),
    };
  }
  const end = token.close === null ? cursor : token.close + 2;
  return {
    cursor: token.open + insertion.length,
    value: value.slice(0, token.open) + insertion + value.slice(end),
  };
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

function isWikiLink(value: string): boolean {
  return value.startsWith('[[') && value.endsWith(']]');
}

function wikiLinkTarget(value: string): string {
  return isWikiLink(value) ? (value.slice(2, -2).split('|', 1)[0] ?? '') : value;
}
