import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';

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

async function annotationCardGeometry(): Promise<{
  readonly cardHeight: number;
  readonly cardWidth: number;
  readonly commentHeight: number;
  readonly commentWidth: number;
  readonly firstPosition: string | null;
  readonly headerHeight: number;
  readonly rowHeight: number;
  readonly rowWidth: number;
  readonly scrollTop: number;
}> {
  return browser.execute(() => {
    const card = document.querySelector<HTMLElement>('.abyss-annotation-card');
    const comment = card?.querySelector<HTMLElement>('[data-annotation-comment]') ?? null;
    const header = card?.querySelector<HTMLElement>('.abyss-annotation-card-header') ?? null;
    const row = card?.closest<HTMLElement>('.abyss-annotation-card-row') ?? null;
    const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
    if (card === null || comment === null || header === null || row === null || scrollHost === null)
      throw new Error('Annotation geometry target is incomplete.');
    const rounded = (value: number): number => Number(value.toFixed(3));
    const cardRect = card.getBoundingClientRect();
    const commentRect = comment.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      cardHeight: rounded(cardRect.height),
      cardWidth: rounded(cardRect.width),
      commentHeight: rounded(commentRect.height),
      commentWidth: rounded(commentRect.width),
      firstPosition: row.getAttribute('aria-posinset'),
      headerHeight: rounded(header.getBoundingClientRect().height),
      rowHeight: rounded(rowRect.height),
      rowWidth: rounded(rowRect.width),
      scrollTop: rounded(scrollHost.scrollTop),
    };
  });
}

async function setCoarseAnnotationGeometry(enabled: boolean): Promise<void> {
  await browser.execute((coarse) => {
    const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
    if (panel === null) throw new Error('Annotation panel is missing for coarse geometry.');
    panel.setCssProps({
      '--abyss-annotation-action-height': coarse ? '44px' : '',
      '--abyss-annotation-action-width': coarse ? '104px' : '',
      '--abyss-annotation-color-chip-height': coarse ? '44px' : '',
    });
    window.dispatchEvent(new Event('resize'));
  }, enabled);
}

async function waitForAnnotationWindowToSettle(): Promise<void> {
  let previous = '';
  let stableSamples = 0;
  await browser.waitUntil(
    async () => {
      const sample = await browser.execute(() => {
        const row = document.querySelector<HTMLElement>('.abyss-annotation-card-row');
        const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
        if (row === null || scrollHost === null) return '';
        return [
          row.getAttribute('aria-posinset'),
          row.getBoundingClientRect().top.toFixed(2),
          scrollHost.scrollTop.toFixed(2),
        ].join(':');
      });
      stableSamples = sample === previous && sample !== '' ? stableSamples + 1 : 0;
      previous = sample;
      return stableSamples >= 2;
    },
    {
      interval: 100,
      timeout: 5_000,
      timeoutMsg: 'Annotation virtual window did not settle.',
    },
  );
}

async function documentTagsAnchorGeometry(annotationId: string): Promise<{
  readonly activeAction: string | null;
  readonly bodyDisplay: string;
  readonly bodyId: string;
  readonly bottomGap: number;
  readonly cardTop: number;
  readonly collapsed: boolean;
  readonly controlledId: string | null;
  readonly firstPosition: string | null;
  readonly footerHeight: number;
  readonly footerIsLast: boolean;
  readonly scrollTop: number;
  readonly summaryHeight: number;
}> {
  return browser.execute((anchorId) => {
    const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
    const footer = panel?.querySelector<HTMLElement>('[data-section="tags"]') ?? null;
    const body = footer?.querySelector<HTMLElement>('.abyss-annotation-tags-body') ?? null;
    const toggle =
      footer?.querySelector<HTMLButtonElement>('[data-action="toggle-document-tags"]') ?? null;
    const scrollHost = panel?.querySelector<HTMLElement>('[data-annotation-scroll-host]') ?? null;
    const card = Array.from(
      panel?.querySelectorAll<HTMLElement>('.abyss-annotation-card') ?? [],
    ).find((candidate) => candidate.dataset['annotationId'] === anchorId);
    if (
      panel === null ||
      footer === null ||
      body === null ||
      toggle === null ||
      scrollHost === null ||
      card === undefined
    )
      throw new Error('Document tags anchor geometry is incomplete.');
    const panelRect = panel.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      activeAction:
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.dataset['action'] ?? null)
          : null,
      bodyDisplay: getComputedStyle(body).display,
      bodyId: body.id,
      bottomGap: Math.abs(panelRect.bottom - footerRect.bottom),
      cardTop: card.getBoundingClientRect().top,
      collapsed: toggle.getAttribute('aria-expanded') === 'false',
      controlledId: toggle.getAttribute('aria-controls'),
      firstPosition:
        card.closest('.abyss-annotation-card-row')?.getAttribute('aria-posinset') ?? null,
      footerHeight: footerRect.height,
      footerIsLast: (() => {
        const annotationFooter = footer.parentElement;
        return (
          annotationFooter?.hasAttribute('data-annotation-footer') === true &&
          annotationFooter.lastElementChild === footer &&
          panel.lastElementChild === annotationFooter
        );
      })(),
      scrollTop: scrollHost.scrollTop,
      summaryHeight: toggle.getBoundingClientRect().height,
    };
  }, annotationId);
}

async function scrollAnnotationListBy(pixels: number): Promise<void> {
  await browser.execute((delta) => {
    const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
    if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
    scrollHost.scrollTop += delta;
    scrollHost.dispatchEvent(new Event('scroll'));
  }, pixels);
  await waitForAnnotationWindowToSettle();
}

async function movePointerTo(x: number, y: number): Promise<void> {
  await browser.performActions([
    {
      type: 'pointer',
      id: 'annotation-geometry-pointer',
      parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', duration: 0, origin: 'viewport', x, y }],
    },
  ]);
  await browser.releaseActions();
}

describe('PDF reader sidebar', () => {
  beforeEach(closeReaderLeaves);
  afterEach(closeReaderLeaves);

  it('filters a searchable outline while retaining its ancestor path', async () => {
    await openOutline();

    await $('[data-action="toggle-outline-search"]').click();
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
    await expect($('[data-annotation-footer]')).not.toBeDisplayed();
    await expect($('[data-section="colors"]')).not.toBeDisplayed();
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
      const footer = panel.querySelector<HTMLElement>('[data-annotation-footer]');
      const colors = panel.querySelector<HTMLElement>('[data-section="colors"]');
      const tags = panel.querySelector<HTMLElement>('[data-section="tags"]');
      if (
        controls === null ||
        scrollHost === null ||
        footer === null ||
        colors === null ||
        tags === null
      )
        throw new Error('Annotation panel structure is incomplete.');
      const rows = Array.from(
        scrollHost.querySelectorAll<HTMLElement>('.abyss-annotation-card-row'),
      );
      return {
        clientHeight: scrollHost.clientHeight,
        controlsAboveList:
          controls.getBoundingClientRect().bottom <= scrollHost.getBoundingClientRect().top + 1,
        controlsChildCount: controls.children.length,
        controlsBottom: controls.getBoundingClientRect().bottom,
        controlsTop: controls.getBoundingClientRect().top,
        colorsBelowList:
          scrollHost.getBoundingClientRect().bottom <= colors.getBoundingClientRect().top + 1,
        colorsInsideScrollHost: scrollHost.contains(colors),
        footerIsLast: panel.lastElementChild === footer,
        footerOrder: footer.firstElementChild === colors && footer.lastElementChild === tags,
        firstPosition: Number(rows[0]?.getAttribute('aria-posinset')),
        firstRowId: rows[0]?.dataset['annotationCardId'] ?? '',
        lastPosition: Number(rows[rows.length - 1]?.getAttribute('aria-posinset')),
        panelOverflowY: getComputedStyle(panel).overflowY,
        scrollHeight: scrollHost.scrollHeight,
        scrollHostOverflowY: getComputedStyle(scrollHost).overflowY,
        tagsBottom: tags.getBoundingClientRect().bottom,
        tagsInsideScrollHost: scrollHost.contains(tags),
        tagsTop: tags.getBoundingClientRect().top,
      };
    });
    expect(geometry).toMatchObject({
      controlsAboveList: true,
      controlsChildCount: 1,
      colorsBelowList: true,
      colorsInsideScrollHost: false,
      footerIsLast: true,
      footerOrder: true,
      panelOverflowY: 'hidden',
      scrollHostOverflowY: 'auto',
      tagsInsideScrollHost: false,
    });
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.firstPosition).toBe(1);
    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize({ lte: 48 });

    const targetScrollTop = Math.min(
      geometry.scrollHeight - geometry.clientHeight,
      Math.max(geometry.clientHeight * 20, 10_000),
    );
    await browser.execute((scrollTop) => {
      const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
      scrollHost.scrollTop = scrollTop;
      scrollHost.dispatchEvent(new Event('scroll'));
    }, targetScrollTop);
    await browser.waitUntil(
      async () =>
        Number(await $('.abyss-annotation-card-row').getAttribute('aria-posinset')) >
        geometry.firstPosition,
      { timeout: 5_000, timeoutMsg: 'Annotation virtual window did not move after scrolling.' },
    );
    const scrolled = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      if (panel === null) throw new Error('Scrolled annotation panel is missing.');
      const controls = panel.querySelector<HTMLElement>('.abyss-annotation-controls');
      const scrollHost = panel.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      const tags = panel.querySelector<HTMLElement>('[data-section="tags"]');
      const rows = Array.from(
        scrollHost?.querySelectorAll<HTMLElement>('.abyss-annotation-card-row') ?? [],
      );
      if (controls === null || scrollHost === null || tags === null || rows.length === 0)
        throw new Error('Scrolled annotation panel structure is incomplete.');
      return {
        cardCount: rows.length,
        controlsBottom: controls.getBoundingClientRect().bottom,
        controlsTop: controls.getBoundingClientRect().top,
        firstPosition: Number(rows[0]?.getAttribute('aria-posinset')),
        firstRowId: rows[0]?.dataset['annotationCardId'] ?? '',
        lastPosition: Number(rows[rows.length - 1]?.getAttribute('aria-posinset')),
        scrollTop: scrollHost.scrollTop,
        tagsBottom: tags.getBoundingClientRect().bottom,
        tagsTop: tags.getBoundingClientRect().top,
      };
    });
    expect(scrolled.scrollTop).toBeGreaterThan(0);
    expect(scrolled.firstPosition).toBeGreaterThan(geometry.firstPosition);
    expect(scrolled.lastPosition).toBeGreaterThan(geometry.lastPosition);
    expect(scrolled.firstRowId).not.toBe(geometry.firstRowId);
    expect(scrolled.cardCount).toBeLessThanOrEqual(48);
    expect(Math.abs(scrolled.controlsTop - geometry.controlsTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(scrolled.controlsBottom - geometry.controlsBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(scrolled.tagsTop - geometry.tagsTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(scrolled.tagsBottom - geometry.tagsBottom)).toBeLessThanOrEqual(1);

    await $('[data-annotation-search]').setValue('not present in any annotation');
    await expect($('[data-annotations-status]')).toHaveText('No matching annotations');
    await expect($$('[data-annotation-search]')).toBeElementsArrayOfSize(1);
  });

  it('pins an independently scrolling Document tags footer without losing the list anchor', async () => {
    await openAnnotations('Documents/annotations-10000.pdf');
    await browser.waitUntil(
      async () => (await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) === '10000',
      { timeout: 15_000, timeoutMsg: 'Annotation panel did not load Document tags.' },
    );
    await browser.execute(() => {
      const sidebar = document.querySelector<HTMLElement>('.abyss-reader-sidebar');
      const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      if (sidebar === null || scrollHost === null) throw new Error('Sidebar geometry is missing.');
      sidebar.setCssProps({ '--abyss-reader-sidebar-width': '260px' });
      scrollHost.scrollTop = Math.min(scrollHost.scrollHeight - scrollHost.clientHeight, 10_000);
      scrollHost.dispatchEvent(new Event('scroll'));
    });
    await browser.waitUntil(
      async () => Number(await $('.abyss-annotation-card-row').getAttribute('aria-posinset')) > 1,
      { timeout: 5_000, timeoutMsg: 'Annotation list did not establish a virtual anchor.' },
    );
    await waitForAnnotationWindowToSettle();
    await browser.execute(() => {
      const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
      const viewport = scrollHost.getBoundingClientRect();
      const card = Array.from(
        document.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
      ).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
      });
      if (card === undefined) throw new Error('No visible annotation card is available to anchor.');
      card.focus({ preventScroll: true });
    });
    await waitForAnnotationWindowToSettle();
    const activeId = await browser.execute(() =>
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.dataset['annotationId'] ?? '')
        : '',
    );
    expect(activeId).not.toBe('');
    const before = await documentTagsAnchorGeometry(activeId);
    expect(before).toMatchObject({ collapsed: true, footerIsLast: true });
    expect(before.bottomGap).toBeLessThanOrEqual(2);
    expect(before.bodyDisplay).toBe('none');
    expect(before.bodyId).not.toBe('');
    expect(before.controlledId).toBe(before.bodyId);
    expect(Math.abs(before.footerHeight - before.summaryHeight)).toBeLessThanOrEqual(2);

    const toggle = $('[data-action="toggle-document-tags"]');
    await scrollAnnotationListBy(18);
    const pointerExpandStart = await documentTagsAnchorGeometry(activeId);
    expect(pointerExpandStart.scrollTop).toBeGreaterThan(before.scrollTop);
    await toggle.click();
    await expect($('[data-annotation-tag-search]')).toBeDisplayed();
    await waitForAnnotationWindowToSettle();
    const pointerExpandedAnchor = await documentTagsAnchorGeometry(activeId);
    expect(pointerExpandedAnchor.activeAction).toBe('toggle-document-tags');
    expect(pointerExpandedAnchor.collapsed).toBe(false);
    expect(pointerExpandedAnchor.firstPosition).toBe(pointerExpandStart.firstPosition);
    expect(
      Math.abs(pointerExpandedAnchor.cardTop - pointerExpandStart.cardTop),
    ).toBeLessThanOrEqual(1);

    const expanded = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      const footer = panel?.querySelector<HTMLElement>('[data-section="tags"]') ?? null;
      const tagScroll =
        footer?.querySelector<HTMLElement>('[data-annotation-tag-scroll-host]') ?? null;
      const chips = Array.from(
        footer?.querySelectorAll<HTMLElement>('[data-annotation-tag]') ?? [],
      );
      if (panel === null || footer === null || tagScroll === null)
        throw new Error('Expanded Document tags geometry is incomplete.');
      const panelRect = panel.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const summary = footer.querySelector<HTMLElement>('.abyss-annotation-tags-summary');
      return {
        bottomGap: Math.abs(panelRect.bottom - footerRect.bottom),
        chipRoles: chips.map((chip) => ({
          pressed: chip.getAttribute('aria-pressed'),
          tag: chip.tagName,
        })),
        footerHeight: footerRect.height,
        maxHeight: panelRect.height * 0.4,
        summaryHeight: summary?.getBoundingClientRect().height ?? Number.NaN,
        tagOverflowY: getComputedStyle(tagScroll).overflowY,
      };
    });
    expect(expanded.bottomGap).toBeLessThanOrEqual(2);
    expect(expanded.footerHeight).toBeGreaterThan(expanded.summaryHeight + 32);
    expect(expanded.footerHeight).toBeLessThanOrEqual(expanded.maxHeight + 1);
    expect(expanded.tagOverflowY).toBe('auto');
    expect(expanded.chipRoles).toHaveLength(26);
    expect(
      expanded.chipRoles.every(({ pressed, tag }) => pressed === 'false' && tag === 'BUTTON'),
    ).toBe(true);

    await scrollAnnotationListBy(18);
    const pointerCollapseStart = await documentTagsAnchorGeometry(activeId);
    expect(pointerCollapseStart.scrollTop).toBeGreaterThan(pointerExpandedAnchor.scrollTop);
    await toggle.click();
    await expect($('[data-annotation-tag-search]')).not.toBeDisplayed();
    await waitForAnnotationWindowToSettle();
    const pointerCollapsed = await documentTagsAnchorGeometry(activeId);
    expect(pointerCollapsed.activeAction).toBe('toggle-document-tags');
    expect(pointerCollapsed.collapsed).toBe(true);
    expect(pointerCollapsed.firstPosition).toBe(pointerCollapseStart.firstPosition);
    expect(Math.abs(pointerCollapsed.cardTop - pointerCollapseStart.cardTop)).toBeLessThanOrEqual(
      1,
    );

    await scrollAnnotationListBy(18);
    const enterExpandStart = await documentTagsAnchorGeometry(activeId);
    expect(enterExpandStart.scrollTop).toBeGreaterThan(pointerCollapsed.scrollTop);
    await browser.keys(Key.Enter);
    await expect($('[data-annotation-tag-search]')).toBeDisplayed();
    await waitForAnnotationWindowToSettle();
    const enterExpanded = await documentTagsAnchorGeometry(activeId);
    expect(enterExpanded.activeAction).toBe('toggle-document-tags');
    expect(enterExpanded.collapsed).toBe(false);
    expect(enterExpanded.firstPosition).toBe(enterExpandStart.firstPosition);
    expect(Math.abs(enterExpanded.cardTop - enterExpandStart.cardTop)).toBeLessThanOrEqual(1);

    await scrollAnnotationListBy(18);
    const spaceCollapseStart = await documentTagsAnchorGeometry(activeId);
    expect(spaceCollapseStart.scrollTop).toBeGreaterThan(enterExpanded.scrollTop);
    await browser.keys(' ');
    await expect($('[data-annotation-tag-search]')).not.toBeDisplayed();
    await waitForAnnotationWindowToSettle();
    const spaceCollapsed = await documentTagsAnchorGeometry(activeId);
    expect(spaceCollapsed.activeAction).toBe('toggle-document-tags');
    expect(spaceCollapsed.collapsed).toBe(true);
    expect(spaceCollapsed.firstPosition).toBe(spaceCollapseStart.firstPosition);
    expect(Math.abs(spaceCollapsed.cardTop - spaceCollapseStart.cardTop)).toBeLessThanOrEqual(1);

    await browser.keys(Key.Enter);
    await expect($('[data-annotation-tag-search]')).toBeDisplayed();
    await waitForAnnotationWindowToSettle();

    const annotationScrollTop = (await documentTagsAnchorGeometry(activeId)).scrollTop;
    await browser.execute(() => {
      const tagScroll = document.querySelector<HTMLElement>('[data-annotation-tag-scroll-host]');
      if (tagScroll === null) throw new Error('Document tag scroll host is missing.');
      tagScroll.scrollTop = tagScroll.scrollHeight;
    });
    const independentScroll = await browser.execute(() => ({
      annotations: document.querySelector<HTMLElement>('[data-annotation-scroll-host]')?.scrollTop,
      tags: document.querySelector<HTMLElement>('[data-annotation-tag-scroll-host]')?.scrollTop,
    }));
    expect(independentScroll.annotations).toBe(annotationScrollTop);
    expect(independentScroll.tags).toBeGreaterThan(0);

    await $('[data-annotation-tag-search]').setValue('topic-24');
    await expect($$('[data-annotation-tag-row]')).toBeElementsArrayOfSize(1);
    await expect($('[data-annotation-tag="topic-24"]')).toHaveText('#topic-24');
    await $('[data-annotation-tag="topic-24"]').click();
    await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '400');
  });

  it('renders semantic facets and structured contextual cards at narrow widths', async () => {
    await openAnnotations('Documents/annotations-10000.pdf');
    await browser.waitUntil(
      async () => (await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) === '10000',
      { timeout: 15_000, timeoutMsg: 'Annotation panel did not load semantic facets.' },
    );
    await browser.execute(() => {
      const sidebar = document.querySelector<HTMLElement>('.abyss-reader-sidebar');
      if (sidebar === null) throw new Error('Reader sidebar is missing.');
      const narrowWidth = '260px';
      sidebar.style.width = narrowWidth;
      sidebar.style.maxWidth = narrowWidth;
    });

    const initial = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      if (panel === null) throw new Error('Annotation panel is missing.');
      const card = panel.querySelector<HTMLElement>('.abyss-annotation-card');
      const row = panel.querySelector<HTMLElement>('.abyss-annotation-card-row');
      const actions = row?.querySelector<HTMLElement>('.abyss-annotation-card-actions') ?? null;
      const chips = Array.from(
        panel.querySelectorAll<HTMLButtonElement>('[data-annotation-color]'),
      );
      if (card === null || row === null || actions === null || chips.length < 12)
        throw new Error('Semantic annotation UI is incomplete.');
      return {
        actionOpacity: getComputedStyle(actions).opacity,
        cardRight: card.getBoundingClientRect().right,
        chipCount: chips.length,
        chipRoles: chips.map((chip) => ({
          pressed: chip.getAttribute('aria-pressed'),
          tag: chip.tagName,
        })),
        comment: card.querySelector('[data-annotation-comment]')?.textContent ?? '',
        link: card.querySelector('[data-annotation-link]')?.textContent ?? '',
        meaning: card.querySelector('[data-annotation-meaning]')?.textContent ?? '',
        paddingInlineEnd: Number.parseFloat(getComputedStyle(card).paddingInlineEnd),
        page: card.querySelector('[data-annotation-page]')?.textContent ?? '',
        panelRight: panel.getBoundingClientRect().right,
        quoteCount: card.querySelectorAll('[data-annotation-quote]').length,
        rawColorInCopy: /#[\da-f]{6}/iu.test(
          panel.querySelector('.abyss-annotation-colors')?.textContent ?? '',
        ),
        tag: card.querySelector('[data-annotation-card-tag]')?.textContent ?? '',
      };
    });
    expect(initial).toMatchObject({
      actionOpacity: '0',
      chipCount: 12,
      meaning: 'Yellow',
      page: 'Page 1',
      quoteCount: 0,
      rawColorInCopy: false,
    });
    expect(initial.chipRoles).toEqual(
      Array.from({ length: 12 }, () => ({ pressed: 'false', tag: 'BUTTON' })),
    );
    expect(initial.link).toContain('Long multilingual reference');
    expect(initial.tag).toContain('#قضية-重要事項');
    expect(initial.comment).toContain('Annotation 00000');
    expect(initial.cardRight).toBeLessThanOrEqual(initial.panelRight + 1);
    expect(initial.paddingInlineEnd).toBeLessThan(30);
    const containment = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      const footer = panel?.querySelector<HTMLElement>('[data-annotation-footer]') ?? null;
      const colors = footer?.querySelector<HTMLElement>('[data-section="colors"]') ?? null;
      const tags = footer?.querySelector<HTMLElement>('[data-section="tags"]') ?? null;
      const colorRows = colors?.querySelector<HTMLElement>('.abyss-annotation-color-rows') ?? null;
      const card = panel?.querySelector<HTMLElement>('.abyss-annotation-card') ?? null;
      const meaning = card?.querySelector<HTMLElement>('[data-annotation-meaning]') ?? null;
      const comment = card?.querySelector<HTMLElement>('[data-annotation-comment]') ?? null;
      const link = card?.querySelector<HTMLElement>('[data-annotation-link]') ?? null;
      const tag = card?.querySelector<HTMLElement>('[data-annotation-card-tag]') ?? null;
      const colorMeaning =
        colors?.querySelector<HTMLElement>('.abyss-annotation-color-chip-meaning') ?? null;
      if (
        panel === null ||
        footer === null ||
        colors === null ||
        tags === null ||
        colorRows === null ||
        card === null ||
        meaning === null ||
        comment === null ||
        link === null ||
        tag === null ||
        colorMeaning === null
      )
        throw new Error('Narrow annotation containment target is incomplete.');
      const panelRect = panel.getBoundingClientRect();
      const elementBounds = Object.fromEntries(
        Object.entries({ card, comment, link, meaning, tag }).map(([name, element]) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return [
            name,
            {
              display: style.display,
              flexBasis: style.flexBasis,
              flexShrink: style.flexShrink,
              left: rect.left,
              maxWidth: style.maxWidth,
              minWidth: style.minWidth,
              overflow: style.overflow,
              right: rect.right,
              width: rect.width,
              widthStyle: style.width,
            },
          ];
        }),
      );
      const bounded = Object.values(elementBounds).every(
        ({ right }) => right <= panelRect.right + 1,
      );
      return {
        bounded,
        colorOverflowX: getComputedStyle(colorRows).overflowX,
        colorScrollable: colorRows.scrollWidth > colorRows.clientWidth,
        footerOrder: footer.firstElementChild === colors && footer.lastElementChild === tags,
        elementBounds,
        panelBounds: { left: panelRect.left, right: panelRect.right, width: panelRect.width },
        panelHasHorizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
      };
    });
    if (!containment.bounded)
      throw new Error(`Narrow annotation content escaped: ${JSON.stringify(containment)}`);
    expect(containment).toEqual({
      bounded: true,
      colorOverflowX: 'auto',
      colorScrollable: true,
      elementBounds: containment.elementBounds,
      footerOrder: true,
      panelBounds: containment.panelBounds,
      panelHasHorizontalOverflow: false,
    });

    await $('[data-annotation-search]').setValue('Annotation 00001');
    await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '1');
    await $('.abyss-annotation-card').click();
    await expect($('[data-annotation-editor-popover]')).toBeDisplayed();
    await expect($('textarea[aria-label="Comment"]')).toHaveValue(
      expect.stringContaining('Annotation 00001'),
    );
    await browser.keys(Key.Escape);
    await $('[data-annotation-search]').click();
    await browser.keys([process.platform === 'darwin' ? Key.Command : Key.Control, 'a']);
    await browser.keys(Key.Backspace);
    await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '10000');

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.abyss-annotation-card')?.focus();
    });
    await browser.keys(Key.ArrowDown);
    const roving = await browser.execute(() => ({
      activePosition: document.activeElement
        ?.closest('.abyss-annotation-card-row')
        ?.getAttribute('aria-posinset'),
      tabStops: Array.from(
        document.querySelectorAll<HTMLButtonElement>('.abyss-annotation-card'),
      ).filter((card) => card.tabIndex === 0).length,
    }));
    expect(roving).toEqual({ activePosition: '2', tabStops: 1 });
    await browser.execute(() => {
      const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
      scrollHost.scrollTop = 600 * 112;
      scrollHost.dispatchEvent(new Event('scroll'));
    });
    await browser.waitUntil(
      async () => Number(await $('.abyss-annotation-card-row').getAttribute('aria-posinset')) > 500,
      { timeout: 5_000, timeoutMsg: 'Annotation virtual window did not advance.' },
    );
    const virtualRoving = await browser.execute(() => {
      const stops = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.abyss-annotation-card'),
      ).filter((card) => card.tabIndex === 0);
      return { mounted: stops[0]?.isConnected === true, tabStops: stops.length };
    });
    expect(virtualRoving).toEqual({ mounted: true, tabStops: 1 });
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.abyss-annotation-card[tabindex="0"]')?.focus();
    });
    await browser.keys(Key.Home);
    await waitForAnnotationWindowToSettle();
    await browser.execute(() => {
      const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
      const viewport = scrollHost.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.abyss-annotation-card'));
      const visible = cards.find((card) => {
        const rect = card.getBoundingClientRect();
        return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
      });
      if (visible === undefined)
        throw new Error('No visible annotation card for pointer geometry.');
      visible.dataset['annotationHoverProbe'] = '';
    });
    const restingGeometry = await annotationCardGeometry();

    await $('[data-annotation-hover-probe]').moveTo();
    expect(await annotationCardGeometry()).toEqual(restingGeometry);

    const contextResult = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('.abyss-annotation-card-row');
      if (row === null) throw new Error('Annotation row is missing.');
      const before = document.activeElement;
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return {
        actionFocused: document.activeElement?.hasAttribute('data-action') === true,
        focusPreserved: document.activeElement === before,
        rowId: row.dataset['annotationRowId'],
      };
    });
    expect(contextResult).toMatchObject({ actionFocused: false, focusPreserved: true });
    expect(await annotationCardGeometry()).toEqual(restingGeometry);
    expect(
      await browser.execute(() => {
        const actions = document.querySelector('.abyss-annotation-card-actions');
        if (actions === null) throw new Error('Annotation actions are missing.');
        return getComputedStyle(actions).opacity;
      }),
    ).toBe('1');

    await browser.execute(() => {
      const insert = document.querySelector<HTMLElement>('[data-action="insert-annotation"]');
      if (insert === null) throw new Error('Insert action is missing.');
      insert.focus();
      window.dispatchEvent(new Event('resize'));
    });
    const resizeFocus = await browser.execute(() => ({
      activeAction:
        document.activeElement?.closest<HTMLElement>('[data-action]')?.dataset['action'],
      activeRow: document.activeElement?.closest<HTMLElement>('[data-annotation-row-id]')?.dataset[
        'annotationRowId'
      ],
      activeTag: document.activeElement?.tagName,
    }));
    expect(resizeFocus.activeAction).toBe('insert-annotation');
    expect(resizeFocus.activeRow).toBe(contextResult.rowId);
    expect(resizeFocus.activeTag).toBe('BUTTON');
    const resizedGeometry = await annotationCardGeometry();
    expect(resizedGeometry).toMatchObject({
      cardHeight: restingGeometry.cardHeight,
      cardWidth: restingGeometry.cardWidth,
      commentHeight: restingGeometry.commentHeight,
      commentWidth: restingGeometry.commentWidth,
      headerHeight: restingGeometry.headerHeight,
      rowHeight: restingGeometry.rowHeight,
      rowWidth: restingGeometry.rowWidth,
    });
    expect(
      await browser.execute(
        () => document.activeElement?.closest<HTMLElement>('[data-action]')?.dataset['action'],
      ),
    ).toBe('insert-annotation');
    await browser.keys(Key.Escape);
    expect(
      await browser.execute(() => document.activeElement?.matches('.abyss-annotation-card')),
    ).toBe(true);
    expect(
      await browser.execute(() => {
        const actions = document.querySelector('.abyss-annotation-card-actions');
        if (actions === null) throw new Error('Annotation actions are missing after Escape.');
        return getComputedStyle(actions).opacity;
      }),
    ).toBe('0');
    expect(await annotationCardGeometry()).toEqual(resizedGeometry);
    await movePointerTo(1, 1);
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-annotation-search]')?.focus();
    });
    await setCoarseAnnotationGeometry(true);
    await waitForAnnotationWindowToSettle();
    const coarseFooter = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      const colors = panel?.querySelector<HTMLElement>('[data-section="colors"]') ?? null;
      const rows = colors?.querySelector<HTMLElement>('.abyss-annotation-color-rows') ?? null;
      const chips = Array.from(
        colors?.querySelectorAll<HTMLElement>('.abyss-annotation-color-chip') ?? [],
      );
      if (panel === null || colors === null || rows === null || chips.length < 12)
        throw new Error('Coarse annotation footer is incomplete.');
      return {
        chipHeights: chips.map((chip) => chip.getBoundingClientRect().height),
        colorsHeight: colors.getBoundingClientRect().height,
        horizontalOverflow: rows.scrollWidth > rows.clientWidth,
        panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
      };
    });
    expect(coarseFooter.chipHeights.every((height) => height >= 44)).toBe(true);
    expect(coarseFooter.colorsHeight).toBeGreaterThanOrEqual(44);
    expect(coarseFooter.horizontalOverflow).toBe(true);
    expect(coarseFooter.panelOverflow).toBe(false);
    const coarseRestingGeometry = await annotationCardGeometry();
    expect(coarseRestingGeometry.headerHeight).toBe(44);
    await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('.abyss-annotation-card-row');
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(await annotationCardGeometry()).toEqual(coarseRestingGeometry);
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-action="insert-annotation"]')?.focus();
    });
    const coarseFocusedGeometry = await annotationCardGeometry();
    expect(coarseFocusedGeometry).toEqual({
      ...coarseRestingGeometry,
      scrollTop: coarseFocusedGeometry.scrollTop,
    });
    await browser.keys(Key.Escape);
    const coarseEscapedGeometry = await annotationCardGeometry();
    expect(coarseEscapedGeometry).toEqual({
      ...coarseRestingGeometry,
      scrollTop: coarseEscapedGeometry.scrollTop,
    });
    await setCoarseAnnotationGeometry(false);

    const firstColor = $('[data-sidebar-panel="annotations"] [data-annotation-color]');
    await firstColor.moveTo();
    await browser.pause(350);
    await expect($('.tooltip')).toBeDisplayed();
    await movePointerTo(1, 1);
    await browser.waitUntil(async () => !(await $('.tooltip').isDisplayed()), {
      timeout: 2_000,
      timeoutMsg: 'Color meaning tooltip did not close after pointer exit.',
    });

    await browser.execute(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-page-number="1"] canvas');
      if (canvas === null) throw new Error('Initial page canvas is missing.');
      const state = {
        badFrame: false,
        canvas,
        consecutivePopulatedFrames: 0,
        frame: 0,
        maxConsecutivePopulatedFrames: 0,
        stopped: false,
      };
      const host = window as Window & { __abyssTask9Continuity?: typeof state };
      host.__abyssTask9Continuity = state;
      const sample = (): void => {
        if (state.stopped) return;
        const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
        const status = panel?.querySelector<HTMLElement>('[data-annotations-status]') ?? null;
        const populated =
          panel?.dataset['annotationState'] === 'content' &&
          panel.querySelectorAll('.abyss-annotation-card').length > 0 &&
          status?.hidden === true;
        state.badFrame ||= !populated;
        state.consecutivePopulatedFrames = populated ? state.consecutivePopulatedFrames + 1 : 0;
        state.maxConsecutivePopulatedFrames = Math.max(
          state.maxConsecutivePopulatedFrames,
          state.consecutivePopulatedFrames,
        );
        state.frame = requestAnimationFrame(sample);
      };
      state.frame = requestAnimationFrame(sample);
    });
    try {
      await $('[data-sidebar-panel="annotations"] [data-annotation-color]').click();
      await browser.waitUntil(
        async () =>
          Number(await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) < 1000,
        { timeout: 5_000, timeoutMsg: 'Semantic color facet did not filter the data model.' },
      );
      const filteredColors = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-sidebar-panel="annotations"] [data-annotation-color]',
          ),
        ).map((element) => element.dataset['annotationColor'] ?? ''),
      );
      expect(filteredColors).toHaveLength(12);
      expect(filteredColors).not.toContain('');
      await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize({ lte: 48 });
      await $(
        '[data-sidebar-panel="annotations"] [data-annotation-color][aria-pressed="true"]',
      ).click();

      await $('[data-action="toggle-document-tags"]').click();
      await $('[data-annotation-tag="topic-1"]').click();
      await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '400');

      await $('[data-annotation-search]').setValue('Annotation 07501');
      await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '1');
      await expect($('[data-annotation-page]')).toHaveText('Page 76');
      await expect($('[data-control="page-field"]')).toHaveValue('1');
      await browser.waitUntil(
        async () =>
          browser
            .execute(
              () =>
                (
                  window as Window & {
                    __abyssTask9Continuity?: { readonly maxConsecutivePopulatedFrames: number };
                  }
                ).__abyssTask9Continuity?.maxConsecutivePopulatedFrames ?? 0,
            )
            .then((frames) => frames >= 5),
        { timeout: 2_000, timeoutMsg: 'Annotation panel did not sustain five populated frames.' },
      );
      const continuity = await browser.execute(() => {
        const state = (
          window as Window & {
            __abyssTask9Continuity?: {
              badFrame: boolean;
              readonly canvas: HTMLCanvasElement;
              readonly maxConsecutivePopulatedFrames: number;
            };
          }
        ).__abyssTask9Continuity;
        const currentCanvas = document.querySelector<HTMLCanvasElement>(
          '[data-page-number="1"] canvas',
        );
        if (state === undefined || currentCanvas === null)
          throw new Error('Annotation continuity probe is incomplete.');
        return {
          badFrame: state.badFrame,
          maxConsecutivePopulatedFrames: state.maxConsecutivePopulatedFrames,
          sameCanvas: state.canvas === currentCanvas,
        };
      });
      expect(continuity.badFrame).toBe(false);
      expect(continuity.maxConsecutivePopulatedFrames).toBeGreaterThanOrEqual(5);
      expect(continuity.sameCanvas).toBe(true);
    } finally {
      await browser.execute(() => {
        const host = window as Window & {
          __abyssTask9Continuity?: { frame: number; stopped: boolean };
        };
        const state = host.__abyssTask9Continuity;
        if (state !== undefined) {
          state.stopped = true;
          cancelAnimationFrame(state.frame);
        }
        delete host.__abyssTask9Continuity;
      });
    }
    const actionTouch = await browser.execute(() => {
      const card = document.querySelector<HTMLButtonElement>('.abyss-annotation-card');
      const insert = document.querySelector<HTMLButtonElement>('[data-action="insert-annotation"]');
      if (card === null || insert === null) throw new Error('Hybrid action target is missing.');
      insert.focus({ preventScroll: true });
      insert.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }),
      );
      insert.click();
      card.click();
      return card.closest('.abyss-annotation-card-row')?.hasAttribute('data-actions-open');
    });
    expect(actionTouch).toBe(false);
    await browser.waitUntil(
      async () => Number(await $('[data-control="page-field"]').getValue()) > 1,
      { timeout: 5_000, timeoutMsg: 'Touching an action swallowed the next card activation.' },
    );
    await $('[data-control="page-field"]').click();
    await browser.keys([process.platform === 'darwin' ? Key.Command : Key.Control, 'a']);
    await browser.keys('1');
    await browser.keys(Key.Enter);
    await expect($('[data-control="page-field"]')).toHaveValue('1');
    const firstTouch = await browser.execute(() => {
      const card = document.querySelector<HTMLButtonElement>('.abyss-annotation-card');
      if (card === null) throw new Error('Touch annotation card is missing.');
      card.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }),
      );
      const clickAccepted = card.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      return {
        actionsOpen: card.closest('.abyss-annotation-card-row')?.hasAttribute('data-actions-open'),
        clickAccepted,
      };
    });
    expect(firstTouch).toEqual({ actionsOpen: true, clickAccepted: false });
    await expect($('[data-control="page-field"]')).toHaveValue('1');
    await browser.execute(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await expect($('.abyss-annotation-card-row')).toHaveAttribute('data-actions-open');

    await browser.execute(() => {
      const card = document.querySelector<HTMLButtonElement>('.abyss-annotation-card');
      if (card === null) throw new Error('Second touch annotation card is missing.');
      card.click();
    });
    await browser.waitUntil(
      async () => Number(await $('[data-control="page-field"]').getValue()) > 1,
      { timeout: 5_000, timeoutMsg: 'Second explicit card intent did not navigate.' },
    );
  });
});
