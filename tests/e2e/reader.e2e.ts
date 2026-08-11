import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';

const pluginId = 'abyss-documents';

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
  await browser.executeObsidian(({ app }) => {
    for (const leaf of app.workspace.getLeavesOfType('abyss-document-view')) leaf.detach();
  });
}

async function waitForFirstPage(): Promise<void> {
  try {
    await $('[data-page-number="1"] canvas').waitForExist({ timeout: 15_000 });
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
    await $('[data-document-search]').setValue('gradient');
    await expect($('[data-search-count]')).toHaveText(/^[1-9]/);
    await expect($('[data-annotation-search]')).not.toExist();
  });

  it('opens a two-level outline and navigates to its destination', async () => {
    await openPdf('Documents/outline-20-pages.pdf');
    await waitForFirstPage();

    await $('[data-control="sidebar"]').click();
    await expect($('[data-tab="outline"][aria-selected="true"]')).toExist();
    await expect($$('[data-outline-item]')).toBeElementsArrayOfSize({ gte: 6 });
    await $('[data-outline-id="outline-1-0"]').click();
    await expect($('[data-control="page-field"]')).toHaveValue('12');
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

    await $('[data-control="profile"]').click();
    const sepia = $('//*[contains(@class, "menu-item-title") and normalize-space(.)="Sepia"]');
    try {
      await sepia.waitForExist({ timeout: 5_000 });
    } catch (error) {
      const diagnostics = await browser.execute(() => {
        const button = document.querySelector<HTMLElement>('[data-control="profile"]');
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
  });
});
