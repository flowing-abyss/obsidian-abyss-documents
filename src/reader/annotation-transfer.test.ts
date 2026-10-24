import { MarkdownView, type FileManager, type TFile, type WorkspaceLeaf } from 'obsidian';
import { App, TFile as MockTFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentAnnotation } from '../document-core/annotations.js';
import { asAnnotationId } from '../document-core/annotations.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  AnnotationTransferService,
  applyAnnotationTransfer,
  buildAnnotationHref,
  buildAnnotationTransfer,
  parseAnnotationHref,
  resolveAnnotationHref,
} from './annotation-transfer.js';

function annotation(id: string, pageIndex = 1, x = 10): DocumentAnnotation {
  return {
    identity: { kind: 'stable', id: asAnnotationId(id) },
    type: 'highlight',
    anchor: {
      kind: 'fixed-page',
      pageIndex,
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'rectangle', rectangle: { x, y: 20, width: 30, height: 4 } },
    },
    color: '#ffd400',
    selectedText: 'A ]]> useful quote',
    author: '',
    createdAt: null,
    modifiedAt: null,
    comment: 'Comment {{quote}} #Tag [[Concept|alias]]',
    tags: ['Tag'],
    links: ['Concept'],
    capabilities: {} as DocumentAnnotation['capabilities'],
  };
}

function file(): TFile {
  const app = App.createConfigured__({ files: { 'Books/Book.pdf': '' } });
  const source = app.vault.getAbstractFileByPath('Books/Book.pdf');
  if (!(source instanceof MockTFile)) throw new Error('Expected PDF fixture.');
  return source.asOriginalType2__();
}

describe('annotation transfer and deep links', () => {
  it('builds and parses the canonical encoded id/page/geometry subpath', () => {
    const href = buildAnnotationHref(annotation('12 R'));
    expect(href).toBe(
      '#annotation=12%20R&page=2&fingerprint=highlight%3Arectangle%3A10%2C20%2C30%2C4',
    );
    expect(parseAnnotationHref(href)).toEqual({
      id: '12 R',
      page: 2,
      fingerprint: 'highlight:rectangle:10,20,30,4',
    });
    expect(parseAnnotationHref('#annotation=x&page=0&fingerprint=y')).toBeNull();
    expect(parseAnnotationHref('#annotation=&page=1&fingerprint=y')).toBeNull();
    expect(parseAnnotationHref('#annotation=%E0%A4%A&page=1&fingerprint=x')).toBeNull();
  });

  it('refuses deep links and transfer payloads until PDF.js has committed a stable id', () => {
    const pending = {
      ...annotation('pending'),
      identity: { kind: 'legacy', fingerprint: 'draft' },
    } satisfies DocumentAnnotation;
    expect(() => buildAnnotationHref(pending)).toThrow(/save.*annotation/iu);
    expect(() =>
      buildAnnotationTransfer(pending, file(), '{{link}}', {
        fileManager: { generateMarkdownLink: vi.fn() },
        sourcePath: 'Books/Book.pdf',
      }),
    ).toThrow(/save.*annotation/iu);
  });

  it('uses committed id first, then only a unique page and geometry fallback', () => {
    const original = annotation('12R');
    const renumbered = annotation('99R');
    const href = buildAnnotationHref(original);
    const reference = parseAnnotationHref(href);
    if (reference === null) throw new Error('Expected valid annotation href.');
    expect(resolveAnnotationHref(reference, [original, renumbered])).toMatchObject({
      status: 'resolved',
      annotation: original,
      matchedBy: 'id',
    });
    expect(resolveAnnotationHref(reference, [renumbered])).toMatchObject({
      status: 'resolved',
      annotation: renumbered,
      matchedBy: 'geometry',
    });
    expect(resolveAnnotationHref(reference, [renumbered, annotation('100R')])).toMatchObject({
      status: 'ambiguous',
    });
    expect(resolveAnnotationHref(reference, [annotation('x', 4, 80)])).toMatchObject({
      status: 'unresolved',
    });
  });

  it('generates user-style links, safely renders the template, and sets both drag MIME types', () => {
    const generateMarkdownLink = vi.fn(
      (_file: TFile, _source: string, _subpath?: string) =>
        '[[Book.pdf#annotation=12R&page=2&fingerprint=f]]',
    );
    const pdf = file();
    const transfer = buildAnnotationTransfer(
      annotation('12R'),
      pdf,
      '> {{quote}}\n\n{{comment}}\n\n{{link}}',
      { fileManager: { generateMarkdownLink }, sourcePath: 'Notes/Study.md' },
    );
    const [target, sourcePath, subpath] = generateMarkdownLink.mock.calls[0] ?? [];
    expect(target).toBe(pdf);
    expect(sourcePath).toBe('Notes/Study.md');
    expect(subpath).toMatch(/^#annotation=/u);
    expect(transfer.markdown).toContain('![[Book.pdf#annotation=12R');
    expect(transfer.markdown).toContain('A ]\\]> useful quote');
    expect(transfer.markdown).toContain('Comment \\{{quote\\}}');
    expect(transfer.plain).toContain('A ]]> useful quote');

    const values = new Map<string, string>();
    applyAnnotationTransfer({ setData: (type, value) => values.set(type, value) }, transfer);
    expect(values.get('text/plain')).toBe(transfer.plain);
    expect(values.get('text/markdown')).toBe(transfer.markdown);
  });

  it.each([
    '[[Book.pdf#annotation=12R&page=2]]',
    '[Book.pdf](Books/Book.pdf#annotation=12R&page=2)',
  ])('renders the actual default as one complete Obsidian link for %s style', (generated) => {
    const transfer = buildAnnotationTransfer(
      annotation('12R'),
      file(),
      DEFAULT_SETTINGS.annotations.markdownTemplate,
      {
        fileManager: { generateMarkdownLink: () => generated },
        sourcePath: 'Books/Book.pdf',
      },
    );
    expect(transfer.markdown).toContain(generated.startsWith('!') ? generated : `!${generated}`);
    expect(transfer.markdown).not.toContain('[Open annotation](');
  });

  it('copies and inserts through public clipboard/workspace editor APIs with one failure boundary', async () => {
    const replaceRange = vi.fn();
    const focus = vi.fn();
    const writeText = vi.fn(async () => undefined);
    const failures: string[] = [];
    const service = new AnnotationTransferService({
      fileManager: { generateMarkdownLink: () => '[[Book.pdf#annotation=12R]]' },
      workspace: {
        activeEditor: {
          editor: { getCursor: () => ({ line: 2, ch: 4 }), replaceRange, focus },
          file: { path: 'Notes/Study.md' },
        },
      } as never,
      clipboard: { writeText },
      template: () => '{{quote}} {{link}}',
      onFailure: ({ action }) => failures.push(action),
    });
    await service.copyAnnotationLink(annotation('12R'), file());
    service.insertAnnotationIntoActiveMarkdown(annotation('12R'), file());
    expect(writeText).toHaveBeenCalledWith(
      '[[Books/Book.pdf#annotation=12R&page=2&fingerprint=highlight%3Arectangle%3A10%2C20%2C30%2C4]]',
    );
    expect(replaceRange).toHaveBeenCalledWith(expect.stringContaining('![[Book.pdf'), {
      line: 2,
      ch: 4,
    });
    expect(focus).toHaveBeenCalledOnce();
    expect(failures).toEqual([]);

    const failed = new AnnotationTransferService({
      fileManager: {
        generateMarkdownLink: () => {
          throw new Error('format failed');
        },
      },
      workspace: {
        activeEditor: null,
        getMostRecentLeaf: () => null,
      },
      clipboard: {
        writeText: async () => {
          throw new Error('clipboard denied');
        },
      },
      template: () => '',
      onFailure: ({ action }) => failures.push(action),
    });
    await expect(failed.copyAnnotationLink(annotation('12R'), file())).resolves.toBeUndefined();
    failed.insertAnnotationIntoActiveMarkdown(annotation('12R'), file());
    expect(failures).toEqual(['copy', 'insert']);
  });

  it('uses a target-independent vault-absolute wiki link for clipboard and drag payloads', async () => {
    const writeText = vi.fn(async () => undefined);
    const generateMarkdownLink = vi.fn(() => '[Book](../Books/Book.pdf)');
    const service = new AnnotationTransferService({
      fileManager: { generateMarkdownLink },
      workspace: {
        activeEditor: null,
        getMostRecentLeaf: () => null,
      },
      clipboard: { writeText },
      template: () => '{{link}}',
      onFailure: vi.fn(),
    });
    const pdf = file();
    expect(service.build(annotation('12R'), pdf).markdown).toContain(
      '![[Books/Book.pdf#annotation=',
    );
    await service.copyAnnotationLink(annotation('12R'), pdf);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[[Books/Book.pdf#annotation='));
    expect(generateMarkdownLink).not.toHaveBeenCalled();
  });

  it('uses the exact Markdown insertion target for same-basename cross-folder links', () => {
    const replaceRange = vi.fn();
    const generateMarkdownLink = vi.fn((_file, sourcePath) =>
      sourcePath === 'Research/Book.md' ? '[Book PDF](../Books/Book.pdf)' : '[wrong](Book.pdf)',
    );
    const service = new AnnotationTransferService({
      fileManager: { generateMarkdownLink },
      workspace: {
        activeEditor: {
          editor: { getCursor: () => ({ line: 0, ch: 0 }), replaceRange, focus: vi.fn() },
          file: { path: 'Research/Book.md' },
        },
        getMostRecentLeaf: () => null,
        iterateAllLeaves: () => undefined,
      } as never,
      clipboard: { writeText: vi.fn(async () => undefined) },
      template: () => '{{link}}',
      onFailure: vi.fn(),
    });
    const pdf = file();
    service.insertAnnotationIntoActiveMarkdown(annotation('12R'), pdf);
    expect(generateMarkdownLink).toHaveBeenCalledWith(
      pdf,
      'Research/Book.md',
      expect.stringMatching(/^#annotation=/u),
    );
    expect(replaceRange).toHaveBeenCalledWith(
      expect.stringContaining('![Book PDF](../Books/Book.pdf)'),
      { line: 0, ch: 0 },
    );
  });

  it('regenerates links from the current Obsidian-managed path after rename', () => {
    const mutable = file() as TFile & { path: string; name: string; basename: string };
    const generateMarkdownLink = vi.fn((target: TFile) => `[[${target.path}]]`);
    const context = {
      fileManager: { generateMarkdownLink } as Pick<FileManager, 'generateMarkdownLink'>,
      sourcePath: 'Notes/Study.md',
    };
    expect(
      buildAnnotationTransfer(annotation('12R'), mutable, '{{link}}', context).markdown,
    ).toContain('Books/Book.pdf');
    mutable.path = 'Archive/Renamed.pdf';
    mutable.name = 'Renamed.pdf';
    mutable.basename = 'Renamed';
    expect(
      buildAnnotationTransfer(annotation('12R'), mutable, '{{link}}', context).markdown,
    ).toContain('Archive/Renamed.pdf');
    expect(generateMarkdownLink).toHaveBeenCalledTimes(2);
  });

  it('inserts into the most recent MarkdownView without activating or focusing its leaf', () => {
    const replaceRange = vi.fn();
    const focus = vi.fn();
    const markdownView = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      editMode: { editor: { getCursor: () => ({ line: 1, ch: 2 }), replaceRange, focus } },
      file: { path: 'Notes/Recent.md' },
    });
    const setActiveLeaf = vi.fn();
    const service = new AnnotationTransferService({
      fileManager: { generateMarkdownLink: () => '[[Book.pdf#annotation=12R]]' },
      workspace: {
        activeEditor: null,
        getMostRecentLeaf: () => ({ view: markdownView }),
        iterateAllLeaves: () => undefined,
        setActiveLeaf,
      } as never,
      clipboard: { writeText: vi.fn(async () => undefined) },
      template: () => '{{link}}',
      onFailure: vi.fn(),
    });
    service.insertAnnotationIntoActiveMarkdown(annotation('12R'), file());
    expect(replaceRange).toHaveBeenCalledOnce();
    expect(setActiveLeaf).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not insert into an arbitrary Markdown leaf when the most recent leaf is not Markdown', () => {
    const replaceRange = vi.fn();
    const markdownView = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      editMode: { editor: { getCursor: () => ({ line: 0, ch: 0 }), replaceRange, focus: vi.fn() } },
      file: { path: 'Notes/Fallback.md' },
    });
    const service = new AnnotationTransferService({
      fileManager: { generateMarkdownLink: () => '[[Book.pdf]]' },
      workspace: {
        activeEditor: null,
        getMostRecentLeaf: () => ({ view: {} }),
        iterateAllLeaves: (visit: (leaf: WorkspaceLeaf) => unknown) => {
          visit({ view: markdownView } as unknown as WorkspaceLeaf);
        },
      } as never,
      clipboard: { writeText: vi.fn(async () => undefined) },
      template: () => '{{link}}',
      onFailure: vi.fn(),
    });
    service.insertAnnotationIntoActiveMarkdown(annotation('12R'), file());
    expect(replaceRange).not.toHaveBeenCalled();
  });

  it('covers every geometry fingerprint and legacy/reflowable identity branch', () => {
    const point = {
      ...annotation('point', 0, 0),
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 1.23456, y: 2 } },
      },
    } satisfies DocumentAnnotation;
    const quadrilaterals = {
      ...annotation('quad', 0, 0),
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: {
          kind: 'quadrilaterals',
          quadrilaterals: [
            {
              topLeft: { x: 1, y: 2 },
              topRight: { x: 3, y: 4 },
              bottomLeft: { x: 5, y: 6 },
              bottomRight: { x: 7, y: 8 },
            },
          ],
        },
      },
    } satisfies DocumentAnnotation;
    const ink = {
      ...annotation('ink', 0, 0),
      anchor: {
        kind: 'fixed-page',
        pageIndex: 0,
        coordinateSpace: 'page-points-top-left',
        geometry: {
          kind: 'ink',
          paths: [
            [
              { x: 1, y: 2 },
              { x: 3, y: 4 },
            ],
          ],
        },
      },
    } satisfies DocumentAnnotation;
    const legacy = {
      ...annotation('legacy', 0, 0),
      identity: { kind: 'legacy', fingerprint: 'old' },
      anchor: {
        kind: 'reflowable-text',
        selector: { exact: 'a', prefix: '', suffix: '' },
        progression: 0.2,
      },
    } satisfies DocumentAnnotation;
    const stableReflowable = {
      ...legacy,
      identity: { kind: 'stable' as const, id: asAnnotationId('flow') },
    } satisfies DocumentAnnotation;
    expect([point, quadrilaterals, ink].map(buildAnnotationHref)).toEqual([
      '#annotation=point&page=1&fingerprint=highlight%3Apoint%3A1.2346%2C2',
      '#annotation=quad&page=1&fingerprint=highlight%3Aquadrilaterals%3A1%2C2%2C3%2C4%2C5%2C6%2C7%2C8',
      '#annotation=ink&page=1&fingerprint=highlight%3Aink%3A1%2C2%3B3%2C4',
    ]);
    expect(() => buildAnnotationHref(legacy)).toThrow(/save.*annotation/iu);
    expect(() => buildAnnotationHref(stableReflowable)).toThrow(/fixed-page.*annotation/iu);
  });

  it('rejects incomplete hrefs and reports duplicate ids without reaching fallback', () => {
    expect(parseAnnotationHref('annotation=x&page=1')).toBeNull();
    expect(parseAnnotationHref('annotation=x&fingerprint=f')).toBeNull();
    expect(parseAnnotationHref('page=1&fingerprint=f')).toBeNull();
    expect(parseAnnotationHref('annotation=x&page=no&fingerprint=f')).toBeNull();
    const reference = { id: 'same', page: 1, fingerprint: 'point:0,0' };
    expect(
      resolveAnnotationHref(reference, [annotation('same'), annotation('same')]),
    ).toMatchObject({ status: 'ambiguous' });
  });

  it('uses build without an active editor, preserves an already embedded link, and deduplicates failures', async () => {
    const failures: string[] = [];
    const generateMarkdownLink = vi.fn(() => '![[Book.pdf#annotation=x]]');
    const service = new AnnotationTransferService({
      fileManager: { generateMarkdownLink },
      workspace: {
        activeEditor: null,
        getMostRecentLeaf: () => null,
      },
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
      template: () => '{{link}}',
      onFailure: ({ action }) => failures.push(action),
    });
    expect(service.build(annotation('x', 0), file()).markdown).toBe(
      '![[Books/Book.pdf#annotation=x&page=1&fingerprint=highlight%3Arectangle%3A10%2C20%2C30%2C4]]',
    );
    await service.copyAnnotationLink(annotation('x'), file());
    await service.copyAnnotationLink(annotation('x'), file());
    expect(failures).toEqual(['copy']);
  });
});
