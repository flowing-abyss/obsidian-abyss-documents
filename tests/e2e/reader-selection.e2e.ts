import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';

const pluginId = 'abyss-documents';
const selectionEditorSelector =
  '.workspace-leaf.mod-active .abyss-documents > [data-annotation-editor-popover]:not([hidden])';
const nativeEditorSelector = selectionEditorSelector;

async function resetWorkingPdf(sourcePath: string, targetPath: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      const bytes = await app.vault.adapter.readBinary(input.sourcePath);
      const existing = app.vault.getAbstractFileByPath(input.targetPath);
      if (existing !== null) await app.fileManager.trashFile(existing);
      await app.vault.createBinary(input.targetPath, bytes);
    },
    { sourcePath, targetPath },
  );
}

async function openPdf(path: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      if (!app.plugins.enabledPlugins.has(input.pluginId)) {
        throw new Error(`Plugin ${input.pluginId} is not enabled.`);
      }
      await app.workspace.openLinkText(input.path, '', false);
    },
    { path, pluginId },
  );
  await $('[data-abyss-document]').waitForDisplayed({ timeout: 15_000 });
  await $('[data-page-number="1"] .textLayer span').waitForExist({ timeout: 15_000 });
}

async function closeReaders(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    for (const leaf of app.workspace.getLeavesOfType('abyss-document-view')) {
      const controller = (leaf.view as unknown as { controller?: { close(): Promise<void> } })
        .controller;
      await controller?.close();
    }
    app.workspace.detachLeavesOfType('abyss-document-view');
    const metrics = (
      window as Window & {
        __abyssDocumentsPerformance?: {
          activeAnnotationOperations: { serializations: number; writes: number };
        };
      }
    ).__abyssDocumentsPerformance;
    if (
      app.workspace.getLeavesOfType('abyss-document-view').length !== 0 ||
      metrics?.activeAnnotationOperations.serializations !== 0 ||
      metrics.activeAnnotationOperations.writes !== 0
    )
      throw new Error('Reader teardown did not settle.');
  });
}

async function waitForNativeHighlightReadiness(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }) => {
        const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
          containerEl?: HTMLElement;
          controller?: {
            viewport?: {
              annotationEditorInstance?: {
                manager?: {
                  getLayer?(
                    pageIndex: number,
                  ): { hasTextLayer?(layer: HTMLElement): boolean } | undefined;
                };
              };
            };
          };
        };
        const textLayer = view.containerEl?.querySelector<HTMLElement>(
          '[data-page-number="1"] .textLayer',
        );
        return (
          textLayer !== null &&
          textLayer !== undefined &&
          view.controller?.viewport?.annotationEditorInstance?.manager
            ?.getLayer?.(0)
            ?.hasTextLayer?.(textLayer) === true
        );
      }),
    { timeout: 10_000, timeoutMsg: 'PDF.js annotation layer did not bind to page text.' },
  );
}

async function selectFixtureText(index = 1): Promise<void> {
  await waitForNativeHighlightReadiness();
  await browser.execute((selectionOrdinal) => {
    const text = document.querySelectorAll('[data-page-number="1"] .textLayer span')[1];
    if (text === undefined) throw new Error('Expected selectable text on fixture page 1.');
    const node = text.firstChild;
    if (!(node instanceof Text)) throw new Error('Expected a text node in the fixture span.');
    const start = (selectionOrdinal - 1) * 8;
    const end = Math.min(node.length, start + 7);
    if (end <= start) throw new Error(`Fixture selection ${selectionOrdinal} is out of range.`);
    const bounds = text.getBoundingClientRect();
    const clientX = Math.round(bounds.left + bounds.width / 2);
    const clientY = Math.round(bounds.top + bounds.height / 2);
    text.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX,
        clientY,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    text.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX,
        clientY,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
    document.dispatchEvent(new Event('selectionchange'));
  }, index);
}

async function dragFixtureTextWhileInspectingPalette(): Promise<void> {
  await waitForNativeHighlightReadiness();
  const points = await browser.execute(() => {
    const spans = Array.from(
      document.querySelectorAll<HTMLElement>('[data-page-number="1"] .textLayer span'),
    );
    const span = spans.find((candidate) => candidate.getBoundingClientRect().width >= 40);
    if (span === undefined)
      throw new Error('Expected a wide selectable text span on fixture page 1.');
    const bounds = span.getBoundingClientRect();
    return {
      end: {
        x: Math.round(bounds.left + bounds.width * 0.8),
        y: Math.round(bounds.top + bounds.height / 2),
      },
      start: {
        x: Math.round(bounds.left + bounds.width * 0.2),
        y: Math.round(bounds.top + bounds.height / 2),
      },
    };
  });
  try {
    await browser.performActions([
      {
        type: 'pointer',
        id: 'selection-drag-pointer',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...points.start },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 400, origin: 'viewport', ...points.end },
          { type: 'pause', duration: 150 },
        ],
      },
    ]);
    const held = await browser.execute(
      (editorSelector) => ({
        paletteVisible: document.querySelector<HTMLElement>(editorSelector)?.hidden === false,
        selectedText: window.getSelection()?.toString().trim() ?? '',
      }),
      selectionEditorSelector,
    );
    expect(held.selectedText.length).toBeGreaterThan(0);
    expect(held.paletteVisible).toBe(false);
  } finally {
    await browser.releaseActions();
  }
}

async function vaultFileSha256(path: string): Promise<string> {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const bytes = await app.vault.adapter.readBinary(filePath);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }, path);
}

async function waitForPdfBytesToChange(path: string, previous: string): Promise<string> {
  let current = previous;
  await browser.waitUntil(
    async () => {
      current = await vaultFileSha256(path);
      return current !== previous;
    },
    { timeout: 15_000, timeoutMsg: `PDF bytes did not change after annotation mutation: ${path}` },
  );
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }) => {
        const metrics = (
          window as Window & {
            __abyssDocumentsPerformance?: {
              activeAnnotationOperations?: { serializations?: number; writes?: number };
            };
          }
        ).__abyssDocumentsPerformance;
        const controller = (
          app.workspace.getMostRecentLeaf()?.view as unknown as {
            controller?: Record<string, unknown>;
          }
        ).controller;
        const native = controller?.['nativeSaveSession'] as
          { committedRevision?: number; isDirty?: boolean; pendingRevision?: number } | undefined;
        const autosave = controller?.['autosave'] as Record<string, unknown> | undefined;
        return (
          (metrics?.activeAnnotationOperations?.serializations ?? 0) === 0 &&
          (metrics?.activeAnnotationOperations?.writes ?? 0) === 0 &&
          native?.isDirty === false &&
          native.pendingRevision === native.committedRevision &&
          autosave?.['inFlight'] === null &&
          autosave['paused'] === false &&
          autosave['newestGeneration'] === autosave['savedGeneration']
        );
      }),
    { timeout: 15_000, timeoutMsg: `PDF save lifecycle did not settle: ${path}` },
  );
  return current;
}

async function reopenPdf(path: string): Promise<void> {
  await closeReaders();
  await openPdf(path);
}

async function nativePageOneAnnotations(): Promise<
  Array<{ annotationType: number | null; color: number[]; contents: string }>
> {
  return browser.executeObsidian(async ({ app }) => {
    const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
      controller?: {
        viewport?: {
          pdf?: {
            getPage(pageNumber: number): Promise<{
              getAnnotations(): Promise<
                Array<{
                  annotationType?: number;
                  color?: ArrayLike<number>;
                  contentsObj?: { str?: string };
                }>
              >;
            }>;
          };
        };
      };
    };
    const page = await view.controller?.viewport?.pdf?.getPage(1);
    const annotations = (await page?.getAnnotations()) ?? [];
    return annotations.map((annotation) => ({
      annotationType: annotation.annotationType ?? null,
      color: Array.from(annotation.color ?? []),
      contents: annotation.contentsObj?.str ?? '',
    }));
  });
}

async function inputValue(selector: string, value: string): Promise<void> {
  await browser.execute(
    (inputSelector, nextValue) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector);
      if (input === null) throw new Error(`Input unavailable: ${inputSelector}`);
      input.value = nextValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
}

async function createSelectionComment(spanIndex: number, value: string): Promise<void> {
  const editorCount = await browser.execute(
    () => document.querySelectorAll('.highlightEditor').length,
  );
  await selectFixtureText(spanIndex);
  const popover = $(selectionEditorSelector);
  await popover.waitForDisplayed({ timeout: 5_000 });
  const input = popover.$('[aria-label="Comment"]');
  await input.waitForDisplayed({ timeout: 5_000 });
  try {
    await inputValue(`${selectionEditorSelector} [aria-label="Comment"]`, value);
    await expect(input).toHaveValue(value);
  } catch (cause) {
    const diagnostics = await browser.execute((editorSelector) => {
      const popover = document.querySelector<HTMLElement>(editorSelector);
      const textarea = popover?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
      const rect = textarea?.getBoundingClientRect();
      return {
        activeTag: document.activeElement?.tagName ?? null,
        popoverHidden: popover?.hidden ?? null,
        popoverStyle: popover === null ? null : getComputedStyle(popover).display,
        textareaHidden: textarea?.hidden ?? null,
        textareaRect: rect === undefined ? null : { height: rect.height, width: rect.width },
        textareaStyle: textarea === null ? null : getComputedStyle(textarea).display,
        value: textarea?.value ?? null,
      };
    }, selectionEditorSelector);
    throw new Error(
      `Selection editor became unavailable: ${JSON.stringify(diagnostics)}; ${String(cause)}`,
    );
  }
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.querySelectorAll('.highlightEditor').length)) ===
      editorCount + 1,
    { timeout: 10_000, timeoutMsg: 'Unified selection editor did not create one highlight.' },
  );
  await expect(popover).toBeDisplayed();
}

async function selectNativeEditor(selector: string, selectedSelector = selector): Promise<void> {
  await browser.execute((editorSelector) => {
    const editor = document.querySelector<HTMLElement>(editorSelector);
    if (editor === null) throw new Error(`Native editor unavailable: ${editorSelector}`);
    const bounds = editor.getBoundingClientRect();
    const init = {
      bubbles: true,
      button: 0,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
      isPrimary: true,
      pointerId: 29,
      pointerType: 'mouse',
    };
    editor.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointerup', init));
    editor.dispatchEvent(new MouseEvent('click', init));
  }, selector);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expectedSelector) => document.querySelector(expectedSelector) !== null,
        `${selectedSelector}.selectedEditor`,
      ),
    { timeout: 5_000, timeoutMsg: `Native editor was not selected: ${selectedSelector}` },
  );
}

describe('reader selection-first annotations', () => {
  const workingPath = 'Documents/e2e-selection-first.pdf';

  beforeEach(async () => {
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
  });

  afterEach(async () => {
    await closeReaders();
  });

  it('offers annotation actions for an ordinary neutral text selection', async () => {
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'false');

    await selectFixtureText();

    await $(selectionEditorSelector).waitForDisplayed({ timeout: 5_000 });
    await expect($(`${selectionEditorSelector} [aria-label="Comment"]`)).toExist();
  });

  it('waits for a genuine primary text drag to end before showing selection actions', async () => {
    await dragFixtureTextWhileInspectingPalette();

    await $(selectionEditorSelector).waitForDisplayed({ timeout: 5_000 });
    await expect($(`${selectionEditorSelector} [aria-label="Comment"]`)).toExist();
  });

  it('lets native Quick Highlight create one editor without opening the selection palette', async () => {
    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');

    await selectFixtureText();
    await $('.highlightEditor').waitForExist({ timeout: 10_000 });

    const editorCount = await browser.execute(
      () => document.querySelectorAll('.highlightEditor').length,
    );
    expect(editorCount).toBe(1);
    await expect($(selectionEditorSelector)).not.toBeDisplayed();
  });

  it('saves and reopens neutral highlight comment link and tag selections', async () => {
    let hash = await vaultFileSha256(workingPath);

    await selectFixtureText(1);
    const selectionEditor = $(selectionEditorSelector);
    await selectionEditor.waitForDisplayed({ timeout: 5_000 });
    await selectionEditor.$('[data-editor-color="#ffd400"]').click();
    await $('.highlightEditor').waitForExist({ timeout: 10_000 });
    await expect(selectionEditor).toBeDisplayed();
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect(selectionEditor).toBeDisplayed();

    await $('[data-control="quick-highlight-menu"]').click();
    await $(
      '//*[contains(@class, "menu-item-title") and contains(normalize-space(.), "Green")]',
    ).click();

    await createSelectionComment(2, 'neutral link [[Linked note]]');
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect($(selectionEditorSelector)).toBeDisplayed();
    await browser.keys(Key.Escape);
    await createSelectionComment(3, 'neutral tag #review');
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect($(selectionEditorSelector)).toBeDisplayed();
    await browser.keys(Key.Escape);
    await createSelectionComment(4, 'Neutral comment');
    await waitForPdfBytesToChange(workingPath, hash);
    await expect($(selectionEditorSelector)).toBeDisplayed();

    await reopenPdf(workingPath);
    await browser.waitUntil(
      async () => {
        const annotations = await nativePageOneAnnotations();
        return annotations.filter(({ annotationType }) => annotationType !== 16).length === 4;
      },
      { timeout: 15_000, timeoutMsg: 'Saved neutral selection annotations did not reopen.' },
    );
    const reopened = await nativePageOneAnnotations();
    expect(reopened.filter(({ annotationType }) => annotationType !== 16)).toEqual([
      { annotationType: 9, color: [255, 212, 0], contents: '' },
      {
        annotationType: 9,
        color: [95, 178, 54],
        contents: 'neutral link [[Linked note]]',
      },
      { annotationType: 9, color: [95, 178, 54], contents: 'neutral tag #review' },
      { annotationType: 9, color: [95, 178, 54], contents: 'Neutral comment' },
    ]);
    expect(reopened.filter(({ annotationType }) => annotationType === 16)).toHaveLength(3);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    try {
      await browser.waitUntil(
        async () => {
          const text = await $('[data-sidebar-panel="annotations"]').getText();
          return (
            text.includes('Neutral comment') &&
            text.includes('neutral link [[Linked note]]') &&
            text.includes('neutral tag #review')
          );
        },
        { timeout: 15_000, timeoutMsg: 'Saved comment/link/tag content did not reopen from PDF.' },
      );
      await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(4);
    } catch (cause) {
      const diagnostics = await browser.executeObsidian(async ({ app }) => {
        const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
          controller?: {
            viewport?: {
              pdf?: {
                getPage(pageNumber: number): Promise<{
                  getAnnotations(): Promise<unknown[]>;
                }>;
              };
            };
          };
        };
        const page = await view.controller?.viewport?.pdf?.getPage(1);
        return {
          nativeAnnotations: await page?.getAnnotations(),
          panelText:
            view instanceof Object
              ? document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]')?.innerText
              : undefined,
        };
      });
      throw new Error(`${String(cause)}; ${JSON.stringify(diagnostics)}`);
    }
  });

  it('uses one selected Quick Highlight color for two gestures then disarms with Escape', async () => {
    let hash = await vaultFileSha256(workingPath);
    await $('[data-control="quick-highlight-menu"]').click();
    await $(
      '//*[contains(@class, "menu-item-title") and contains(normalize-space(.), "Green")]',
    ).click();
    const quick = $('[data-annotation-tool="highlight"]');
    await expect(quick).toHaveAttribute('aria-label', expect.stringContaining('Green'));
    await quick.click();
    await expect(quick).toHaveAttribute('aria-pressed', 'true');

    await selectFixtureText(1);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.highlightEditor').length)) === 1,
      { timeout: 10_000, timeoutMsg: 'First Quick Highlight gesture was not singular.' },
    );
    await expect(quick).toHaveAttribute('aria-pressed', 'true');
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await selectFixtureText(2);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.highlightEditor').length)) === 2,
      { timeout: 10_000, timeoutMsg: 'Second Quick Highlight gesture was not singular.' },
    );
    await expect($(selectionEditorSelector)).not.toBeDisplayed();

    await browser.keys(Key.Escape);
    await expect(quick).toHaveAttribute('aria-pressed', 'false');
    await waitForPdfBytesToChange(workingPath, hash);
    await reopenPdf(workingPath);
    await browser.waitUntil(
      async () => {
        const annotations = await nativePageOneAnnotations();
        return annotations.filter(({ annotationType }) => annotationType !== 16).length === 2;
      },
      { timeout: 15_000, timeoutMsg: 'Two Quick Highlight annotations did not reopen.' },
    );
    expect(
      (await nativePageOneAnnotations()).filter(({ annotationType }) => annotationType !== 16),
    ).toEqual([
      { annotationType: 9, color: [95, 178, 54], contents: '' },
      { annotationType: 9, color: [95, 178, 54], contents: '' },
    ]);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-annotation-color="#5fb236"]')).toExist();
  });

  it('recolors and enriches one writable annotation contextually then deletes it', async () => {
    let hash = await vaultFileSha256(workingPath);
    await selectFixtureText(1);
    const selectionEditor = $(selectionEditorSelector);
    await selectionEditor.waitForDisplayed({ timeout: 5_000 });
    await selectionEditor.$('[data-editor-color="#ffd400"]').click();
    await $('.highlightEditor').waitForExist({ timeout: 10_000 });
    await expect(selectionEditor).toBeDisplayed();
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect(selectionEditor).toBeDisplayed();

    await reopenPdf(workingPath);
    await $('.annotationLayer .highlightAnnotation').waitForExist({ timeout: 10_000 });
    await selectNativeEditor('.annotationLayer .highlightAnnotation', '.highlightEditor');
    const popover = $(nativeEditorSelector);
    await popover.waitForDisplayed({ timeout: 5_000 });
    await popover.$('[data-editor-color="#5fb236"]').click();
    await expect(popover.$('[data-editor-color="#5fb236"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const comment = popover.$('[aria-label="Comment"]');
    await inputValue(`${nativeEditorSelector} [aria-label="Comment"]`, 'Contextual comment');
    await inputValue(`${nativeEditorSelector} [aria-label="Links"]`, '[[Link]]');
    await inputValue(`${nativeEditorSelector} [aria-label="Tags"]`, '#tag');
    await expect(comment).toHaveValue('Contextual comment');
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect(popover).toBeDisplayed();
    await expect(comment).toHaveValue('Contextual comment');

    await reopenPdf(workingPath);
    await $('.annotationLayer .highlightAnnotation').waitForExist({ timeout: 10_000 });
    expect(
      (await nativePageOneAnnotations()).filter(({ annotationType }) => annotationType !== 16),
    ).toEqual([
      {
        annotationType: 9,
        color: [95, 178, 54],
        contents: 'Contextual comment #tag [[Link]]',
      },
    ]);
    await selectNativeEditor('.annotationLayer .highlightAnnotation', '.highlightEditor');
    const editable = $(nativeEditorSelector);
    await editable.waitForDisplayed({ timeout: 5_000 });
    await editable.$('[data-action="delete-annotation"]').click();
    await waitForPdfBytesToChange(workingPath, hash);

    await reopenPdf(workingPath);
    await expect($('.annotationLayer .highlightAnnotation')).not.toExist();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-annotations-status]')).toHaveText('No annotations');
  });
});
