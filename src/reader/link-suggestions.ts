import {
  getAllTags,
  parseFrontMatterAliases,
  type FileManager,
  type MetadataCache,
  type TFile,
  type Vault,
} from 'obsidian';
export { parseAnnotationTokens } from '../annotation-tokens.js';

export interface AnnotationSuggestion {
  readonly display: string;
  readonly insertion: string;
  readonly path?: string;
}

export type AnnotationSuggestionKind = 'link' | 'tag';

export interface AnnotationSuggestionProvider {
  suggest(
    kind: AnnotationSuggestionKind,
    query: string,
    sourcePath: string,
  ): readonly AnnotationSuggestion[];
}

export interface AnnotationCaretToken {
  readonly close: number | null;
  readonly kind: AnnotationSuggestionKind;
  readonly open: number;
  readonly query: string;
  readonly targetEnd: number;
}

export interface AnnotationSuggestionReplacement {
  readonly cursor: number;
  readonly value: string;
}

export function annotationCaretTokenAtCursor(
  value: string,
  cursor: number,
): AnnotationCaretToken | null {
  const open = value.lastIndexOf('[[', cursor);
  if (open >= 0 && cursor >= open + 2) {
    const closeIndex = value.indexOf(']]', open + 2);
    const close = closeIndex < 0 ? null : closeIndex;
    if (close === null || cursor <= close) {
      const targetEnd = wikiTargetEnd(value, open + 2, cursor, close);
      if (cursor <= targetEnd)
        return {
          close,
          kind: 'link',
          open,
          query: value.slice(open + 2, cursor),
          targetEnd,
        };
      return null;
    }
  }
  return annotationTagTokenAtCursor(value, cursor);
}

export function replaceAnnotationSuggestion(
  value: string,
  cursor: number,
  insertion: string,
): AnnotationSuggestionReplacement | null {
  const token = annotationCaretTokenAtCursor(value, cursor);
  if (token === null) return null;
  if (token.kind === 'tag') {
    return {
      cursor: token.open + insertion.length,
      value: value.slice(0, token.open) + insertion + value.slice(token.targetEnd),
    };
  }
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

export class LinkSuggestionService implements AnnotationSuggestionProvider {
  private candidates: IndexedSuggestionCandidates | null = null;

  constructor(
    private readonly vault: Pick<Vault, 'getMarkdownFiles'>,
    private readonly metadataCache: Pick<MetadataCache, 'getFileCache'>,
    private readonly fileManager: Pick<FileManager, 'generateMarkdownLink'>,
  ) {}

  suggest(
    kind: AnnotationSuggestionKind,
    query: string,
    sourcePath: string,
  ): readonly AnnotationSuggestion[] {
    if (kind === 'tag') return this.suggestTags(query);
    const key = normalize(query.trim());
    const suggestions: AnnotationSuggestion[] = [];
    for (const candidate of this.index().links) {
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

  private index(): IndexedSuggestionCandidates {
    this.candidates ??= this.buildIndex();
    return this.candidates;
  }

  private buildIndex(): IndexedSuggestionCandidates {
    const links: IndexedLinkCandidate[] = [];
    const tags = new Map<string, string>();
    for (const file of this.vault.getMarkdownFiles()) {
      const cache = this.metadataCache.getFileCache(file);
      if (cache === null) continue;
      const aliases = parseFrontMatterAliases(cache.frontmatter ?? null) ?? [];
      links.push({ file, names: [file.basename, ...aliases] });
      for (const tag of getAllTags(cache) ?? []) {
        const display = tag.replace(/^#+/u, '').trim();
        const key = normalize(display);
        if (display.length > 0 && !tags.has(key)) tags.set(key, display);
      }
    }
    return { links, tags: Array.from(tags.values()) };
  }

  private suggestTags(query: string): readonly AnnotationSuggestion[] {
    const key = normalize(query.trim().replace(/^#+/u, ''));
    return this.index()
      .tags.filter((tag) => normalize(tag).includes(key))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 50)
      .map((tag) => ({ display: `#${tag}`, insertion: `#${tag}` }));
  }
}

interface IndexedSuggestionCandidates {
  readonly links: readonly IndexedLinkCandidate[];
  readonly tags: readonly string[];
}

interface IndexedLinkCandidate {
  readonly file: TFile;
  readonly names: readonly string[];
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function annotationTagTokenAtCursor(value: string, cursor: number): AnnotationCaretToken | null {
  const prefix = value.slice(0, cursor);
  const match = /(^|[\s([{])#([\p{L}\p{N}_/-]*)$/u.exec(prefix);
  if (match === null) return null;
  const query = match[2] ?? '';
  const open = cursor - query.length - 1;
  let targetEnd = cursor;
  while (targetEnd < value.length && /[\p{L}\p{N}_/-]/u.test(value[targetEnd] ?? ''))
    targetEnd += 1;
  return { close: null, kind: 'tag', open, query, targetEnd };
}

function wikiTargetEnd(
  value: string,
  targetStart: number,
  cursor: number,
  close: number | null,
): number {
  const limit = close ?? cursor;
  const suffix = value.slice(targetStart, limit);
  const delimiter = suffix.search(/[|#]/u);
  return delimiter < 0 ? limit : targetStart + delimiter;
}

function isWikiLink(value: string): boolean {
  return value.startsWith('[[') && value.endsWith(']]');
}

function wikiLinkTarget(value: string): string {
  return isWikiLink(value) ? (value.slice(2, -2).split('|', 1)[0] ?? '') : value;
}
