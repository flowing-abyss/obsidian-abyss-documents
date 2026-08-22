import { App, TFile as MockTFile, Notice } from 'obsidian-test-mocks/obsidian';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  AnnotationExportError,
  AnnotationExportFlow,
  AnnotationExportModal,
  exportAnnotations,
  proposedAnnotationExportPath,
  type AnnotationTypeJsonV1,
} from './annotation-export.js';
import {
  asAnnotationId,
  type AnnotationExportRecord,
  type DocumentAnnotation,
} from './document-core/annotations.js';

function fixture() {
  const app = App.createConfigured__({ files: { 'Books/Guide.pdf': '' } });
  const source = app.vault.getAbstractFileByPath('Books/Guide.pdf');
  if (!(source instanceof MockTFile)) throw new Error('Expected source PDF.');
  const annotation = {
    identity: { kind: 'stable' as const, id: asAnnotationId('12R') },
    type: 'highlight' as const,
    anchor: {
      kind: 'fixed-page' as const,
      pageIndex: 1,
      coordinateSpace: 'page-points-top-left' as const,
      geometry: { kind: 'rectangle' as const, rectangle: { x: 1, y: 2, width: 3, height: 4 } },
    },
    color: '#ffd400',
    selectedText: 'Quote }} [[unsafe]]',
    author: 'Reader',
    createdAt: null,
    modifiedAt: null,
    comment: 'Comment {{value}} #tag',
    tags: ['tag'],
    links: ['Concept'],
    capabilities: {
      comment: { available: true as const },
      color: { available: true as const },
      geometry: { available: true as const },
      metadata: { available: true as const },
      deletion: { available: true as const },
      conversions: {
        highlight: { available: true as const },
        underline: {
          available: false as const,
          reason: { code: 'lossy-conversion' as const, message: 'Unavailable' },
        },
      },
    },
  };
  const records: readonly AnnotationExportRecord[] = [
    {
      documentPath: source.path,
      documentFingerprint: 'sha256:guide',
      annotation,
    },
  ];
  return { app, originalApp: app.asOriginalType__(), records, source: source.asOriginalType2__() };
}

describe('annotation export', () => {
  it('keeps the explicit JSON-v1 annotation type union exhaustive with the current core', () => {
    expectTypeOf<AnnotationTypeJsonV1>().toEqualTypeOf<DocumentAnnotation['type']>();
  });

  it('proposes a safe sibling artifact for both explicit formats', () => {
    const { app, source } = fixture();
    expect(proposedAnnotationExportPath(source, 'markdown')).toBe('Books/Guide.annotations.md');
    expect(proposedAnnotationExportPath(source, 'json-v1')).toBe('Books/Guide.annotations.json');
    const root = MockTFile.create__(app.vault, 'Root.pdf').asOriginalType2__();
    expect(proposedAnnotationExportPath(root, 'markdown')).toBe('Root.annotations.md');
  });

  it('writes and verifies versioned JSON from canonical export records', async () => {
    const { originalApp, records, source } = fixture();
    const destination = 'Books/Guide.annotations.json';
    const exported = await exportAnnotations({
      vault: originalApp.vault,
      fileManager: originalApp.fileManager,
      source,
      records,
      format: 'json-v1',
      destination,
      overwrite: false,
      template: '{{quote}}\n\n{{comment}}\n\n{{link}}',
    });
    expect(exported.path).toBe(destination);
    expect(JSON.parse(await originalApp.vault.read(exported))).toEqual({
      schemaVersion: 1,
      document: { path: source.path, fingerprint: 'sha256:guide' },
      annotations: [
        {
          identity: { kind: 'stable', id: '12R' },
          type: 'highlight',
          externalType: null,
          anchor: {
            kind: 'fixed-page',
            pageIndex: 1,
            coordinateSpace: 'page-points-top-left',
            geometry: {
              kind: 'rectangle',
              rectangle: { x: 1, y: 2, width: 3, height: 4 },
            },
          },
          color: '#ffd400',
          selectedText: 'Quote }} [[unsafe]]',
          author: 'Reader',
          createdAt: null,
          modifiedAt: null,
          comment: 'Comment {{value}} #tag',
          tags: ['tag'],
          links: ['Concept'],
        },
      ],
    });
  });

  it('projects every fixed and reflowable anchor variant into the stable JSON-v1 schema', async () => {
    const { originalApp, records, source } = fixture();
    const base = records[0];
    if (base === undefined) throw new Error('Expected export record.');
    const annotations: readonly DocumentAnnotation[] = [
      {
        ...base.annotation,
        anchor: {
          kind: 'fixed-page',
          pageIndex: 0,
          coordinateSpace: 'page-points-top-left',
          geometry: { kind: 'point', point: { x: 1, y: 2 } },
        },
      },
      {
        ...base.annotation,
        identity: { kind: 'stable', id: asAnnotationId('quad') },
        anchor: {
          kind: 'fixed-page',
          pageIndex: 1,
          coordinateSpace: 'page-points-top-left',
          geometry: {
            kind: 'quadrilaterals',
            quadrilaterals: [
              {
                bottomLeft: { x: 1, y: 4 },
                bottomRight: { x: 3, y: 4 },
                topLeft: { x: 1, y: 2 },
                topRight: { x: 3, y: 2 },
              },
            ],
          },
        },
      },
      {
        ...base.annotation,
        identity: { kind: 'stable', id: asAnnotationId('ink') },
        anchor: {
          kind: 'fixed-page',
          pageIndex: 2,
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
      },
      {
        ...base.annotation,
        identity: { kind: 'legacy', fingerprint: 'reflowable-location' },
        anchor: {
          kind: 'reflowable-text',
          selector: { exact: 'quote', prefix: 'before', suffix: 'after' },
          progression: 0.25,
        },
      },
    ];
    const artifact = await exportAnnotations({
      vault: originalApp.vault,
      fileManager: originalApp.fileManager,
      source,
      records: annotations.map((annotation) => ({ ...base, annotation })),
      format: 'json-v1',
      destination: 'Books/Variants.annotations.json',
      overwrite: false,
      template: '{{link}}',
    });
    const json = JSON.parse(await originalApp.vault.read(artifact)) as {
      readonly annotations: ReadonlyArray<{
        readonly identity: unknown;
        readonly anchor: unknown;
      }>;
    };
    expect(json.annotations.map(({ identity, anchor }) => ({ identity, anchor }))).toEqual(
      annotations.map(({ identity, anchor }) => ({ identity, anchor })),
    );
  });

  it('rejects a forged future annotation type before any JSON-v1 artifact write', async () => {
    const { app, originalApp, records, source } = fixture();
    const record = records[0];
    if (record === undefined) throw new Error('Expected export record.');
    const create = vi.fn(async () =>
      MockTFile.create__(app.vault, 'Books/Future.annotations.json').asOriginalType2__(),
    );
    const forged = {
      ...record,
      annotation: { ...record.annotation, type: 'future-annotation-kind' },
    } as unknown as AnnotationExportRecord;

    await expect(
      exportAnnotations({
        vault: {
          getAbstractFileByPath: () => null,
          create,
          modify: async () => undefined,
          read: async () => '',
        },
        fileManager: originalApp.fileManager,
        source,
        records: [forged],
        format: 'json-v1',
        destination: 'Books/Future.annotations.json',
        overwrite: false,
        template: '{{link}}',
      }),
    ).rejects.toMatchObject({ code: 'format-failed', format: 'json-v1' });
    expect(create).not.toHaveBeenCalled();
  });

  it('exports mixed committed and legacy annotations to Markdown without inventing a legacy deep link', async () => {
    const { app, originalApp, records, source } = fixture();
    const stable = records[0];
    if (stable === undefined) throw new Error('Expected stable export record.');
    const legacy: AnnotationExportRecord = {
      ...stable,
      annotation: {
        ...stable.annotation,
        identity: { kind: 'legacy', fingerprint: 'legacy-position' },
        selectedText: 'Legacy quote',
      },
    };
    const artifact = MockTFile.create__(
      app.vault,
      'Books/Mixed.annotations.md',
    ).asOriginalType2__();
    let written = '';
    await exportAnnotations({
      vault: {
        getAbstractFileByPath: () => null,
        create: async (_path, data) => {
          written = data;
          return artifact;
        },
        modify: async (_file, data) => {
          written = data;
        },
        read: async () => written,
      },
      fileManager: originalApp.fileManager,
      source,
      records: [stable, legacy],
      format: 'markdown',
      destination: artifact.path,
      overwrite: false,
      template: '> {{quote}}\n\n{{comment}}\n\n{{link}}',
    });
    expect(written).toContain('annotation=12R');
    expect(written).toContain('Legacy quote');
    expect(written).toContain('Source: Guide.pdf, page 2');
    expect(written).not.toContain('legacy-position');
  });

  it('renders Markdown with the shared safe template/link renderer', async () => {
    const { app, originalApp, records, source } = fixture();
    const artifact = MockTFile.create__(
      app.vault,
      'Books/Guide.annotations.md',
    ).asOriginalType2__();
    let written = '';
    const exported = await exportAnnotations({
      vault: {
        getAbstractFileByPath: () => null,
        create: async (_path, data) => {
          written = data;
          return artifact;
        },
        modify: async (_file, data) => {
          written = data;
        },
        read: async () => written,
      },
      fileManager: originalApp.fileManager,
      source,
      records,
      format: 'markdown',
      destination: 'Books/Guide.annotations.md',
      overwrite: false,
      template: '> {{quote}}\n\n{{comment}}\n\n{{link}}',
    });
    expect(exported).toBe(artifact);
    const markdown = written;
    expect(markdown).toContain('\\}}');
    expect(markdown).toContain('![[Guide');
    expect(markdown).toContain('annotation=12R');
    expect(markdown).not.toContain('[Open annotation](');
  });

  it('requires explicit overwrite and wraps vault failures with destination/format context', async () => {
    const { app, originalApp, records, source } = fixture();
    const existing = await app.vault.create('Books/Guide.annotations.md', 'old');
    const request = {
      vault: originalApp.vault,
      fileManager: originalApp.fileManager,
      source,
      records,
      format: 'markdown' as const,
      destination: existing.path,
      template: '{{link}}',
    };
    await expect(exportAnnotations({ ...request, overwrite: false })).rejects.toMatchObject({
      code: 'destination-exists',
      destination: existing.path,
      format: 'markdown',
    });
    await expect(exportAnnotations({ ...request, overwrite: true })).resolves.toBe(existing);
    vi.spyOn(app.vault, 'modify').mockRejectedValueOnce(new Error('disk full'));
    let failure: unknown;
    try {
      await exportAnnotations({ ...request, overwrite: true });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(AnnotationExportError);
    if (!(failure instanceof AnnotationExportError)) throw new Error('Expected export error.');
    expect(failure).toMatchObject({
      code: 'write-failed',
      destination: existing.path,
      format: 'markdown',
    });
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it('uses a mobile-compatible native modal with cancel and explicit overwrite confirmation', async () => {
    const { app, originalApp, source } = fixture();
    await app.vault.create('Books/Guide.annotations.md', 'old');
    const modal = new AnnotationExportModal(originalApp, originalApp.vault, source);
    document.body.append(modal.containerEl);
    modal.onOpen();
    expect(modal.contentEl.querySelector('input')?.value).toBe('Books/Guide.annotations.md');
    const choice = modal.waitForChoice();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();
    expect(modal.contentEl.textContent).toContain('already exists');
    expect(modal.contentEl.querySelector('[data-action="confirm-overwrite"]')).not.toBeNull();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await expect(choice).resolves.toBeNull();
    modal.containerEl.remove();
  });

  it('rejects a folder destination in the modal instead of offering destructive overwrite', async () => {
    const { app, originalApp, source } = fixture();
    await app.vault.createFolder('Books/Exports.md');
    const modal = new AnnotationExportModal(originalApp, originalApp.vault, source);
    document.body.append(modal.containerEl);
    modal.onOpen();
    const destination = modal.contentEl.querySelector<HTMLInputElement>('input');
    if (destination === null) throw new Error('Expected destination input.');
    destination.value = 'Books/Exports.md';

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();

    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain('not a file');
    expect(modal.contentEl.querySelector('[data-action="confirm-overwrite"]')).toBeNull();
    modal.onClose();
    modal.containerEl.remove();
  });

  it('changes format paths, reports invalid input inline, and returns a new-file choice', async () => {
    const { originalApp, source } = fixture();
    const modal = new AnnotationExportModal(originalApp, originalApp.vault, source);
    document.body.append(modal.containerEl);
    modal.onOpen();
    const format = modal.contentEl.querySelector<HTMLSelectElement>('select');
    const destination = modal.contentEl.querySelector<HTMLInputElement>('input');
    if (format === null || destination === null) throw new Error('Expected export fields.');
    format.value = 'json-v1';
    format.dispatchEvent(new Event('change'));
    expect(destination.value).toBe('Books/Guide.annotations.json');
    destination.value = '../unsafe.json';
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain('safe');
    destination.value = 'Books/New.annotations.json';
    const choice = modal.waitForChoice();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();
    await expect(choice).resolves.toEqual({
      format: 'json-v1',
      destination: 'Books/New.annotations.json',
      overwrite: false,
    });
    modal.containerEl.remove();
  });

  it('returns an explicit overwrite choice only after confirmation', async () => {
    const { app, originalApp, source } = fixture();
    await app.vault.create('Books/Guide.annotations.md', 'old');
    const modal = new AnnotationExportModal(originalApp, originalApp.vault, source);
    document.body.append(modal.containerEl);
    modal.onOpen();
    const choice = modal.waitForChoice();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="confirm-overwrite"]')?.click();
    await expect(choice).resolves.toEqual({
      format: 'markdown',
      destination: 'Books/Guide.annotations.md',
      overwrite: true,
    });
    modal.containerEl.remove();
  });

  it('rejects unsafe and mismatched destinations plus non-file and unverifiable writes', async () => {
    const { app, originalApp, records, source } = fixture();
    const base = {
      vault: originalApp.vault,
      fileManager: originalApp.fileManager,
      source,
      records,
      format: 'json-v1' as const,
      overwrite: false,
      template: '{{link}}',
    };
    for (const destination of ['', '/absolute.json', 'Books\\bad.json', 'Books/../bad.json']) {
      await expect(exportAnnotations({ ...base, destination })).rejects.toMatchObject({
        code: 'invalid-destination',
        format: 'json-v1',
      });
    }
    await expect(
      exportAnnotations({ ...base, destination: 'Books/wrong.md' }),
    ).rejects.toMatchObject({ code: 'invalid-destination' });
    await app.vault.createFolder('Books/Folder.json');
    await expect(
      exportAnnotations({ ...base, destination: 'Books/Folder.json' }),
    ).rejects.toMatchObject({ code: 'destination-not-file' });
    const artifact = MockTFile.create__(app.vault, 'Books/Unverified.json').asOriginalType2__();
    await expect(
      exportAnnotations({
        ...base,
        destination: artifact.path,
        vault: {
          getAbstractFileByPath: () => null,
          create: async () => artifact,
          modify: async () => undefined,
          read: async () => 'different bytes',
        },
      }),
    ).rejects.toMatchObject({ code: 'verification-failed', destination: artifact.path });
  });

  it('wraps destination lookup failures with direct API destination and format context', async () => {
    const { originalApp, records, source } = fixture();
    let failure: unknown;
    try {
      await exportAnnotations({
        vault: {
          getAbstractFileByPath: () => {
            throw new Error('vault index unavailable');
          },
          create: (path, data, options) => originalApp.vault.create(path, data, options),
          modify: (file, data, options) => originalApp.vault.modify(file, data, options),
          read: (file) => originalApp.vault.read(file),
        },
        fileManager: originalApp.fileManager,
        source,
        records,
        format: 'json-v1',
        destination: 'Books/Lookup.annotations.json',
        overwrite: false,
        template: '{{link}}',
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(AnnotationExportError);
    if (!(failure instanceof AnnotationExportError)) throw new Error('Expected export error.');
    expect(failure).toMatchObject({
      code: 'lookup-failed',
      destination: 'Books/Lookup.annotations.json',
      format: 'json-v1',
    });
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it('keeps the modal usable after a lookup error and settles only an explicit choice', async () => {
    const { originalApp, source } = fixture();
    let unavailable = true;
    const modal = new AnnotationExportModal(
      originalApp,
      {
        getAbstractFileByPath: (path) => {
          if (unavailable) throw new Error('vault index unavailable');
          return originalApp.vault.getAbstractFileByPath(path);
        },
      },
      source,
    );
    document.body.append(modal.containerEl);
    modal.onOpen();
    const choice = modal.waitForChoice();
    let settled = false;
    void choice
      .then(() => {
        settled = true;
      })
      .catch(() => undefined);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not check',
    );
    unavailable = false;
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="export"]')?.click();
    await expect(choice).resolves.toEqual({
      format: 'markdown',
      destination: 'Books/Guide.annotations.md',
      overwrite: false,
    });
    modal.containerEl.remove();
  });

  it('wraps Markdown formatter failures and writes a valid empty JSON-v1 artifact', async () => {
    const { originalApp, records, source } = fixture();
    await expect(
      exportAnnotations({
        vault: originalApp.vault,
        fileManager: {
          generateMarkdownLink: () => {
            throw new Error('formatter failed');
          },
        },
        source,
        records,
        format: 'markdown',
        destination: 'Books/Formatter.annotations.md',
        overwrite: false,
        template: '{{link}}',
      }),
    ).rejects.toMatchObject({ code: 'format-failed', format: 'markdown' });
    const empty = await exportAnnotations({
      vault: originalApp.vault,
      fileManager: originalApp.fileManager,
      source,
      records: [],
      format: 'json-v1',
      destination: 'Books/Empty.annotations.json',
      overwrite: false,
      template: '{{link}}',
    });
    expect(JSON.parse(await originalApp.vault.read(empty))).toMatchObject({
      document: { fingerprint: '' },
      annotations: [],
    });
  });

  it('uses the native modal by default and contains unknown vault lookup failures', async () => {
    const { originalApp, records, source } = fixture();
    const defaultFlow = new AnnotationExportFlow({
      app: originalApp,
      vault: originalApp.vault,
      fileManager: originalApp.fileManager,
      template: () => '{{link}}',
    });
    await expect(defaultFlow.run(source, records)).resolves.toBeNull();

    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failedFlow = new AnnotationExportFlow({
      app: originalApp,
      vault: {
        getAbstractFileByPath: () => {
          throw new Error('lookup failed');
        },
        create: (path, data, options) => originalApp.vault.create(path, data, options),
        modify: (file, data, options) => originalApp.vault.modify(file, data, options),
        read: (file) => originalApp.vault.read(file),
      },
      fileManager: originalApp.fileManager,
      template: () => '{{link}}',
      choose: async (_source, proposed) => proposed,
    });
    await expect(failedFlow.run(source, records)).resolves.toBeNull();
    expect(notice).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[abyss-documents] Failed to export PDF annotations',
      expect.objectContaining({ code: 'lookup-failed' }),
    );
  });

  it('contains confirmed failures behind one deduplicated Notice boundary while cancel is silent', async () => {
    const { app, originalApp, records, source } = fixture();
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const choose = vi.fn().mockResolvedValue(null);
    const flow = new AnnotationExportFlow({
      app: originalApp,
      vault: originalApp.vault,
      fileManager: originalApp.fileManager,
      template: () => '{{link}}',
      choose,
    });
    await expect(flow.run(source, records)).resolves.toBeNull();
    expect(notice).not.toHaveBeenCalled();

    choose.mockResolvedValue({
      format: 'markdown',
      destination: 'Books/Guide.annotations.md',
      overwrite: false,
    });
    vi.spyOn(app.vault, 'create').mockRejectedValue(new Error('read only'));
    await flow.run(source, records);
    await flow.run(source, records);
    expect(notice).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[abyss-documents] Failed to export PDF annotations',
      expect.any(AnnotationExportError),
    );
  });
});
