import { $, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';

const pluginId = 'abyss-documents';

async function openPdf(path = 'Documents/text-12-pages.pdf'): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      if (!app.plugins.enabledPlugins.has(input.pluginId)) {
        throw new Error(`Plugin ${input.pluginId} is not enabled.`);
      }
      await app.workspace.openLinkText(input.path, '', false);
    },
    { path, pluginId },
  );
  await $('[data-abyss-document]').waitForDisplayed({ timeout: 15_000 });
  await $('.pdfViewer canvas').waitForExist({ timeout: 15_000 });
}

async function closeReaders(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    const taskWindow = window as Window & {
      __abyssTask6RenderMonitor?: {
        active: boolean;
        frame: number;
        observer?: MutationObserver;
      };
      __abyssTask6AppearanceMonitor?: { cleanup(): unknown };
      __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
      __abyssTask6PointerTraceController?: AbortController;
    };
    const monitor = taskWindow.__abyssTask6RenderMonitor;
    if (monitor !== undefined) {
      monitor.active = false;
      cancelAnimationFrame(monitor.frame);
      monitor.observer?.disconnect();
      delete taskWindow.__abyssTask6RenderMonitor;
    }
    taskWindow.__abyssTask6AppearanceMonitor?.cleanup();
    delete taskWindow.__abyssTask6AppearanceMonitor;
    taskWindow.__abyssTask6PointerTraceController?.abort();
    delete taskWindow.__abyssTask6PointerTraceController;
    delete taskWindow.__abyssTask6PointerTrace;
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

async function chooseToolColor(control: string, label: string): Promise<void> {
  await $(`[data-control="${control}"]`).click();
  const choice = $(`//*[contains(@class, "menu-item-title") and normalize-space(.)="${label}"]`);
  await choice.waitForClickable({ timeout: 5_000 });
  await choice.click();
}

async function displayedMenuOptionChecked(label: string): Promise<boolean> {
  return browser.execute((expected) => {
    const title = Array.from(document.querySelectorAll<HTMLElement>('.menu-item-title')).find(
      (candidate) => candidate.offsetParent !== null && candidate.textContent.trim() === expected,
    );
    return title?.closest('.menu-item')?.classList.contains('mod-checked') ?? false;
  }, label);
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
    if (!monitorStopped) await stopMenuMutationMonitor();
  }
}

async function longPressMenu(selector: string): Promise<number> {
  const pointer = selector.includes('annotation-tool')
    ? ({ id: 'task-6-context-pen', type: 'pen' } as const)
    : ({ id: 'task-6-long-press-touch', type: 'touch' } as const);
  await browser.execute((targetSelector) => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (target === null) throw new Error(`Pointer target unavailable: ${targetSelector}`);
    const taskWindow = window as Window & {
      __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
      __abyssTask6PointerTraceController?: AbortController;
    };
    taskWindow.__abyssTask6PointerTraceController?.abort();
    const controller = new AbortController();
    taskWindow.__abyssTask6PointerTraceController = controller;
    taskWindow.__abyssTask6PointerTrace = [];
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'contextmenu',
      'click',
    ]) {
      document.addEventListener(
        type,
        (event) => {
          const pointer = event as PointerEvent;
          taskWindow.__abyssTask6PointerTrace?.push({
            button: pointer.button,
            isPrimary: pointer.isPrimary,
            pointerId: pointer.pointerId,
            pointerType: pointer.pointerType,
            target: (event.target as Element | null)?.closest<HTMLElement>('[data-control]')
              ?.dataset['control'],
            timeStamp: event.timeStamp,
            type: event.type,
          });
        },
        { capture: true, signal: controller.signal },
      );
    }
  }, selector);
  const point = await targetCenter(selector);
  const additions = await countMenusOpenedBy(async () => {
    await browser.performActions([
      {
        type: 'pointer',
        id: pointer.id,
        parameters: { pointerType: pointer.type },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 0 },
        ],
      },
    ]);
    // Split the hold into a separate WebDriver command so Chromium can service
    // the reader's 500 ms timer while the genuine pointer remains depressed.
    await browser.pause(550);
    await browser.performActions([
      {
        type: 'pointer',
        id: pointer.id,
        parameters: { pointerType: pointer.type },
        actions: [{ type: 'pointerUp', button: 0 }],
      },
    ]);
  });
  try {
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
  } catch (error) {
    const trace = await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
      };
      return taskWindow.__abyssTask6PointerTrace ?? [];
    });
    throw new Error(
      `Long press did not open exactly one menu for ${selector}; trace=${JSON.stringify(trace)}; cause=${String(error)}`,
    );
  }
  return additions;
}

async function heldPointerContextMenu(selector: string, contextDelay: number): Promise<number> {
  await browser.execute((targetSelector) => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (target === null) throw new Error(`Pointer target unavailable: ${targetSelector}`);
    const taskWindow = window as Window & {
      __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
      __abyssTask6PointerTraceController?: AbortController;
    };
    taskWindow.__abyssTask6PointerTraceController?.abort();
    const controller = new AbortController();
    taskWindow.__abyssTask6PointerTraceController = controller;
    taskWindow.__abyssTask6PointerTrace = [];
    for (const type of [
      'pointerdown',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'contextmenu',
      'click',
    ]) {
      document.addEventListener(
        type,
        (event) => {
          const pointer = event as PointerEvent;
          taskWindow.__abyssTask6PointerTrace?.push({
            button: pointer.button,
            isPrimary: pointer.isPrimary,
            pointerId: pointer.pointerId,
            pointerType: pointer.pointerType,
            target: (event.target as Element | null)?.closest<HTMLElement>('[data-control]')
              ?.dataset['control'],
            timeStamp: event.timeStamp,
            type: event.type,
          });
        },
        { capture: true, signal: controller.signal },
      );
    }
  }, selector);
  const point = await targetCenter(selector);
  const remainingHold = Math.max(0, 550 - contextDelay);
  const additions = await countMenusOpenedBy(async () => {
    await browser.performActions([
      {
        type: 'pointer',
        id: 'task-6-context-pen',
        parameters: { pointerType: 'pen' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 0 },
        ],
      },
    ]);
    await browser.pause(contextDelay);
    await browser.performActions([
      {
        type: 'pointer',
        id: 'task-6-context-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...point },
          { type: 'pointerDown', button: 2 },
          { type: 'pointerUp', button: 2 },
        ],
      },
    ]);
    await browser.pause(remainingHold);
    await browser.performActions([
      {
        type: 'pointer',
        id: 'task-6-context-pen',
        parameters: { pointerType: 'pen' },
        actions: [{ type: 'pointerUp', button: 0 }],
      },
    ]);
  });
  try {
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
  } catch (error) {
    const trace = await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
      };
      return taskWindow.__abyssTask6PointerTrace ?? [];
    });
    throw new Error(
      `Held-pointer context did not retain exactly one menu for ${selector} at ${contextDelay}ms; additions=${additions}; trace=${JSON.stringify(trace)}; cause=${String(error)}`,
    );
  }
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
            isSplitDisclosure: element.classList.contains('abyss-reader-split-menu'),
            isSplitMain: element.classList.contains('abyss-reader-split-main'),
            width: bounds.width,
          };
        }),
    );
    expect(targets.filter(({ height }) => height < 32)).toEqual([]);
    expect(
      targets.filter(
        ({ isSplitDisclosure, width }) => isSplitDisclosure && (width < 12 || width > 16),
      ),
    ).toEqual([]);
    expect(
      targets.filter(({ isSplitMain, width }) => isSplitMain && (width < 32 || width > 36)),
    ).toEqual([]);
    expect(
      targets.filter(
        ({ isSplitDisclosure, isSplitMain, width }) =>
          !isSplitDisclosure && !isSplitMain && width < 32,
      ),
    ).toEqual([]);

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

    const iconControls = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '.abyss-reader-toolbar button.clickable-icon:not([hidden])',
        ),
      )
        .filter((button) => button.offsetParent !== null)
        .map((button) => ({
          annotationTool: button.dataset['annotationTool'] ?? null,
          control: button.dataset['control'] ?? null,
          label: button.getAttribute('aria-label') ?? '',
        })),
    );
    expect(iconControls.length).toBeGreaterThanOrEqual(10);
    for (const { annotationTool, control, label } of iconControls) {
      expect(label).not.toBe('');
      const selector =
        control === null
          ? `[data-annotation-tool=${JSON.stringify(annotationTool)}]`
          : `[data-control=${JSON.stringify(control)}]`;
      await $(selector).moveTo();
      await browser.waitUntil(async () => (await countDisplayedExactTooltips(label)) > 0, {
        interval: 50,
        timeout: 1_500,
        timeoutMsg: `Visible icon control missed its exact native tooltip: ${label}`,
      });
    }

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

  it('keeps separate colors for every split annotation tool and makes Select explicit', async () => {
    await chooseToolColor('quick-highlight-menu', 'Red');
    await chooseToolColor('ink-color-menu', 'Green');
    await chooseToolColor('freetext-color-menu', 'Blue');

    const presentations = await browser.execute(() => {
      const toolbar = document.querySelector<HTMLElement>('[data-region="annotation-toolbar"]');
      if (toolbar === null) throw new Error('Annotation toolbar is missing.');
      const colors = Object.fromEntries(
        ['highlight', 'ink', 'freetext'].map((tool) => {
          const button = toolbar.querySelector<HTMLButtonElement>(
            `[data-annotation-tool="${tool}"]`,
          );
          if (button === null) throw new Error(`${tool} button is missing.`);
          return [
            tool,
            {
              color: button.style.getPropertyValue('--abyss-annotation-tool-color'),
              hasMarker: button.querySelector('.abyss-reader-tool-color') !== null,
              label: button.getAttribute('aria-label'),
            },
          ];
        }),
      );
      return { colors, mode: toolbar.dataset['annotationMode'] };
    });
    expect(presentations).toEqual({
      colors: {
        freetext: { color: '#2ea8e5', hasMarker: true, label: 'Text — Blue — inactive' },
        highlight: {
          color: '#ff6666',
          hasMarker: true,
          label: 'Sticky Highlight — Red — Select mode',
        },
        ink: { color: '#5fb236', hasMarker: true, label: 'Ink — Green — inactive' },
      },
      mode: 'select',
    });

    const highlight = $('[data-annotation-tool="highlight"]');
    await highlight.click();
    await expect($('[data-region="annotation-toolbar"]')).toHaveAttribute(
      'data-annotation-mode',
      'sticky-highlight',
    );
    await expect(highlight).toHaveAttribute('aria-pressed', 'true');
    await highlight.click();
    await expect($('[data-region="annotation-toolbar"]')).toHaveAttribute(
      'data-annotation-mode',
      'select',
    );
    await expect(highlight).toHaveAttribute('aria-pressed', 'false');

    for (const [tool, color] of [
      ['ink', '#5fb236'],
      ['freetext', '#2ea8e5'],
      ['highlight', '#ff6666'],
    ] as const) {
      await $(`[data-annotation-tool="${tool}"]`).click();
      await expect($(`[data-annotation-tool="${tool}"]`)).toHaveAttribute('aria-pressed', 'true');
      expect(
        await browser.execute(
          (activeTool) =>
            document
              .querySelector<HTMLElement>(`[data-annotation-tool="${activeTool}"]`)
              ?.style.getPropertyValue('--abyss-annotation-tool-color'),
          tool,
        ),
      ).toBe(color);
    }
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
    await fitMenu.click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect(fitMenu).toHaveAttribute('aria-expanded', 'false');
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="fit-menu"]')?.focus();
    });
    await browser.keys(['Enter']);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="fit-menu"]')?.focus();
    });
    await browser.keys(['Enter']);
    await expect($('.menu')).not.toBeDisplayed();
    await expect(fitMenu).toHaveAttribute('aria-expanded', 'false');

    await fitMenu.click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
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
    await fitMenu.click();
    await fitPage.waitForDisplayed({ timeout: 3_000 });
    expect(await displayedMenuOptionChecked('Fit page')).toBe(true);
    await browser.keys(['Escape']);
    await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6Identity?: { canvas: Element | null };
      };
      if (taskWindow.__abyssTask6Identity !== undefined)
        taskWindow.__abyssTask6Identity.canvas = document.querySelector('.pdfViewer canvas');
    });
    expect(await longPressMenu('[data-control="fit"]')).toBe(1);
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit width'));
    expect(await displayedMenuOptionChecked('Fit page')).toBe(true);
    await browser.keys(['Escape']);
    for (const delay of [200, 550]) {
      expect(await heldPointerContextMenu('[data-control="fit"]', delay)).toBe(1);
      await expect($('.menu')).toHaveText(expect.stringContaining('Fit height'));
      expect(await displayedMenuOptionChecked('Fit page')).toBe(true);
      await browser.keys(['Escape']);
    }

    const quick = $('[data-annotation-tool="highlight"]');
    await expect(quick).toHaveAttribute('aria-pressed', 'false');
    await expect(quick).toHaveAttribute('aria-label', expect.stringContaining('Yellow'));
    await quick.click();
    await expect(quick).toHaveAttribute('aria-pressed', 'true');

    await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
        __abyssTask6PointerTraceController?: AbortController;
      };
      taskWindow.__abyssTask6PointerTraceController?.abort();
      const controller = new AbortController();
      taskWindow.__abyssTask6PointerTraceController = controller;
      taskWindow.__abyssTask6PointerTrace = [];
      for (const type of ['pointerdown', 'contextmenu', 'pointerup', 'click']) {
        document.addEventListener(
          type,
          (event) => {
            const pointer = event as PointerEvent;
            taskWindow.__abyssTask6PointerTrace?.push({
              button: pointer.button,
              detail: (event as MouseEvent).detail,
              pointerType: pointer.pointerType,
              target: (event.target as Element | null)?.closest<HTMLElement>(
                '[data-annotation-tool], [data-control]',
              )?.dataset['annotationTool'],
              type: event.type,
            });
          },
          { capture: true, signal: controller.signal },
        );
      }
    });
    await quick.click({ button: 'right' });
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
    const quickBeforeContextEscape = await quick.getAttribute('aria-pressed');
    if (quickBeforeContextEscape !== 'true')
      throw new Error(`Quick context disarmed before Escape: ${quickBeforeContextEscape}`);
    await browser.keys(['Escape']);
    const quickContextRoute = await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
      };
      return {
        pressed: document
          .querySelector('[data-annotation-tool="highlight"]')
          ?.getAttribute('aria-pressed'),
        trace: taskWindow.__abyssTask6PointerTrace ?? [],
      };
    });
    if (quickContextRoute.pressed !== 'true')
      throw new Error(`Quick context toggled the tool: ${JSON.stringify(quickContextRoute)}`);

    expect(await longPressMenu('[data-annotation-tool="highlight"]')).toBe(1);
    await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
    await browser.keys(['Escape']);
    const quickLongPress = await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6PointerTrace?: Array<Record<string, unknown>>;
      };
      return {
        pressed: document
          .querySelector('[data-annotation-tool="highlight"]')
          ?.getAttribute('aria-pressed'),
        trace: taskWindow.__abyssTask6PointerTrace ?? [],
      };
    });
    expect(quickLongPress).toMatchObject({ pressed: 'true' });
    for (const delay of [200, 550]) {
      expect(await heldPointerContextMenu('[data-annotation-tool="highlight"]', delay)).toBe(1);
      await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
      await browser.keys(['Escape']);
      await expect(quick).toHaveAttribute('aria-pressed', 'true');
    }
    await browser.releaseActions();

    const quickMenu = $('[data-control="quick-highlight-menu"]');
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]')?.focus();
    });
    await browser.keys(['ArrowDown']);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]')?.focus();
    });
    await browser.keys([' ']);
    await expect($('.menu')).not.toBeDisplayed();
    await expect(quickMenu).toHaveAttribute('aria-expanded', 'false');

    await fitMenu.click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await quickMenu.click();
    await expect(fitMenu).toHaveAttribute('aria-expanded', 'false');
    await expect(quickMenu).toHaveAttribute('aria-expanded', 'true');
    expect(
      await browser.execute(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('.menu')).filter(
            (menu) => menu.offsetParent !== null,
          ).length,
      ),
    ).toBe(1);
    await quickMenu.click();
    await expect($('.menu')).not.toBeDisplayed();

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-control="quick-highlight-menu"]')?.focus();
    });
    await browser.keys(['ArrowDown']);
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
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
    await more.click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
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

  it('applies Default Light Dark and Sepia through the public appearance menu', async () => {
    const root = $('[data-abyss-document]');
    await browser.execute(() => {
      const reader = document.querySelector<HTMLElement>('[data-abyss-document]');
      const container = reader?.querySelector<HTMLElement>('.pdfViewerContainer') ?? null;
      const viewer = container?.querySelector<HTMLElement>('.pdfViewer') ?? null;
      const page = viewer?.querySelector<HTMLElement>('[data-page-number="1"]') ?? null;
      const canvas = page?.querySelector<HTMLCanvasElement>('canvas') ?? null;
      if (
        reader === null ||
        container === null ||
        viewer === null ||
        page === null ||
        canvas === null
      )
        throw new Error('Appearance continuity targets are incomplete.');
      const state = { disconnects: 0, identityBreaks: 0, mutationRecords: 0 };
      const tracked = [reader, container, viewer, page, canvas];
      const removedTarget = (node: Node, target: Node): boolean =>
        node === target || (node.instanceOf(Element) && node.contains(target));
      const sample = (): void => {
        if (
          document.querySelector('[data-abyss-document]') !== reader ||
          reader.querySelector('.pdfViewerContainer') !== container ||
          container.querySelector('.pdfViewer') !== viewer ||
          viewer.querySelector('[data-page-number="1"]') !== page ||
          page.querySelector('canvas') !== canvas
        )
          state.identityBreaks += 1;
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
        attributeFilter: ['class', 'data-reading-profile', 'hidden', 'style'],
        attributeOldValue: true,
        attributes: true,
        childList: true,
        subtree: true,
      });
      (
        window as Window & {
          __abyssTask6AppearanceMonitor?: { cleanup(): Record<string, number> };
        }
      ).__abyssTask6AppearanceMonitor = {
        cleanup() {
          processRecords(observer.takeRecords());
          observer.disconnect();
          return { ...state };
        },
      };
    });
    for (const [label, profile] of [
      ['Light', 'light'],
      ['Dark', 'dark'],
      ['Sepia', 'sepia'],
      ['Default', 'default'],
    ] as const) {
      await chooseMenuOption(label);
      await expect(root).toHaveAttribute('data-reading-profile', profile);
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('.pdfViewer canvas');
            const bounds = canvas?.getBoundingClientRect();
            return (
              canvas?.isConnected === true &&
              canvas.offsetParent !== null &&
              canvas.width > 0 &&
              canvas.height > 0 &&
              (bounds?.height ?? 0) > 0 &&
              (bounds?.width ?? 0) > 0
            );
          }),
        { timeout: 3_000, timeoutMsg: `${label} did not retain a populated PDF surface.` },
      );
    }
    const continuity = await browser.execute(() => {
      const host = window as Window & {
        __abyssTask6AppearanceMonitor?: { cleanup(): Record<string, number> };
      };
      const monitor = host.__abyssTask6AppearanceMonitor;
      if (monitor === undefined) throw new Error('Appearance continuity monitor is unavailable.');
      const result = monitor.cleanup();
      delete host.__abyssTask6AppearanceMonitor;
      return result;
    });
    expect(continuity['mutationRecords']).toBeGreaterThan(0);
    expect(continuity).toMatchObject({ disconnects: 0, identityBreaks: 0 });
  });

  it('applies Fit page and explicit Two-page Continuous layout without an empty render frame', async () => {
    await $('.pdfViewer canvas').waitForDisplayed({ timeout: 5_000 });
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
          consecutivePopulatedFrames: number;
          container: HTMLElement;
          emptyFrames: number;
          frame: number;
          loadingFrames: number;
          maxPopulatedFrames: number;
          observer: MutationObserver;
          page: HTMLElement;
          removalWithoutPopulatedReplacement: number;
          replacementCount: number;
          samples: number;
          shellIdentityBreaks: number;
          trackedSurfaceRemovals: number;
          viewer: HTMLElement;
        };
      };
      const monitor = {
        active: true,
        canvas,
        consecutivePopulatedFrames: 0,
        container,
        emptyFrames: 0,
        frame: 0,
        loadingFrames: 0,
        maxPopulatedFrames: 0,
        observer: new MutationObserver(() => undefined),
        page,
        removalWithoutPopulatedReplacement: 0,
        replacementCount: 0,
        samples: 0,
        shellIdentityBreaks: 0,
        trackedSurfaceRemovals: 0,
        viewer,
      };
      const currentSurface = (): {
        canvas: HTMLCanvasElement | null;
        page: HTMLElement | null;
      } => {
        const currentPage = document.querySelector<HTMLElement>('[data-page-number="1"]');
        return {
          canvas: currentPage?.querySelector<HTMLCanvasElement>('canvas') ?? null,
          page: currentPage,
        };
      };
      const isPopulated = (
        currentPage: HTMLElement | null,
        currentCanvas: HTMLCanvasElement | null,
      ): boolean => {
        if (
          currentPage === null ||
          currentCanvas === null ||
          !currentPage.isConnected ||
          !currentCanvas.isConnected ||
          currentPage.offsetParent === null ||
          currentCanvas.offsetParent === null ||
          currentCanvas.width <= 0 ||
          currentCanvas.height <= 0
        )
          return false;
        const pageBounds = currentPage.getBoundingClientRect();
        const canvasBounds = currentCanvas.getBoundingClientRect();
        const pageStyle = getComputedStyle(currentPage);
        const canvasStyle = getComputedStyle(currentCanvas);
        return (
          pageBounds.width > 0 &&
          pageBounds.height > 0 &&
          canvasBounds.width > 0 &&
          canvasBounds.height > 0 &&
          pageStyle.display !== 'none' &&
          pageStyle.visibility !== 'hidden' &&
          Number(pageStyle.opacity) > 0 &&
          canvasStyle.display !== 'none' &&
          canvasStyle.visibility !== 'hidden' &&
          Number(canvasStyle.opacity) > 0
        );
      };
      monitor.observer.disconnect();
      monitor.observer = new MutationObserver((records) => {
        const trackedRemovalRecords = records.filter((record) =>
          Array.from(record.removedNodes).some(
            (removed) =>
              removed === monitor.page ||
              removed === monitor.canvas ||
              (removed.instanceOf(Element) &&
                (removed.contains(monitor.page) || removed.contains(monitor.canvas))),
          ),
        );
        monitor.trackedSurfaceRemovals += trackedRemovalRecords.length;
        if (trackedRemovalRecords.length === 0) return;
        const current = currentSurface();
        if (!isPopulated(current.page, current.canvas))
          monitor.removalWithoutPopulatedReplacement += 1;
      });
      monitor.observer.observe(viewer, { childList: true, subtree: true });
      const sample = (): void => {
        if (!monitor.active) return;
        monitor.samples += 1;
        const current = currentSurface();
        if (
          document.querySelector('.pdfViewerContainer') !== monitor.container ||
          document.querySelector('.pdfViewer') !== monitor.viewer
        )
          monitor.shellIdentityBreaks += 1;
        if (current.page !== monitor.page || current.canvas !== monitor.canvas) {
          monitor.replacementCount += 1;
          if (current.page !== null) monitor.page = current.page;
          if (current.canvas !== null) monitor.canvas = current.canvas;
        }
        if (!isPopulated(current.page, current.canvas)) {
          monitor.emptyFrames += 1;
          monitor.consecutivePopulatedFrames = 0;
        } else {
          monitor.consecutivePopulatedFrames += 1;
          monitor.maxPopulatedFrames = Math.max(
            monitor.maxPopulatedFrames,
            monitor.consecutivePopulatedFrames,
          );
        }
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
    await $('[data-control="fit-menu"]').click();
    await fitPage.waitForDisplayed({ timeout: 5_000 });
    expect(await displayedMenuOptionChecked('Fit page')).toBe(true);
    await browser.keys(['Escape']);

    await chooseMenuOption('Two pages');
    await chooseMenuOption('Continuous scrolling');
    await chooseMenuOption('Continuous scrolling');
    await $('[data-control="overflow"]').click();
    await $(
      '//*[contains(@class, "menu-item-title") and normalize-space(.)="Two pages"]',
    ).waitForDisplayed({ timeout: 5_000 });
    expect(await displayedMenuOptionChecked('Single page')).toBe(false);
    expect(await displayedMenuOptionChecked('Two pages')).toBe(true);
    expect(await displayedMenuOptionChecked('Continuous scrolling')).toBe(true);
    await browser.keys(['Escape']);
    await browser.execute(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          const waitForFrames = (): void => {
            frames += 1;
            if (frames >= 6) resolve();
            else requestAnimationFrame(waitForFrames);
          };
          requestAnimationFrame(waitForFrames);
        }),
    );

    const render = await browser.execute(() => {
      const taskWindow = window as Window & {
        __abyssTask6RenderMonitor?: {
          active: boolean;
          emptyFrames: number;
          frame: number;
          loadingFrames: number;
          maxPopulatedFrames: number;
          observer: MutationObserver;
          removalWithoutPopulatedReplacement: number;
          replacementCount: number;
          samples: number;
          shellIdentityBreaks: number;
          trackedSurfaceRemovals: number;
        };
      };
      const monitor = taskWindow.__abyssTask6RenderMonitor;
      if (monitor === undefined) throw new Error('Render monitor is unavailable.');
      monitor.active = false;
      cancelAnimationFrame(monitor.frame);
      monitor.observer.disconnect();
      delete taskWindow.__abyssTask6RenderMonitor;
      return {
        emptyFrames: monitor.emptyFrames,
        loadingFrames: monitor.loadingFrames,
        maxPopulatedFrames: monitor.maxPopulatedFrames,
        removalWithoutPopulatedReplacement: monitor.removalWithoutPopulatedReplacement,
        replacementCount: monitor.replacementCount,
        samples: monitor.samples,
        shellIdentityBreaks: monitor.shellIdentityBreaks,
        trackedSurfaceRemovals: monitor.trackedSurfaceRemovals,
      };
    });
    expect(render.samples).toBeGreaterThanOrEqual(5);
    expect(render.maxPopulatedFrames).toBeGreaterThanOrEqual(5);
    expect(render).toMatchObject({
      emptyFrames: 0,
      loadingFrames: 0,
      removalWithoutPopulatedReplacement: 0,
      replacementCount: 0,
      shellIdentityBreaks: 0,
      trackedSurfaceRemovals: 0,
    });
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
    await closeReaders();
    await openPdf('Documents/text-700-pages.pdf');
    await expect($('[data-control="page-total"]')).toHaveText('/ 700');

    for (const width of [1440, 1024, 768, 480, 390]) {
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
        const visibleTools = Array.from(
          toolbar.querySelectorAll<HTMLElement>('[data-annotation-tool]'),
        )
          .filter((element) => element.offsetParent !== null)
          .map((element) => element.dataset['annotationTool']);
        return {
          centers,
          clientWidth: toolbar.clientWidth,
          directPageNavigation: ['previous-page', 'page-field', 'next-page'].every(
            (control) =>
              toolbar.querySelector<HTMLElement>(`[data-control="${control}"]`)?.offsetParent !==
              null,
          ),
          fitVisible: fit?.offsetParent !== null,
          overflowVisible:
            toolbar.querySelector<HTMLElement>('[data-control="overflow"]')?.offsetParent !== null,
          scrollWidth: toolbar.scrollWidth,
          visibleTools,
        };
      }, width);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(Math.max(...geometry.centers) - Math.min(...geometry.centers)).toBeLessThanOrEqual(1);
      expect(geometry.fitVisible).toBe(width > 760);
      expect(geometry.directPageNavigation).toBe(true);
      expect(geometry.overflowVisible).toBe(true);
      expect(geometry.visibleTools).toEqual(
        width <= 600 ? ['highlight'] : ['highlight', 'ink', 'freetext'],
      );

      await $('[data-control="overflow"]').click();
      await $('.menu').waitForDisplayed({ timeout: 3_000 });
      const toolTitles = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '.menu .menu-item[data-section="abyss-documents-tools"]:not(.is-label) .menu-item-title',
          ),
          (item) => item.textContent.trim(),
        ),
      );
      expect(toolTitles).toEqual(width <= 600 ? ['Ink', 'Text'] : []);
      const menuText = await $('.menu').getText();
      expect(menuText).not.toContain('Previous page');
      expect(menuText).not.toContain('Next page');
      await $('[data-control="overflow"]').click();
      await expect($('.menu')).not.toBeDisplayed();
    }
  });
});
