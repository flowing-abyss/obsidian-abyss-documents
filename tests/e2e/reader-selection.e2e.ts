import { $, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';

const pluginId = 'abyss-documents';

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
      await leaf.setViewState({ type: 'empty', state: {} });
    }
  });
}

async function selectFixtureText(): Promise<void> {
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
    document.dispatchEvent(new Event('selectionchange'));
  });
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
    await expect($('[data-annotation-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

    await selectFixtureText();

    await $('[data-region="selection-annotation-popover"]').waitForDisplayed({ timeout: 5_000 });
    await expect($('[data-selection-intent="comment"]')).toExist();
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
    await expect($('[data-region="selection-annotation-popover"]')).not.toBeDisplayed();
  });
});
