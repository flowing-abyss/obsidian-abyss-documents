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

async function countDisplayedExactTooltips(expected: string): Promise<number> {
  let count = 0;
  for (const tooltip of await Promise.resolve(browser.$$('.tooltip'))) {
    if ((await tooltip.isDisplayed()) && (await tooltip.getText()).trim() === expected) count += 1;
  }
  return count;
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
    let displayedTooltipFound = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
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
      await browser.pause(350);
      if ((await countDisplayedExactTooltips('Toggle sidebar')) > 0) {
        displayedTooltipFound = true;
        break;
      }
    }
    expect(displayedTooltipFound).toBe(true);
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

    const quick = $('[data-annotation-tool="highlight"]');
    await expect(quick).toHaveAttribute('aria-pressed', 'false');
    await expect(quick).toHaveAttribute('aria-label', expect.stringContaining('Yellow'));
    await quick.click();
    await expect(quick).toHaveAttribute('aria-pressed', 'true');

    const quickMenu = $('[data-control="quick-highlight-menu"]');
    await quickMenu.click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    await expect($('.menu')).toHaveText(expect.stringContaining('Yellow'));
    await $('[data-control="page-field"]').click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect(quickMenu).toHaveAttribute('aria-expanded', 'false');
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
});
