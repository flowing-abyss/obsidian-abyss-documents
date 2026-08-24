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
    });
    window.dispatchEvent(new Event('resize'));
  }, enabled);
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
      const rows = Array.from(
        scrollHost.querySelectorAll<HTMLElement>('.abyss-annotation-card-row'),
      );
      return {
        clientHeight: scrollHost.clientHeight,
        controlsAboveList:
          controls.getBoundingClientRect().bottom <= scrollHost.getBoundingClientRect().top + 1,
        controlsBottom: controls.getBoundingClientRect().bottom,
        controlsTop: controls.getBoundingClientRect().top,
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
      if (card === null || row === null || actions === null || chips.length !== 2)
        throw new Error('Semantic annotation UI is incomplete.');
      return {
        actionOpacity: getComputedStyle(actions).opacity,
        cardRight: card.getBoundingClientRect().right,
        chipLabels: chips.map((chip) => chip.textContent),
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
      chipLabels: ['Blue5000', 'Yellow5000'],
      chipRoles: [
        { pressed: 'false', tag: 'BUTTON' },
        { pressed: 'false', tag: 'BUTTON' },
      ],
      link: 'Topic 0',
      meaning: 'Yellow',
      page: 'Page 1',
      quoteCount: 0,
      rawColorInCopy: false,
      tag: '#topic-0',
    });
    expect(initial.comment).toContain('Annotation 00000');
    expect(initial.cardRight).toBeLessThanOrEqual(initial.panelRight + 1);
    expect(initial.paddingInlineEnd).toBeLessThan(30);
    const restingGeometry = await annotationCardGeometry();

    const cardCenter = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.abyss-annotation-card');
      if (card === null) throw new Error('Annotation card is missing for pointer geometry.');
      const rect = card.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    });
    await movePointerTo(cardCenter.x, cardCenter.y);
    expect(await annotationCardGeometry()).toEqual(restingGeometry);

    const contextResult = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('.abyss-annotation-card-row');
      if (row === null) throw new Error('Annotation row is missing.');
      const before = document.activeElement;
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return {
        actionFocused: document.activeElement?.hasAttribute('data-action') === true,
        focusPreserved: document.activeElement === before,
      };
    });
    expect(contextResult).toEqual({ actionFocused: false, focusPreserved: true });
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
    await expect($('[data-action="insert-annotation"]')).toBeFocused();
    expect(await annotationCardGeometry()).toEqual(restingGeometry);
    await browser.keys(Key.Escape);
    await expect($('.abyss-annotation-card')).toBeFocused();
    expect(
      await browser.execute(() => {
        const actions = document.querySelector('.abyss-annotation-card-actions');
        if (actions === null) throw new Error('Annotation actions are missing after Escape.');
        return getComputedStyle(actions).opacity;
      }),
    ).toBe('0');
    expect(await annotationCardGeometry()).toEqual(restingGeometry);
    await movePointerTo(1, 1);
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-annotation-search]')?.focus();
    });
    await setCoarseAnnotationGeometry(true);
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

    await $('[data-annotation-color]').click();
    await browser.waitUntil(
      async () => (await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) === '5000',
      { timeout: 5_000, timeoutMsg: 'Semantic color facet did not filter the data model.' },
    );
    await expect($$('[data-annotation-color]')).toBeElementsArrayOfSize(2);
    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize({ lte: 48 });

    await $('[data-annotation-search]').setValue('Annotation 07501');
    await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '1');
    await expect($('[data-annotation-page]')).toHaveText('Page 76');
    await expect($('[data-control="page-field"]')).toHaveValue('1');
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
    await $('[data-control="page-field"]').setValue('1');
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
