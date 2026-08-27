import type { TFile } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import {
  annotationLinkTokenAtCursor,
  LinkSuggestionService,
  parseAnnotationTokens,
  replaceAnnotationLinkSuggestion,
} from './link-suggestions.js';

function md(path: string): TFile {
  const app = App.createConfigured__({ files: { [path]: '' } });
  const source = app.vault.getAbstractFileByPath(path);
  if (!(source instanceof MockTFile)) throw new Error(`Expected Markdown fixture ${path}.`);
  return source.asOriginalType2__();
}

describe('annotation link suggestions', () => {
  it('locates the active wiki-link target and preserves a closed token alias on replacement', () => {
    const value = 'See [[con|Existing alias]] later';
    expect({
      replacement: replaceAnnotationLinkSuggestion(value, 9, '[[Concept]]'),
      token: annotationLinkTokenAtCursor(value, 9),
    }).toEqual({
      replacement: { cursor: 13, value: 'See [[Concept|Existing alias]] later' },
      token: { close: 24, open: 4, query: 'con', targetEnd: 9 },
    });
  });

  it('parses explicit Unicode tags and wiki-link targets without consuming ordinary prose', () => {
    expect(
      parseAnnotationTokens('prose#x #Tag #ＴＡＧ [[Concept|alias]] [[Other#H]] [brackets]'),
    ).toEqual({ tags: [{ normalized: 'tag', display: 'Tag' }], links: ['Concept', 'Other'] });
  });

  it('offers only Markdown files with public metadata cache entries and preserves aliases/link style', () => {
    const concept = md('Notes/Concept.md');
    const hidden = md('Private/Hidden.md');
    const generateMarkdownLink = vi.fn((_file, _source, _subpath, alias) =>
      alias === undefined ? '[[Concept]]' : `[[Concept|${alias}]]`,
    );
    const service = new LinkSuggestionService(
      { getMarkdownFiles: () => [concept, hidden] },
      {
        getFileCache: (file) => (file === concept ? { frontmatter: { aliases: ['Idea'] } } : null),
      },
      { generateMarkdownLink },
    );

    expect(service.suggest('ide', 'Books/Book.pdf')).toEqual([
      { display: 'Idea', path: 'Notes/Concept.md', insertion: '[[Concept|Idea]]' },
    ]);
    expect(service.suggest('', 'Books/Book.pdf').map(({ path }) => path)).toEqual([
      'Notes/Concept.md',
    ]);
    expect(generateMarkdownLink).toHaveBeenCalledWith(concept, 'Books/Book.pdf', undefined, 'Idea');
    expect(service).not.toHaveProperty('isPathIgnored');
  });

  it('uses basenames, sorts and caps candidates, and ignores malformed tokens', () => {
    const candidates = Array.from({ length: 60 }, (_, index) =>
      md(`Notes/Z${String(index).padStart(2, '0')}.md`),
    );
    const service = new LinkSuggestionService(
      { getMarkdownFiles: () => candidates },
      { getFileCache: () => ({}) },
      { generateMarkdownLink: (file) => `[[${file.basename}]]` },
    );
    const results = service.suggest(' z ', 'Source.md');
    expect(results).toHaveLength(50);
    expect(results[0]?.display).toBe('Z00');
    expect(results[0]?.insertion).toBe('[[Z00]]');
    expect(parseAnnotationTokens('# #Tag #tag [[ ]] [[bad[link]] [[open')).toEqual({
      tags: [{ normalized: 'tag', display: 'Tag' }],
      links: [],
    });
    expect(parseAnnotationTokens('[[One]]\n[[One|again]]\n[[Two\nBad]]')).toEqual({
      tags: [],
      links: ['One'],
    });
  });

  it('preserves the first raw Unicode link target while comparing canonically', () => {
    expect(parseAnnotationTokens('[[Ｆｏｏ#Section|Shown]] [[Foo|Again]]')).toEqual({
      tags: [],
      links: ['Ｆｏｏ'],
    });
  });

  it('preserves tag spelling while using deterministic Unicode comparison', () => {
    expect(parseAnnotationTokens('#İdea #idea #I #ı #ＴＡＧ')).toEqual({
      tags: [
        { display: 'İdea', normalized: 'i̇dea' },
        { display: 'idea', normalized: 'idea' },
        { display: 'I', normalized: 'i' },
        { display: 'ı', normalized: 'ı' },
        { display: 'ＴＡＧ', normalized: 'tag' },
      ],
      links: [],
    });
  });

  it('caches the public metadata candidate index until explicit invalidation', () => {
    const concept = md('Notes/Concept.md');
    const getMarkdownFiles = vi.fn(() => [concept]);
    const getFileCache = vi.fn(() => ({}));
    const service = new LinkSuggestionService(
      { getMarkdownFiles },
      { getFileCache },
      { generateMarkdownLink: () => '[[Concept]]' },
    );
    service.suggest('con', 'Books/One.pdf');
    service.suggest('con', 'Books/Two.pdf');
    expect(getMarkdownFiles).toHaveBeenCalledOnce();
    expect(getFileCache).toHaveBeenCalledOnce();
    service.invalidate();
    service.suggest('con', 'Books/Two.pdf');
    expect(getMarkdownFiles).toHaveBeenCalledTimes(2);
  });
});
