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

async function touchMenu(control: string): Promise<void> {
  await $(`[data-control="${control}"]`).waitForExist({ timeout: 15_000 });
  const openings = await browser.execute(async (targetControl) => {
    const target = document.querySelector<HTMLElement>(`[data-control="${targetControl}"]`);
    if (target === null) throw new Error(`Touch menu trigger unavailable: ${targetControl}`);
    const bounds = target.getBoundingClientRect();
    let menuAdditions = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of Array.from(record.addedNodes)) {
          if (!added.instanceOf(Element)) continue;
          if (added.matches('.menu')) menuAdditions += 1;
          menuAdditions += added.querySelectorAll('.menu').length;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const eventData = {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    };
    target.dispatchEvent(
      new PointerEvent('pointerdown', {
        ...eventData,
        isPrimary: true,
        pointerId: 41,
        pointerType: 'touch',
      }),
    );
    target.dispatchEvent(
      new PointerEvent('pointerup', {
        ...eventData,
        isPrimary: true,
        pointerId: 41,
        pointerType: 'touch',
      }),
    );
    target.dispatchEvent(new MouseEvent('click', { ...eventData, button: 0, detail: 1 }));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    observer.disconnect();
    return menuAdditions;
  }, control);
  expect(openings).toBe(1);
  await $('.menu').waitForDisplayed({ timeout: 3_000 });
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
      const visible = Array.from(
        toolbar.querySelectorAll<HTMLElement>(
          '[data-toolbar-control], [data-control-group], [data-control="page-field"], [data-control="page-total"]',
        ),
      ).filter((element) => element.offsetParent !== null);
      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        controls: visible.map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            center: bounds.top + bounds.height / 2,
            height: bounds.height,
            width: bounds.width,
          };
        }),
        innerWidth: window.innerWidth,
        overflow: toolbar.scrollWidth - toolbar.clientWidth,
      };
    });
    expect(geometry.coarse).toBe(true);
    expect(geometry.innerWidth).toBe(390);
    expect(geometry.overflow).toBeLessThanOrEqual(0);
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
            width: bounds.width,
          };
        }),
    );
    expect(touchControls.filter(({ height, width }) => height < 44 || width < 44)).toEqual([]);

    await touchMenu('quick-highlight-menu');
    await expect($('[data-control="quick-highlight-menu"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await $('.suggestion-bg').click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'false');

    await touchMenu('overflow');
    await expect($('.menu')).toHaveText(expect.stringContaining('Fit page'));
    await browser.keys(['Escape']);
    await expect($('.menu')).not.toBeDisplayed();
  });
});
