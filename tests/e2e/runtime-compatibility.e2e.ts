import { $, browser, expect } from '@wdio/globals';
import { afterEach, describe, it } from 'mocha';

async function fileFingerprint(): Promise<string> {
  return browser.executeObsidian(async ({ app }) => {
    const bytes = await app.vault.adapter.readBinary('Documents/text-12-pages.pdf');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
      '',
    );
  });
}

describe('Unsupported PDF runtime', () => {
  afterEach(async () => {
    await browser.executeObsidian(async ({ app }) => {
      for (const leaf of app.workspace.getLeavesOfType('abyss-document-view')) {
        const controller = (leaf.view as unknown as { controller?: { close(): Promise<void> } })
          .controller;
        await controller?.close();
      }
      app.workspace.detachLeavesOfType('abyss-document-view');
    });
  });

  it('explains the installer update before loading a worker and leaves the PDF unchanged', async () => {
    const before = await fileFingerprint();
    await browser.executeObsidian(async ({ app }) => {
      await app.workspace.openLinkText('Documents/text-12-pages.pdf', '', false);
    });

    const error = $('[data-reader-error="open"]');
    await error.waitForDisplayed({ timeout: 5_000 });
    await expect(error).toHaveText(expect.stringContaining('installer'));
    await expect(error.$('[data-action="retry"]')).toBeDisplayed();
    expect(await fileFingerprint()).toBe(before);

    const counters = await browser.execute(() => {
      const state = (
        window as Window & {
          __abyssDocumentsPerformance?: {
            counters: { pdfImports: number; workersStarted: number; blobsCreated: number };
          };
        }
      ).__abyssDocumentsPerformance;
      if (state === undefined) throw new Error('Reader performance counters are unavailable.');
      return {
        pdfImports: state.counters.pdfImports,
        workersStarted: state.counters.workersStarted,
        blobsCreated: state.counters.blobsCreated,
      };
    });
    expect(counters).toEqual({ pdfImports: 0, workersStarted: 0, blobsCreated: 0 });
  });
});
