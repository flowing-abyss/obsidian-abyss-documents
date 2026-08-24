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

async function openAnnotations(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, documentPath) => {
    await app.workspace.openLinkText(documentPath, '', false);
  }, path);
  await $('[data-abyss-document]').waitForDisplayed({ timeout: 15_000 });
  await $('[data-page-number="1"] canvas').waitForExist({ timeout: 15_000 });
  await $('[data-control="sidebar"]').click();
  await $('[data-tab="annotations"]').click();
  await expect($('[data-tab="annotations"][aria-selected="true"]')).toExist();
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
    await expect($$('[data-outline-match]')).toBeElementsArrayOfSize(4);
    expect(await $$('[data-outline-match]').map(async (match) => match.getText())).toEqual([
      'Section 2',
      'Section 2',
      'Section 2',
      'Section 2',
    ]);
    await expect($('[data-outline-id="outline-1-1"]')).toHaveAttribute(
      'aria-label',
      'Chapter 2 · Section 2',
    );
    await expect($('[data-outline-item="outline-1"]')).toHaveAttribute('aria-expanded', 'true');

    await search.setValue('missing heading');
    const status = $('[data-outline-status]');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveText('No matching headings');
    await expect(status).toBeDisplayed();
    await expect($('[role="tree"]')).not.toBeDisplayed();
    expect(
      await browser.execute(() => {
        const panel = document.querySelector('[data-sidebar-panel="outline"]');
        const tree = panel?.querySelector('[role="tree"]');
        const outlineStatus = panel?.querySelector('[data-outline-status]');
        return {
          statusInsidePanel: panel?.contains(outlineStatus ?? null) === true,
          statusInsideTree: tree?.contains(outlineStatus ?? null) === true,
          treeChildren: tree?.children.length ?? -1,
        };
      }),
    ).toEqual({ statusInsidePanel: true, statusInsideTree: false, treeChildren: 0 });
    await search.clearValue();
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('[data-outline-search]');
      input?.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await expect($$('[data-outline-row]')).toBeElementsArrayOfSize(12);
    await expect($('[role="tree"]')).toBeDisplayed();
    await expect(status).not.toBeDisplayed();
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
      const chevrons = Array.from(
        document.querySelectorAll<HTMLElement>('[data-outline-chevron].is-interactive'),
      );
      const icons = chevrons.flatMap((chevron) =>
        Array.from(chevron.querySelectorAll<SVGElement>('.svg-icon')),
      );
      if (panel === null || tree === null || rows.length === 0)
        throw new Error('Outline geometry is unavailable.');
      const panelRect = panel.getBoundingClientRect();
      return {
        hasChevron: rows[0]?.querySelector('[data-outline-chevron] svg') !== null,
        maxRowRight: Math.max(...rows.map((row) => row.getBoundingClientRect().right)),
        minRowLeft: Math.min(...rows.map((row) => row.getBoundingClientRect().left)),
        chevronHeights: chevrons.map((chevron) => chevron.getBoundingClientRect().height),
        chevronWidths: chevrons.map((chevron) => chevron.getBoundingClientRect().width),
        iconHeights: icons.map((icon) => icon.getBoundingClientRect().height),
        iconWidths: icons.map((icon) => icon.getBoundingClientRect().width),
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
    expect(Math.min(...geometry.chevronHeights)).toBeGreaterThanOrEqual(32);
    expect(Math.min(...geometry.chevronWidths)).toBeGreaterThanOrEqual(32);
    expect(Math.min(...geometry.iconHeights)).toBeGreaterThanOrEqual(14);
    expect(Math.max(...geometry.iconHeights)).toBeLessThanOrEqual(16);
    expect(Math.min(...geometry.iconWidths)).toBeGreaterThanOrEqual(14);
    expect(Math.max(...geometry.iconWidths)).toBeLessThanOrEqual(16);
  });

  it('shows one clean empty annotation state without inactive controls', async () => {
    await openAnnotations('Documents/outline-20-pages.pdf');

    const status = $('[data-annotations-status]');
    await expect(status).toHaveText('No annotations');
    await expect($('[data-annotation-search]')).not.toBeDisplayed();
    await expect($('[data-section="tags"]')).not.toBeDisplayed();
    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(0);
  });

  it('keeps annotation controls above an independent virtual scroll host', async () => {
    await openAnnotations('Documents/annotations-10000.pdf');
    await browser.waitUntil(
      async () => (await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) === '10000',
      { timeout: 15_000, timeoutMsg: 'Annotation panel did not load ten thousand items.' },
    );

    const geometry = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      if (panel === null) throw new Error('Annotation panel is missing.');
      const controls = panel.querySelector<HTMLElement>('.abyss-annotation-controls');
      const scrollHost = panel.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      const tags = panel.querySelector<HTMLElement>('[data-section="tags"]');
      if (controls === null || scrollHost === null || tags === null)
        throw new Error('Annotation panel structure is incomplete.');
      return {
        controlsAboveList:
          controls.getBoundingClientRect().bottom <= scrollHost.getBoundingClientRect().top + 1,
        panelOverflowY: getComputedStyle(panel).overflowY,
        scrollHostOverflowY: getComputedStyle(scrollHost).overflowY,
        tagsInsideScrollHost: scrollHost.contains(tags),
      };
    });
    expect(geometry).toEqual({
      controlsAboveList: true,
      panelOverflowY: 'hidden',
      scrollHostOverflowY: 'auto',
      tagsInsideScrollHost: false,
    });
    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize({ lte: 48 });

    await $('[data-annotation-search]').setValue('not present in any annotation');
    await expect($('[data-annotations-status]')).toHaveText('No matching annotations');
    await expect($$('[data-annotation-search]')).toBeElementsArrayOfSize(1);
  });
});
