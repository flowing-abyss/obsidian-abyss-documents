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
  await $('.pdfViewer canvas').waitForExist({ timeout: 15_000 });
}

async function closeReaders(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const taskWindow = window as Window & {
      __abyssTask6RenderMonitor?: { active: boolean; frame: number };
    };
    const monitor = taskWindow.__abyssTask6RenderMonitor;
    if (monitor !== undefined) {
      monitor.active = false;
      cancelAnimationFrame(monitor.frame);
      delete taskWindow.__abyssTask6RenderMonitor;
    }
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

async function chooseMenuOption(label: string): Promise<void> {
  await $('[data-control="overflow"]').click();
  const choice = $(`//*[contains(@class, "menu-item-title") and normalize-space(.)="${label}"]`);
  await choice.waitForClickable({ timeout: 5_000 });
  await choice.click();
}

async function currentScaleValue(): Promise<unknown> {
  return browser.executeObsidian(({ app }) => {
    const view = app.workspace.getLeavesOfType('abyss-document-view')[0]?.view as unknown as {
      controller?: { viewport?: { viewer?: { currentScaleValue?: unknown } } };
    };
    return view.controller?.viewport?.viewer?.currentScaleValue ?? null;
  });
}

async function countDisplayedExactTooltips(expected: string): Promise<number> {
  let count = 0;
  for (const tooltip of await Promise.resolve(browser.$$('.tooltip'))) {
    if ((await tooltip.isDisplayed()) && (await tooltip.getText()).trim() === expected) count += 1;
  }
  return count;
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

async function longPressMenu(selector: string): Promise<number> {
  const point = await targetCenter(selector);
  const additions = await countMenusOpenedBy(async () => {
    await browser.performActions([
      {
        type: 'pointer',
        id: 'task-6-long-press-touch',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 550 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  });
  await $('.menu').waitForDisplayed({ timeout: 3_000 });
  return additions;
}

async function touchContextMenu(selector: string, contextDelay: number): Promise<number> {
  const point = await targetCenter(selector);
  const remainingHold = Math.max(0, 550 - contextDelay);
  const additions = await countMenusOpenedBy(async () => {
    await browser.performActions([
      {
        type: 'pointer',
        id: 'task-6-context-touch',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: contextDelay },
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: remainingHold },
          { type: 'pointerUp', button: 0 },
        ],
      },
      {
        type: 'pointer',
        id: 'task-6-context-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: contextDelay },
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 2 },
          { type: 'pointerUp', button: 2 },
          { type: 'pause', duration: remainingHold },
          { type: 'pause', duration: 0 },
        ],
      },
    ]);
  });
  await $('.menu').waitForDisplayed({ timeout: 3_000 });
  return additions;
}

describe('reader compact toolbar', () => {
  beforeEach(async () => {
    await browser.executeObsidian(({ app }) => {
      app.workspace.leftSplit.collapse();
      app.workspace.rightSplit.collapse();
    });
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

    const targets = await browser.execute(() =>
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
            width: bounds.width,
          };
        }),
    );
    expect(targets.filter(({ height, width }) => height < 32 || width < 32)).toEqual([]);

    const sidebar = $('[data-control="sidebar"]');
    await expect(sidebar).toHaveAttribute('aria-label', 'Toggle sidebar');
    await browser.execute(() => {
      const hidden = document.body.createDiv({ cls: 'tooltip', text: 'Toggle sidebar' });
      hidden.dataset['e2eHiddenTooltip'] = '';
      hidden.hidden = true;
    });
    expect(
      await browser.execute(
        () =>
          document.querySelector<HTMLElement>('[data-e2e-hidden-tooltip]')?.textContent ===
          'Toggle sidebar',
      ),
    ).toBe(true);
    expect(await countDisplayedExactTooltips('Toggle sidebar')).toBe(0);
    await browser.execute(() => {
      document.querySelector('[data-e2e-hidden-tooltip]')?.remove();
    });

    await $('[data-control="page-field"]').click();
    await sidebar.moveTo();
    await browser.execute(() => {
      window.focus();
      const button = document.querySelector<HTMLElement>('[data-control="sidebar"]');
      const bounds = button?.getBoundingClientRect();
      button?.dispatchEvent(
        new PointerEvent('pointerover', {
          bubbles: true,
          clientX: bounds?.left ?? 0,
          clientY: bounds?.top ?? 0,
          isPrimary: true,
          pointerType: 'mouse',
        }),
      );
    });
    await browser.waitUntil(async () => (await countDisplayedExactTooltips('Toggle sidebar')) > 0, {
      interval: 100,
      timeout: 3_000,
      timeoutMsg: 'Native toolbar tooltip did not become visible.',
    });
    const tooltipState = await browser.execute((expected) => {
      const button = document.querySelector<HTMLElement>('[data-control="sidebar"]');
      const bounds = button?.getBoundingClientRect();
      const matches = Array.from(document.querySelectorAll<HTMLElement>('.tooltip'))
        .filter(({ textContent }) => textContent.trim() === expected)
        .map((tooltip) => {
          const style = getComputedStyle(tooltip);
          const rect = tooltip.getBoundingClientRect();
          return {
            display: style.display,
            hidden: tooltip.hidden,
            intersectsViewport:
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth,
            opacity: Number(style.opacity),
            pointerEvents: style.pointerEvents,
            rect: { height: rect.height, width: rect.width },
            visibility: style.visibility,
          };
        });
      return {
        elementAtButtonControl:
          bounds === undefined
            ? null
            : document
                .elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
                ?.closest<HTMLElement>('[data-control]')?.dataset['control'],
        hasFocus: document.hasFocus(),
        matches,
      };
    }, 'Toggle sidebar');
    const validVisibleMatch = tooltipState.matches.some(
      ({ display, hidden, intersectsViewport, opacity, pointerEvents, rect, visibility }) =>
        display !== 'none' &&
        !hidden &&
        intersectsViewport &&
        opacity > 0 &&
        pointerEvents === 'none' &&
        rect.height > 0 &&
        rect.width > 0 &&
        visibility === 'visible',
    );
    expect({ ...tooltipState, validVisibleMatch }).toMatchObject({
      elementAtButtonControl: 'sidebar',
      hasFocus: true,
      validVisibleMatch: true,
    });

    const fit = $('[data-control="fit"]');
    await fit.moveTo();
    await browser.waitUntil(
      async () => (await countDisplayedExactTooltips('Fit width — more fit options')) > 0,
      {
        interval: 100,
        timeout: 3_000,
        timeoutMsg: 'Fit tooltip did not become visible.',
      },
    );

    const geometry = await browser.execute(() => {
      const toolbar = document.querySelector<HTMLElement>('.abyss-reader-toolbar');
      const toolbarBounds = toolbar?.getBoundingClientRect();
      const controls = Array.from(
        toolbar?.querySelectorAll<HTMLElement>(
          '[data-toolbar-control], [data-control-group], [data-control="page-field"], [data-control="page-total"], [data-control="zoom-level"]',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      return {
        bottom: toolbarBounds?.bottom ?? 0,
        centers: controls.map((element) => {
          const bounds = element.getBoundingClientRect();
          return Math.round(bounds.top + bounds.height / 2);
        }),
        contained: controls.every((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            toolbarBounds !== undefined &&
            bounds.top >= toolbarBounds.top &&
            bounds.bottom <= toolbarBounds.bottom
          );
        }),
        height: toolbarBounds?.height ?? 0,
        top: toolbarBounds?.top ?? 0,
      };
    });
    expect(Math.max(...geometry.centers) - Math.min(...geometry.centers)).toBeLessThanOrEqual(1);
    expect(geometry.contained).toBe(true);
    expect(geometry.bottom).toBeGreaterThan(geometry.top);
    expect(geometry.height).toBeLessThanOrEqual(44);
  });

  it('supports pointer context keyboard and outside-dismissal routes for every toolbar menu', async () => {
    await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6Identity?: {
          canvas: Element | null;
          container: Element | null;
          viewer: Element | null;
        };
      };
      const canvas = document.querySelector('.pdfViewer canvas');
      const container = document.querySelector('.pdfViewerContainer');
      const viewer = document.querySelector('.pdfViewer');
      if (canvas === null || container === null || viewer === null)
        throw new Error('PDF identity nodes are unavailable.');
      taskWindow.__abyssTask6Identity = {
        canvas,
        container,
        viewer,
      };
    });
    const fitMenu = $('[data-control="fit-menu"]');
    await fitMenu.click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit height'));
    await expect(fitMenu).toHaveAttribute('aria-expanded', 'true');
    await $('[data-control="page-field"]').click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect(fitMenu).toHaveAttribute('aria-expanded', 'false');
    expect(
      await browser.execute(
        () => (document.activeElement as HTMLElement | null)?.dataset['control'] ?? '',
      ),
    ).toBe('page-field');

    const fit = $('[data-control="fit"]');
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="fit"]')?.focus();
    });
    await browser.keys(['ArrowDown']);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit height'));
    await browser.keys(['Escape']);

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="fit"]')?.focus();
    });
    await browser.keys(['Shift', 'F10']);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit page'));
    await browser.keys(['Escape']);

    await fit.click({ button: 'right' });
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit page'));
    await browser.keys(['Escape']);
    await expect($('.menu')).not.toBeDisplayed();
    await expect(fit).toHaveAttribute('aria-expanded', 'false');
    expect(
      await browser.execute(
        () => (document.activeElement as HTMLElement | null)?.dataset['control'] ?? '',
      ),
    ).toBe('fit');

    await fitMenu.click();
    const fitPage = $('//*[contains(@class, "menu-item-title") and normalize-space(.)="Fit page"]');
    await fitPage.waitForClickable({ timeout: 3_000 });
    await fitPage.click();
    await browser.waitUntil(async () => (await currentScaleValue()) === 'page-fit', {
      timeout: 3_000,
      timeoutMsg: 'Fit page did not settle before the long-press route check.',
    });
    expect(await longPressMenu('[data-control="fit"]')).toBe(1);
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit width'));
    expect(await currentScaleValue()).toBe('page-fit');
    await browser.keys(['Escape']);
    for (const delay of [200, 550]) {
      expect(await touchContextMenu('[data-control="fit"]', delay)).toBe(1);
      await expect($('.menu')).toHaveText(expect.stringContaining('Fit height'));
      expect(await currentScaleValue()).toBe('page-fit');
      await browser.keys(['Escape']);
    }

    const quick = $('[data-annotation-tool="highlight"]');
    await expect(quick).toHaveAttribute('aria-pressed', 'false');
    await expect(quick).toHaveAttribute('aria-label', expect.stringContaining('Yellow'));
    await quick.click();
    await expect(quick).toHaveAttribute('aria-pressed', 'true');

    await quick.click({ button: 'right' });
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
    await browser.keys(['Escape']);

    expect(await longPressMenu('[data-annotation-tool="highlight"]')).toBe(1);
    await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
    await browser.keys(['Escape']);
    await expect(quick).toHaveAttribute('aria-pressed', 'true');
    for (const delay of [200, 550]) {
      expect(await touchContextMenu('[data-annotation-tool="highlight"]', delay)).toBe(1);
      await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
      await browser.keys(['Escape']);
      await expect(quick).toHaveAttribute('aria-pressed', 'true');
    }

    const quickMenu = $('[data-control="quick-highlight-menu"]');
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]')?.focus();
    });
    await browser.keys(['ArrowDown']);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
    await $('[data-control="page-field"]').click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect(quickMenu).toHaveAttribute('aria-expanded', 'false');
    await expect(quick).toHaveAttribute('aria-pressed', 'true');
    expect(
      await browser.execute(
        () => (document.activeElement as HTMLElement | null)?.dataset['control'] ?? '',
      ),
    ).toBe('page-field');

    await quickMenu.click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]')?.focus();
    });
    await browser.keys(['Escape']);
    await expect($('.menu')).not.toBeDisplayed();
    await expect(quickMenu).toHaveAttribute('aria-expanded', 'false');
    expect(
      await browser.execute(
        () => (document.activeElement as HTMLElement | null)?.dataset['control'] ?? '',
      ),
    ).toBe('quick-highlight-menu');
    await browser.keys(['Escape']);
    await expect(quick).toHaveAttribute('aria-pressed', 'false');

    const more = $('[data-control="overflow"]');
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="overflow"]')?.focus();
    });
    await browser.keys(['ArrowDown']);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    const menuText = await $('.menu').getText();
    expect(menuText).toContain('Layout');
    expect(menuText).toContain('Appearance');
    expect(menuText).toContain('Default');
    expect(menuText).toContain('Export annotations');
    expect(menuText).not.toContain('OCR');
    expect(menuText).not.toContain('Recognize');
    const menuTitles = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.menu .menu-item-title')).map((item) =>
        item.textContent.trim(),
      ),
    );
    const layoutStart = menuTitles.indexOf('Layout');
    const appearanceStart = menuTitles.indexOf('Appearance');
    expect(menuTitles.slice(layoutStart, appearanceStart)).toEqual([
      'Layout',
      'Single page',
      'Two pages',
      'Continuous scrolling',
    ]);
    expect(menuTitles.slice(appearanceStart)).toEqual([
      'Appearance',
      'Default',
      'Follow Obsidian',
      'Light',
      'Sepia',
      'Dark',
      'Custom',
      'Export annotations…',
    ]);
    const layoutGeometry = await browser.execute(() => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.menu .menu-item[data-section="abyss-documents-layout"]:not(.is-label)',
        ),
      );
      const group = items[0]?.parentElement;
      return {
        display: group === undefined || group === null ? null : getComputedStyle(group).display,
        lefts: items.map((item) => Math.round(item.getBoundingClientRect().left)),
        tops: items.map((item) => Math.round(item.getBoundingClientRect().top)),
      };
    });
    expect(layoutGeometry.display).not.toBe('grid');
    expect(layoutGeometry.lefts).toHaveLength(3);
    expect(
      Math.max(...layoutGeometry.lefts) - Math.min(...layoutGeometry.lefts),
    ).toBeLessThanOrEqual(2);
    expect(layoutGeometry.tops[0]).toBeLessThan(layoutGeometry.tops[1] ?? 0);
    expect(layoutGeometry.tops[1]).toBeLessThan(layoutGeometry.tops[2] ?? 0);
    expect(menuText).not.toContain('Single page ·');
    expect(menuText).not.toContain('Two pages ·');
    await browser.keys(['ArrowDown']);
    await expect(
      $('.menu-item.selected, .menu-item.is-selected, .menu-item[aria-selected="true"]'),
    ).toExist();
    await browser.keys(['Enter']);
    await expect($('.menu')).not.toBeDisplayed();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(
      await browser.execute(
        () => (document.activeElement as HTMLElement | null)?.dataset['control'] ?? '',
      ),
    ).toBe('overflow');

    await more.click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await $('[data-control="page-field"]').click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(
      await browser.execute(
        () => (document.activeElement as HTMLElement | null)?.dataset['control'] ?? '',
      ),
    ).toBe('page-field');

    const identity = await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6Identity?: {
          canvas: Element | null;
          container: Element | null;
          viewer: Element | null;
        };
      };
      const initial = taskWindow.__abyssTask6Identity;
      delete taskWindow.__abyssTask6Identity;
      return {
        canvas: initial?.canvas === document.querySelector('.pdfViewer canvas'),
        container: initial?.container === document.querySelector('.pdfViewerContainer'),
        viewer: initial?.viewer === document.querySelector('.pdfViewer'),
      };
    });
    expect(identity).toEqual({ canvas: true, container: true, viewer: true });
  });

  it('applies Fit page and explicit Two-page Continuous layout without an empty render frame', async () => {
    await browser.execute(() => {
      const container = document.querySelector<HTMLElement>('.pdfViewerContainer');
      const viewer = document.querySelector<HTMLElement>('.pdfViewer');
      const page = document.querySelector<HTMLElement>('[data-page-number="1"]');
      const canvas = page?.querySelector<HTMLCanvasElement>('canvas') ?? null;
      if (container === null || viewer === null || page === null || canvas === null)
        throw new Error('Rendered PDF identity nodes are unavailable.');
      const taskWindow = window as Window & {
        __abyssTask6RenderMonitor?: {
          active: boolean;
          canvas: HTMLCanvasElement;
          container: HTMLElement;
          emptyFrames: number;
          frame: number;
          identityBreaks: number;
          loadingFrames: number;
          page: HTMLElement;
          samples: number;
          viewer: HTMLElement;
        };
      };
      const monitor = {
        active: true,
        canvas,
        container,
        emptyFrames: 0,
        frame: 0,
        identityBreaks: 0,
        loadingFrames: 0,
        page,
        samples: 0,
        viewer,
      };
      const sample = (): void => {
        if (!monitor.active) return;
        monitor.samples += 1;
        const currentPage = document.querySelector<HTMLElement>('[data-page-number="1"]');
        const currentCanvas = currentPage?.querySelector<HTMLCanvasElement>('canvas') ?? null;
        if (
          document.querySelector('.pdfViewerContainer') !== monitor.container ||
          document.querySelector('.pdfViewer') !== monitor.viewer ||
          currentPage !== monitor.page ||
          currentCanvas !== monitor.canvas
        )
          monitor.identityBreaks += 1;
        const pageBounds = monitor.page.getBoundingClientRect();
        const canvasBounds = monitor.canvas.getBoundingClientRect();
        if (
          !monitor.page.isConnected ||
          !monitor.canvas.isConnected ||
          monitor.page.offsetParent === null ||
          monitor.canvas.offsetParent === null ||
          pageBounds.width <= 0 ||
          pageBounds.height <= 0 ||
          canvasBounds.width <= 0 ||
          canvasBounds.height <= 0
        )
          monitor.emptyFrames += 1;
        if (
          document.querySelector(
            '[data-region="document"][aria-busy="true"], [data-reader-loading], [data-reader-error]',
          ) !== null
        )
          monitor.loadingFrames += 1;
        monitor.frame = requestAnimationFrame(sample);
      };
      taskWindow.__abyssTask6RenderMonitor = monitor;
      monitor.frame = requestAnimationFrame(sample);
    });

    await $('[data-control="fit-menu"]').click();
    const fitPage = $('//*[contains(@class, "menu-item-title") and normalize-space(.)="Fit page"]');
    await fitPage.waitForClickable({ timeout: 5_000 });
    await fitPage.click();
    await browser.waitUntil(
      () =>
        browser.executeObsidian(({ app }) => {
          const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
            controller?: { viewport?: { viewer?: { currentScaleValue?: unknown } } };
          };
          return view.controller?.viewport?.viewer?.currentScaleValue === 'page-fit';
        }),
      { timeout: 5_000, timeoutMsg: 'Fit page did not reach PDF.js.' },
    );

    await chooseMenuOption('Two pages');
    await chooseMenuOption('Continuous scrolling');
    await chooseMenuOption('Continuous scrolling');
    await browser.waitUntil(
      () =>
        browser
          .executeObsidian(({ app }) => {
            const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
              controller?: { currentLayout?: unknown };
            };
            return view.controller?.currentLayout;
          })
          .then(
            (layout) =>
              JSON.stringify(layout) ===
              JSON.stringify({ pages: 'facing', scrolling: 'continuous' }),
          ),
      { timeout: 5_000, timeoutMsg: 'Two-page continuous layout did not settle.' },
    );
    await browser.execute(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        }),
    );

    const render = await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6RenderMonitor?: {
          active: boolean;
          emptyFrames: number;
          frame: number;
          identityBreaks: number;
          loadingFrames: number;
          samples: number;
        };
      };
      const monitor = taskWindow.__abyssTask6RenderMonitor;
      if (monitor === undefined) throw new Error('Render monitor is unavailable.');
      monitor.active = false;
      cancelAnimationFrame(monitor.frame);
      delete taskWindow.__abyssTask6RenderMonitor;
      return {
        emptyFrames: monitor.emptyFrames,
        identityBreaks: monitor.identityBreaks,
        loadingFrames: monitor.loadingFrames,
        samples: monitor.samples,
      };
    });
    expect(render.samples).toBeGreaterThan(0);
    expect(render).toMatchObject({ emptyFrames: 0, identityBreaks: 0, loadingFrames: 0 });
  });

  it('adapts a 680px reader leaf inside a wide viewport without losing Fit or zoom', async () => {
    const responsive = await browser.execute(() => {
      const reader = document.querySelector<HTMLElement>('.abyss-documents');
      if (reader === null) throw new Error('Reader root is missing.');
      // Emulate a narrow split leaf without changing the wide app viewport.
      Reflect.set(reader.style, 'alignSelf', 'flex-start');
      Reflect.set(reader.style, 'width', '680px');
      Reflect.set(reader.style, 'maxWidth', '680px');
      return { viewport: window.innerWidth };
    });
    expect(responsive.viewport).toBeGreaterThan(760);
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const toolbar = document.querySelector<HTMLElement>('.abyss-reader-toolbar');
          const fit = document.querySelector<HTMLElement>('.abyss-reader-fit-control');
          const zoom = document.querySelector<HTMLElement>('.abyss-reader-toolbar-zoom');
          return (
            toolbar !== null &&
            toolbar.getBoundingClientRect().width <= 680 &&
            getComputedStyle(fit as HTMLElement).display === 'none' &&
            getComputedStyle(zoom as HTMLElement).display === 'none'
          );
        }),
      { timeout: 3_000, timeoutMsg: 'Reader container query did not enter compact mode.' },
    );

    const geometry = await browser.execute(() => {
      const toolbar = document.querySelector<HTMLElement>('.abyss-reader-toolbar');
      const controls = Array.from(
        toolbar?.querySelectorAll<HTMLElement>('[data-toolbar-control], [data-control-group]') ??
          [],
      ).filter((element) => element.offsetParent !== null);
      const centers = controls.map((element) => {
        const bounds = element.getBoundingClientRect();
        return Math.round(bounds.top + bounds.height / 2);
      });
      return {
        centers,
        clientWidth: toolbar?.clientWidth ?? 0,
        scrollWidth: toolbar?.scrollWidth ?? 0,
      };
    });
    expect(Math.max(...geometry.centers) - Math.min(...geometry.centers)).toBeLessThanOrEqual(1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

    await $('[data-control="overflow"]').click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    const menuText = await $('.menu').getText();
    expect(menuText).toContain('Zoom · Fit width');
    expect(menuText).toContain('Fit');
    expect(menuText).toContain('Zoom out');
    expect(menuText).toContain('Reset zoom');
    expect(menuText).toContain('Zoom in');
    expect(menuText).toContain('Fit width');
    expect(menuText).toContain('Fit page');
    expect(menuText).toContain('Fit height');
  });

  it('keeps the toolbar single-row and contained across its responsive boundary', async () => {
    for (const width of [1440, 1024, 768, 760, 680, 390]) {
      const geometry = await browser.execute((readerWidth) => {
        const reader = document.querySelector<HTMLElement>('.abyss-documents');
        if (reader === null) throw new Error('Reader is missing.');
        const toolbar = reader.querySelector<HTMLElement>('.abyss-reader-toolbar');
        if (toolbar === null) throw new Error('Reader toolbar is missing.');
        reader.setAttribute(
          'style',
          `align-self: flex-start; width: ${readerWidth}px; max-width: ${readerWidth}px`,
        );
        const visible = Array.from(
          toolbar.querySelectorAll<HTMLElement>('[data-toolbar-control], [data-control-group]'),
        ).filter((element) => element.offsetParent !== null);
        const centers = visible.map((element) => {
          const bounds = element.getBoundingClientRect();
          return Math.round(bounds.top + bounds.height / 2);
        });
        const fit = toolbar.querySelector<HTMLElement>('.abyss-reader-fit-control');
        return {
          centers,
          clientWidth: toolbar.clientWidth,
          fitVisible: fit?.offsetParent !== null,
          scrollWidth: toolbar.scrollWidth,
        };
      }, width);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(Math.max(...geometry.centers) - Math.min(...geometry.centers)).toBeLessThanOrEqual(1);
      expect(geometry.fitVisible).toBe(width > 760);
    }
  });
});
