import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';

async function closeReaderLeaves(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    for (const leaf of app.workspace.getLeavesOfType('abyss-document-view'))
      await leaf.setViewState({ type: 'empty', state: {} });
  });
}

async function openOutline(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    await app.workspace.openLinkText('Documents/outline-20-pages.pdf', '', false);
  });
  await $('[data-abyss-document]').waitForDisplayed({ timeout: 15_000 });
  await $('[data-page-number="1"] canvas').waitForExist({ timeout: 15_000 });
  await $('[data-control="sidebar"]').click();
  await expect($('[data-tab="outline"][aria-selected="true"]')).toExist();
  await expect($$('[data-outline-row]')).toBeElementsArrayOfSize({ gte: 6 });
}

describe('PDF reader sidebar', () => {
  beforeEach(closeReaderLeaves);
  afterEach(closeReaderLeaves);

  it('filters a searchable outline while retaining its ancestor path', async () => {
    await openOutline();

    const search = $('[data-outline-search]');
    await expect(search).toHaveAttribute('placeholder', 'Find a heading…');
    await search.setValue('SECTION 2');

    await expect($$('[data-outline-row]')).toBeElementsArrayOfSize(8);
    await expect(
      $('[data-outline-id="outline-1"] > [data-outline-row] [data-outline-label]'),
    ).toHaveText('Chapter 2');
    await expect($('[data-outline-id="outline-1-1"] [data-outline-label]')).toHaveText(
      expect.stringContaining('Section 2'),
    );
    await expect($('[data-outline-item="outline-1"]')).toHaveAttribute('aria-expanded', 'true');

    await search.setValue('missing heading');
    await expect($('[data-outline-empty="filtered"]')).toHaveText('No matching headings');
    await search.clearValue();
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('[data-outline-search]');
      input?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await expect($$('[data-outline-row]')).toBeElementsArrayOfSize(12);
  });

  it('keeps the outline left aligned contained and keyboard navigable at narrow widths', async () => {
    await openOutline();
    await browser.execute(() => {
      const sidebar = document.querySelector<HTMLElement>('.abyss-reader-sidebar');
      if (sidebar === null) throw new Error('Reader sidebar is missing.');
      const narrowWidth = '260px';
      sidebar.style.width = narrowWidth;
      sidebar.style.maxWidth = narrowWidth;
    });

    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-outline-id="outline-0"]')?.focus();
    });
    await expect($('[data-outline-id="outline-0"]')).toBeFocused();
    await browser.keys(Key.ArrowDown);
    await expect($('[data-outline-id="outline-0-0"]')).toBeFocused();

    const geometry = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="outline"]');
      const tree = document.querySelector<HTMLElement>('[role="tree"]');
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-outline-row]'));
      if (panel === null || tree === null || rows.length === 0)
        throw new Error('Outline geometry is unavailable.');
      const panelRect = panel.getBoundingClientRect();
      return {
        hasChevron: rows[0]?.querySelector('[data-outline-chevron] svg') !== null,
        maxRowRight: Math.max(...rows.map((row) => row.getBoundingClientRect().right)),
        minRowLeft: Math.min(...rows.map((row) => row.getBoundingClientRect().left)),
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        rowHeights: rows.map((row) => row.getBoundingClientRect().height),
        scrollOverflow: tree.scrollWidth - tree.clientWidth,
      };
    });

    expect(geometry.hasChevron).toBe(true);
    expect(geometry.minRowLeft).toBeGreaterThanOrEqual(geometry.panelLeft);
    expect(geometry.maxRowRight).toBeLessThanOrEqual(geometry.panelRight + 1);
    expect(geometry.scrollOverflow).toBeLessThanOrEqual(1);
    expect(Math.min(...geometry.rowHeights)).toBeGreaterThanOrEqual(28);
    expect(Math.max(...geometry.rowHeights)).toBeLessThanOrEqual(32);
  });
});
