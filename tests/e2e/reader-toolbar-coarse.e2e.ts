import { $, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';

const pluginId = 'abyss-documents';

async function closeReaders(): Promise<void> {
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
  await $('[data-control="quick-highlight-menu"]').waitForExist({ timeout: 15_000 });
}

async function targetCenter(selector: string): Promise<{ x: number; y: number }> {
  return browser.execute((targetSelector) => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (target === null) throw new Error(`Pointer target unavailable: ${targetSelector}`);
    const bounds = target.getBoundingClientRect();
    return {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2),
    };
  }, selector);
}

async function startMenuMutationMonitor(): Promise<void> {
  await browser.execute(() => {
    const taskWindow = window as Window & {
      __abyssTask6MenuMonitor?: { additions: number; observer: MutationObserver };
    };
    taskWindow.__abyssTask6MenuMonitor?.observer.disconnect();
    const monitor = {
      additions: 0,
      observer: new MutationObserver((records) => {
        for (const record of records) {
          for (const added of Array.from(record.addedNodes)) {
            if (!added.instanceOf(Element)) continue;
            if (added.matches('.menu')) monitor.additions += 1;
            monitor.additions += added.querySelectorAll('.menu').length;
          }
        }
      }),
    };
    monitor.observer.observe(document.body, { childList: true, subtree: true });
    taskWindow.__abyssTask6MenuMonitor = monitor;
  });
}

async function stopMenuMutationMonitor(): Promise<number> {
  return browser.execute(() => {
    const taskWindow = window as Window & {
      __abyssTask6MenuMonitor?: { additions: number; observer: MutationObserver };
    };
    const monitor = taskWindow.__abyssTask6MenuMonitor;
    if (monitor === undefined) return 0;
    monitor.observer.disconnect();
    delete taskWindow.__abyssTask6MenuMonitor;
    return monitor.additions;
  });
}

async function countMenusOpenedBy(action: () => Promise<void>): Promise<number> {
  await startMenuMutationMonitor();
  let monitorStopped = false;
  try {
    await action();
    await browser.pause(50);
    const additions = await stopMenuMutationMonitor();
    monitorStopped = true;
    return additions;
  } finally {
    await browser.releaseActions();
    if (!monitorStopped) await stopMenuMutationMonitor();
  }
}

async function touchMenu(control: string): Promise<void> {
  const selector = `[data-control="${control}"]`;
  await $(selector).waitForExist({ timeout: 15_000 });
  const point = await targetCenter(selector);
  const openings = await countMenusOpenedBy(async () => {
    await browser.performActions([
      {
        type: 'pointer',
        id: `task-6-${control}-touch`,
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  });
  expect(openings).toBe(1);
  await $('.menu').waitForDisplayed({ timeout: 3_000 });
}

async function clickOutsideMenu(): Promise<void> {
  const point = await browser.execute(() => {
    const backdrop = document.querySelector('.suggestion-bg');
    if (backdrop === null) throw new Error('The native menu backdrop is unavailable.');
    for (const { left, right, top, bottom } of Array.from(backdrop.getClientRects())) {
      for (const xRatio of [0.5, 0.25, 0.75]) {
        for (const yRatio of [0.5, 0.25, 0.75]) {
          const point = {
            x: Math.round(left + (right - left) * xRatio),
            y: Math.round(top + (bottom - top) * yRatio),
          };
          if (document.elementFromPoint(point.x, point.y) === backdrop) return point;
        }
      }
    }
    throw new Error('The native menu backdrop has no hittable interior point.');
  });
  try {
    await browser.performActions([
      {
        type: 'pointer',
        id: 'coarse-menu-outside-click',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  } finally {
    await browser.releaseActions();
  }
}

async function clickToolbarControl(control: string): Promise<void> {
  const selector = `[data-control="${control}"]`;
  try {
    await $(selector).click();
  } catch (cause) {
    throw Object.assign(new Error(`Coarse toolbar click ${selector} failed: ${String(cause)}`), {
      cause,
    });
  }
}

async function longPressQuick(moveBy = 0): Promise<number> {
  const point = await targetCenter('[data-annotation-tool="highlight"]');
  return countMenusOpenedBy(async () => {
    await browser.performActions([
      {
        type: 'pointer',
        id: 'task-6-quick-long-press-touch',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 0 },
          ...(moveBy === 0
            ? []
            : [
                {
                  type: 'pointerMove' as const,
                  duration: 0,
                  origin: 'viewport',
                  x: point.x + moveBy,
                  y: point.y,
                },
              ]),
          { type: 'pause', duration: 550 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  });
}

describe('reader toolbar under a 390px coarse pointer', () => {
  beforeEach(async () => {
    await closeReaders();
    await openPdf();
  });
  afterEach(closeReaders);

  it('keeps visible controls contained, touch-sized, and operable without duplicate clicks', async () => {
    const geometry = await browser.execute(() => {
      const toolbar = document.querySelector<HTMLElement>('.abyss-reader-toolbar');
      if (toolbar === null) throw new Error('Reader toolbar unavailable.');
      const navigation = toolbar.querySelector<HTMLElement>('.abyss-reader-toolbar-navigation');
      const zones = Array.from(
        toolbar.querySelectorAll<HTMLElement>(':scope > [data-toolbar-zone]'),
      );
      if (navigation === null || zones.length !== 3)
        throw new Error('Three-zone toolbar geometry unavailable.');
      const visible = Array.from(
        toolbar.querySelectorAll<HTMLElement>(
          '[data-toolbar-control]:not(.abyss-reader-split-control [data-toolbar-control]), [data-control-group], [data-control="page-field"], [data-control="page-total"]',
        ),
      ).filter((element) => element.offsetParent !== null);
      const contentBounds = zones.map((zone) => {
        const visibleChildren = Array.from(zone.children)
          .filter((child): child is HTMLElement => child.instanceOf(HTMLElement))
          .filter((child) => child.offsetParent !== null)
          .map((child) => child.getBoundingClientRect());
        if (visibleChildren.length === 0) throw new Error('Toolbar zone has no visible content.');
        return {
          left: Math.min(...visibleChildren.map((bounds) => bounds.left)),
          right: Math.max(...visibleChildren.map((bounds) => bounds.right)),
        };
      });
      const toolbarBounds = toolbar.getBoundingClientRect();
      const toolbarStyle = getComputedStyle(toolbar);
      const toolbarContentLeft = toolbarBounds.left + Number.parseFloat(toolbarStyle.paddingLeft);
      const toolbarContentRight =
        toolbarBounds.right - Number.parseFloat(toolbarStyle.paddingRight);
      const navigationBounds = navigation.getBoundingClientRect();
      const directNavigation = ['previous-page', 'page-field', 'next-page'].map((control) => {
        const element = toolbar.querySelector<HTMLElement>(`[data-control="${control}"]`);
        if (element === null) throw new Error(`Direct navigation control unavailable: ${control}`);
        const bounds = element.getBoundingClientRect();
        return {
          control,
          height: bounds.height,
          visible: element.offsetParent !== null,
          width: bounds.width,
        };
      });
      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        controls: visible.map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            center: bounds.top + bounds.height / 2,
            height: bounds.height,
            splitDisclosure: element.classList.contains('abyss-reader-split-menu'),
            splitMain: element.classList.contains('abyss-reader-split-main'),
            width: bounds.width,
          };
        }),
        directNavigation,
        innerWidth: window.innerWidth,
        navigationCenterDelta: Math.abs(
          navigationBounds.left +
            navigationBounds.width / 2 -
            (toolbarContentLeft + toolbarContentRight) / 2,
        ),
        noZoneOverlap:
          (contentBounds[0]?.right ?? Number.POSITIVE_INFINITY) <=
            (contentBounds[1]?.left ?? Number.NEGATIVE_INFINITY) + 1 &&
          (contentBounds[1]?.right ?? Number.POSITIVE_INFINITY) <=
            (contentBounds[2]?.left ?? Number.NEGATIVE_INFINITY) + 1,
        overflow: toolbar.scrollWidth - toolbar.clientWidth,
        zones: zones.map((zone) => zone.dataset['toolbarZone']),
      };
    });
    expect(geometry.coarse).toBe(true);
    expect(geometry.innerWidth).toBe(390);
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    expect(geometry.navigationCenterDelta).toBeLessThanOrEqual(2);
    expect(geometry.noZoneOverlap).toBe(true);
    expect(geometry.zones).toEqual(['left', 'center', 'right']);
    expect(
      geometry.directNavigation.map(({ control, height, visible, width }) => ({
        control,
        touchSized: height >= 44 && width >= 44,
        visible,
      })),
    ).toEqual([
      { control: 'previous-page', touchSized: true, visible: true },
      { control: 'page-field', touchSized: true, visible: true },
      { control: 'next-page', touchSized: true, visible: true },
    ]);
    expect(Math.max(...geometry.controls.map(({ center }) => Math.round(center)))).toBe(
      Math.min(...geometry.controls.map(({ center }) => Math.round(center))),
    );
    const touchControls = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.abyss-reader-toolbar :is(button, input):not([hidden])',
        ),
      )
        .filter((element) => element.offsetParent !== null)
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            control: element.dataset['control'] ?? element.dataset['annotationTool'] ?? null,
            height: bounds.height,
            splitDisclosure: element.classList.contains('abyss-reader-split-menu'),
            splitMain: element.classList.contains('abyss-reader-split-main'),
            width: bounds.width,
          };
        }),
    );
    expect(
      touchControls.filter(({ height, width, splitMain, splitDisclosure }) => {
        if (width < 44) return true;
        if (splitMain) return height < 34;
        if (splitDisclosure) return height < 10;
        return height < 44;
      }),
    ).toEqual([]);

    await touchMenu('quick-highlight-menu');
    await expect($('[data-control="quick-highlight-menu"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await clickOutsideMenu();
    await expect($('.menu')).not.toBeDisplayed();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'false');

    expect(await longPressQuick(20)).toBe(0);
    await expect($('.menu')).not.toBeDisplayed();
    // A touch moved beyond the press tolerance is a pan, so it must not toggle.
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'false');

    expect(await longPressQuick()).toBe(1);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'false');
    await browser.keys(['Escape']);
    await expect($('.menu')).not.toBeDisplayed();

    const pageField = $('[data-control="page-field"]');
    await expect(pageField).toHaveValue('1');
    await clickToolbarControl('next-page');
    await expect(pageField).toHaveValue('2');
    await clickToolbarControl('previous-page');
    await expect(pageField).toHaveValue('1');

    await touchMenu('overflow');
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit page'));
    const moreText = await $('.menu').getText();
    expect(moreText).not.toContain('Previous page');
    expect(moreText).not.toContain('Next page');
    await browser.keys(['Escape']);
    await expect($('.menu')).not.toBeDisplayed();
  });
});
