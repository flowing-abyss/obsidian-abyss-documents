import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';
import {
  captureAnnotationSaveBaseline,
  isVerifiedAnnotationSaveSettled,
  readAnnotationSaveLifecycleSnapshot,
  type AnnotationSaveBaseline,
} from './annotation-save-oracle.js';

const pluginId = 'abyss-documents';

interface MobileRuntimeMetrics {
  readonly activeAnnotationOperations: {
    readonly serializations: number;
    readonly writes: number;
  };
  readonly counters: {
    readonly annotationSaveFailures: number;
    readonly annotationSaveRecoveries: number;
    readonly annotationSaves: number;
    readonly maxAnnotationCards: number;
    readonly maxAnnotationPanelNodes: number;
    readonly maxConcurrentSerializations: number;
    readonly maxConcurrentWrites: number;
    readonly workerUrlsActive: number;
    readonly workersStarted: number;
  };
}

async function openPdf(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, documentPath) => {
    await app.workspace.openLinkText(documentPath, '', false);
  }, path);
  await $('[data-abyss-document]').waitForDisplayed({ timeout: 20_000 });
}

async function waitForFirstPage(): Promise<void> {
  await $('[data-page-number="1"] canvas').waitForExist({ timeout: 20_000 });
}

async function closeReaderLeaves(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    for (const leaf of app.workspace.getLeavesOfType('abyss-document-view')) {
      await leaf.setViewState({ type: 'empty', state: {} });
    }
  });
}

async function resetWorkingPdf(sourcePath: string, targetPath: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      const source = app.vault.getFileByPath(input.sourcePath);
      if (source === null) throw new Error(`Fixture unavailable: ${input.sourcePath}`);
      const existing = app.vault.getAbstractFileByPath(input.targetPath);
      if (existing !== null) await app.fileManager.trashFile(existing);
      await app.vault.createBinary(input.targetPath, await app.vault.readBinary(source));
    },
    { sourcePath, targetPath },
  );
}

async function runtimeMetrics(): Promise<MobileRuntimeMetrics> {
  return browser.execute(() => {
    const metrics = (window as Window & { __abyssDocumentsPerformance?: MobileRuntimeMetrics })
      .__abyssDocumentsPerformance;
    if (metrics === undefined) throw new Error('Reader instrumentation is unavailable.');
    return metrics;
  });
}

async function waitForAnnotationSave(baseline: AnnotationSaveBaseline): Promise<void> {
  await browser.waitUntil(
    async () =>
      isVerifiedAnnotationSaveSettled(await readAnnotationSaveLifecycleSnapshot(), baseline),
    {
      timeout: 20_000,
      timeoutMsg: 'Android annotation save did not reach a verified settled state.',
    },
  );
}

async function vaultFileSha256(path: string): Promise<string> {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const file = app.vault.getFileByPath(filePath);
    if (file === null) throw new Error(`PDF unavailable: ${filePath}`);
    const bytes = await app.vault.readBinary(file);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }, path);
}

describe('PDF reader foundation on Android', () => {
  afterEach(async () => {
    await closeReaderLeaves();
  });

  it('uses an overlay sidebar and a pinch-capable PDF viewer', async () => {
    await openPdf('Documents/text-12-pages.pdf');

    await $('[data-control="sidebar"]').click();
    await expect($('[data-region="sidebar"]')).toHaveElementClass('is-mobile');
    await expect($('[data-pinch-capable="true"]')).toExist();
  });

  it('opens a raster-heavy PDF without a Node runtime dependency', async () => {
    await openPdf('Documents/raster-heavy-24-pages.pdf');

    await expect($('[data-page-number="1"] canvas')).toExist();
    const pluginUsesNodeGlobals = await browser.execute(() =>
      Boolean(
        document.querySelector('[data-abyss-document]')?.getAttribute('data-runtime-node-api'),
      ),
    );
    expect(pluginUsesNodeGlobals).toBe(false);
  });

  it('exposes only supported annotation tools and round-trips a native Highlight', async () => {
    const workingPath = 'Documents/android-e2e-highlight.pdf';
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
    await waitForFirstPage();

    expect(
      await $$('[data-region="annotation-toolbar"] [data-annotation-tool]').map((button) =>
        button.getAttribute('data-annotation-tool'),
      ),
    ).toEqual(['select', 'highlight', 'ink', 'freetext']);
    await expect($('[data-annotation-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
    await expect($('[data-annotation-tool="underline"]')).not.toExist();
    await expect($('[data-annotation-tool="text-note"]')).not.toExist();
    const compactToolbar = await browser.execute(() => {
      const toolbar = document.querySelector<HTMLElement>('.abyss-reader-toolbar');
      const highlight = toolbar?.querySelector<HTMLElement>('[data-annotation-tool="highlight"]');
      const disclosure = toolbar?.querySelector<HTMLElement>(
        '[data-control="quick-highlight-menu"]',
      );
      const navigation = toolbar?.querySelector<HTMLElement>('.abyss-reader-toolbar-navigation');
      const zones = Array.from(
        toolbar?.querySelectorAll<HTMLElement>(':scope > [data-toolbar-zone]') ?? [],
      );
      if (
        toolbar === null ||
        highlight == null ||
        disclosure == null ||
        navigation == null ||
        zones.length !== 3
      )
        throw new Error('Mobile annotation split is missing.');
      const mainBounds = highlight.getBoundingClientRect();
      const disclosureBounds = disclosure.getBoundingClientRect();
      const navigationBounds = navigation.getBoundingClientRect();
      const toolbarBounds = toolbar.getBoundingClientRect();
      const toolbarStyle = getComputedStyle(toolbar);
      const toolbarContentMidpoint =
        (toolbarBounds.left +
          Number.parseFloat(toolbarStyle.paddingLeft) +
          toolbarBounds.right -
          Number.parseFloat(toolbarStyle.paddingRight)) /
        2;
      return {
        directPageNavigation: ['previous-page', 'page-field', 'next-page'].every(
          (control) =>
            toolbar.querySelector<HTMLElement>(`[data-control="${control}"]`)?.offsetParent !==
            null,
        ),
        disclosureHeight: disclosureBounds.height,
        disclosureWidth: disclosureBounds.width,
        mainHeight: mainBounds.height,
        mainWidth: mainBounds.width,
        navigationCenterDelta: Math.abs(
          navigationBounds.left + navigationBounds.width / 2 - toolbarContentMidpoint,
        ),
        noOverlap: mainBounds.right <= disclosureBounds.left,
        overflow: toolbar.scrollWidth > toolbar.clientWidth,
        visibleTools: Array.from(toolbar.querySelectorAll<HTMLElement>('[data-annotation-tool]'))
          .filter((button) => button.offsetParent !== null)
          .map((button) => button.dataset['annotationTool']),
        zones: zones.map((zone) => zone.dataset['toolbarZone']),
      };
    });
    expect(compactToolbar).toMatchObject({
      directPageNavigation: true,
      noOverlap: true,
      overflow: false,
      visibleTools: ['highlight'],
      zones: ['left', 'center', 'right'],
    });
    expect(compactToolbar.navigationCenterDelta).toBeLessThanOrEqual(2);
    expect(compactToolbar.mainHeight).toBeGreaterThanOrEqual(44);
    expect(compactToolbar.mainWidth).toBeGreaterThanOrEqual(44);
    expect(compactToolbar.disclosureHeight).toBeGreaterThanOrEqual(44);
    expect(compactToolbar.disclosureWidth).toBeGreaterThanOrEqual(24);

    await $('[data-control="overflow"]').click();
    await $('.menu').waitForDisplayed({ timeout: 3_000 });
    const compactTools = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.menu .menu-item[data-section="abyss-documents-tools"]:not(.is-label) .menu-item-title',
        ),
        (item) => item.textContent.trim(),
      ),
    );
    expect(compactTools).toEqual(['Ink', 'Text']);
    const moreMenu = await $('.menu').getText();
    expect(moreMenu).toContain('Layout');
    expect(moreMenu).toContain('Fit page');
    expect(moreMenu).toContain('Two pages');
    expect(moreMenu).toContain('Appearance');
    expect(moreMenu).toContain('Default');
    expect(moreMenu).toContain('Export annotations');
    expect(moreMenu).not.toContain('OCR');
    expect(moreMenu).not.toContain('Previous page');
    const essentialMoreItems = await browser.execute(() => {
      const menu = document.querySelector<HTMLElement>('.menu');
      if (menu === null) throw new Error('Mobile More menu is missing.');
      const itemState = (item: HTMLElement) => {
        const bounds = item.getBoundingClientRect();
        return {
          ariaDisabled: item.getAttribute('aria-disabled') ?? null,
          clickable: item.offsetParent !== null && getComputedStyle(item).pointerEvents !== 'none',
          label: item.querySelector('.menu-item-title')?.textContent.trim() ?? '',
          reachable:
            bounds.top >= 0 &&
            bounds.bottom <= window.innerHeight &&
            bounds.left >= 0 &&
            bounds.right <= window.innerWidth,
        };
      };
      const actionable = (section: string) =>
        Array.from(
          menu.querySelectorAll<HTMLElement>(
            `.menu-item[data-section="${section}"]:not(.is-label)`,
          ),
          itemState,
        );
      return {
        appearance: actionable('abyss-documents-appearance'),
        export: actionable('abyss-documents-actions'),
        layout: actionable('abyss-documents-layout'),
      };
    });
    expect(essentialMoreItems.layout.map((item) => item.label)).toEqual([
      'Single page',
      'Two pages',
      'Continuous scrolling',
    ]);
    expect(essentialMoreItems.appearance.map((item) => item.label)).toEqual([
      'Default',
      'Follow Obsidian',
      'Light',
      'Sepia',
      'Dark',
      'Custom',
    ]);
    expect(essentialMoreItems.export.map((item) => item.label)).toEqual(['Export annotations…']);
    expect(
      [
        ...essentialMoreItems.layout,
        ...essentialMoreItems.appearance,
        ...essentialMoreItems.export,
      ].every((item) => item.ariaDisabled === null && item.clickable && item.reachable),
    ).toBe(true);
    await $(
      '//*[contains(@class, "menu-item-title") and normalize-space(.)="Single page"]',
    ).click();
    await expect($('.menu')).not.toBeDisplayed();
    await $('[data-control="overflow"]').click();
    await $('//*[contains(@class, "menu-item-title") and normalize-space(.)="Default"]').click();
    await expect($('.menu')).not.toBeDisplayed();
    await expect($('[data-abyss-document]')).toHaveAttribute('data-reading-profile', 'default');
    const saveBaseline = await captureAnnotationSaveBaseline();

    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');
    await expect($('[data-region="annotation-toolbar"]')).toHaveAttribute(
      'data-annotation-mode',
      'sticky-highlight',
    );
    const selectedText = await browser.execute(() => {
      const text = document.querySelectorAll('[data-page-number="1"] .textLayer span')[1];
      if (text === undefined) throw new Error('Selectable mobile fixture text is unavailable.');
      const selectedText = text.textContent.trim();
      if (selectedText.length === 0) throw new Error('Selectable mobile fixture text is empty.');
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      text.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          clientX: 160,
          clientY: 200,
          pointerType: 'touch',
        }),
      );
      return selectedText;
    });
    await $('.highlightEditor').waitForExist({ timeout: 10_000 });
    await waitForAnnotationSave(saveBaseline);

    await closeReaderLeaves();
    await openPdf(workingPath);
    await waitForFirstPage();
    await $('.annotationLayer .highlightAnnotation').waitForExist({ timeout: 10_000 });
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await $('.abyss-annotation-card-text').waitForExist({ timeout: 10_000 });
    const savedHighlight = await browser.executeObsidian(({ app }) => {
      const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
        controller?: { currentAnnotations?: unknown[] };
      };
      return view.controller?.currentAnnotations?.find(
        (annotation) =>
          typeof annotation === 'object' &&
          annotation !== null &&
          (annotation as { type?: unknown }).type === 'highlight',
      );
    });
    expect(savedHighlight).toMatchObject({
      anchor: {
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'quadrilaterals' },
        kind: 'fixed-page',
        pageIndex: 0,
      },
      color: '#ffd400',
      selectedText,
      type: 'highlight',
    });
    const quadrilaterals = (
      savedHighlight as {
        anchor?: {
          geometry?: { quadrilaterals?: Array<Record<string, { x: number; y: number }>> };
        };
      }
    ).anchor?.geometry?.quadrilaterals;
    expect(quadrilaterals?.length).toBeGreaterThan(0);
    const corners = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;
    expect(
      quadrilaterals?.every((quad) =>
        corners.every(
          (corner) => Number.isFinite(quad[corner]?.x) && Number.isFinite(quad[corner]?.y),
        ),
      ),
    ).toBe(true);
    await expect(
      $('[data-sidebar-panel="annotations"] [data-annotation-color="#ffd400"]'),
    ).toExist();
    expect((await runtimeMetrics()).counters).toMatchObject({
      maxConcurrentSerializations: 1,
      maxConcurrentWrites: 1,
    });
  });

  it('keeps the ten-thousand-annotation mobile panel bounded', async () => {
    await openPdf('Documents/annotations-10000.pdf');
    await waitForFirstPage();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await browser.waitUntil(
      async () => (await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) === '10000',
      {
        timeout: 30_000,
        timeoutMsg: 'Android did not index all ten thousand annotations.',
      },
    );

    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize({ lte: 80 });
    const footer = await browser.execute(() => {
      const annotationFooter = document.querySelector<HTMLElement>('[data-annotation-footer]');
      const colors = annotationFooter?.querySelector<HTMLElement>('[data-section="colors"]');
      if (annotationFooter === null || colors == null)
        throw new Error('Mobile color footer is missing.');
      return {
        height: colors.getBoundingClientRect().height,
        labelAbsent: colors.querySelector('[data-annotation-colors-label]') === null,
        onlyColors:
          annotationFooter.childElementCount === 1 &&
          annotationFooter.firstElementChild === colors &&
          annotationFooter.querySelector('[data-section="tags"]') === null,
      };
    });
    expect(footer).toMatchObject({ labelAbsent: true, onlyColors: true });
    expect(footer.height).toBeLessThanOrEqual(44);
    const maximumCards = (await runtimeMetrics()).counters.maxAnnotationCards;
    expect(maximumCards).toBeGreaterThan(0);
    expect(maximumCards).toBeLessThanOrEqual(80);
  });

  for (const qualification of [
    {
      comment: 'Signed #secure',
      message: 'Signed PDF documents are opened read-only to preserve signatures.',
      path: 'Documents/signed-document.pdf',
    },
    {
      comment: 'Restricted #secure',
      message: 'This PDF does not grant permission to modify its contents.',
      path: 'Documents/permission-restricted.pdf',
    },
  ]) {
    it(`keeps ${qualification.path} read-only and byte-identical`, async () => {
      const before = await vaultFileSha256(qualification.path);
      await openPdf(qualification.path);
      await waitForFirstPage();

      await expect($('[data-region="annotation-read-only-reason"]')).toHaveText(
        qualification.message,
      );
      expect(
        await browser.execute(() => {
          const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[data-region="annotation-toolbar"] button',
            ),
          );
          const select = buttons.find((button) => button.dataset['annotationTool'] === 'select');
          const editors = buttons.filter((button) => button.dataset['annotationTool'] !== 'select');
          return (
            select?.disabled === false &&
            editors.length > 0 &&
            editors.every((button) => button.disabled)
          );
        }),
      ).toBe(true);
      await $('[data-control="sidebar"]').click();
      await $('[data-tab="annotations"]').click();
      await expect($('[data-sidebar-panel="annotations"]')).toHaveText(
        expect.stringContaining(qualification.comment),
      );
      await browser.execute((comment) => {
        const card = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.abyss-annotation-card'),
        ).find((candidate) => candidate.innerText.includes(comment));
        if (card === undefined) throw new Error(`Read-only mobile card is missing: ${comment}`);
        card.dataset['mobileContextTarget'] = '';
      }, qualification.comment);
      const popover = $('[data-annotation-editor-popover]');
      const target = await browser.execute(() => {
        const card = document.querySelector<HTMLElement>('[data-mobile-context-target]');
        if (card === null) throw new Error('Read-only mobile context target disappeared.');
        const bounds = card.getBoundingClientRect();
        return {
          x: Math.round(bounds.left + bounds.width / 2),
          y: Math.round(bounds.top + bounds.height / 2),
        };
      });
      try {
        await browser.performActions([
          {
            type: 'pointer',
            id: 'annotation-card-short-tap',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, origin: 'viewport', ...target },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 50 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ]);
      } finally {
        await browser.releaseActions();
      }
      await expect(popover).not.toBeDisplayed();
      try {
        await browser.performActions([
          {
            type: 'pointer',
            id: 'annotation-card-long-press',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, origin: 'viewport', ...target },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 650 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ]);
      } finally {
        await browser.releaseActions();
      }
      await popover.waitForDisplayed({ timeout: 5_000 });
      const readOnlyGeometry = await browser.execute(() => {
        const editor = document.querySelector<HTMLElement>('[data-annotation-editor-popover]');
        const card = document.querySelector<HTMLElement>(
          '.abyss-annotation-card[aria-current="true"]',
        );
        const metadata = editor?.querySelector<HTMLElement>(
          '.abyss-annotation-editor-readonly-metadata',
        );
        if (editor === null || card === null || metadata == null)
          throw new Error('Read-only mobile annotation geometry is incomplete.');
        const bounds = editor.getBoundingClientRect();
        return {
          cardHeight: card.getBoundingClientRect().height,
          editableControls: Array.from(
            editor.querySelectorAll<HTMLElement>(
              '[aria-label="Comment"], [data-editor-color], [data-action="delete-annotation"]',
            ),
          ).filter((element) => element.offsetParent !== null).length,
          edgeInset: Math.min(
            bounds.left,
            bounds.top,
            window.innerWidth - bounds.right,
            window.innerHeight - bounds.bottom,
          ),
          label: editor.getAttribute('aria-label'),
          metadataVisible: !metadata.hidden,
          width: bounds.width,
        };
      });
      expect(readOnlyGeometry).toMatchObject({
        editableControls: 0,
        label: 'Annotation details',
        metadataVisible: true,
      });
      expect(readOnlyGeometry.cardHeight).toBeLessThanOrEqual(152);
      expect(readOnlyGeometry.edgeInset).toBeGreaterThanOrEqual(8);
      expect(readOnlyGeometry.width).toBeLessThanOrEqual(320);
      await browser.keys(Key.Escape);
      await expect(popover).not.toBeDisplayed();
      expect(await vaultFileSha256(qualification.path)).toBe(before);
    });
  }

  it('revokes the PDF worker when the plugin is disabled', async () => {
    await openPdf('Documents/text-12-pages.pdf');
    await waitForFirstPage();
    const beforeDisable = (await runtimeMetrics()).counters;
    expect(beforeDisable.workerUrlsActive).toBe(1);
    expect(beforeDisable.workersStarted).toBeGreaterThan(0);

    const obsidian = browser.getObsidianPage();
    try {
      await obsidian.disablePlugin(pluginId);
      expect((await runtimeMetrics()).counters.workerUrlsActive).toBe(0);
      await expect($('[data-abyss-document]')).not.toExist();
    } finally {
      await obsidian.enablePlugin(pluginId);
    }
  });
});
