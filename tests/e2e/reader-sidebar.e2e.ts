import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { join } from 'node:path';
import { env, pid } from 'node:process';
import type { Browser as PuppeteerBrowser } from 'puppeteer-core';
import { Key } from 'webdriverio';
import { startDeleteTimeline } from './delete-timeline-diagnostics.js';
import { waitForPdfPageReady } from './pdf-ready.js';

import {
  installTenThousandDeleteFrameTrace,
  installTenThousandDeleteTrace,
  measureNextAnnotationCardNavigation,
  readTenThousandDeleteFrameStatus,
  readTenThousandDeleteFrameTrace,
  readTenThousandDeleteStatus,
  readTenThousandDeleteTrace,
  waitForAnimationFrames,
  waitForAnnotationProjectionToSettle,
  type TenThousandDeleteFrameTrace,
  type TenThousandDeleteStatus,
  type TenThousandDeleteTarget,
  type TenThousandDeleteTrace,
} from './annotation-performance-oracle';

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

async function resetWorkingPdf(sourcePath: string, targetPath: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      const bytes = await app.vault.adapter.readBinary(input.sourcePath);
      const existing = app.vault.getAbstractFileByPath(input.targetPath);
      if (existing !== null) await app.fileManager.trashFile(existing);
      await app.vault.createBinary(input.targetPath, bytes);
    },
    { sourcePath, targetPath },
  );
}

async function dragFixtureText(): Promise<void> {
  await waitForPdfPageReady();
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }) => {
        const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
          containerEl?: HTMLElement;
          controller?: {
            viewport?: {
              annotationEditorInstance?: {
                manager?: {
                  getLayer?(
                    pageIndex: number,
                  ): { hasTextLayer?(layer: HTMLElement): boolean } | undefined;
                };
              };
            };
          };
        };
        const root = view.containerEl?.querySelector<HTMLElement>('[data-abyss-document]');
        const textLayer = root?.querySelector<HTMLElement>('[data-page-number="1"] .textLayer');
        return (
          textLayer instanceof HTMLElement &&
          root?.querySelectorAll('[data-page-number="1"] .textLayer span')[1] !== undefined &&
          view.controller?.viewport?.annotationEditorInstance?.manager
            ?.getLayer?.(0)
            ?.hasTextLayer?.(textLayer) === true
        );
      }),
    { timeout: 10_000, timeoutMsg: 'PDF.js editor did not bind to selectable fixture text.' },
  );
  const points = await browser.execute(async () => {
    const text = document.querySelectorAll<HTMLElement>(
      '[data-page-number="1"] .textLayer span',
    )[1];
    if (text === undefined) throw new Error('Selectable fixture text is missing.');
    const bounds = text.getBoundingClientRect();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    return {
      end: {
        x: Math.round(bounds.left + bounds.width * 0.8),
        y: Math.round(bounds.top + bounds.height / 2),
      },
      start: {
        x: Math.round(bounds.left + bounds.width * 0.2),
        y: Math.round(bounds.top + bounds.height / 2),
      },
    };
  });
  try {
    await browser.performActions([
      {
        type: 'pointer',
        id: 'sidebar-search-native-selection',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', ...points.start },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 400, origin: 'viewport', ...points.end },
          { type: 'pause', duration: 150 },
        ],
      },
    ]);
    const selectedText = await browser.execute(
      () => window.getSelection()?.toString().trim() ?? '',
    );
    if (selectedText.length === 0) throw new Error('Trusted PDF text drag selected nothing.');
    await browser.performActions([
      {
        type: 'pointer',
        id: 'sidebar-search-native-selection',
        parameters: { pointerType: 'mouse' },
        actions: [{ type: 'pointerUp', button: 0 }],
      },
    ]);
  } finally {
    await browser.releaseActions();
  }
}

async function pdfAnnotationSnapshot(requestedStorageId: string | null = null): Promise<{
  readonly color: string | null;
  readonly count: number;
  readonly deleted: boolean;
  readonly storageId: string;
}> {
  return browser.executeObsidian(({ app }, requestedId) => {
    const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
      controller?: {
        viewport?: {
          annotationEditorInstance?: {
            manager?: {
              firstSelectedEditor?: { readonly id?: string; readonly uid?: string } | null;
            } | null;
          };
          pdf?: {
            annotationStorage?: {
              readonly size: number;
              getRawValue(
                key: string,
              ): { readonly color?: string; readonly deleted?: boolean } | undefined;
              has(key: string): boolean;
            };
          } | null;
        };
      };
    };
    const viewport = view.controller?.viewport;
    const selected = viewport?.annotationEditorInstance?.manager?.firstSelectedEditor ?? null;
    const storage = viewport?.pdf?.annotationStorage ?? null;
    const storageId =
      requestedId ??
      [selected?.id, selected?.uid].find(
        (id) => typeof id === 'string' && id.length > 0 && storage?.has(id) === true,
      ) ??
      null;
    const annotation = storageId === null ? undefined : storage?.getRawValue(storageId);
    if (
      (requestedId === null && selected === null) ||
      storage === null ||
      storageId === null ||
      annotation === undefined
    )
      throw new Error(
        `Expected a stored PDF.js annotation: ${JSON.stringify({
          hasEditorInstance: viewport?.annotationEditorInstance !== undefined,
          hasManager: viewport?.annotationEditorInstance?.manager != null,
          hasStoredAnnotation: annotation !== undefined,
          selectedEditorCount: document.querySelectorAll('.annotationEditorLayer .selectedEditor')
            .length,
          storageId,
          storageSize: storage?.size ?? null,
          visiblePopoverCount: Array.from(
            document.querySelectorAll<HTMLElement>('[data-annotation-editor-popover]'),
          ).filter((popover) => popover.hidden === false).length,
        })}`,
      );
    return {
      color: annotation.color ?? null,
      count: storage.size,
      deleted: annotation.deleted === true,
      storageId,
    };
  }, requestedStorageId);
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

async function readerLayoutIsStable(): Promise<boolean> {
  const sample = (): readonly number[] | null => {
    const reader = document.querySelector<HTMLElement>('.abyss-documents');
    const body = document.querySelector<HTMLElement>('.abyss-reader-body');
    const documentHost = document.querySelector<HTMLElement>('[data-region="document"]');
    if (reader === null || body === null || documentHost === null) return null;
    return [
      reader.getBoundingClientRect().width,
      body.getBoundingClientRect().width,
      documentHost.getBoundingClientRect().width,
    ];
  };
  const first = sample();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
  const second = sample();
  return (
    first !== null &&
    second !== null &&
    first.every((value, index) => value > 0 && Math.abs(value - (second[index] ?? 0)) <= 0.5)
  );
}

async function waitForReaderLayoutToSettle(): Promise<void> {
  await browser.waitUntil(async () => browser.execute(readerLayoutIsStable), {
    interval: 50,
    timeout: 3_000,
    timeoutMsg: 'Reader split layout did not settle across animation frames.',
  });
}

async function scrollAnnotationListByViewport(): Promise<void> {
  await browser.execute(() => {
    const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
    if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
    scrollHost.scrollTop += Math.max(scrollHost.clientHeight * 2, 2_000);
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
        __abyssTask6SidebarMonitor?: {
          cleanup(): Record<string, number>;
          snapshot(): Record<string, number>;
        };
      }
    ).__abyssTask6SidebarMonitor = {
      cleanup() {
        processRecords(observer.takeRecords());
        observer.disconnect();
        return { ...state };
      },
      snapshot() {
        processRecords(observer.takeRecords());
        return { ...state };
      },
    };
  });
}

async function assertSidebarContinuityMonitor(): Promise<void> {
  let lastMetrics: Record<string, number> = {};
  let previousMutationRecords = -1;
  let stableFrames = 0;
  try {
    await browser.waitUntil(
      async () => {
        await waitForAnimationFrames(2);
        lastMetrics = await browser.execute(() => {
          const monitor = (
            window as Window & {
              __abyssTask6SidebarMonitor?: { snapshot(): Record<string, number> };
            }
          ).__abyssTask6SidebarMonitor;
          if (monitor === undefined) throw new Error('Sidebar continuity monitor is unavailable.');
          return monitor.snapshot();
        });
        const mutationRecords = lastMetrics['mutationRecords'] ?? 0;
        stableFrames =
          mutationRecords > 0 && mutationRecords === previousMutationRecords ? stableFrames + 1 : 0;
        previousMutationRecords = mutationRecords;
        return stableFrames >= 1;
      },
      {
        interval: 0,
        timeout: 5_000,
        timeoutMsg: 'Sidebar continuity mutations did not settle across animation frames.',
      },
    );
  } catch (cause) {
    throw new Error(
      `Sidebar continuity mutations did not settle: ${JSON.stringify(lastMetrics)}; ${String(cause)}`,
    );
  }
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

async function prepareTenThousandDeleteScenario(): Promise<TenThousandDeleteTarget> {
  const workingPath = 'Documents/e2e-annotations-10000-delete.pdf';
  await resetWorkingPdf('Documents/annotations-10000.pdf', workingPath);
  await openAnnotations(workingPath);
  await browser.waitUntil(
    async () => (await $('.abyss-annotation-card-row').getAttribute('aria-setsize')) === '10000',
    { timeout: 15_000, timeoutMsg: 'Annotation delete fixture did not load ten thousand items.' },
  );
  await waitForAnnotationWindowToSettle();
  await waitForAnimationFrames(5);

  expect(await measureNextAnnotationCardNavigation()).toBeLessThan(250);
  await browser.keys(Key.ArrowUp);
  await browser.waitUntil(
    async () =>
      browser.execute(
        () =>
          document.activeElement
            ?.closest('.abyss-annotation-card-row')
            ?.getAttribute('aria-posinset') === '1',
      ),
    { timeout: 2_000, timeoutMsg: 'Delete target card did not regain keyboard focus.' },
  );

  const target = await browser.execute(() => {
    const card = document.querySelector<HTMLButtonElement>('.abyss-annotation-card[tabindex="0"]');
    const rowId = card?.dataset['annotationRowId'];
    const annotationId = card?.dataset['annotationId'];
    if (card === null || rowId === undefined || annotationId === undefined)
      throw new Error('Delete target identity is incomplete.');
    return { annotationId, rowId };
  });
  await $('.abyss-annotation-card[tabindex="0"]').click({ button: 'right' });
  await expect($('[data-annotation-editor-popover]')).toBeDisplayed();
  await expect($('[data-action="delete-annotation"]')).toBeEnabled();
  await waitForAnnotationProjectionToSettle();
  await waitForAnimationFrames(5);
  return target;
}

async function deleteAnnotationAndExpectFirstFrame(target: TenThousandDeleteTarget): Promise<void> {
  // Prime each monitor before trusted input; its first raw timestamp stays in the interval window.
  await waitForAnimationFrames(1);
  await $('[data-action="delete-annotation"]').click();
  const firstFrame = await browser.execute(
    (rowId) =>
      new Promise<{ readonly cards: number; readonly targetPresent: boolean }>((resolve) => {
        requestAnimationFrame(() => {
          const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
          resolve({
            cards: panel?.querySelectorAll('.abyss-annotation-card').length ?? 0,
            targetPresent:
              panel?.querySelector(
                `.abyss-annotation-card[data-annotation-row-id="${CSS.escape(rowId)}"]`,
              ) !== null,
          });
        });
      }),
    target.rowId,
  );
  expect(firstFrame.targetPresent).toBe(false);
  expect(firstFrame.cards).toBeGreaterThan(0);
}

async function waitForTenThousandDeleteConvergence(
  readStatus: () => Promise<TenThousandDeleteStatus>,
): Promise<void> {
  let lastStatus: TenThousandDeleteStatus | null = null;
  try {
    await browser.waitUntil(
      async () => {
        lastStatus = await readStatus();
        return (
          !lastStatus.targetPresent &&
          lastStatus.indexedBatches >= 1 &&
          lastStatus.settledFrames >= 5 &&
          lastStatus.setSize === 9_999
        );
      },
      {
        interval: 0,
        timeout: 10_000,
        timeoutMsg: 'Ten-thousand delete projection did not converge.',
      },
    );
  } catch (cause) {
    throw new Error(
      `Ten-thousand delete projection did not converge: ${JSON.stringify(lastStatus)}; ${String(cause)}`,
    );
  }
}

async function cleanupTenThousandDeleteFrameTrace(): Promise<TenThousandDeleteFrameTrace | null> {
  const exists = await browser.execute(
    () =>
      (window as Window & { __abyssTask7DeleteFrameTrace?: unknown })
        .__abyssTask7DeleteFrameTrace !== undefined,
  );
  return exists ? readTenThousandDeleteFrameTrace() : null;
}

describe('PDF reader sidebar', () => {
  beforeEach(closeReaderLeaves);
  afterEach(closeReaderLeaves);

  it('filters a searchable outline while retaining its ancestor path', async () => {
    await openOutline();

    const search = $('[data-outline-search]');
    await expect(search).toBeDisplayed();
    await expect($$('[data-outline-search]')).toBeElementsArrayOfSize(1);
    await expect($('[data-action="toggle-outline-search"]')).not.toExist();
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
    expect(Math.min(...geometry.chevronHeights)).toBeGreaterThanOrEqual(26);
    expect(Math.max(...geometry.chevronHeights)).toBeLessThanOrEqual(28);
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
      await waitForReaderLayoutToSettle();
      await waitForPdfPageReady();
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
          bodyRight: bodyRect.right,
          documentWidth: documentHost.getBoundingClientRect().width,
          readerWidth: reader.getBoundingClientRect().width,
          sidebarLeft: sidebarRect.left,
          sidebarPosition: getComputedStyle(sidebar).position,
          sidebarRight: sidebarRect.right,
          sidebarWidth: sidebarRect.width,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.viewportWidth).toBeGreaterThan(600);
      expect(geometry.readerWidth).toBeLessThanOrEqual(600);
      expect(geometry.sidebarPosition).toBe('absolute');
      expect(Math.abs(geometry.sidebarLeft - geometry.bodyLeft)).toBeLessThanOrEqual(1);
      expect(geometry.sidebarRight).toBeLessThanOrEqual(geometry.bodyRight + 1);
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

  it('keeps one shared searchbox in the empty annotation state', async () => {
    await openAnnotations('Documents/outline-20-pages.pdf');

    const status = $('[data-annotations-status]');
    await expect(status).toHaveText('No annotations');
    const search = $('[data-annotation-search]');
    await expect(search).toBeDisplayed();
    await expect($$('[data-annotation-search]')).toBeElementsArrayOfSize(1);
    await expect(search).toHaveAttribute('role', 'searchbox');
    await expect(search).toHaveAttribute('aria-label', 'Filter annotations');
    await expect(search).toHaveAttribute('placeholder', 'Filter annotations');
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

  it('keeps trusted search editing local after dismissing contextual PDF editing', async () => {
    const workingPath = 'Documents/e2e-search-focus.pdf';
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openAnnotations(workingPath);
    await $('[data-annotation-tool="highlight"]').click();
    await dragFixtureText();
    const highlight = $('.highlightEditor');
    await highlight.waitForExist({ timeout: 10_000 });
    const annotationCard = $('.abyss-annotation-card');
    await annotationCard.waitForExist({ timeout: 10_000 });
    await annotationCard.click({ button: 'right' });
    const search = $('[data-annotation-search]');
    const popover = $('[data-annotation-editor-popover]');
    await expect(popover).toBeDisplayed();
    const before = await pdfAnnotationSnapshot();
    expect(before.deleted).toBe(false);
    const modifier = process.platform === 'darwin' ? Key.Command : Key.Control;

    await browser.execute(() => {
      const host = window as Window & {
        __abyssSearchFocusTrace?: { events: string[]; stop(): void };
      };
      const events: string[] = [];
      const listener = (event: FocusEvent): void => {
        const target = event.target;
        events.push(
          target instanceof HTMLElement
            ? `${performance.now().toFixed(1)}:${target.tagName}.${target.className}`
            : `${performance.now().toFixed(1)}:unknown`,
        );
      };
      document.addEventListener('focusin', listener, true);
      host.__abyssSearchFocusTrace = {
        events,
        stop: () => {
          document.removeEventListener('focusin', listener, true);
        },
      };
    });
    try {
      await search.click();
      let lastFocusState: {
        readonly focused: boolean;
        readonly hitInsideSearch: boolean;
        readonly popoverVisible: boolean;
      } | null = null;
      try {
        await browser.waitUntil(
          async () => {
            lastFocusState = await browser.execute(() => {
              const input = document.querySelector<HTMLInputElement>('[data-annotation-search]');
              const popover = document.querySelector<HTMLElement>(
                '[data-annotation-editor-popover]:not([hidden])',
              );
              if (input === null) throw new Error('Annotation search input disappeared.');
              const bounds = input.getBoundingClientRect();
              const hit = document.elementFromPoint(
                Math.round(bounds.left + bounds.width / 2),
                Math.round(bounds.top + bounds.height / 2),
              );
              return {
                focused: document.activeElement === input,
                hitInsideSearch: hit === input || input.contains(hit),
                popoverVisible: popover !== null,
              };
            });
            return (
              lastFocusState.focused &&
              lastFocusState.hitInsideSearch &&
              !lastFocusState.popoverVisible
            );
          },
          {
            timeout: 2_000,
            timeoutMsg: 'Annotation search did not acquire stable trusted focus.',
          },
        );
      } catch (cause) {
        throw new Error(
          `Annotation search did not acquire stable trusted focus: ${JSON.stringify(lastFocusState)}; ${String(cause)}`,
        );
      }
      const searchFocus = await browser.execute(() => {
        const host = window as Window & {
          __abyssSearchFocusTrace?: { events: string[]; stop(): void };
        };
        const input = document.querySelector<HTMLInputElement>('[data-annotation-search]');
        const popover = document.querySelector<HTMLElement>(
          '[data-annotation-editor-popover]:not([hidden])',
        );
        if (input === null) throw new Error('Annotation search input disappeared.');
        const focusEvents = [...(host.__abyssSearchFocusTrace?.events ?? [])];
        host.__abyssSearchFocusTrace?.stop();
        delete host.__abyssSearchFocusTrace;
        const bounds = input.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(bounds.left + bounds.width / 2),
          Math.round(bounds.top + bounds.height / 2),
        );
        const popoverBounds = popover?.getBoundingClientRect();
        return {
          activeElement:
            document.activeElement instanceof HTMLElement
              ? {
                  className: document.activeElement.className,
                  tagName: document.activeElement.tagName,
                }
              : null,
          focused: document.activeElement === input,
          focusEvents,
          hit:
            hit instanceof HTMLElement
              ? {
                  className: hit.className,
                  insidePopover: popover?.contains(hit) ?? false,
                  insideSearch: input.contains(hit) || hit === input,
                  tagName: hit.tagName,
                }
              : null,
          popoverBounds:
            popoverBounds === undefined
              ? null
              : {
                  bottom: popoverBounds.bottom,
                  left: popoverBounds.left,
                  right: popoverBounds.right,
                  top: popoverBounds.top,
                },
          searchBounds: {
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
          },
        };
      });
      if (!searchFocus.focused || searchFocus.hit?.insideSearch !== true)
        throw new Error(`Annotation search was not reachable: ${JSON.stringify(searchFocus)}`);
      await browser.keys([modifier, 'a']);
      await browser.keys('trusted typing');
      const typed = await search.getValue();
      if (typed !== 'trusted typing')
        throw new Error(
          `Trusted annotation search input was intercepted: ${JSON.stringify({
            actual: typed,
            expected: 'trusted typing',
            searchFocus,
          })}`,
        );

      await browser.keys(Key.Backspace);
      expect(await search.getValue()).toBe(typed.slice(0, -1));

      await browser.keys([modifier, 'a']);
      await browser.keys('replacement');
      await expect(search).toHaveValue('replacement');
      await browser.keys([modifier, 'z']);
      expect(await search.getValue()).toBe('replacemen');
      expect(await pdfAnnotationSnapshot(before.storageId)).toEqual(before);
      await browser.keys(
        process.platform === 'darwin' ? [modifier, Key.Shift, 'z'] : [modifier, 'y'],
      );
      await expect(search).toHaveValue('replacement');
      expect(await pdfAnnotationSnapshot(before.storageId)).toEqual(before);

      await browser.keys([modifier, 'a']);
      await browser.keys([modifier, 'c']);
      await browser.keys([modifier, 'x']);
      await expect(search).toHaveValue('');
      await browser.keys([modifier, 'v']);
      await expect(search).toHaveValue('replacement');
      expect(await pdfAnnotationSnapshot(before.storageId)).toEqual(before);
    } finally {
      await browser.execute(() => {
        const host = window as Window & {
          __abyssSearchFocusTrace?: { stop(): void };
        };
        host.__abyssSearchFocusTrace?.stop();
        delete host.__abyssSearchFocusTrace;
      });
    }
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
      const rows = colors?.querySelector<HTMLElement>('.abyss-annotation-color-rows') ?? null;
      const tags = footer?.querySelector<HTMLElement>('[data-section="tags"]') ?? null;
      if (
        panel === null ||
        scrollHost === null ||
        footer === null ||
        colors === null ||
        rows === null
      )
        throw new Error('Color footer geometry is incomplete.');
      return {
        bottomGap: Math.abs(
          panel.getBoundingClientRect().bottom - colors.getBoundingClientRect().bottom,
        ),
        colorsInsideScrollHost: scrollHost.contains(colors),
        footerHeight: colors.getBoundingClientRect().height,
        footerBottom: colors.getBoundingClientRect().bottom,
        footerOnlyColors: footer.childElementCount === 1 && footer.firstElementChild === colors,
        rowFlexWrap: getComputedStyle(rows).flexWrap,
        rowOverflowX: getComputedStyle(rows).overflowX,
        rowTops: Array.from(rows.children, (chip) => chip.getBoundingClientRect().top),
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
    expect(before.rowFlexWrap).toBe('nowrap');
    expect(before.rowOverflowX).toBe('auto');
    expect(Math.max(...before.rowTops) - Math.min(...before.rowTops)).toBeLessThanOrEqual(1);

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
  it('renders semantic facets and unified annotation cards at narrow widths', async () => {
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
      const chips = Array.from(
        panel.querySelectorAll<HTMLButtonElement>('[data-annotation-color]'),
      );
      if (card === null || row === null || chips.length < 12)
        throw new Error('Semantic annotation UI is incomplete.');
      return {
        editTriggerLabel:
          row
            .querySelector<HTMLButtonElement>(':scope > .abyss-annotation-card-edit')
            ?.getAttribute('aria-label') ?? null,
        editTriggerNested: card.querySelector('.abyss-annotation-card-edit') !== null,
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
        editControlClear: (() => {
          const edit = row.querySelector<HTMLElement>(':scope > .abyss-annotation-card-edit');
          if (edit === null) return false;
          const bounds = edit.getBoundingClientRect();
          const contentRight =
            card.getBoundingClientRect().right -
            Number.parseFloat(getComputedStyle(card).paddingRight);
          return (
            bounds.width >= 28 &&
            contentRight <= bounds.left &&
            bounds.right <= card.getBoundingClientRect().right
          );
        })(),
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
      chipCount: 12,
      editTriggerLabel: expect.stringMatching(/^Edit color, comment, or delete — .+/u),
      editTriggerNested: false,
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
    await expect($('[data-annotation-colors-label]')).not.toExist();
    expect(initial.header).toContain('Page 1 · Highlight');
    expect(initial.comment).toContain('Annotation 00000');
    expect(initial.cardRight).toBeLessThanOrEqual(initial.panelRight + 1);
    expect(initial.editControlClear).toBe(true);
    expectAnnotationContentAligned(await annotationContentGeometry(), ['header', 'comment']);
    const containment = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
      const footer = panel?.querySelector<HTMLElement>('[data-annotation-footer]') ?? null;
      const colors = footer?.querySelector<HTMLElement>('[data-section="colors"]') ?? null;
      const tags = footer?.querySelector<HTMLElement>('[data-section="tags"]') ?? null;
      const colorRows = colors?.querySelector<HTMLElement>('.abyss-annotation-color-rows') ?? null;
      const card = panel?.querySelector<HTMLElement>('.abyss-annotation-card') ?? null;
      const header = card?.querySelector<HTMLElement>('[data-annotation-header]') ?? null;
      const meaning = card?.querySelector<HTMLElement>('[data-annotation-meaning]') ?? null;
      const comment = card?.querySelector<HTMLElement>('[data-annotation-comment]') ?? null;
      const chips = Array.from(
        colors?.querySelectorAll<HTMLButtonElement>('[data-annotation-color]') ?? [],
      );
      if (
        panel === null ||
        footer === null ||
        colors === null ||
        colorRows === null ||
        card === null ||
        header === null ||
        meaning === null ||
        comment === null ||
        chips.length === 0
      )
        throw new Error('Narrow annotation containment target is incomplete.');
      const panelRect = panel.getBoundingClientRect();
      const elementBounds = Object.fromEntries(
        Object.entries({ card, comment, footer, header, meaning }).map(([name, element]) => {
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
      colorRows.scrollLeft = colorRows.scrollWidth;
      const rowRect = colorRows.getBoundingClientRect();
      const lastChipRect = chips[chips.length - 1]?.getBoundingClientRect();
      return {
        bounded,
        colorChipSemantics: chips.map((chip) => ({
          ariaLabel: chip.getAttribute('aria-label'),
          count: chip.querySelector('.abyss-annotation-color-chip-count')?.textContent ?? '',
          hasSwatch: chip.querySelector('.abyss-annotation-color-chip-swatch') !== null,
          tag: chip.tagName,
          title: chip.title,
        })),
        colorOverflowX: getComputedStyle(colorRows).overflowX,
        colorScrollable: colorRows.scrollWidth > colorRows.clientWidth,
        footerOnlyColors:
          footer.childElementCount === 1 &&
          footer.firstElementChild === colors &&
          footer.lastElementChild === colors,
        elementBounds,
        panelBounds: { left: panelRect.left, right: panelRect.right, width: panelRect.width },
        panelHasHorizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
        lastColorReachable:
          lastChipRect !== undefined &&
          lastChipRect.left >= rowRect.left - 1 &&
          lastChipRect.right <= rowRect.right + 1,
        tagsAbsent: tags === null,
      };
    });
    if (!containment.bounded)
      throw new Error(`Narrow annotation content escaped: ${JSON.stringify(containment)}`);
    expect(containment).toEqual({
      bounded: true,
      colorOverflowX: 'auto',
      colorScrollable: true,
      colorChipSemantics: containment.colorChipSemantics,
      elementBounds: containment.elementBounds,
      footerOnlyColors: true,
      lastColorReachable: true,
      panelBounds: containment.panelBounds,
      panelHasHorizontalOverflow: false,
      tagsAbsent: true,
    });
    expect(
      containment.colorChipSemantics.every(
        ({ ariaLabel, count, hasSwatch, tag, title }) =>
          tag === 'BUTTON' &&
          ariaLabel !== null &&
          ariaLabel.length > 0 &&
          title.length > 0 &&
          hasSwatch &&
          count.length > 0,
      ),
    ).toBe(true);

    await $('[data-annotation-search]').setValue('Annotation 00001');
    await expect($('.abyss-annotation-card-row')).toHaveAttribute('aria-setsize', '1');
    await browser.keys(Key.Escape);
    await expect($('[data-annotation-editor-popover]')).not.toBeDisplayed();
    await $('.abyss-annotation-card [data-annotation-header]').click();
    await expect($('.abyss-annotation-card')).toHaveAttribute('aria-current', 'true');
    await expect($('[data-annotation-editor-popover]')).not.toBeDisplayed();
    expect(
      await browser.execute(() => ({
        selectedEditors: document.querySelectorAll('.annotationEditorLayer .selectedEditor').length,
        visiblePopovers: Array.from(
          document.querySelectorAll<HTMLElement>('[data-annotation-editor-popover]'),
        ).filter((popover) => popover.hidden === false).length,
      })),
    ).toEqual({ selectedEditors: 0, visiblePopovers: 0 });
    await $('.abyss-annotation-card-edit').click();
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
    const hoverPoint = await browser.execute(() => {
      const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
      if (scrollHost === null) throw new Error('Annotation scroll host is missing.');
      const viewport = scrollHost.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.abyss-annotation-card'));
      const visible = cards.find((card) => {
        const rect = card.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return (
          rect.top >= Math.max(0, viewport.top) &&
          rect.bottom <= Math.min(innerHeight, viewport.bottom) &&
          document.elementFromPoint(x, y)?.closest('.abyss-annotation-card') === card
        );
      });
      if (visible === undefined)
        throw new Error('No visible annotation card for pointer geometry.');
      visible.dataset['annotationHoverProbe'] = '';
      const bounds = visible.getBoundingClientRect();
      return {
        x: Math.round(bounds.left + bounds.width / 2),
        y: Math.round(bounds.top + bounds.height / 2),
      };
    });
    const restingGeometry = await annotationCardGeometry();
    expect(restingGeometry.headerHeight).toBeLessThanOrEqual(34);
    expect(restingGeometry.cardHeight).toBeLessThanOrEqual(128);

    await browser
      .action('pointer')
      .move({ origin: 'viewport', ...hoverPoint })
      .perform();
    expect(await annotationCardGeometry()).toEqual(restingGeometry);

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.abyss-annotation-card')?.focus();
    });
    await browser.keys(Key.ArrowDown);
    await expect($('[data-annotation-editor-popover]')).not.toBeDisplayed();

    for (const key of ['Enter', ' '] as const) {
      const navigation = await browser.execute((pressedKey) => {
        const card = document.querySelector<HTMLButtonElement>(
          '.abyss-annotation-card[tabindex="0"]',
        );
        if (card === null) throw new Error('Annotation navigation target is missing.');
        const event = new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: pressedKey,
        });
        card.dispatchEvent(event);
        return {
          current: card.getAttribute('aria-current'),
          prevented: event.defaultPrevented,
          rowId: card.dataset['annotationRowId'] ?? null,
        };
      }, key);
      expect(navigation).toEqual({ current: 'true', prevented: true, rowId: expect.any(String) });
      await expect($('[data-annotation-editor-popover]')).not.toBeDisplayed();
      expect(
        await browser.execute(
          () => document.querySelectorAll('.annotationEditorLayer .selectedEditor').length,
        ),
      ).toBe(0);
    }

    const contextualGestures = [
      { key: 'contextmenu', shiftKey: false },
      { key: 'ContextMenu', shiftKey: false },
      { key: 'F10', shiftKey: true },
    ] as const;
    for (const gesture of contextualGestures) {
      const activation = await browser.execute(({ key, shiftKey }) => {
        const current = document.querySelector<HTMLButtonElement>(
          '.abyss-annotation-card[tabindex="0"]',
        );
        const card =
          key === 'contextmenu'
            ? (Array.from(
                document.querySelectorAll<HTMLButtonElement>('.abyss-annotation-card'),
              ).find((candidate) => candidate !== current) ?? null)
            : current;
        if (card === null) throw new Error('Explicit annotation activation target is missing.');
        const rowId = card.dataset['annotationRowId'];
        if (rowId === undefined) throw new Error('Annotation activation target has no row id.');
        if (key === 'contextmenu') {
          const elsewhere = document.querySelector<HTMLInputElement>('[data-annotation-search]');
          if (elsewhere === null) throw new Error('Annotation search focus target is missing.');
          elsewhere.focus();
          const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
          card.dispatchEvent(event);
          return { prevented: event.defaultPrevented, rowId };
        }
        card.focus();
        const event = new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key,
          shiftKey,
        });
        card.dispatchEvent(event);
        return { prevented: event.defaultPrevented, rowId };
      }, gesture);
      expect(activation.prevented).toBe(true);
      await expect($('[data-annotation-editor-popover]')).toBeDisplayed();
      const editorGeometry = await browser.execute(() => {
        const editors = Array.from(
          document.querySelectorAll<HTMLElement>('[data-annotation-editor-popover]'),
        ).filter((editor) => editor.hidden === false);
        const rect = editors[0]?.getBoundingClientRect();
        return {
          count: editors.length,
          insideViewport:
            rect !== undefined &&
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= window.innerWidth &&
            rect.bottom <= window.innerHeight,
          notOrigin: rect !== undefined && (rect.left !== 0 || rect.top !== 0),
        };
      });
      expect(editorGeometry).toEqual({ count: 1, insideViewport: true, notOrigin: true });
      await browser.keys(Key.Escape);
      await browser.waitUntil(
        async () =>
          browser.execute(
            (rowId) => document.activeElement?.getAttribute('data-annotation-row-id') === rowId,
            activation.rowId,
          ),
        { timeout: 2_000, timeoutMsg: 'Contextual activation focus did not return to its card.' },
      );
      expect(
        await browser.execute((rowId) => {
          const active = document.activeElement as HTMLElement | null;
          return {
            activeRowId: active?.dataset['annotationRowId'] ?? null,
            invokingTabIndex:
              document.querySelector<HTMLButtonElement>(
                `.abyss-annotation-card[data-annotation-row-id="${CSS.escape(rowId)}"]`,
              )?.tabIndex ?? null,
          };
        }, activation.rowId),
      ).toEqual({ activeRowId: activation.rowId, invokingTabIndex: 0 });
    }
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
    await setCoarseAnnotationGeometry(false);

    const firstColor = $('[data-sidebar-panel="annotations"] [data-annotation-color]');
    await firstColor.moveTo();
    try {
      await $('.tooltip').waitForDisplayed({
        timeout: 2_000,
        timeoutMsg: 'Color meaning tooltip did not become visible while its chip was hovered.',
      });
    } catch (cause) {
      const diagnostic = await browser.execute(() => ({
        hovered: document
          .querySelector('[data-sidebar-panel="annotations"] [data-annotation-color]')
          ?.matches(':hover'),
        tooltips: Array.from(document.querySelectorAll<HTMLElement>('.tooltip')).map((tooltip) => ({
          display: getComputedStyle(tooltip).display,
          hidden: tooltip.hidden,
          text: tooltip.textContent,
          visibility: getComputedStyle(tooltip).visibility,
        })),
      }));
      throw new Error(
        `Color meaning tooltip did not become visible: ${JSON.stringify(diagnostic)}; ${String(cause)}`,
      );
    }
    const tooltipExitPoint = await browser.execute(() => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const xs = [
        Math.round(width / 2),
        24,
        width - 24,
        Math.round(width / 4),
        Math.round((width * 3) / 4),
      ];
      const ys = [
        Math.round(height / 2),
        Math.round(height / 4),
        Math.round((height * 3) / 4),
        height - 24,
      ];
      for (const y of ys) {
        for (const x of xs) {
          if (x < 16 || y < 64 || x >= width - 16 || y >= height - 16) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit === null) continue;
          if (hit.closest('.tooltip') !== null) continue;
          let inert = true;
          for (
            let element: Element | null = hit;
            element !== null;
            element = element.parentElement
          ) {
            if (
              element.hasAttribute('aria-label') ||
              element.hasAttribute('title') ||
              getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'drag'
            ) {
              inert = false;
              break;
            }
          }
          if (inert) return { x, y };
        }
      }
      throw new Error(`No inert interior tooltip exit point: ${width}x${height}.`);
    });
    await movePointerTo(tooltipExitPoint.x, tooltipExitPoint.y);
    try {
      await browser.waitUntil(async () => !(await $('.tooltip').isDisplayed()), {
        timeout: 2_000,
        timeoutMsg: 'Color meaning tooltip did not close after pointer exit.',
      });
    } catch (cause) {
      const diagnostic = await browser.execute(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        let dragAncestor: string | null = null;
        for (let element: Element | null = hit; element !== null; element = element.parentElement) {
          if (getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'drag') {
            dragAncestor = element.outerHTML.slice(0, 400);
            break;
          }
        }
        return {
          dragAncestor,
          focused: document.hasFocus(),
          hovered: document
            .querySelector('[data-sidebar-panel="annotations"] [data-annotation-color]')
            ?.matches(':hover'),
          hit: hit?.outerHTML.slice(0, 400) ?? null,
          tooltipOwner: hit?.closest('[aria-label], [title]')?.outerHTML.slice(0, 400) ?? null,
          tooltips: Array.from(document.querySelectorAll<HTMLElement>('.tooltip'), (tooltip) => {
            const style = getComputedStyle(tooltip);
            return {
              display: style.display,
              hidden: tooltip.hidden,
              text: tooltip.textContent,
              visibility: style.visibility,
            };
          }),
        };
      }, tooltipExitPoint);
      throw new Error(
        `Color meaning tooltip did not close after pointer exit: ${JSON.stringify({ point: tooltipExitPoint, ...diagnostic })}; ${String(cause)}`,
      );
    }

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
  });

  it('deletes one annotation from ten thousand without replacing unrelated mounted content', async () => {
    const target = await prepareTenThousandDeleteScenario();
    await installTenThousandDeleteTrace(target);

    let trace: TenThousandDeleteTrace | null = null;
    try {
      await deleteAnnotationAndExpectFirstFrame(target);

      await waitForTenThousandDeleteConvergence(readTenThousandDeleteStatus);
      trace = await readTenThousandDeleteTrace();
    } finally {
      if (trace === null) {
        const traceExists = await browser.execute(
          () =>
            (
              window as Window & {
                __abyssTask7DeleteTrace?: unknown;
              }
            ).__abyssTask7DeleteTrace !== undefined,
        );
        if (traceExists) trace = await readTenThousandDeleteTrace();
      }
      if (trace !== null)
        console.info(
          '[annotation-delete-trace]',
          JSON.stringify({
            ...trace,
            finalNativeSemanticMismatches: trace.finalNativeSemanticMismatches.length,
            missingRetainedNativeSemanticIds: trace.missingRetainedNativeSemanticIds.length,
            replacedRetainedNativeSemanticIds: trace.replacedRetainedNativeSemanticIds.length,
          }),
        );
    }

    expect(trace).toMatchObject({
      indexedBatches: 1,
      indexedRenderCalls: 1,
      mountedBursts: 1,
      targetNativeSemanticPresent: false,
      targetPresent: false,
      unrelatedCardIdentityBreaks: 0,
      zeroCardFrames: 0,
      zeroCardMutationSamples: 0,
      zeroNativeFrames: 0,
      zeroNativeMutationSamples: 0,
    });
    expect(trace.renderCalls).toBeGreaterThanOrEqual(2);
    expect(trace.renderCalls).toBeLessThanOrEqual(3);
    expect(trace.mutationSamples).toBeGreaterThan(0);
    expect(trace.settledFrames).toBeGreaterThanOrEqual(5);
    expect(trace.baselineNativeSemanticCount).toBeGreaterThan(1);
    expect(trace.finalNativeSemanticMismatches).toEqual([]);
    expect(trace.missingRetainedNativeSemanticIds).toEqual([]);
    expect(trace.replacedRetainedNativeSemanticIds.length).toBeGreaterThan(0);
  });

  it('deletes one annotation from ten thousand within the raw frame budget', async () => {
    const target = await prepareTenThousandDeleteScenario();
    await installTenThousandDeleteFrameTrace(target);
    let trace: TenThousandDeleteFrameTrace | null = null;
    try {
      await deleteAnnotationAndExpectFirstFrame(target);
      await waitForTenThousandDeleteConvergence(readTenThousandDeleteFrameStatus);
      trace = await readTenThousandDeleteFrameTrace();
    } finally {
      if (trace === null) {
        const traceExists = await browser.execute(
          () =>
            (window as Window & { __abyssTask7DeleteFrameTrace?: unknown })
              .__abyssTask7DeleteFrameTrace !== undefined,
        );
        if (traceExists) trace = await readTenThousandDeleteFrameTrace();
      }
      if (trace !== null) console.info('[annotation-delete-frame-trace]', JSON.stringify(trace));
    }
    expect(trace).toMatchObject({
      deleteClickTrusted: true,
      indexedBatches: 1,
      setSize: 9_999,
      settledFrames: 5,
      targetPresent: false,
    });
    expect(trace.maxRafGapMs).toBeLessThan(100);
  });

  // Temporary MacCI investigation; remove this case and its workflow artifact
  // after the legacy frame gap is understood. The unprofiled gate above remains authoritative.
  it('captures a diagnostic-only renderer timeline for the deletion scenario', async function () {
    const directory = env['E2E_DELETE_TIMELINE_DIR'];
    if (directory === undefined || directory.length === 0) {
      this.skip();
    }
    const puppeteer = await (
      browser as unknown as { getPuppeteer(): Promise<PuppeteerBrowser> }
    ).getPuppeteer();
    const page = (await puppeteer.pages()).find((candidate) =>
      candidate.url().startsWith('app://obsidian.md/'),
    );
    if (page === undefined) throw new Error('The Obsidian renderer is unavailable for tracing.');
    const destination = join(directory, `delete-${pid}-${Date.now()}.trace.json`);
    const capture = await startDeleteTimeline(await page.createCDPSession(), destination);
    let trace: TenThousandDeleteFrameTrace | null = null;
    let alignment: { readonly startTime: number; readonly timeOrigin: number } | null = null;
    let scenarioError: string | null = null;
    try {
      const target = await prepareTenThousandDeleteScenario();
      alignment = await browser.execute(() => ({
        startTime: performance.mark('abyss-delete:before-monitor').startTime,
        timeOrigin: performance.timeOrigin,
      }));
      await installTenThousandDeleteFrameTrace(target);
      await deleteAnnotationAndExpectFirstFrame(target);
      await waitForTenThousandDeleteConvergence(readTenThousandDeleteFrameStatus);
      trace = await readTenThousandDeleteFrameTrace();
      expect(trace).toMatchObject({
        deleteClickTrusted: true,
        indexedBatches: 1,
        setSize: 9_999,
        settledFrames: 5,
        targetPresent: false,
      });
    } catch (cause) {
      scenarioError = String(cause);
      throw cause;
    } finally {
      try {
        trace ??= await cleanupTenThousandDeleteFrameTrace();
      } finally {
        await capture.stop({ alignment, trace, scenarioError });
      }
      if (trace !== null)
        console.info('[annotation-delete-diagnostic-frame-trace]', JSON.stringify(trace));
    }
  });
});
