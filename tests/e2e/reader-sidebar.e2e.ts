import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';

async function closeReaderLeaves(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const host = window as Window & {
      __abyssTask6SidebarMonitor?: { cleanup(): unknown };
    };
    host.__abyssTask6SidebarMonitor?.cleanup();
    delete host.__abyssTask6SidebarMonitor;
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

type AnnotationContentName = 'header' | 'quote' | 'comment';

interface AnnotationContentMetric {
  readonly left: number;
  readonly right: number;
  readonly textAlign: string;
  readonly width: number;
}

interface AnnotationContentGeometry {
  readonly alignItems: string;
  readonly content: Readonly<Record<AnnotationContentName, AnnotationContentMetric | null>>;
  readonly innerLeft: number;
  readonly innerRight: number;
  readonly justifyContent: string;
  readonly usableWidth: number;
}

async function annotationContentGeometry(): Promise<AnnotationContentGeometry> {
  return browser.execute(() => {
    const card = document.querySelector<HTMLElement>('.abyss-annotation-card');
    if (card === null) throw new Error('Annotation card is missing.');
    const cardRect = card.getBoundingClientRect();
    const cardStyle = getComputedStyle(card);
    const innerLeft = cardRect.left + Number.parseFloat(cardStyle.paddingLeft);
    const innerRight = cardRect.right - Number.parseFloat(cardStyle.paddingRight);
    const selectors = {
      comment: '[data-annotation-comment]',
      header: '[data-annotation-header]',
      quote: '[data-annotation-quote]',
    } as const;
    const content = Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => {
        const element = card.querySelector<HTMLElement>(selector);
        if (element === null) return [name, null];
        const rect = element.getBoundingClientRect();
        return [
          name,
          {
            left: rect.left,
            right: rect.right,
            textAlign: getComputedStyle(element).textAlign,
            width: rect.width,
          },
        ];
      }),
    ) as Record<AnnotationContentName, AnnotationContentMetric | null>;
    return {
      alignItems: cardStyle.alignItems,
      content,
      innerLeft,
      innerRight,
      justifyContent: cardStyle.justifyContent,
      usableWidth: innerRight - innerLeft,
    };
  });
}

function expectAnnotationContentAligned(
  geometry: AnnotationContentGeometry,
  expected: readonly AnnotationContentName[],
): void {
  expect(geometry.alignItems).toBe('stretch');
  expect(geometry.justifyContent).toBe('flex-start');
  for (const name of ['header', 'quote', 'comment'] as const) {
    const metric = geometry.content[name];
    if (!expected.includes(name)) {
      expect(metric).toBeNull();
      continue;
    }
    if (metric === null) throw new Error(`Expected ${name} annotation content.`);
    expect(Math.abs(metric.left - geometry.innerLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric.right - geometry.innerRight)).toBeLessThanOrEqual(1);
    expect(metric.width).toBeGreaterThanOrEqual(geometry.usableWidth - 1);
    expect(metric.textAlign).toBe('start');
  }
}

async function setCoarseAnnotationGeometry(enabled: boolean): Promise<void> {
  await browser.execute((coarse) => {
    const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
    if (panel === null) throw new Error('Annotation panel is missing for coarse geometry.');
    panel.setCssProps({
      '--abyss-annotation-action-height': coarse ? '44px' : '',
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

async function scrollAnnotationListByViewport(): Promise<void> {
  await browser.execute(() => {
    const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
    if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
    scrollHost.scrollTop += scrollHost.clientHeight;
    scrollHost.dispatchEvent(new Event('scroll'));
  });
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

async function installSidebarContinuityMonitor(): Promise<void> {
  await browser.execute(() => {
    const reader = document.querySelector<HTMLElement>('.abyss-documents');
    const viewer = reader?.querySelector<HTMLElement>('.pdfViewerContainer') ?? null;
    const page = viewer?.querySelector<HTMLElement>('[data-page-number="1"]') ?? null;
    const canvas = page?.querySelector<HTMLCanvasElement>('canvas') ?? null;
    const sidebar = reader?.querySelector<HTMLElement>('.abyss-reader-sidebar') ?? null;
    if (reader === null || viewer === null || page === null || canvas === null || sidebar === null)
      throw new Error('Sidebar continuity targets are incomplete.');
    const state = {
      disconnects: 0,
      emptySurfaceSamples: 0,
      identityBreaks: 0,
      mutationRecords: 0,
    };
    const tracked = [reader, viewer, page, canvas, sidebar];
    const removedTarget = (node: Node, target: Node): boolean =>
      node === target || (node.instanceOf(Element) && node.contains(target));
    const sample = (): void => {
      if (
        document.querySelector('.abyss-documents') !== reader ||
        reader.querySelector('.pdfViewerContainer') !== viewer ||
        viewer.querySelector('[data-page-number="1"]') !== page ||
        page.querySelector('canvas') !== canvas ||
        reader.querySelector('.abyss-reader-sidebar') !== sidebar
      )
        state.identityBreaks += 1;
      const bounds = canvas.getBoundingClientRect();
      if (
        !canvas.isConnected ||
        canvas.width <= 0 ||
        canvas.height <= 0 ||
        bounds.width <= 0 ||
        bounds.height <= 0
      )
        state.emptySurfaceSamples += 1;
    };
    const processRecords = (records: readonly MutationRecord[]): void => {
      state.mutationRecords += records.length;
      for (const record of records) {
        for (const removed of Array.from(record.removedNodes)) {
          if (tracked.some((target) => removedTarget(removed, target))) state.disconnects += 1;
        }
      }
      sample();
    };
    const observer = new MutationObserver(processRecords);
    observer.observe(reader.closest('.workspace-leaf') ?? reader, {
      attributeFilter: ['class', 'hidden', 'style'],
      attributeOldValue: true,
      attributes: true,
      childList: true,
      subtree: true,
    });
    (
      window as Window & {
        __abyssTask6SidebarMonitor?: { cleanup(): Record<string, number> };
      }
    ).__abyssTask6SidebarMonitor = {
      cleanup() {
        processRecords(observer.takeRecords());
        observer.disconnect();
        return { ...state };
      },
    };
  });
}

async function assertSidebarContinuityMonitor(): Promise<void> {
  await browser.pause(50);
  const metrics = await browser.execute(() => {
    const host = window as Window & {
      __abyssTask6SidebarMonitor?: { cleanup(): Record<string, number> };
    };
    const monitor = host.__abyssTask6SidebarMonitor;
    if (monitor === undefined) throw new Error('Sidebar continuity monitor is unavailable.');
    const result = monitor.cleanup();
    delete host.__abyssTask6SidebarMonitor;
    return result;
  });
  expect(metrics['mutationRecords']).toBeGreaterThan(0);
  expect(metrics).toMatchObject({
    disconnects: 0,
    emptySurfaceSamples: 0,
    identityBreaks: 0,
  });
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
      const parentRow = document.querySelector<HTMLElement>(
        '[data-outline-id="outline-0"] > [data-outline-row]',
      );
      const childRow = document.querySelector<HTMLElement>(
        '[data-outline-id="outline-0-0"] > [data-outline-row]',
      );
      if (panel === null || tree === null || rows.length === 0)
        throw new Error('Outline geometry is unavailable.');
      const panelRect = panel.getBoundingClientRect();
      return {
        hasChevron: rows[0]?.querySelector('[data-outline-chevron] svg') !== null,
        hasNativeClasses: rows.every(
          (row) =>
            row.classList.contains('nav-folder-title') || row.classList.contains('nav-file-title'),
        ),
        indent:
          parentRow === null || childRow === null
            ? Number.NaN
            : childRow.getBoundingClientRect().left - parentRow.getBoundingClientRect().left,
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
    expect(geometry.hasNativeClasses).toBe(true);
    expect(geometry.minRowLeft).toBeGreaterThanOrEqual(geometry.panelLeft);
    expect(geometry.maxRowRight).toBeLessThanOrEqual(geometry.panelRight + 1);
    expect(geometry.scrollOverflow).toBeLessThanOrEqual(1);
    expect(geometry.indent).toBeGreaterThanOrEqual(12);
    expect(geometry.indent).toBeLessThanOrEqual(14);
    expect(Math.min(...geometry.rowHeights)).toBeGreaterThanOrEqual(26);
    expect(Math.max(...geometry.rowHeights)).toBeLessThanOrEqual(28);
    expect(Math.min(...geometry.chevronHeights)).toBeGreaterThanOrEqual(16);
    expect(Math.max(...geometry.chevronHeights)).toBeLessThanOrEqual(18);
    expect(Math.min(...geometry.chevronWidths)).toBeGreaterThanOrEqual(16);
    expect(Math.max(...geometry.chevronWidths)).toBeLessThanOrEqual(18);
    expect(Math.min(...geometry.iconHeights)).toBeGreaterThanOrEqual(14);
    expect(Math.max(...geometry.iconHeights)).toBeLessThanOrEqual(16);
    expect(Math.min(...geometry.iconWidths)).toBeGreaterThanOrEqual(14);
    expect(Math.max(...geometry.iconWidths)).toBeLessThanOrEqual(16);
  });

  it('overlays the sidebar from narrow reader width without squeezing the document', async () => {
    await openOutline();
    await $('[data-action="close-sidebar"]').click();
    const auxiliaryLeafIds: string[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        auxiliaryLeafIds.push(
          await browser.executeObsidian(({ app }) => {
            const readerLeaf = app.workspace.getMostRecentLeaf();
            if (readerLeaf === null) throw new Error('Reader leaf is missing.');
            const auxiliary = app.workspace.createLeafBySplit(readerLeaf, 'vertical');
            app.workspace.setActiveLeaf(readerLeaf, { focus: true });
            return (auxiliary as unknown as { id: string }).id;
          }),
        );
      }
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => document.querySelector('.abyss-documents')?.getBoundingClientRect().width ?? 0,
          )) <= 600,
        { timeout: 3_000, timeoutMsg: 'Reader container did not become narrow.' },
      );
      const closedDocumentWidth = await browser.execute(
        () =>
          document.querySelector('[data-region="document"]')?.getBoundingClientRect().width ?? 0,
      );

      await installSidebarContinuityMonitor();
      await $('[data-control="sidebar"]').click();

      const geometry = await browser.execute(() => {
        const reader = document.querySelector<HTMLElement>('.abyss-documents');
        const body = document.querySelector<HTMLElement>('.abyss-reader-body');
        const sidebar = document.querySelector<HTMLElement>('.abyss-reader-sidebar');
        const documentHost = document.querySelector<HTMLElement>('[data-region="document"]');
        if (reader === null || body === null || sidebar === null || documentHost === null)
          throw new Error('Narrow-reader overlay geometry is incomplete.');
        const bodyRect = body.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        return {
          bodyLeft: bodyRect.left,
          documentWidth: documentHost.getBoundingClientRect().width,
          readerWidth: reader.getBoundingClientRect().width,
          sidebarLeft: sidebarRect.left,
          sidebarPosition: getComputedStyle(sidebar).position,
          sidebarWidth: sidebarRect.width,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.viewportWidth).toBeGreaterThan(600);
      expect(geometry.readerWidth).toBeLessThanOrEqual(600);
      expect(geometry.sidebarPosition).toBe('absolute');
      expect(Math.abs(geometry.sidebarLeft - geometry.bodyLeft)).toBeLessThanOrEqual(1);
      expect(geometry.sidebarWidth).toBeLessThanOrEqual(geometry.readerWidth * 0.9 + 1);
      expect(Math.abs(geometry.documentWidth - closedDocumentWidth)).toBeLessThanOrEqual(1);
      await assertSidebarContinuityMonitor();
    } finally {
      await browser.executeObsidian(({ app }, leafIds) => {
        const leavesToDetach: Array<{ detach(): void }> = [];
        app.workspace.iterateAllLeaves((leaf) => {
          if (leafIds.includes((leaf as unknown as { id: string }).id)) leavesToDetach.push(leaf);
        });
        for (const leaf of leavesToDetach) leaf.detach();
      }, auxiliaryLeafIds);
    }
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

  it('keeps Unicode comment content in one compact card without tag or link chrome', async () => {
    await openAnnotations('Documents/unicode-annotations.pdf');
    await $('.abyss-annotation-card').waitForExist({ timeout: 10_000 });

    const card = $('.abyss-annotation-card');
    await expect(card.$('[data-annotation-page]')).toHaveText('Page 1');
    await expect(card.$('[data-annotation-comment]')).toHaveText(
      'Unicode annotation #résumé [[Café note]]',
    );
    await expect(card.$('[data-annotation-link]')).not.toExist();
    await expect(card.$('[data-annotation-card-tag]')).not.toExist();
    await expect($('[data-section="tags"]')).not.toExist();
    expect(/unsupported|custom color/iu.test(await card.getText())).toBe(false);

    const geometry = await browser.execute(() => {
      const cardElement = document.querySelector<HTMLElement>('.abyss-annotation-card');
      const header = cardElement?.querySelector<HTMLElement>('[data-annotation-header]') ?? null;
      const footer = document.querySelector<HTMLElement>('[data-annotation-footer]');
      const colors = footer?.querySelector<HTMLElement>('[data-section="colors"]') ?? null;
      if (cardElement === null || header === null || footer === null || colors === null)
        throw new Error('Unicode annotation geometry is incomplete.');
      return {
        cardHeight: cardElement.getBoundingClientRect().height,
        footerOnlyColors: footer.childElementCount === 1 && footer.firstElementChild === colors,
        headerHeight: header.getBoundingClientRect().height,
      };
    });
    expect(geometry.footerOnlyColors).toBe(true);
    expect(geometry.headerHeight).toBeLessThanOrEqual(34);
    expect(geometry.cardHeight).toBeLessThanOrEqual(128);
    expectAnnotationContentAligned(await annotationContentGeometry(), [
      'header',
      'quote',
      'comment',
    ]);
    await browser.execute(() => {
      document.querySelector('[data-annotation-comment]')?.remove();
    });
    expectAnnotationContentAligned(await annotationContentGeometry(), ['header', 'quote']);
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
      if (controls === null || scrollHost === null || footer === null || colors === null)
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
        colorsBottom: colors.getBoundingClientRect().bottom,
        colorsInsideScrollHost: scrollHost.contains(colors),
        footerIsLast: panel.lastElementChild === footer,
        footerOnlyColors:
          footer.childElementCount === 1 &&
          footer.firstElementChild === colors &&
          footer.lastElementChild === colors,
        firstPosition: Number(rows[0]?.getAttribute('aria-posinset')),
        firstRowId: rows[0]?.dataset['annotationCardId'] ?? '',
        lastPosition: Number(rows[rows.length - 1]?.getAttribute('aria-posinset')),
        panelOverflowY: getComputedStyle(panel).overflowY,
        scrollHeight: scrollHost.scrollHeight,
        scrollHostOverflowY: getComputedStyle(scrollHost).overflowY,
        tagsAbsent: tags === null,
      };
    });
    expect(geometry).toMatchObject({
      controlsAboveList: true,
      controlsChildCount: 1,
      colorsBelowList: true,
      colorsInsideScrollHost: false,
      footerIsLast: true,
      footerOnlyColors: true,
      panelOverflowY: 'hidden',
      scrollHostOverflowY: 'auto',
      tagsAbsent: true,
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
      const colors = panel.querySelector<HTMLElement>('[data-section="colors"]');
      const rows = Array.from(
        scrollHost?.querySelectorAll<HTMLElement>('.abyss-annotation-card-row') ?? [],
      );
      if (controls === null || scrollHost === null || colors === null || rows.length === 0)
        throw new Error('Scrolled annotation panel structure is incomplete.');
      return {
        cardCount: rows.length,
        controlsBottom: controls.getBoundingClientRect().bottom,
        controlsTop: controls.getBoundingClientRect().top,
        firstPosition: Number(rows[0]?.getAttribute('aria-posinset')),
        firstRowId: rows[0]?.dataset['annotationCardId'] ?? '',
        lastPosition: Number(rows[rows.length - 1]?.getAttribute('aria-posinset')),
        scrollTop: scrollHost.scrollTop,
        colorsBottom: colors.getBoundingClientRect().bottom,
      };
    });
    expect(scrolled.scrollTop).toBeGreaterThan(0);
    expect(scrolled.firstPosition).toBeGreaterThan(geometry.firstPosition);
    expect(scrolled.lastPosition).toBeGreaterThan(geometry.lastPosition);
    expect(scrolled.firstRowId).not.toBe(geometry.firstRowId);
    expect(scrolled.cardCount).toBeLessThanOrEqual(48);
    expect(Math.abs(scrolled.controlsTop - geometry.controlsTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(scrolled.controlsBottom - geometry.controlsBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(scrolled.colorsBottom - geometry.colorsBottom)).toBeLessThanOrEqual(1);

    await $('[data-annotation-search]').setValue('not present in any annotation');
    await expect($('[data-annotations-status]')).toHaveText('No matching annotations');
    await expect($$('[data-annotation-search]')).toBeElementsArrayOfSize(1);
  });

  it('pins only compact color filters below the independently scrolling annotation list', async () => {
    await openAnnotations('Documents/annotations-10000.pdf');
    await browser.waitUntil(
      async () => (await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) === '10000',
      { timeout: 15_000, timeoutMsg: 'Annotation panel did not load color filters.' },
    );

    const before = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      const scrollHost = panel?.querySelector<HTMLElement>('[data-annotation-scroll-host]') ?? null;
      const footer = panel?.querySelector<HTMLElement>('[data-annotation-footer]') ?? null;
      const colors = footer?.querySelector<HTMLElement>('[data-section="colors"]') ?? null;
      const tags = footer?.querySelector<HTMLElement>('[data-section="tags"]') ?? null;
      if (panel === null || scrollHost === null || footer === null || colors === null)
        throw new Error('Color footer geometry is incomplete.');
      return {
        bottomGap: Math.abs(
          panel.getBoundingClientRect().bottom - colors.getBoundingClientRect().bottom,
        ),
        colorsInsideScrollHost: scrollHost.contains(colors),
        footerHeight: colors.getBoundingClientRect().height,
        footerBottom: colors.getBoundingClientRect().bottom,
        footerOnlyColors: footer.childElementCount === 1 && footer.firstElementChild === colors,
        tagsAbsent: tags === null,
      };
    });
    expect(before).toMatchObject({
      colorsInsideScrollHost: false,
      footerOnlyColors: true,
      tagsAbsent: true,
    });
    expect(before.bottomGap).toBeLessThanOrEqual(2);
    expect(before.footerHeight).toBeLessThanOrEqual(36);

    await scrollAnnotationListByViewport();
    const after = await browser.execute(() => ({
      footerBottom: document
        .querySelector<HTMLElement>('[data-section="colors"]')
        ?.getBoundingClientRect().bottom,
      firstPosition: Number(
        document
          .querySelector<HTMLElement>('.abyss-annotation-card-row')
          ?.getAttribute('aria-posinset'),
      ),
    }));
    expect(after.firstPosition).toBeGreaterThan(1);
    expect(after.footerBottom).toBeGreaterThan(0);
    expect(Math.abs((after.footerBottom ?? 0) - before.footerBottom)).toBeLessThanOrEqual(2);
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
        hasLinkRegion: card.querySelector('[data-annotation-link]') !== null,
        hasTagRegion: card.querySelector('[data-annotation-card-tag]') !== null,
        header: card.querySelector('[data-annotation-header]')?.textContent ?? '',
        meaning: card.querySelector('[data-annotation-meaning]')?.textContent ?? '',
        paddingInlineEnd: Number.parseFloat(getComputedStyle(card).paddingInlineEnd),
        page: card.querySelector('[data-annotation-page]')?.textContent ?? '',
        panelRight: panel.getBoundingClientRect().right,
        quoteCount: card.querySelectorAll('[data-annotation-quote]').length,
        rawColorInCopy: /#[\da-f]{6}/iu.test(
          panel.querySelector('.abyss-annotation-colors')?.textContent ?? '',
        ),
        forbiddenCopy: /unsupported|custom color/iu.test(panel.textContent),
      };
    });
    expect(initial).toMatchObject({
      actionOpacity: '0',
      chipCount: 12,
      forbiddenCopy: false,
      hasLinkRegion: false,
      hasTagRegion: false,
      meaning: 'Highlight',
      page: 'Page 1',
      quoteCount: 0,
      rawColorInCopy: false,
    });
    expect(initial.chipRoles).toEqual(
      Array.from({ length: 12 }, () => ({ pressed: 'false', tag: 'BUTTON' })),
    );
    expect(initial.header).toContain('Page 1 · Highlight');
    expect(initial.comment).toContain('Annotation 00000');
    expect(initial.cardRight).toBeLessThanOrEqual(initial.panelRight + 1);
    expect(initial.paddingInlineEnd).toBeLessThan(30);
    expectAnnotationContentAligned(await annotationContentGeometry(), ['header', 'comment']);
    const containment = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      const footer = panel?.querySelector<HTMLElement>('[data-annotation-footer]') ?? null;
      const colors = footer?.querySelector<HTMLElement>('[data-section="colors"]') ?? null;
      const tags = footer?.querySelector<HTMLElement>('[data-section="tags"]') ?? null;
      const colorRows = colors?.querySelector<HTMLElement>('.abyss-annotation-color-rows') ?? null;
      const card = panel?.querySelector<HTMLElement>('.abyss-annotation-card') ?? null;
      const meaning = card?.querySelector<HTMLElement>('[data-annotation-meaning]') ?? null;
      const comment = card?.querySelector<HTMLElement>('[data-annotation-comment]') ?? null;
      const colorMeaning =
        colors?.querySelector<HTMLElement>('.abyss-annotation-color-chip-meaning') ?? null;
      if (
        panel === null ||
        footer === null ||
        colors === null ||
        colorRows === null ||
        card === null ||
        meaning === null ||
        comment === null ||
        colorMeaning === null
      )
        throw new Error('Narrow annotation containment target is incomplete.');
      const panelRect = panel.getBoundingClientRect();
      const elementBounds = Object.fromEntries(
        Object.entries({ card, comment, meaning }).map(([name, element]) => {
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
        footerOnlyColors:
          footer.childElementCount === 1 &&
          footer.firstElementChild === colors &&
          footer.lastElementChild === colors,
        elementBounds,
        panelBounds: { left: panelRect.left, right: panelRect.right, width: panelRect.width },
        panelHasHorizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
        tagsAbsent: tags === null,
      };
    });
    if (!containment.bounded)
      throw new Error(`Narrow annotation content escaped: ${JSON.stringify(containment)}`);
    expect(containment).toEqual({
      bounded: true,
      colorOverflowX: 'auto',
      colorScrollable: true,
      elementBounds: containment.elementBounds,
      footerOnlyColors: true,
      panelBounds: containment.panelBounds,
      panelHasHorizontalOverflow: false,
      tagsAbsent: true,
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
    expect(restingGeometry.headerHeight).toBeLessThanOrEqual(34);
    expect(restingGeometry.cardHeight).toBeLessThanOrEqual(128);

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
    expect(coarseRestingGeometry.headerHeight).toBeLessThanOrEqual(48);
    expect(coarseRestingGeometry.cardHeight).toBeLessThanOrEqual(152);
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
      const reader = document.querySelector<HTMLElement>('.abyss-documents');
      const viewer = reader?.querySelector<HTMLElement>('.pdfViewerContainer') ?? null;
      const page = viewer?.querySelector<HTMLElement>('[data-page-number="1"]') ?? null;
      const canvas = document.querySelector<HTMLCanvasElement>('[data-page-number="1"] canvas');
      const panel =
        reader?.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]') ?? null;
      const footer = panel?.querySelector<HTMLElement>('[data-annotation-footer]') ?? null;
      if (
        reader === null ||
        viewer === null ||
        page === null ||
        canvas === null ||
        panel === null ||
        footer === null
      )
        throw new Error('Annotation convergence identity is incomplete.');
      const state = {
        badFrame: false,
        baselineGeneration: null as number | null,
        canvas,
        consecutivePopulatedFrames: 0,
        disconnects: 0,
        footer,
        frame: 0,
        frameSamples: 0,
        identityBreaks: 0,
        maxPendingFrames: 0,
        maxConsecutivePopulatedFrames: 0,
        mutationSamples: 0,
        observer: new MutationObserver(() => undefined),
        pendingFrames: 0,
        page,
        panel,
        reader,
        samplingGeneration: 0,
        stopped: false,
        viewer,
      };
      const host = window as Window & { __abyssTask9Continuity?: typeof state };
      host.__abyssTask9Continuity = state;
      const scheduleSample = (): void => {
        state.pendingFrames += 1;
        state.maxPendingFrames = Math.max(state.maxPendingFrames, state.pendingFrames);
        state.frame = requestAnimationFrame(() => {
          state.pendingFrames -= 1;
          sample();
        });
      };
      const sample = (): void => {
        if (state.stopped) return;
        const currentPanel = document.querySelector<HTMLElement>(
          '[data-sidebar-panel="annotations"]',
        );
        const status =
          currentPanel?.querySelector<HTMLElement>('[data-annotations-status]') ?? null;
        const populated =
          currentPanel?.dataset['annotationState'] === 'content' &&
          currentPanel.querySelectorAll('.abyss-annotation-card').length > 0 &&
          status?.hidden === true;
        state.badFrame ||= !populated;
        if (
          document.querySelector('.abyss-documents') !== reader ||
          reader.querySelector('.pdfViewerContainer') !== viewer ||
          viewer.querySelector('[data-page-number="1"]') !== page ||
          page.querySelector('canvas') !== canvas ||
          currentPanel !== panel ||
          panel.querySelector('[data-annotation-footer]') !== footer
        )
          state.identityBreaks += 1;
        if (state.baselineGeneration === state.samplingGeneration) {
          state.frameSamples += 1;
          state.consecutivePopulatedFrames = populated ? state.consecutivePopulatedFrames + 1 : 0;
          state.maxConsecutivePopulatedFrames = Math.max(
            state.maxConsecutivePopulatedFrames,
            state.consecutivePopulatedFrames,
          );
        }
        scheduleSample();
      };
      const removedTarget = (node: Node, target: Node): boolean =>
        node === target || (node.instanceOf(Element) && node.contains(target));
      const processRecords = (records: readonly MutationRecord[]): void => {
        state.mutationSamples += records.length;
        for (const record of records) {
          for (const removed of Array.from(record.removedNodes)) {
            if (
              [reader, viewer, page, canvas, panel, footer].some((target) =>
                removedTarget(removed, target),
              )
            )
              state.disconnects += 1;
          }
        }
      };
      state.observer.disconnect();
      state.observer = new MutationObserver(processRecords);
      state.observer.observe(reader.closest('.workspace-leaf') ?? reader, {
        attributeFilter: ['class', 'hidden', 'style'],
        attributeOldValue: true,
        attributes: true,
        childList: true,
        subtree: true,
      });
      scheduleSample();
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

      await $('[data-annotation-search]').setValue('Annotation 07501');
      await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '1');
      await expect($('[data-annotation-page]')).toHaveText('Page 76');
      await expect($('[data-control="page-field"]')).toHaveValue('1');
      await browser.execute(() => {
        const state = (
          window as Window & {
            __abyssTask9Continuity?: {
              baselineGeneration: number | null;
              consecutivePopulatedFrames: number;
              frameSamples: number;
              maxConsecutivePopulatedFrames: number;
              samplingGeneration: number;
            };
          }
        ).__abyssTask9Continuity;
        const row = document.querySelector(
          '[data-sidebar-panel="annotations"] .abyss-annotation-card-row',
        );
        if (state === undefined || row?.getAttribute('aria-setsize') !== '1')
          throw new Error('Cannot baseline annotation continuity before its exact search result.');
        state.samplingGeneration += 1;
        state.baselineGeneration = state.samplingGeneration;
        state.consecutivePopulatedFrames = 0;
        state.frameSamples = 0;
        state.maxConsecutivePopulatedFrames = 0;
      });
      await browser.waitUntil(
        async () =>
          browser
            .execute(() => {
              const state = (
                window as Window & {
                  __abyssTask9Continuity?: {
                    readonly baselineGeneration: number | null;
                    readonly frameSamples: number;
                    readonly maxConsecutivePopulatedFrames: number;
                    readonly samplingGeneration: number;
                  };
                }
              ).__abyssTask9Continuity;
              return state?.baselineGeneration === 1 &&
                state.samplingGeneration === 1 &&
                state.frameSamples >= 5 &&
                state.maxConsecutivePopulatedFrames >= 5
                ? state.maxConsecutivePopulatedFrames
                : 0;
            })
            .then((frames) => frames >= 5),
        { timeout: 2_000, timeoutMsg: 'Annotation panel did not sustain five populated frames.' },
      );
      const continuity = await browser.execute(() => {
        const state = (
          window as Window & {
            __abyssTask9Continuity?: {
              badFrame: boolean;
              readonly baselineGeneration: number | null;
              readonly canvas: HTMLCanvasElement;
              readonly disconnects: number;
              readonly frameSamples: number;
              readonly identityBreaks: number;
              readonly maxPendingFrames: number;
              readonly maxConsecutivePopulatedFrames: number;
              readonly mutationSamples: number;
              readonly samplingGeneration: number;
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
          baselineGeneration: state.baselineGeneration,
          disconnects: state.disconnects,
          frameSamples: state.frameSamples,
          identityBreaks: state.identityBreaks,
          maxPendingFrames: state.maxPendingFrames,
          maxConsecutivePopulatedFrames: state.maxConsecutivePopulatedFrames,
          mutationSamples: state.mutationSamples,
          sameCanvas: state.canvas === currentCanvas,
          samplingGeneration: state.samplingGeneration,
        };
      });
      expect(continuity.badFrame).toBe(false);
      expect(continuity.baselineGeneration).toBe(1);
      expect(continuity.disconnects).toBe(0);
      expect(continuity.frameSamples).toBeGreaterThanOrEqual(5);
      expect(continuity.identityBreaks).toBe(0);
      expect(continuity.maxPendingFrames).toBe(1);
      expect(continuity.maxConsecutivePopulatedFrames).toBeGreaterThanOrEqual(5);
      expect(continuity.mutationSamples).toBeGreaterThan(0);
      expect(continuity.sameCanvas).toBe(true);
      expect(continuity.samplingGeneration).toBe(1);
    } finally {
      await browser.execute(() => {
        const host = window as Window & {
          __abyssTask9Continuity?: {
            frame: number;
            observer: MutationObserver;
            stopped: boolean;
          };
        };
        const state = host.__abyssTask9Continuity;
        if (state !== undefined) {
          state.stopped = true;
          cancelAnimationFrame(state.frame);
          state.observer.takeRecords();
          state.observer.disconnect();
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
