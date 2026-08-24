import { $, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';

const pluginId = 'abyss-documents';

async function openPdf(): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      if (!app.plugins.enabledPlugins.has(input.pluginId)) {
        throw new Error(`Plugin ${input.pluginId} is not enabled.`);
      }
      await app.workspace.openLinkText('Documents/text-12-pages.pdf', '', false);
    },
    { pluginId },
  );
  await $('[data-abyss-document]').waitForDisplayed({ timeout: 15_000 });
}

async function closeReaders(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    for (const leaf of app.workspace.getLeavesOfType('abyss-document-view')) {
      await leaf.setViewState({ type: 'empty', state: {} });
    }
  });
}

describe('reader compact toolbar', () => {
  beforeEach(async () => {
    await closeReaders();
    await openPdf();
  });
  afterEach(closeReaders);

  it('keeps one priority row with native tooltips and no permanent destructive controls', async () => {
    await expect($('[data-control="layout"]')).not.toExist();
    await expect($('[data-control="profile"]')).not.toExist();
    await expect($('[data-action="undo-annotation"]')).not.toExist();
    await expect($('[data-action="redo-annotation"]')).not.toExist();
    await expect($('[data-action="delete-annotation"]')).not.toExist();

    const sidebar = $('[data-control="sidebar"]');
    await sidebar.moveTo();
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          const button = document.querySelector<HTMLElement>('[data-control="sidebar"]');
          button?.dispatchEvent(
            new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
          );
        });
        await browser.pause(350);
        return browser.execute(
          () => document.querySelector<HTMLElement>('.tooltip')?.textContent === 'Toggle sidebar',
        );
      },
      { interval: 100, timeout: 4_000, timeoutMsg: 'Native sidebar tooltip did not appear.' },
    );

    const geometry = await browser.execute(() => {
      const toolbar = document.querySelector<HTMLElement>('.abyss-reader-toolbar');
      const controls = Array.from(
        toolbar?.querySelectorAll<HTMLElement>(':scope > *, :scope > * > *') ?? [],
      ).filter((element) => element.matches('[data-toolbar-control], [data-control-group]'));
      return {
        height: toolbar?.getBoundingClientRect().height ?? 0,
        tops: controls.map((element) => Math.round(element.getBoundingClientRect().top)),
      };
    });
    expect(new Set(geometry.tops).size).toBe(1);
    expect(geometry.height).toBeLessThanOrEqual(44);
  });

  it('exposes Fit, semantic Quick Highlight, Layout, appearance and Export without OCR', async () => {
    await $('[data-control="fit-menu"]').click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit height'));
    await browser.keys(['Escape']);
    await expect($('.menu')).not.toBeDisplayed();
    await expect($('[data-control="fit-menu"]')).toHaveAttribute('aria-expanded', 'false');
    expect(
      await browser.execute(
        () => (document.activeElement as HTMLElement | null)?.dataset['control'] ?? '',
      ),
    ).toBe('fit-menu');

    const quick = $('[data-annotation-tool="highlight"]');
    await expect(quick).toHaveAttribute('aria-pressed', 'false');
    await expect(quick).toHaveAttribute('aria-label', expect.stringContaining('Yellow'));
    await quick.click();
    await expect(quick).toHaveAttribute('aria-pressed', 'true');

    await $('[data-control="overflow"]').click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    const menuText = await $('.menu').getText();
    expect(menuText).toContain('Layout');
    expect(menuText).toContain('Appearance');
    expect(menuText).toContain('Default');
    expect(menuText).toContain('Export annotations');
    expect(menuText).not.toContain('OCR');
    expect(menuText).not.toContain('Recognize');
  });
});
