import { $, browser, expect } from '@wdio/globals';
import { afterEach, describe, it } from 'mocha';

async function openPdf(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, documentPath) => {
    await app.workspace.openLinkText(documentPath, '', false);
  }, path);
  await $('[data-abyss-document]').waitForDisplayed({ timeout: 20_000 });
}

describe('PDF reader foundation on Android', () => {
  afterEach(async () => {
    await browser.executeObsidian(({ app }) => {
      for (const leaf of app.workspace.getLeavesOfType('abyss-document-view')) leaf.detach();
    });
  });

  it('uses an overlay sidebar and a pinch-capable PDF viewer', async () => {
    await openPdf('Documents/text-12-pages.pdf');

    await $('[data-control="sidebar"]').click();
    await expect($('[data-region="sidebar"]')).toHaveElementClass('is-mobile');
    await expect($('[data-pinch-capable="true"]')).toExist();
  });

  it('opens a raster-heavy PDF without a Node runtime dependency', async () => {
    await openPdf('Documents/raster-heavy-24-pages.pdf');

    await expect($('[data-page-number="1"] canvas')).toExist();
    const pluginUsesNodeGlobals = await browser.execute(() =>
      Boolean(
        document.querySelector('[data-abyss-document]')?.getAttribute('data-runtime-node-api'),
      ),
    );
    expect(pluginUsesNodeGlobals).toBe(false);
  });
});
