import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';
import {
  captureAnnotationSaveBaseline,
  isVerifiedAnnotationSaveSettled,
  readAnnotationSaveLifecycleSnapshot,
  type AnnotationSaveBaseline,
} from './annotation-save-oracle.js';

const pluginId = 'abyss-documents';

interface AnnotationLoadTestFault {
  readonly cacheRead?: 'fail';
  readonly extractionDelayMs?: number;
  readonly extractionFailure?: boolean;
}

async function setAnnotationLoadTestFault(fault: AnnotationLoadTestFault | null): Promise<void> {
  await browser.executeObsidian(({ app }, nextFault) => {
    const view = app.workspace.getMostRecentLeaf()?.view;
    if (
      view === undefined ||
      !('setAnnotationLoadTestFault' in view) ||
      typeof view.setAnnotationLoadTestFault !== 'function'
    )
      throw new Error('Typed annotation-load test fault boundary is unavailable.');
    (view.setAnnotationLoadTestFault as (value: AnnotationLoadTestFault | null) => void)(nextFault);
  }, fault);
}
const nativeEditorSelector =
  '.workspace-leaf.mod-active .abyss-documents > [data-annotation-editor-popover]:not([hidden])';

async function openPdf(path: string): Promise<void> {
  const openState = await browser.executeObsidian(
    async ({ app }, input) => {
      await app.workspace.openLinkText(input.documentPath, '', false);
      const activeLeaf = app.workspace.getMostRecentLeaf();
      return {
        activeFile: app.workspace.getActiveFile()?.path ?? null,
        activeView: activeLeaf?.getViewState() ?? null,
        customLeaves: app.workspace
          .getLeavesOfType('abyss-document-view')
          .map((leaf) => leaf.getViewState()),
        enabled: app.plugins.enabledPlugins.has(input.pluginId),
        fileExists: app.vault.getAbstractFileByPath(input.documentPath) !== null,
        manifestVersion: app.plugins.manifests[input.pluginId]?.version ?? null,
        pdfLeaves: app.workspace.getLeavesOfType('pdf').map((leaf) => leaf.getViewState()),
      };
    },
    { documentPath: path, pluginId },
  );
  try {
    await $('[data-abyss-document]').waitForDisplayed({ timeout: 15_000 });
  } catch (error) {
    const diagnostics = await browser.execute(() => {
      const root = document.querySelector<HTMLElement>('[data-abyss-document]');
      return {
        performance: (
          window as Window & {
            __abyssDocumentsPerformance?: {
              marks: Array<{ name: string; startTime: number }>;
            };
          }
        ).__abyssDocumentsPerformance,
        root:
          root === null
            ? null
            : {
                connected: root.isConnected,
                display: getComputedStyle(root).display,
                height: root.getBoundingClientRect().height,
                visibility: getComputedStyle(root).visibility,
                width: root.getBoundingClientRect().width,
              },
      };
    });
    throw new Error(
      `PDF reader did not display: ${JSON.stringify({ diagnostics, openState })}; ${String(error)}`,
    );
  }
}

async function closeReaderLeaves(): Promise<void> {
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

async function chooseMoreOption(label: string): Promise<void> {
  await $('[data-control="overflow"]').click();
  const choice = $(`//*[contains(@class, "menu-item-title") and normalize-space(.)="${label}"]`);
  await choice.waitForClickable({ timeout: 5_000 });
  await choice.click();
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

async function activateLeaf(id: string): Promise<void> {
  await browser.executeObsidian(({ app }, leafId) => {
    const leaf = app.workspace.getLeafById(leafId);
    if (leaf === null) throw new Error(`Reader leaf unavailable: ${leafId}`);
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, id);
}

async function waitForFirstPage(): Promise<void> {
  try {
    await $('.workspace-leaf.mod-active [data-page-number="1"] canvas').waitForExist({
      timeout: 15_000,
    });
  } catch (error) {
    const diagnostics = await browser.execute(() => ({
      errorBoundary: document.querySelector<HTMLElement>('[data-reader-error]')?.innerText ?? null,
      pages: document.querySelectorAll('[data-page-number]').length,
      performance: (
        window as Window & {
          __abyssDocumentsPerformance?: unknown;
        }
      ).__abyssDocumentsPerformance,
      readerText: document.querySelector<HTMLElement>('[data-abyss-document]')?.innerText ?? null,
      viewer: document.querySelector('.pdfViewer') !== null,
    }));
    throw new Error(
      `First PDF page did not become usable: ${JSON.stringify(diagnostics)}; ${String(error)}`,
    );
  }
}

async function waitForNativeHighlightReadiness(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }) => {
        const leaf = app.workspace.getMostRecentLeaf();
        const view = leaf?.view as unknown as
          | {
              containerEl?: HTMLElement;
              controller?: {
                viewport?: {
                  annotationEditorInstance?: {
                    manager?: {
                      getLayer?(pageIndex: number):
                        | {
                            hasTextLayer?(layer: HTMLElement): boolean;
                          }
                        | undefined;
                    };
                  };
                };
              };
            }
          | undefined;
        const root = view?.containerEl?.querySelector<HTMLElement>('[data-abyss-document]');
        const textLayer = root?.querySelector<HTMLElement>('[data-page-number="1"] .textLayer');
        const pageLayer =
          view?.controller?.viewport?.annotationEditorInstance?.manager?.getLayer?.(0);
        return (
          textLayer instanceof HTMLElement &&
          root?.querySelectorAll('[data-page-number="1"] .textLayer span')[1] !== undefined &&
          pageLayer?.hasTextLayer?.(textLayer) === true
        );
      }),
    {
      timeout: 10_000,
      timeoutMsg: 'PDF.js annotation editor did not bind to the selectable page text.',
    },
  );
}

async function resetWorkingPdf(sourcePath: string, targetPath: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      const bytes = await app.vault.adapter.readBinary(input.sourcePath);
      const existing = app.vault.getAbstractFileByPath(input.targetPath);
      if (existing !== null) {
        await app.fileManager.trashFile(existing);
      }
      await app.vault.createBinary(input.targetPath, bytes);
    },
    { sourcePath, targetPath },
  );
}

async function waitForAnnotationSave(baseline: AnnotationSaveBaseline): Promise<void> {
  try {
    await browser.waitUntil(
      async () =>
        isVerifiedAnnotationSaveSettled(await readAnnotationSaveLifecycleSnapshot(), baseline),
      { timeout: 15_000 },
    );
  } catch (cause) {
    const diagnostics = await readAnnotationSaveLifecycleSnapshot().catch(() => null);
    throw new Error(
      `Expected at least ${baseline.minimumSaves} completed annotation save(s): ${JSON.stringify(diagnostics)}; ${String(cause)}`,
    );
  }
}

async function vaultFileSha256(path: string): Promise<string> {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const bytes = await app.vault.adapter.readBinary(filePath);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }, path);
}

async function createFreeText(text: string): Promise<void> {
  await $('[data-annotation-tool="freetext"]').click();
  await expect($('[data-annotation-tool="freetext"]')).toHaveAttribute('aria-pressed', 'true');
  const layer = $('[data-page-number="1"] .annotationEditorLayer');
  await layer.waitForDisplayed({ timeout: 5_000 });
  await browser.execute(() => {
    const editorLayer = document.querySelector<HTMLElement>(
      '[data-page-number="1"] .annotationEditorLayer',
    );
    if (editorLayer === null) throw new Error('FreeText editor layer unavailable.');
    editorLayer.focus();
  });
  await browser.keys(Key.Enter);
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.querySelector('.freeTextEditor [contenteditable="true"]') !== null,
      ),
    { timeout: 5_000, timeoutMsg: 'FreeText content editor did not become available.' },
  );
  const input = $('.freeTextEditor [contenteditable="true"]');
  await input.click();
  await browser.keys(text);
  await expect(input).toHaveText(text);
  await browser.keys(Key.Escape);
  await expect(input).toHaveAttribute('contenteditable', 'false');
  await $('[data-annotation-tool="freetext"]').click();
  await expect($('[data-annotation-tool="freetext"]')).toHaveAttribute('aria-pressed', 'false');
}

async function createInk(): Promise<void> {
  await $('[data-annotation-tool="ink"]').click();
  await expect($('[data-annotation-tool="ink"]')).toHaveAttribute('aria-pressed', 'true');
  await drawInk('[data-page-number="1"] .annotationEditorLayer');
  await $('[data-annotation-tool="ink"]').click();
  await expect($('[data-annotation-tool="ink"]')).toHaveAttribute('aria-pressed', 'false');
  await $('.inkEditor').waitForExist({ timeout: 5_000 });
}

async function drawInk(selector: string): Promise<void> {
  await $(selector).waitForDisplayed({ timeout: 5_000 });
  const points = await browser.execute((layerSelector) => {
    const layer = document.querySelector<HTMLElement>(layerSelector);
    if (layer === null) throw new Error(`Ink editor layer unavailable: ${layerSelector}`);
    const bounds = layer.getBoundingClientRect();
    return [
      { x: Math.round(bounds.left + bounds.width * 0.3), y: Math.round(bounds.top + 30) },
      { x: Math.round(bounds.left + bounds.width * 0.45), y: Math.round(bounds.top + 60) },
      { x: Math.round(bounds.left + bounds.width * 0.6), y: Math.round(bounds.top + 35) },
    ];
  }, selector);
  const [start, middle, end] = points;
  if (start === undefined || middle === undefined || end === undefined)
    throw new Error('Ink gesture points unavailable.');
  await browser
    .action('pointer')
    .move({ origin: 'viewport', ...start })
    .down()
    .move({ duration: 120, origin: 'viewport', ...middle })
    .move({ duration: 120, origin: 'viewport', ...end })
    .up()
    .perform();
}

async function selectNativeEditor(selector: string): Promise<void> {
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
      pointerId: 19,
      pointerType: 'mouse',
    };
    editor.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointerup', init));
  }, selector);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (editorSelector) =>
          document.querySelector(editorSelector)?.classList.contains('selectedEditor') === true,
        selector,
      ),
    { timeout: 5_000, timeoutMsg: `Native editor was not selected: ${selector}` },
  );
}

async function inspectPassiveImportedAnnotation(selector: string): Promise<{
  readonly editableControls: number;
  readonly nativeEditors: number;
  readonly selectedEditors: number;
}> {
  return browser.execute(async (annotationSelector) => {
    const annotation = document.querySelector<HTMLElement>(annotationSelector);
    if (annotation === null)
      throw new Error(`Imported annotation unavailable: ${annotationSelector}`);
    const bounds = annotation.getBoundingClientRect();
    const init = {
      bubbles: true,
      button: 0,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
      isPrimary: true,
      pointerId: 31,
      pointerType: 'mouse',
    };
    annotation.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointerup', init));
    annotation.dispatchEvent(new MouseEvent('click', init));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    return {
      editableControls: document.querySelectorAll(
        '[data-annotation-editor-popover]:not([hidden]) :is([data-editor-color], [data-action="delete-annotation"])',
      ).length,
      nativeEditors: document.querySelectorAll(
        '.annotationEditorLayer :is(.highlightEditor, .inkEditor, .freeTextEditor)',
      ).length,
      selectedEditors: document.querySelectorAll('.annotationEditorLayer .selectedEditor').length,
    };
  }, selector);
}

describe('PDF reader foundation', () => {
  beforeEach(async () => {
    await closeReaderLeaves();
  });

  afterEach(async () => {
    await closeReaderLeaves();
  });

  it('opens with only the PDF surface and no sidebar', async () => {
    await openPdf('Documents/text-12-pages.pdf');

    await expect($('[data-region="document"]')).toBeDisplayed();
    await expect($('[data-region="sidebar"]')).not.toExist();
  });

  it('Ctrl/Cmd+F searches the PDF document only', async () => {
    await openPdf('Documents/text-12-pages.pdf');
    await waitForFirstPage();

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('.pdfViewerContainer')
        ?.setAttribute('data-e2e-search-viewport-identity', 'preserved');
      document
        .querySelector<HTMLElement>('[data-page-number="1"] canvas')
        ?.setAttribute('data-e2e-search-canvas-identity', 'preserved');
    });

    const documentSurface = $('[data-region="document"]');
    await documentSurface.click();
    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-region="document"]')?.focus(),
    );
    await expect(documentSurface).toBeFocused();
    const isMacOs = process.platform === 'darwin';
    if (isMacOs) {
      // ChromeDriver routes Cmd+F to Electron's native menu and sends only the
      // Meta key to the renderer. Dispatch through the focused public DOM hook
      // so the reader-level shortcut remains deterministic in automation.
      await browser.execute(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'f',
            metaKey: true,
          }),
        );
      });
    } else {
      await browser.keys([Key.Control, 'f']);
    }
    await expect($('[data-tab="search"][aria-selected="true"]')).toExist();
    await $('[data-document-search]').setValue('fixture');
    await expect($('[data-search-count]')).toHaveText(/^[1-9]/);
    await expect($('[data-sidebar-panel="annotations"]')).not.toBeDisplayed();
    await expect($('[data-document-search]')).toBeFocused();

    const firstResult = $('[data-search-result]');
    await firstResult.click();
    await expect(firstResult).toHaveAttribute('aria-current', 'true');
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelectorAll('[data-page-number="1"] .textLayer .highlight').length >= 2 &&
            document.querySelectorAll('[data-page-number="1"] .textLayer .highlight.selected')
              .length === 1,
        ),
      {
        timeout: 5_000,
        timeoutMsg: 'PDF.js did not expose two visible matches and one active match.',
      },
    );

    const searchLayout = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('.abyss-reader-search');
      const controls = document.querySelector<HTMLElement>('.abyss-reader-search-controls');
      const count = document.querySelector<HTMLElement>('[data-search-count]');
      const results = document.querySelector<HTMLElement>('.abyss-reader-search-results');
      if (panel === null || controls === null || count === null || results === null)
        throw new Error('Search layout unavailable.');
      const panelStyle = getComputedStyle(panel);
      const resultsStyle = getComputedStyle(results);
      const controlsTop = controls.getBoundingClientRect().top;
      const countTop = count.getBoundingClientRect().top;
      results.scrollTop = results.scrollHeight;
      return {
        controlsFixed: controls.getBoundingClientRect().top === controlsTop,
        countFixed: count.getBoundingClientRect().top === countTop,
        direction: panelStyle.flexDirection,
        display: panelStyle.display,
        overflow: panelStyle.overflow,
        resultsBounded:
          results.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1,
        resultsOverflowY: resultsStyle.overflowY,
      };
    });
    expect(searchLayout).toMatchObject({
      controlsFixed: true,
      countFixed: true,
      direction: 'column',
      display: 'flex',
      overflow: 'hidden',
      resultsBounded: true,
      resultsOverflowY: 'auto',
    });

    await $('[data-document-search]').setValue('ordinary');
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const matches = Array.from(
            document.querySelectorAll<HTMLElement>('.textLayer .highlight'),
          );
          return (
            matches.length > 0 &&
            matches.every((match) => match.textContent.toLocaleLowerCase().includes('ordinary')) &&
            document.querySelectorAll('.textLayer .highlight.selected').length === 1
          );
        }),
      { timeout: 5_000, timeoutMsg: 'Replacement query retained stale PDF.js highlights.' },
    );

    await $('[data-document-search]').setValue('');
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelectorAll('.textLayer .highlight').length === 0 &&
            document.querySelectorAll('[data-search-result][aria-current]').length === 0,
        ),
      { timeout: 5_000, timeoutMsg: 'Cleared query retained stale search state.' },
    );
    await expect($('[data-e2e-search-viewport-identity="preserved"]')).toExist();
    await expect($('[data-e2e-search-canvas-identity="preserved"]')).toExist();
  });

  it('opens a two-level outline and navigates to its destination', async () => {
    await openPdf('Documents/outline-20-pages.pdf');
    await waitForFirstPage();

    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('.pdfViewerContainer')
        ?.setAttribute('data-e2e-viewport-identity', 'preserved');
      document
        .querySelector<HTMLElement>('[data-page-number="1"] canvas')
        ?.setAttribute('data-e2e-canvas-identity', 'preserved');
    });

    await $('[data-control="sidebar"]').click();
    await expect($('[data-tab="outline"][aria-selected="true"]')).toExist();
    await expect($$('[data-outline-item]')).toBeElementsArrayOfSize({ gte: 6 });
    await expect($('[data-outline-search]')).not.toBeDisplayed();
    await $('[data-action="toggle-outline-search"]').click();
    await expect($('[data-outline-search]')).toBeFocused();
    await browser.keys(Key.Escape);
    await expect($('[data-outline-search]')).not.toBeDisplayed();

    const treeLayout = await browser.execute(() => {
      const tree = document.querySelector<HTMLElement>('.abyss-reader-outline-tree');
      const row = document.querySelector<HTMLElement>('[data-outline-row]');
      const label = document.querySelector<HTMLElement>('[data-outline-label]');
      const group = document.querySelector<HTMLElement>('.tree-item-children');
      if (tree === null || row === null || label === null || group === null)
        throw new Error('Outline layout unavailable.');
      const labelStyle = getComputedStyle(label);
      const groupStyle = getComputedStyle(group);
      return {
        guide: groupStyle.borderInlineStartStyle,
        labelOverflow: labelStyle.textOverflow,
        labelWhiteSpace: labelStyle.whiteSpace,
        noHorizontalOverflow: tree.scrollWidth <= tree.clientWidth + 1,
        rowHeight: row.getBoundingClientRect().height,
      };
    });
    expect(treeLayout.rowHeight).toBeGreaterThanOrEqual(26);
    expect(treeLayout.rowHeight).toBeLessThanOrEqual(30);
    expect(treeLayout.noHorizontalOverflow).toBe(true);
    expect(treeLayout.labelOverflow).toBe('ellipsis');
    expect(treeLayout.labelWhiteSpace).toBe('nowrap');
    expect(treeLayout.guide).not.toBe('none');
    await $('[data-outline-id="outline-1-0"]').click();
    await expect($('[data-control="page-field"]')).toHaveValue('12');
    await expect($('[data-e2e-viewport-identity="preserved"]')).toExist();
    await expect($('[data-e2e-canvas-identity="preserved"]')).toExist();
  });

  it('accepts bounded direct page entry', async () => {
    await openPdf('Documents/text-12-pages.pdf');
    await waitForFirstPage();

    const page = $('[data-control="page-field"]');
    await page.setValue('999');
    await browser.keys(Key.Enter);
    await expect(page).toHaveValue('12');
  });

  it('switches reading profiles through the public profile control', async () => {
    await openPdf('Documents/text-12-pages.pdf');
    await waitForFirstPage();

    await $('[data-control="overflow"]').click();
    const sepia = $('//*[contains(@class, "menu-item-title") and normalize-space(.)="Sepia"]');
    try {
      await sepia.waitForExist({ timeout: 5_000 });
    } catch (error) {
      const diagnostics = await browser.execute(() => {
        const button = document.querySelector<HTMLElement>('[data-control="overflow"]');
        button?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
        );
        return {
          button: button?.outerHTML ?? null,
          menus: Array.from(document.querySelectorAll<HTMLElement>('.menu')).map(
            (menu) => menu.outerHTML,
          ),
        };
      });
      throw new Error(
        `Reading profile menu did not expose Sepia: ${JSON.stringify(diagnostics)}; ${String(error)}`,
      );
    }
    await sepia.click();
    await expect($('[data-abyss-document]')).toHaveAttribute('data-reading-profile', 'sepia');
  });

  it('returns focus to the sidebar invoker after close', async () => {
    await openPdf('Documents/text-12-pages.pdf');
    await waitForFirstPage();

    const invoker = $('[data-control="sidebar"]');
    await invoker.click();
    await $('[data-action="close-sidebar"]').click();
    await expect(invoker).toBeFocused();
  });

  it('reopens the real PDF after a plugin reload', async () => {
    await openPdf('Documents/text-12-pages.pdf');
    await waitForFirstPage();

    const obsidian = browser.getObsidianPage();
    await obsidian.disablePlugin(pluginId);
    await obsidian.enablePlugin(pluginId);
    await openPdf('Documents/text-12-pages.pdf');
    await expect($('[data-page-number="1"] canvas')).toExist();
  });

  it('opens in a popout and tears down its owner-window session before reopening', async () => {
    const mainWindow = await browser.getWindowHandle();
    const leafId = await browser.executeObsidian(async ({ app }, documentPath) => {
      const file = app.vault.getFileByPath(documentPath);
      if (file === null) throw new Error(`PDF fixture unavailable: ${documentPath}`);
      const leaf = app.workspace.openPopoutLeaf();
      await leaf.openFile(file);
      return (leaf as unknown as { id: string }).id;
    }, 'Documents/text-12-pages.pdf');
    let popoutWindow: string | null = null;
    try {
      await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
        timeout: 10_000,
        timeoutMsg: 'PDF popout window did not open.',
      });
      popoutWindow =
        (await browser.getWindowHandles()).find((handle) => handle !== mainWindow) ?? null;
      if (popoutWindow === null) throw new Error('PDF popout window handle unavailable.');
      await browser.switchToWindow(popoutWindow);
      await $('[data-abyss-document]').waitForDisplayed({ timeout: 15_000 });
      await $('[data-page-number="1"] canvas').waitForExist({ timeout: 15_000 });
      expect(
        await browser.execute(() => {
          const root = document.querySelector<HTMLElement>('[data-abyss-document]');
          return root?.ownerDocument.defaultView === window;
        }),
      ).toBe(true);

      await browser.switchToWindow(mainWindow);
      await browser.executeObsidian(async ({ app }, id) => {
        const leaf = app.workspace.getLeafById(id);
        if (leaf === null) throw new Error(`Popout reader leaf unavailable: ${id}`);
        const controller = (leaf.view as unknown as { controller?: { close(): Promise<void> } })
          .controller;
        await controller?.close();
        leaf.detach();
        const metrics = (
          window as Window & {
            __abyssDocumentsPerformance?: {
              activeAnnotationOperations: { serializations: number; writes: number };
            };
          }
        ).__abyssDocumentsPerformance;
        if (
          app.workspace.getLeafById(id) !== null ||
          metrics?.activeAnnotationOperations.serializations !== 0 ||
          metrics.activeAnnotationOperations.writes !== 0
        )
          throw new Error('Popout reader teardown did not settle.');
      }, leafId);
      await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
        timeout: 10_000,
        timeoutMsg: 'PDF popout window did not close after leaf teardown.',
      });

      await openPdf('Documents/text-12-pages.pdf');
      await waitForFirstPage();
      await expect($('[data-abyss-document]')).toBeDisplayed();
    } finally {
      const handles = await browser.getWindowHandles();
      if (handles.includes(mainWindow)) await browser.switchToWindow(mainWindow);
      if (popoutWindow !== null && handles.includes(popoutWindow)) {
        await browser.switchToWindow(popoutWindow);
        await browser.closeWindow();
        await browser.switchToWindow(mainWindow);
      }
    }
  });

  it('shows a retry boundary for invalid bytes', async () => {
    await browser.executeObsidian(async ({ app }) => {
      await app.workspace.openLinkText('Documents/invalid.pdf', '', false);
    });

    await expect($('[data-reader-error="open"]')).toBeDisplayed();
    await expect($('[data-action="retry"]')).toBeClickable();
  });

  it('keeps rendered long-document DOM bounded during distant navigation', async () => {
    await openPdf('Documents/text-700-pages.pdf');
    await waitForFirstPage();

    const page = $('[data-control="page-field"]');
    for (const target of ['350', '700', '1']) {
      await page.setValue(target);
      await browser.keys(Key.Enter);
      await browser.waitUntil(async () => (await page.getValue()) === target);
    }
    await expect($$('[data-page-number] canvas')).toBeElementsArrayOfSize({ lte: 7 });
    const maximum = await browser.execute(() => {
      const metrics = (
        window as Window & {
          __abyssDocumentsPerformance?: {
            counters?: { maxRenderedPagesDuringLongNavigation?: number };
          };
        }
      ).__abyssDocumentsPerformance;
      return metrics?.counters?.maxRenderedPagesDuringLongNavigation ?? null;
    });
    expect(maximum).not.toBeNull();
    expect(maximum).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(7);
  });

  it('keeps the lazy left sidebar ordered and a ten-thousand-annotation list bounded', async () => {
    await openPdf('Documents/annotations-10000.pdf');
    await waitForFirstPage();
    await expect($('[data-region="sidebar"]')).not.toExist();

    await $('[data-control="sidebar"]').click();
    const tabLabels = await $$('[data-tab]').map(async (tab) => tab.getText());
    expect(tabLabels).toEqual(['Outline', 'Annotations', 'Search']);
    await $('[data-tab="annotations"]').click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.abyss-annotation-card').length)) >
        0,
      {
        timeout: 20_000,
        timeoutMsg: 'High-annotation cards did not become available.',
      },
    );
    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize({ lte: 80 });

    const annotationSearch = $('[data-annotation-search]');
    await annotationSearch.setValue('Annotation 07500');
    await expect($('.abyss-annotation-card')).toHaveText(expect.stringContaining('07500'));
    await annotationSearch.clearValue();
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('[data-annotation-search]');
      if (input === null) throw new Error('Annotation search input unavailable.');
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
      );
    });
    const filteredSize = async (): Promise<number> => {
      const value = await $('.abyss-annotation-card-row').getAttribute('aria-setsize');
      return Number(value);
    };
    await browser.waitUntil(async () => (await filteredSize()) === 10_000);

    const colorFacets = $$(
      '[data-sidebar-panel="annotations"] .abyss-annotation-colors [data-annotation-color]',
    );
    await expect(colorFacets).toBeElementsArrayOfSize(2);
    await colorFacets[0]?.click();
    await browser.waitUntil(async () => (await filteredSize()) === 5_000);

    await $('[data-action="toggle-document-tags"]').click();
    const topic = $('[data-annotation-tag="topic-0"]');
    await expect(topic).toExist();
    await topic.click();
    await browser.waitUntil(async () => (await filteredSize()) === 200);
    expect(
      await browser.execute(() => {
        const cards = Array.from(document.querySelectorAll('.abyss-annotation-card'));
        return cards.length > 0 && cards.every((card) => card.textContent.includes('#topic-0'));
      }),
    ).toBe(true);
    await colorFacets[0]?.click();
    await browser.waitUntil(async () => (await filteredSize()) === 400);
    await topic.click();
    await browser.waitUntil(async () => (await filteredSize()) === 10_000);

    const metrics = await browser.execute(
      () =>
        (window as Window & { __abyssDocumentsPerformance?: unknown }).__abyssDocumentsPerformance,
    );
    expect(metrics).toMatchObject({ counters: { maxAnnotationCards: 48 } });
  });

  it('starts in Default, Single + Continuous and composes all four layout combinations', async () => {
    await openPdf('Documents/text-12-pages.pdf');
    await waitForFirstPage();

    await expect($('[data-abyss-document]')).toHaveAttribute('data-reading-profile', 'default');

    for (const [choice, pages, scrolling] of [
      ['Two pages', 'facing', 'continuous'],
      ['Continuous scrolling', 'facing', 'page-by-page'],
      ['Single page', 'single', 'page-by-page'],
      ['Continuous scrolling', 'single', 'continuous'],
    ] as const) {
      await chooseMoreOption(choice);
      expect(
        await browser.executeObsidian(({ app }) => {
          const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
            controller?: { currentLayout?: unknown };
          };
          return view.controller?.currentLayout ?? null;
        }),
      ).toEqual({ pages, scrolling });
    }
  });

  it('round-trips a native highlight and keeps annotation controls operable after save', async () => {
    const workingPath = 'Documents/e2e-native-annotations.pdf';
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
    await waitForFirstPage();
    const saveBaseline = await captureAnnotationSaveBaseline();

    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');
    await waitForNativeHighlightReadiness();
    await browser.execute(() => {
      const text = document.querySelectorAll('[data-page-number="1"] .textLayer span')[1];
      if (text === undefined) throw new Error('Expected selectable text on fixture page 1.');
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      text.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          clientX: 200,
          clientY: 200,
          pointerType: 'mouse',
        }),
      );
    });
    await expect($('.highlightEditor')).toExist();
    await waitForAnnotationSave(saveBaseline);

    await $('[data-annotation-tool="freetext"]').click();
    await expect($('[data-annotation-tool="freetext"]')).toHaveAttribute('aria-pressed', 'true');
    await closeReaderLeaves();
    await openPdf(workingPath);
    await waitForFirstPage();
    await $('.annotationLayer .highlightAnnotation').waitForExist({ timeout: 10_000 });
    const reopenedGeometry = await browser.execute(() => {
      const annotation = document.querySelector<HTMLElement>(
        '.annotationLayer .highlightAnnotation',
      );
      const bounds = annotation?.getBoundingClientRect();
      return { height: bounds?.height ?? 0, width: bounds?.width ?? 0 };
    });
    expect(reopenedGeometry.height).toBeGreaterThan(0);
    expect(reopenedGeometry.width).toBeGreaterThan(0);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect(
      $(
        '[data-sidebar-panel="annotations"] .abyss-annotation-colors ' +
          '[data-annotation-color="#ffd400"]',
      ),
    ).toExist();
  });

  it('serializes two live views and reloads each clean peer in verified write order', async () => {
    const workingPath = 'Documents/e2e-two-view.pdf';
    const active = '.workspace-leaf.mod-active';
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
    await waitForFirstPage();
    const leaves = await browser.executeObsidian(async ({ app }) => {
      const primary = app.workspace.getMostRecentLeaf();
      if (primary === null) throw new Error('Primary reader leaf unavailable.');
      const secondary = app.workspace.getLeaf('split', 'vertical');
      await secondary.setViewState(primary.getViewState());
      return {
        primary: (primary as unknown as { id: string }).id,
        secondary: (secondary as unknown as { id: string }).id,
      };
    });
    await browser.waitUntil(async () => (await $$('[data-abyss-document]').length) === 2, {
      timeout: 10_000,
      timeoutMsg: 'Second live PDF view did not open.',
    });
    let saveBaseline = await captureAnnotationSaveBaseline();

    await activateLeaf(leaves.primary);
    await $(`${active} [data-annotation-tool="highlight"]`).click();
    await expect($(`${active} [data-annotation-tool="highlight"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitForNativeHighlightReadiness();
    await browser.execute((scope) => {
      const text = document.querySelectorAll(`${scope} [data-page-number="1"] .textLayer span`)[1];
      if (text === undefined) throw new Error('Primary view text unavailable.');
      const range = document.createRange();
      range.selectNodeContents(text);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      text.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          clientX: 200,
          clientY: 200,
          pointerType: 'mouse',
        }),
      );
    }, active);
    await waitForAnnotationSave(saveBaseline);

    await activateLeaf(leaves.secondary);
    await $(`${active} [data-page-number="1"] canvas`).waitForExist({ timeout: 10_000 });
    await $(`${active} .annotationLayer .highlightAnnotation`).waitForExist({ timeout: 10_000 });
    saveBaseline = await captureAnnotationSaveBaseline();
    await $(`${active} [data-annotation-tool="ink"]`).click();
    await drawInk(`${active} [data-page-number="1"] .annotationEditorLayer`);
    await $(`${active} [data-annotation-tool="ink"]`).click();
    await expect($(`${active} [data-annotation-tool="ink"]`)).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await waitForAnnotationSave(saveBaseline);

    await activateLeaf(leaves.primary);
    await $(`${active} [data-page-number="1"] canvas`).waitForExist({ timeout: 10_000 });
    await $(`${active} .annotationLayer .highlightAnnotation`).waitForExist({ timeout: 10_000 });
    await $(`${active} .annotationLayer .inkAnnotation`).waitForExist({ timeout: 10_000 });
  });

  it('creates, saves, and reopens a native FreeText annotation', async () => {
    const workingPath = 'Documents/e2e-freetext.pdf';
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
    await waitForFirstPage();
    const saveBaseline = await captureAnnotationSaveBaseline();

    await createFreeText('Native FreeText round trip');
    await waitForAnnotationSave(saveBaseline);
    await expect($('.freeTextEditor')).toExist();

    await closeReaderLeaves();
    await openPdf(workingPath);
    await waitForFirstPage();
    await expect($('.freeTextEditor, .freeTextAnnotation')).toExist();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await $('[data-annotation-search]').setValue('Native FreeText round trip');
    await expect($('.abyss-annotation-card-text')).toHaveText('Native FreeText round trip');
  });

  it('creates, saves, and reopens a native Ink annotation', async () => {
    const workingPath = 'Documents/e2e-ink.pdf';
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
    await waitForFirstPage();
    const saveBaseline = await captureAnnotationSaveBaseline();

    await createInk();
    await waitForAnnotationSave(saveBaseline);
    await expect($('.inkEditor')).toExist();

    await closeReaderLeaves();
    await openPdf(workingPath);
    await waitForFirstPage();
    await $('.inkEditor, .inkAnnotation').waitForExist({ timeout: 10_000 });
    expect(
      await browser.execute(() => {
        const annotation = document.querySelector<HTMLElement>('.inkEditor, .inkAnnotation');
        const bounds = annotation?.getBoundingClientRect();
        const strokes = Array.from(
          annotation?.querySelectorAll<SVGElement>('path[d], polyline[points]') ?? [],
        ).map((stroke) => stroke.getAttribute('d') ?? stroke.getAttribute('points') ?? '');
        return {
          height: bounds?.height ?? 0,
          strokes,
          width: bounds?.width ?? 0,
        };
      }),
    ).toEqual(
      expect.objectContaining({
        height: expect.any(Number),
        strokes: expect.arrayContaining([expect.stringMatching(/\S/u)]),
        width: expect.any(Number),
      }),
    );
  });

  it('creates, edits, saves, and reopens an ordinary native Highlight comment', async () => {
    const workingPath = 'Documents/e2e-comment.pdf';
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
    await waitForFirstPage();
    let saveBaseline = await captureAnnotationSaveBaseline();

    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');
    await waitForNativeHighlightReadiness();
    await browser.execute(() => {
      const text = document.querySelectorAll('[data-page-number="1"] .textLayer span')[1];
      if (text === undefined) throw new Error('Expected selectable comment fixture text.');
      const range = document.createRange();
      range.selectNodeContents(text);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      text.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          clientX: 200,
          clientY: 200,
          pointerType: 'mouse',
        }),
      );
    });
    await $('.highlightEditor').waitForExist({ timeout: 5_000 });
    await waitForAnnotationSave(saveBaseline);
    saveBaseline = await captureAnnotationSaveBaseline();
    await selectNativeEditor('.highlightEditor');
    const commentEditor = $(nativeEditorSelector);
    await commentEditor.waitForDisplayed({ timeout: 5_000 });
    await inputValue(`${nativeEditorSelector} [aria-label="Comment"]`, 'Comment');
    await inputValue(`${nativeEditorSelector} [aria-label="Tags"]`, '#review');
    await inputValue(`${nativeEditorSelector} [aria-label="Links"]`, '[[Linked note]]');
    await waitForAnnotationSave(saveBaseline);
    await expect(commentEditor).toBeDisplayed();
    await expect(commentEditor.$('[aria-label="Comment"]')).toHaveValue('Comment');

    await closeReaderLeaves();
    await openPdf(workingPath);
    await waitForFirstPage();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await $('[data-annotation-search]').setValue('review');
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.abyss-annotation-card-text')).some(
            (card) => card.innerText.includes('#review'),
          ),
        ),
      { timeout: 5_000, timeoutMsg: 'Saved native comment did not appear in annotation search.' },
    );

    await $('[data-control="sidebar"]').click();
    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');
    await $('.highlightEditor').waitForExist({ timeout: 5_000 });
    await selectNativeEditor('.highlightEditor');
    saveBaseline = await captureAnnotationSaveBaseline();
    const revisedComment = $(`${nativeEditorSelector} [aria-label="Comment"]`);
    await revisedComment.waitForDisplayed({ timeout: 5_000 });
    await inputValue(`${nativeEditorSelector} [aria-label="Comment"]`, 'Revised');
    await inputValue(`${nativeEditorSelector} [aria-label="Tags"]`, '#verified');
    await inputValue(`${nativeEditorSelector} [aria-label="Links"]`, '[[Linked note]]');
    await expect(revisedComment).toHaveValue('Revised');
    await waitForAnnotationSave(saveBaseline);
    await expect($(nativeEditorSelector)).toBeDisplayed();
    await expect(revisedComment).toHaveValue('Revised');

    await closeReaderLeaves();
    await openPdf(workingPath);
    await waitForFirstPage();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await $('[data-annotation-search]').setValue('verified');
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.abyss-annotation-card-text')).some(
            (card) => card.innerText.includes('#verified'),
          ),
        ),
      { timeout: 5_000, timeoutMsg: 'Edited native comment did not reopen in annotation search.' },
    );
  });

  it('preserves imported Underline and Text Note annotations across a supported save', async () => {
    const workingPath = 'Documents/e2e-readonly-existing.pdf';
    await resetWorkingPdf('Documents/annotation-qualification.pdf', workingPath);
    await openPdf(workingPath);
    await waitForFirstPage();
    await expect($('.underlineAnnotation')).toExist();
    await expect($('.textAnnotation')).toExist();
    expect(await inspectPassiveImportedAnnotation('.underlineAnnotation')).toEqual({
      editableControls: 0,
      nativeEditors: 0,
      selectedEditors: 0,
    });
    expect(await inspectPassiveImportedAnnotation('.textAnnotation')).toEqual({
      editableControls: 0,
      nativeEditors: 0,
      selectedEditors: 0,
    });
    const saveBaseline = await captureAnnotationSaveBaseline();

    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');
    await waitForNativeHighlightReadiness();
    await browser.execute(() => {
      const text = document.querySelectorAll('[data-page-number="1"] .textLayer span')[1];
      if (text === undefined) throw new Error('Expected qualification fixture text.');
      const range = document.createRange();
      range.selectNodeContents(text);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      text.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          clientX: 200,
          clientY: 200,
          pointerType: 'mouse',
        }),
      );
    });
    await $('.highlightEditor').waitForExist({
      timeout: 5_000,
      timeoutMsg: 'Supported Highlight was not created beside imported read-only annotations.',
    });
    await waitForAnnotationSave(saveBaseline);
    await closeReaderLeaves();
    await openPdf(workingPath);
    await waitForFirstPage();

    await expect($('.underlineAnnotation')).toExist();
    await expect($('.textAnnotation')).toExist();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-sidebar-panel="annotations"]')).toHaveText(
      expect.stringContaining('Existing underline'),
    );
    await expect($('[data-sidebar-panel="annotations"]')).toHaveText(
      expect.stringContaining('Existing text note'),
    );
  });

  for (const qualification of [
    {
      comment: 'Signed #secure',
      message: 'Signed PDF documents are opened read-only to preserve signatures.',
      path: 'Documents/signed-document.pdf',
    },
    {
      comment: 'Restricted #secure',
      message: 'This PDF does not grant permission to modify its contents.',
      path: 'Documents/permission-restricted.pdf',
    },
  ]) {
    it(`opens ${qualification.path} read-only without mutating its bytes`, async () => {
      const before = await vaultFileSha256(qualification.path);
      await openPdf(qualification.path);
      await waitForFirstPage();

      await expect($('[data-region="annotation-toolbar"]')).toHaveAttribute(
        'aria-description',
        qualification.message,
      );
      expect(
        await browser.execute(() => {
          const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[data-region="annotation-toolbar"] button',
            ),
          );
          return buttons.length > 0 && buttons.every((button) => button.disabled);
        }),
      ).toBe(true);
      await $('[data-control="sidebar"]').click();
      await $('[data-tab="annotations"]').click();
      await expect($('[data-sidebar-panel="annotations"]')).toHaveText(
        expect.stringContaining(qualification.comment),
      );
      await browser.keys([process.platform === 'darwin' ? Key.Command : Key.Control, 's']);
      expect(await vaultFileSha256(qualification.path)).toBe(before);
    });
  }

  it('exports verified native annotations to a real vault file', async () => {
    const exportPath = 'Documents/e2e-annotation-export.md';
    await browser.executeObsidian(async ({ app }, path) => {
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing !== null) {
        await app.fileManager.trashFile(existing);
      }
    }, exportPath);
    await openPdf('Documents/annotation-qualification.pdf');
    await waitForFirstPage();

    await $('[data-control="overflow"]').click();
    await $(
      '//*[contains(@class, "menu-item-title") and normalize-space(.)="Export annotations…"]',
    ).click();
    const destination = $('input[aria-label="Vault destination"]');
    await destination.setValue(exportPath);
    await $('[data-action="export"]').click();
    await browser.waitUntil(
      async () =>
        browser.executeObsidian(
          ({ app }, path) => app.vault.getAbstractFileByPath(path) !== null,
          exportPath,
        ),
      { timeout: 10_000, timeoutMsg: 'Annotation export did not create its vault file.' },
    );
    const exported = await browser.executeObsidian(
      async ({ app }, path) => app.vault.adapter.read(path),
      exportPath,
    );
    expect(exported).toContain('![[annotation-qualification.pdf#annotation=');
    expect(exported).toContain('Existing underline');
    expect(exported).toContain('Existing text note');
    const link = /!\[\[([^\]]+#annotation=[^\]]+)\]\]/u.exec(exported)?.[1];
    expect(link).toBeDefined();
    await closeReaderLeaves();
    await browser.executeObsidian(
      async ({ app }, input) => {
        await app.vault.adapter.write(
          input.sourcePath,
          `${await app.vault.adapter.read(input.sourcePath)}\n\n[Open annotation](${input.link})\n`,
        );
        const leaf = app.workspace.getLeaf(true);
        await leaf.setViewState({
          type: 'markdown',
          state: { file: input.sourcePath, mode: 'preview' },
        });
        app.workspace.setActiveLeaf(leaf, { focus: true });
      },
      { link: link ?? '', sourcePath: exportPath },
    );
    const renderedLink = $('a.internal-link[data-href*="#annotation="]');
    await renderedLink.waitForClickable({ timeout: 10_000 });
    await renderedLink.click();
    try {
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              document.querySelectorAll('.abyss-annotation-card[aria-current="true"]').length === 1,
          ),
        { timeout: 10_000, timeoutMsg: 'Exported annotation deep link did not select its target.' },
      );
    } catch (cause) {
      const diagnostics = await browser.executeObsidian(({ app }) => ({
        activeFile: app.workspace.getActiveFile()?.path ?? null,
        leaves: app.workspace
          .getLeavesOfType('abyss-document-view')
          .map((leaf) => leaf.getViewState()),
        panel: document.querySelector('[data-sidebar-panel="annotations"]')?.textContent ?? null,
        selected: Array.from(
          document.querySelectorAll<HTMLElement>('.abyss-annotation-card[aria-current="true"]'),
        ).map((card) => card.dataset['annotationId']),
      }));
      throw new Error(
        `Exported annotation deep link ${JSON.stringify(link)} did not select its target: ` +
          `${JSON.stringify(diagnostics)}; ${String(cause)}`,
      );
    }
    await expect($('[data-control="page-field"]')).toHaveValue('1');
  });
});

it('projects annotates and searches a PDF from a long Unicode Cyrillic vault path', async () => {
  const unicodePath =
    'Documents/Юридические документы — очень длинный путь — Résumé Café — проверка.pdf';
  await resetWorkingPdf('Documents/unicode-annotations.pdf', unicodePath);
  await openPdf(unicodePath);
  await waitForFirstPage();

  await $('[data-control="sidebar"]').click();
  await $('[data-tab="annotations"]').click();
  await $('.abyss-annotation-card').waitForExist({ timeout: 10_000 });
  await $('[data-annotation-search]').setValue('Unicode annotation');
  await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(1);
  await $('.abyss-annotation-card').click();
  await expect($('[data-control="page-field"]')).toHaveValue('1');

  await $('[data-tab="search"]').click();
  const query = $('[data-document-search]');
  await query.setValue('café déjà');
  await expect($('[data-search-count]')).toHaveText('1 result');
  const exactMark = $('[data-search-result] mark[data-search-match]');
  await expect(exactMark).toHaveText('Café déjà');
  await $('[data-search-result]').click();
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.querySelectorAll('[data-page-number="1"] .textLayer .highlight').length > 0,
      ),
    { timeout: 5_000, timeoutMsg: 'Native PDF search highlight did not become visible.' },
  );

  await query.setValue('Résumé');
  await expect($('[data-search-result] mark[data-search-match]')).toHaveText('Résumé');
  await expect($('[data-search-result] mark[data-search-match]')).not.toHaveText('Café déjà');
  await query.click();
  await browser.keys([process.platform === 'darwin' ? Key.Command : Key.Control, 'a']);
  await browser.keys(Key.Backspace);
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelectorAll('[data-search-result] mark[data-search-match]').length ===
              0 &&
            document.querySelectorAll('[data-page-number="1"] .textLayer .highlight').length === 0,
        ),
      { timeout: 5_000, timeoutMsg: 'Clearing search left stale sidebar or PDF highlights.' },
    );
  } catch (cause) {
    const diagnostic = await browser.execute(() => ({
      input: document.querySelector<HTMLInputElement>('[data-document-search]')?.value ?? null,
      nativeHighlights: Array.from(
        document.querySelectorAll<HTMLElement>('[data-page-number="1"] .textLayer .highlight'),
        (highlight) => ({ className: highlight.className, text: highlight.textContent }),
      ),
      resultMarks: Array.from(
        document.querySelectorAll<HTMLElement>('[data-search-result] mark[data-search-match]'),
        (mark) => mark.textContent,
      ),
    }));
    throw new Error(`${String(cause)}; diagnostic=${JSON.stringify(diagnostic)}`);
  }
});

it('falls back from cache failure delays the quiet spinner and recovers from terminal extraction failure', async () => {
  const fallbackPath = 'Documents/Сбой кэша — fallback annotations.pdf';
  const delayPath = 'Documents/Задержка извлечения — quiet spinner.pdf';
  const terminalPath = 'Documents/Сбой извлечения — terminal annotations.pdf';
  await resetWorkingPdf('Documents/unicode-annotations.pdf', fallbackPath);
  await resetWorkingPdf('Documents/text-12-pages.pdf', delayPath);
  await resetWorkingPdf('Documents/unicode-annotations.pdf', terminalPath);
  await openPdf(fallbackPath);
  await waitForFirstPage();
  let monitorInstalled = false;
  try {
    await setAnnotationLoadTestFault({ cacheRead: 'fail' });
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await $('.abyss-annotation-card').waitForExist({ timeout: 10_000 });
    await expect($('[data-sidebar-panel="annotations"]')).toHaveAttribute(
      'data-annotation-state',
      'content',
    );

    await openPdf(delayPath);
    await waitForFirstPage();
    await setAnnotationLoadTestFault({ cacheRead: 'fail', extractionDelayMs: 350 });
    await $('[data-control="sidebar"]').click();
    await browser.execute(() => {
      const host = window as Window & {
        __abyssTask9AnnotationLoading?: {
          readonly cleanup: () => void;
          readonly samples: Array<{
            readonly at: number;
            readonly spinner: boolean;
            readonly state: string | null;
            readonly status: string;
          }>;
          activatedAt: number | null;
        };
      };
      const samples: Array<{
        at: number;
        spinner: boolean;
        state: string | null;
        status: string;
      }> = [];
      const record = (): void => {
        const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
        samples.push({
          at: performance.now(),
          spinner: panel?.querySelector('[data-annotations-spinner]') !== null,
          state: panel?.dataset['annotationState'] ?? null,
          status: panel?.querySelector<HTMLElement>('[role="status"]')?.innerText.trim() ?? '',
        });
      };
      const observer = new MutationObserver(record);
      observer.observe(document.body, {
        attributeFilter: ['data-annotation-state', 'hidden'],
        attributes: true,
        childList: true,
        subtree: true,
      });
      const onClick = (event: MouseEvent): void => {
        const target = event.target;
        if (!(target instanceof Element) || target.closest('[data-tab="annotations"]') === null)
          return;
        const monitor = host.__abyssTask9AnnotationLoading;
        if (monitor !== undefined) monitor.activatedAt = performance.now();
        record();
      };
      document.addEventListener('click', onClick, { capture: true });
      host.__abyssTask9AnnotationLoading = {
        activatedAt: null,
        cleanup: () => {
          observer.disconnect();
          document.removeEventListener('click', onClick, { capture: true });
        },
        samples,
      };
    });
    monitorInstalled = true;
    await $('[data-tab="annotations"]').click();
    await expect($('[data-sidebar-panel="annotations"] [role="status"]')).toHaveText(
      'No annotations',
      { wait: 10_000 },
    );
    const timing = await browser.execute(() => {
      const monitor = (
        window as Window & {
          __abyssTask9AnnotationLoading?: {
            readonly samples: ReadonlyArray<{
              at: number;
              spinner: boolean;
              state: string | null;
              status: string;
            }>;
            readonly activatedAt: number | null;
          };
        }
      ).__abyssTask9AnnotationLoading;
      if (monitor?.activatedAt === null || monitor?.activatedAt === undefined)
        throw new Error('Annotation loading activation was not observed.');
      const activatedAt = monitor.activatedAt;
      return {
        finalSpinner:
          document.querySelector(
            '[data-sidebar-panel="annotations"] [data-annotations-spinner]',
          ) !== null,
        finalState:
          document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]')?.dataset[
            'annotationState'
          ] ?? null,
        spinnerOffsets: monitor.samples
          .filter((sample) => sample.spinner)
          .map((sample) => sample.at - activatedAt),
        timeline: monitor.samples.map((sample) => ({
          offset: sample.at - activatedAt,
          spinner: sample.spinner,
          state: sample.state,
          status: sample.status,
        })),
      };
    });
    if (timing.spinnerOffsets.length === 0)
      throw new Error(`Delayed extraction never exposed its spinner: ${JSON.stringify(timing)}`);
    expect(Math.min(...timing.spinnerOffsets)).toBeGreaterThanOrEqual(250);
    expect(timing).toMatchObject({ finalSpinner: false, finalState: 'empty' });
    await browser.execute(() => {
      const host = window as Window & {
        __abyssTask9AnnotationLoading?: { cleanup(): void };
      };
      host.__abyssTask9AnnotationLoading?.cleanup();
      delete host.__abyssTask9AnnotationLoading;
    });
    monitorInstalled = false;

    await openPdf(terminalPath);
    await waitForFirstPage();
    await setAnnotationLoadTestFault({ cacheRead: 'fail', extractionFailure: true });
    await expect($('.annotationLayer .highlightAnnotation')).toExist();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-sidebar-panel="annotations"] [role="status"]')).toHaveText(
      "Couldn't load annotations",
    );
    expect(
      await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
        return {
          native: document.querySelectorAll('.annotationLayer .highlightAnnotation').length,
          retryButtons: panel?.querySelectorAll('[data-action*="retry"]').length ?? -1,
          technicalCopy: /cache|extract|retry|page/iu.test(panel?.innerText ?? ''),
        };
      }),
    ).toEqual({ native: 1, retryButtons: 0, technicalCopy: false });

    await setAnnotationLoadTestFault(null);
    await closeReaderLeaves();
    await openPdf(terminalPath);
    await waitForFirstPage();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await $('.abyss-annotation-card').waitForExist({ timeout: 10_000 });
    await expect($('[data-sidebar-panel="annotations"]')).toHaveAttribute(
      'data-annotation-state',
      'content',
    );
  } finally {
    if (monitorInstalled)
      await browser.execute(() => {
        const host = window as Window & {
          __abyssTask9AnnotationLoading?: { cleanup(): void };
        };
        host.__abyssTask9AnnotationLoading?.cleanup();
        delete host.__abyssTask9AnnotationLoading;
      });
    await setAnnotationLoadTestFault(null).catch(() => undefined);
  }
});
