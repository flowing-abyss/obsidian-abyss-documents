import { $, $$, browser, expect } from '@wdio/globals';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Key } from 'webdriverio';
import {
  captureAnnotationSaveBaseline,
  isVerifiedAnnotationSaveSettled,
  readAnnotationSaveLifecycleSnapshot,
} from './annotation-save-oracle.js';

const pluginId = 'abyss-documents';
const activeReaderSelector = '.workspace-leaf.mod-active [data-abyss-document]';
const selectionEditorSelector =
  '.workspace-leaf.mod-active .abyss-documents > [data-annotation-editor-popover]:not([hidden])';
const nativeEditorSelector = selectionEditorSelector;

function activeReaderDescendant(selector: string): string {
  return `${activeReaderSelector} ${selector}`;
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

async function openPdf(path: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, input) => {
      if (!app.plugins.enabledPlugins.has(input.pluginId)) {
        throw new Error(`Plugin ${input.pluginId} is not enabled.`);
      }
      await app.workspace.openLinkText(input.path, '', false);
    },
    { path, pluginId },
  );
  await $(activeReaderSelector).waitForDisplayed({ timeout: 15_000 });
  await $(activeReaderDescendant('[data-page-number="1"] .textLayer span')).waitForExist({
    timeout: 15_000,
  });
}

async function captureReaderLifecycleIdentity(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    const leaf = app.workspace.getMostRecentLeaf();
    const view = leaf?.view as unknown as {
      containerEl?: HTMLElement;
      controller?: {
        viewport?: {
          annotationEditorInstance?: { manager?: unknown };
          commentBridge?: unknown;
        };
      };
    };
    const controller = view.controller;
    const viewport = controller?.viewport;
    const editor = viewport?.annotationEditorInstance;
    const bridge = viewport?.commentBridge;
    const readerNode = view.containerEl?.querySelector<HTMLElement>('[data-abyss-document]');
    const pageNode = readerNode?.querySelector<HTMLElement>('[data-page-number="1"]');
    if (
      controller === undefined ||
      viewport === undefined ||
      editor === undefined ||
      bridge === undefined ||
      readerNode === null ||
      readerNode === undefined ||
      pageNode === null ||
      pageNode === undefined
    )
      throw new Error('Current reader lifecycle identity is incomplete.');
    (
      window as Window & {
        __abyssTask3OldReader?: {
          bridge: unknown;
          controller: unknown;
          editor: unknown;
          manager: unknown;
          pageNode: HTMLElement;
          readerNode: HTMLElement;
          viewport: unknown;
        };
      }
    ).__abyssTask3OldReader = {
      bridge,
      controller,
      editor,
      manager: editor.manager,
      pageNode,
      readerNode,
      viewport,
    };
  });
}

async function assertReaderLifecycleReplaced(): Promise<void> {
  expect(
    await browser.executeObsidian(({ app }) => {
      const old = (
        window as Window & {
          __abyssTask3OldReader?: {
            bridge: {
              bindings?: Map<unknown, unknown>;
              disposed?: boolean;
              focusReadinessChecks?: Set<unknown>;
              sidebarUiManager?: unknown;
            };
            controller: { viewport?: unknown };
            editor: { destroyed?: boolean; manager?: unknown };
            manager: unknown;
            pageNode: HTMLElement;
            readerNode: HTMLElement;
            viewport: { destroyPromise?: Promise<void> | null };
          };
        }
      ).__abyssTask3OldReader;
      const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
        containerEl?: HTMLElement;
        controller?: {
          viewport?: {
            annotationEditorInstance?: { manager?: unknown };
            commentBridge?: unknown;
          };
        };
      };
      const controller = view.controller;
      const viewport = controller?.viewport;
      const editor = viewport?.annotationEditorInstance;
      const bridge = viewport?.commentBridge;
      const readerNode = view.containerEl?.querySelector<HTMLElement>('[data-abyss-document]');
      if (
        old === undefined ||
        controller === undefined ||
        viewport === undefined ||
        editor === undefined ||
        bridge === undefined ||
        readerNode === null ||
        readerNode === undefined
      )
        throw new Error('Reader replacement identity is incomplete.');
      const result = {
        bridgeBindingsReleased: old.bridge.bindings?.size === 0,
        bridgeDisposed: old.bridge.disposed === true,
        bridgeManagerReleased: old.bridge.sidebarUiManager == null,
        controllerDistinct: old.controller !== controller,
        controllerReleasedViewport: old.controller.viewport == null,
        editorDestroyed: old.editor.destroyed === true,
        editorDistinct: old.editor !== editor,
        editorManagerReleased: old.editor.manager == null,
        managerDistinct: old.manager !== editor.manager,
        oldPageDisconnected: !old.pageNode.isConnected,
        oldReaderDisconnected: !old.readerNode.isConnected,
        readinessReleased: old.bridge.focusReadinessChecks?.size === 0,
        readerNodeConnected: readerNode.isConnected,
        viewportDestroyed: old.viewport.destroyPromise instanceof Promise,
        viewportDistinct: !Object.is(old.viewport, viewport),
        bridgeDistinct: old.bridge !== bridge,
      };
      delete (window as Window & { __abyssTask3OldReader?: unknown }).__abyssTask3OldReader;
      return result;
    }),
  ).toEqual({
    bridgeBindingsReleased: true,
    bridgeDisposed: true,
    bridgeDistinct: true,
    bridgeManagerReleased: true,
    controllerDistinct: true,
    controllerReleasedViewport: true,
    editorDestroyed: true,
    editorDistinct: true,
    editorManagerReleased: true,
    managerDistinct: true,
    oldPageDisconnected: true,
    oldReaderDisconnected: true,
    readinessReleased: true,
    readerNodeConnected: true,
    viewportDestroyed: true,
    viewportDistinct: true,
  });
}

async function closeReaders(): Promise<void> {
  await browser.execute(() => {
    const host = window as Window & {
      __abyssTask3ActivationTrace?: { cleanup(): void };
    };
    host.__abyssTask3ActivationTrace?.cleanup();
    delete host.__abyssTask3ActivationTrace;
  });
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

async function waitForNativeHighlightReadiness(): Promise<void> {
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
        const textLayer = view.containerEl?.querySelector<HTMLElement>(
          '[data-page-number="1"] .textLayer',
        );
        return (
          textLayer !== null &&
          textLayer !== undefined &&
          view.controller?.viewport?.annotationEditorInstance?.manager
            ?.getLayer?.(0)
            ?.hasTextLayer?.(textLayer) === true
        );
      }),
    { timeout: 10_000, timeoutMsg: 'PDF.js annotation layer did not bind to page text.' },
  );
}

async function selectFixtureText(index = 1): Promise<void> {
  await waitForNativeHighlightReadiness();
  await browser.execute((selectionOrdinal) => {
    const text = document.querySelectorAll('[data-page-number="1"] .textLayer span')[1];
    if (text === undefined) throw new Error('Expected selectable text on fixture page 1.');
    const node = text.firstChild;
    if (!(node instanceof Text)) throw new Error('Expected a text node in the fixture span.');
    const start = (selectionOrdinal - 1) * 8;
    const end = Math.min(node.length, start + 7);
    if (end <= start) throw new Error(`Fixture selection ${selectionOrdinal} is out of range.`);
    const bounds = text.getBoundingClientRect();
    const clientX = Math.round(bounds.left + bounds.width / 2);
    const clientY = Math.round(bounds.top + bounds.height / 2);
    text.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX,
        clientY,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    text.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX,
        clientY,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
    document.dispatchEvent(new Event('selectionchange'));
  }, index);
}

async function dragFixtureTextWhileInspectingPalette(
  options: {
    readonly endRatio?: number;
    readonly modifierKeys?: readonly string[];
    readonly startRatio?: number;
  } = {},
): Promise<void> {
  const { endRatio = 0.8, modifierKeys = [], startRatio = 0.2 } = options;
  await waitForNativeHighlightReadiness();
  const points = await browser.execute(
    async (start, end) => {
      const spans = Array.from(
        document.querySelectorAll<HTMLElement>('[data-page-number="1"] .textLayer span'),
      );
      const span = spans.find((candidate) => candidate.getBoundingClientRect().width >= 40);
      if (span === undefined)
        throw new Error('Expected a wide selectable text span on fixture page 1.');
      const scrollHost = span.closest<HTMLElement>('.pdfViewerContainer');
      if (scrollHost === null) throw new Error('Expected the PDF viewer scroll host.');
      const before = span.getBoundingClientRect();
      scrollHost.scrollTop += before.top - window.innerHeight / 2;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      const bounds = span.getBoundingClientRect();
      return {
        end: {
          x: Math.round(bounds.left + bounds.width * end),
          y: Math.round(bounds.top + bounds.height / 2),
        },
        start: {
          x: Math.round(bounds.left + bounds.width * start),
          y: Math.round(bounds.top + bounds.height / 2),
        },
      };
    },
    startRatio,
    endRatio,
  );
  try {
    if (modifierKeys.length > 0)
      await browser.performActions([
        {
          type: 'key',
          id: 'selection-drag-modifiers',
          actions: modifierKeys.map((value) => ({ type: 'keyDown' as const, value })),
        },
      ]);
    try {
      await browser.performActions([
        {
          type: 'pointer',
          id: 'selection-drag-pointer',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 0, origin: 'viewport', ...points.start },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', duration: 400, origin: 'viewport', ...points.end },
            { type: 'pause', duration: 150 },
          ],
        },
      ]);
    } catch (cause) {
      const viewport = await browser.execute(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }));
      throw new Error(
        `PDF text drag action failed: ${JSON.stringify({ cause: String(cause), points, viewport })}`,
      );
    }
    const held = await browser.execute(
      (editorSelector, point) => ({
        paletteVisible: document.querySelector<HTMLElement>(editorSelector)?.hidden === false,
        selectedText: window.getSelection()?.toString().trim() ?? '',
        target: (() => {
          const element = document.elementFromPoint(point.x, point.y);
          return element instanceof HTMLElement
            ? { className: element.className, tagName: element.tagName }
            : null;
        })(),
      }),
      selectionEditorSelector,
      points.start,
    );
    if (held.selectedText.length === 0)
      throw new Error(`Genuine PDF text drag selected nothing: ${JSON.stringify(held)}`);
    expect(held.paletteVisible).toBe(false);
  } finally {
    await browser.releaseActions();
  }
}

async function clickNativeHighlight(
  index: number,
  modifierKeys: readonly string[] = [],
): Promise<void> {
  const point = await browser.execute((editorIndex) => {
    const editor = document.querySelectorAll<HTMLElement>('.highlightEditor')[editorIndex];
    if (editor === undefined) throw new Error(`Native highlight ${editorIndex} is missing.`);
    const target = editor.querySelector<HTMLElement>('.internal');
    const bounds = target?.getBoundingClientRect();
    if (
      target === null ||
      bounds === undefined ||
      !target.isConnected ||
      bounds.width <= 2 ||
      bounds.height <= 2 ||
      getComputedStyle(target).pointerEvents === 'none'
    )
      throw new Error(`Native highlight ${editorIndex} has no visible highlight surface.`);
    return {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2),
    };
  }, index);
  try {
    if (modifierKeys.length > 0)
      await browser.performActions([
        {
          type: 'key',
          id: 'annotation-selection-modifiers',
          actions: modifierKeys.map((value) => ({ type: 'keyDown' as const, value })),
        },
      ]);
    await browser.performActions([
      {
        type: 'pointer',
        id: 'annotation-selection-pointer',
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

async function vaultFileSha256(path: string): Promise<string> {
  return browser.executeObsidian(async ({ app }, filePath) => {
    const bytes = await app.vault.adapter.readBinary(filePath);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }, path);
}

async function waitForPdfBytesToChange(path: string, previous: string): Promise<string> {
  const initial = await readAnnotationSaveLifecycleSnapshot();
  const baseline = {
    failures: initial.failures,
    minimumSaves: initial.saves + (initial.isDirty ? 1 : 0),
    recoveries: initial.recoveries,
  };
  let current = previous;
  await browser.waitUntil(
    async () => {
      current = await vaultFileSha256(path);
      return current !== previous;
    },
    { timeout: 15_000, timeoutMsg: `PDF bytes did not change after annotation mutation: ${path}` },
  );
  await browser.waitUntil(
    async () =>
      isVerifiedAnnotationSaveSettled(await readAnnotationSaveLifecycleSnapshot(), baseline),
    { timeout: 15_000, timeoutMsg: `PDF save lifecycle did not settle: ${path}` },
  );
  return current;
}

async function reopenPdf(path: string): Promise<void> {
  await captureReaderLifecycleIdentity();
  await closeReaders();
  await openPdf(path);
  await assertReaderLifecycleReplaced();
}

async function nativePageOneAnnotations(): Promise<
  Array<{ annotationType: number | null; color: number[]; contents: string }>
> {
  return browser.executeObsidian(async ({ app }) => {
    const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
      controller?: {
        viewport?: {
          pdf?: {
            getPage(pageNumber: number): Promise<{
              getAnnotations(): Promise<
                Array<{
                  annotationType?: number;
                  color?: ArrayLike<number>;
                  contentsObj?: { str?: string };
                  defaultAppearanceData?: { fontColor?: ArrayLike<number> };
                }>
              >;
            }>;
          };
        };
      };
    };
    const page = await view.controller?.viewport?.pdf?.getPage(1);
    const annotations = (await page?.getAnnotations()) ?? [];
    return annotations.map((annotation) => ({
      annotationType: annotation.annotationType ?? null,
      color: Array.from(annotation.color ?? annotation.defaultAppearanceData?.fontColor ?? []),
      contents: annotation.contentsObj?.str ?? '',
    }));
  });
}

async function inputValue(selector: string, value: string): Promise<void> {
  await browser.execute(
    (inputSelector, nextValue) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector);
      if (input === null) throw new Error(`Input unavailable: ${inputSelector}`);
      input.value = nextValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
}

async function createSelectionComment(spanIndex: number, value: string): Promise<void> {
  const editorCount = await browser.execute(
    () => document.querySelectorAll('.highlightEditor').length,
  );
  await selectFixtureText(spanIndex);
  const popover = $(selectionEditorSelector);
  await popover.waitForDisplayed({ timeout: 5_000 });
  const input = popover.$('[aria-label="Comment"]');
  await input.waitForDisplayed({ timeout: 5_000 });
  try {
    await inputValue(`${selectionEditorSelector} [aria-label="Comment"]`, value);
    await expect(input).toHaveValue(value);
  } catch (cause) {
    const diagnostics = await browser.execute((editorSelector) => {
      const popover = document.querySelector<HTMLElement>(editorSelector);
      const textarea = popover?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
      const rect = textarea?.getBoundingClientRect();
      return {
        activeTag: document.activeElement?.tagName ?? null,
        popoverHidden: popover?.hidden ?? null,
        popoverStyle: popover === null ? null : getComputedStyle(popover).display,
        textareaHidden: textarea?.hidden ?? null,
        textareaRect: rect === undefined ? null : { height: rect.height, width: rect.width },
        textareaStyle: textarea === null ? null : getComputedStyle(textarea).display,
        value: textarea?.value ?? null,
      };
    }, selectionEditorSelector);
    throw new Error(
      `Selection editor became unavailable: ${JSON.stringify(diagnostics)}; ${String(cause)}`,
    );
  }
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.querySelectorAll('.highlightEditor').length)) ===
      editorCount + 1,
    { timeout: 10_000, timeoutMsg: 'Unified selection editor did not create one highlight.' },
  );
  await expect(popover).toBeDisplayed();
}

type PersistedWritableFixture = {
  readonly editorSelector: string;
  readonly kind: 'freetext' | 'highlight' | 'ink';
  readonly nativeType: number;
  readonly persistedSelector: string;
};

const persistedWritableFixtures: readonly PersistedWritableFixture[] = [
  {
    editorSelector: '.highlightEditor',
    kind: 'highlight',
    nativeType: 9,
    persistedSelector: '.annotationLayer .highlightAnnotation[data-annotation-id]',
  },
  {
    editorSelector: '.inkEditor',
    kind: 'ink',
    nativeType: 15,
    persistedSelector: '.annotationLayer .inkAnnotation[data-annotation-id]',
  },
  {
    editorSelector: '.freeTextEditor',
    kind: 'freetext',
    nativeType: 3,
    persistedSelector: '.annotationLayer .freeTextAnnotation[data-annotation-id]',
  },
];

async function createPersistedWritableAnnotation(fixture: PersistedWritableFixture): Promise<void> {
  if (fixture.kind === 'highlight') {
    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');
    await dragFixtureTextWhileInspectingPalette({ endRatio: 0.42, startRatio: 0.12 });
    await $(fixture.editorSelector).waitForExist({ timeout: 10_000 });
    await browser.keys(Key.Escape);
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'false');
    return;
  }
  if (fixture.kind === 'ink') {
    await $('[data-annotation-tool="ink"]').click();
    await expect($('[data-annotation-tool="ink"]')).toHaveAttribute('aria-pressed', 'true');
    await drawPersistedInk('[data-page-number="1"] .annotationEditorLayer');
    await $('[data-annotation-tool="ink"]').click();
    await expect($('[data-annotation-tool="ink"]')).toHaveAttribute('aria-pressed', 'false');
    await $(fixture.editorSelector).waitForExist({ timeout: 10_000 });
    return;
  }

  await $('[data-annotation-tool="freetext"]').click();
  await expect($('[data-annotation-tool="freetext"]')).toHaveAttribute('aria-pressed', 'true');
  const layer = $('[data-page-number="1"] .annotationEditorLayer');
  await layer.waitForDisplayed({ timeout: 5_000 });
  const placement = await browser.execute(() => {
    const editorLayer = document.querySelector<HTMLElement>(
      '[data-page-number="1"] .annotationEditorLayer',
    );
    if (editorLayer === null) throw new Error('FreeText editor layer unavailable.');
    const bounds = editorLayer.getBoundingClientRect();
    return {
      x: Math.round(bounds.left + bounds.width * 0.45),
      y: Math.round(bounds.top + 80),
    };
  });
  await browser
    .action('pointer')
    .move({ origin: 'viewport', ...placement })
    .down()
    .up()
    .perform();
  const input = $('.freeTextEditor [contenteditable="true"]');
  await input.waitForExist({ timeout: 5_000 });
  await input.click();
  await browser.keys('Persisted FreeText');
  await browser.keys(Key.Escape);
  const freeTextTool = $('[data-annotation-tool="freetext"]');
  if ((await freeTextTool.getAttribute('aria-pressed')) === 'true')
    await $('[data-annotation-tool="highlight"]').click();
  await expect(freeTextTool).toHaveAttribute('aria-pressed', 'false');
}

async function installPersistedActivationTrace(fixture: PersistedWritableFixture): Promise<void> {
  await browser.execute(
    (readerSelector, editorSelector, popoverSelector) => {
      const reader = document.querySelector<HTMLElement>(readerSelector);
      if (reader === null) throw new Error('Active reader unavailable for activation trace.');
      const trace = {
        cleanup: () => undefined,
        events: [] as string[],
        prematureFocus: 0,
        readerRemounts: 0,
        readonlyVisible: 0,
      };
      const sample = (event: string): void => {
        const currentReader = document.querySelector<HTMLElement>(readerSelector);
        if (currentReader !== reader || !reader.isConnected) trace.readerRemounts += 1;
        const selected = reader.querySelectorAll(`${editorSelector}.selectedEditor`).length;
        const popover = document.querySelector<HTMLElement>(popoverSelector);
        const visible = popover !== null && !popover.hidden;
        if (visible && popover.innerText.includes('Read-only')) trace.readonlyVisible += 1;
        if (visible && popover.contains(document.activeElement) && selected === 0)
          trace.prematureFocus += 1;
        trace.events.push(`${event}:${String(selected)}:${visible ? 'visible' : 'hidden'}`);
      };
      const observer = new MutationObserver(() => {
        sample('mutation');
      });
      const onFocus = (): void => {
        sample('focus');
      };
      observer.observe(reader, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      document.addEventListener('focusin', onFocus, true);
      trace.cleanup = () => {
        observer.disconnect();
        document.removeEventListener('focusin', onFocus, true);
      };
      (
        window as Window & { __abyssTask3ActivationTrace?: typeof trace }
      ).__abyssTask3ActivationTrace = trace;
      sample('installed');
    },
    activeReaderSelector,
    fixture.editorSelector,
    nativeEditorSelector,
  );
}

async function assertPersistedActivationTrace(): Promise<void> {
  const trace = await browser.execute(() => {
    const host = window as Window & {
      __abyssTask3ActivationTrace?: {
        cleanup(): void;
        events: string[];
        prematureFocus: number;
        readerRemounts: number;
        readonlyVisible: number;
      };
    };
    const current = host.__abyssTask3ActivationTrace;
    if (current === undefined) throw new Error('Persisted activation trace was not installed.');
    current.cleanup();
    delete host.__abyssTask3ActivationTrace;
    return {
      eventCount: current.events.length,
      prematureFocus: current.prematureFocus,
      readerRemounts: current.readerRemounts,
      readonlyVisible: current.readonlyVisible,
    };
  });
  expect(trace.eventCount).toBeGreaterThan(1);
  expect(trace).toMatchObject({
    prematureFocus: 0,
    readerRemounts: 0,
    readonlyVisible: 0,
  });
}

async function drawPersistedInk(selector: string): Promise<void> {
  await $(selector).waitForDisplayed({ timeout: 5_000 });
  const points = await browser.execute((layerSelector) => {
    const layer = document.querySelector<HTMLElement>(layerSelector);
    if (layer === null) throw new Error(`Ink editor layer unavailable: ${layerSelector}`);
    const bounds = layer.getBoundingClientRect();
    return [
      { x: Math.round(bounds.left + bounds.width * 0.3), y: Math.round(bounds.top + 30) },
      { x: Math.round(bounds.left + bounds.width * 0.45), y: Math.round(bounds.top + 60) },
      { x: Math.round(bounds.left + bounds.width * 0.6), y: Math.round(bounds.top + 35) },
    ];
  }, selector);
  const [start, middle, end] = points;
  if (start === undefined || middle === undefined || end === undefined)
    throw new Error('Ink gesture points unavailable.');
  await browser
    .action('pointer')
    .move({ origin: 'viewport', ...start })
    .down()
    .move({ duration: 120, origin: 'viewport', ...middle })
    .move({ duration: 120, origin: 'viewport', ...end })
    .up()
    .perform();
}

async function assertFreshNeutralReader(fixture: PersistedWritableFixture): Promise<void> {
  await $(activeReaderDescendant(fixture.persistedSelector)).waitForExist({ timeout: 10_000 });
  expect(
    await browser.execute(
      (readerSelector, editorSelector) => {
        const reader = document.querySelector<HTMLElement>(readerSelector);
        if (reader === null) throw new Error('Active reader unavailable after reopen.');
        return {
          liveEditors: reader.querySelectorAll(`.annotationEditorLayer ${editorSelector}`).length,
          mode:
            (
              window as Window & {
                app?: {
                  workspace?: {
                    getMostRecentLeaf?(): {
                      view?: {
                        controller?: { viewport?: { viewer?: { annotationEditorMode?: number } } };
                      };
                    } | null;
                  };
                };
              }
            ).app?.workspace?.getMostRecentLeaf?.()?.view?.controller?.viewport?.viewer
              ?.annotationEditorMode ?? null,
        };
      },
      activeReaderSelector,
      fixture.editorSelector,
    ),
  ).toEqual({ liveEditors: 0, mode: 0 });
  await expect($(`[data-annotation-tool="${fixture.kind}"]`)).toHaveAttribute(
    'aria-pressed',
    'false',
  );
}

async function assertEditablePersistedActivation(fixture: PersistedWritableFixture): Promise<void> {
  await $(activeReaderDescendant(`${fixture.editorSelector}.selectedEditor`)).waitForExist({
    timeout: 20_000,
  });
  const popover = $(nativeEditorSelector);
  await popover.waitForDisplayed({ timeout: 5_000 });
  await expect(popover.$('.abyss-annotation-editor-palette')).toBeDisplayed();
  await expect(popover).not.toHaveText(expect.stringContaining('Read-only'));
  await assertPersistedActivationTrace();
}

async function updateActivatedPersistedAnnotation(comment: string): Promise<void> {
  const popover = $(nativeEditorSelector);
  await inputValue(`${nativeEditorSelector} [aria-label="Comment"]`, comment);
  await popover.$('[data-editor-color="#5fb236"]').click();
  await expect(popover.$('[data-editor-color="#5fb236"]')).toHaveAttribute('aria-pressed', 'true');
}

async function installSelectionTimingProbe(): Promise<void> {
  await browser.execute((editorSelector) => {
    const host = window as Window & {
      __abyssTask9Selection?: {
        cleanup(): void;
        nextFrameVisible: boolean;
        pointerUpAt: number | null;
        popover: HTMLElement | null;
        visibleAt: number | null;
      };
    };
    host.__abyssTask9Selection?.cleanup();
    delete host.__abyssTask9Selection;
    const state = {
      nextFrameVisible: false,
      pointerUpAt: null as number | null,
      popover: null as HTMLElement | null,
      visibleAt: null as number | null,
    };
    const sample = (): void => {
      const popover = document.querySelector<HTMLElement>(editorSelector);
      if (popover?.hidden === false && getComputedStyle(popover).display !== 'none') {
        state.popover ??= popover;
        state.visibleAt ??= performance.now();
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['hidden', 'style'],
    });
    const onPointerUp = (): void => {
      state.pointerUpAt ??= performance.now();
      requestAnimationFrame(() => {
        sample();
        state.nextFrameVisible = state.popover?.hidden === false;
      });
    };
    document.addEventListener('pointerup', onPointerUp, { capture: true, once: true });
    host.__abyssTask9Selection = {
      ...state,
      get nextFrameVisible() {
        return state.nextFrameVisible;
      },
      get pointerUpAt() {
        return state.pointerUpAt;
      },
      get popover() {
        return state.popover;
      },
      get visibleAt() {
        return state.visibleAt;
      },
      cleanup() {
        observer.disconnect();
        document.removeEventListener('pointerup', onPointerUp, { capture: true });
      },
    };
  }, selectionEditorSelector);
}

async function selectionTiming(): Promise<{
  latencyMs: number;
  nextFrameVisible: boolean;
}> {
  return browser.execute(() => {
    const state = (
      window as Window & {
        __abyssTask9Selection?: {
          nextFrameVisible: boolean;
          pointerUpAt: number | null;
          visibleAt: number | null;
        };
      }
    ).__abyssTask9Selection;
    if (state?.pointerUpAt === null || state?.pointerUpAt === undefined || state.visibleAt === null)
      throw new Error('Selection timing probe did not observe pointer-up and popover visibility.');
    return {
      latencyMs: state.visibleAt - state.pointerUpAt,
      nextFrameVisible: state.nextFrameVisible,
    };
  });
}

async function installCreationContinuityProbe(): Promise<void> {
  await browser.execute((editorSelector) => {
    const popover = document.querySelector<HTMLElement>(editorSelector);
    const viewer = document.querySelector<HTMLElement>('.pdfViewerContainer');
    const page = document.querySelector<HTMLElement>('[data-page-number="1"]');
    const canvas = page?.querySelector<HTMLCanvasElement>('canvas') ?? null;
    const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
    if (
      popover === null ||
      viewer === null ||
      page === null ||
      canvas === null ||
      scrollHost === null
    )
      throw new Error('Creation continuity targets are incomplete.');
    const host = window as Window & {
      __abyssTask9Creation?: {
        activationAt: number | null;
        activationValue: string;
        card: HTMLElement | null;
        cardRemoved: boolean;
        canvas: HTMLCanvasElement;
        canvasRemoved: boolean;
        cleanup(): void;
        initialAnnotationId: string | null;
        initialRowId: string | null;
        maxPopulatedFrames: number;
        nextFrameCard: boolean;
        nextFrameMetadata: boolean;
        nextFrameText: string;
        page: HTMLElement;
        pageRemoved: boolean;
        popover: HTMLElement;
        popoverHidden: boolean;
        popoverRemoved: boolean;
        provisionalObserved: boolean;
        scrollTop: number;
        surfaceFailuresAfterActivation: number;
        timeline: Array<{
          at: number;
          card: boolean;
          ids: string[];
          provisional: boolean;
          type: string;
        }>;
        viewer: HTMLElement;
        viewerRemoved: boolean;
      };
    };
    const state = {
      activationAt: null as number | null,
      activationValue: '',
      card: null as HTMLElement | null,
      cardRemoved: false,
      canvas,
      canvasRemoved: false,
      initialAnnotationId: null as string | null,
      initialRowId: null as string | null,
      maxPopulatedFrames: 0,
      nextFrameCard: false,
      nextFrameMetadata: false,
      nextFrameText: '',
      page,
      pageRemoved: false,
      popover,
      popoverHidden: false,
      popoverRemoved: false,
      provisionalObserved: false,
      scrollTop: scrollHost.scrollTop,
      surfaceFailuresAfterActivation: 0,
      timeline: [] as Array<{
        at: number;
        card: boolean;
        ids: string[];
        provisional: boolean;
        type: string;
      }>,
      viewer,
      viewerRemoved: false,
    };
    let frame = 0;
    let populatedFrames = 0;
    let stopped = false;
    let cardRow: Element | null = null;
    const captureCard = (card: HTMLElement | null): void => {
      if (card === null || state.card !== null) return;
      state.card = card;
      cardRow = card.closest('.abyss-annotation-card-row');
      state.initialAnnotationId = card.dataset['annotationId'] ?? null;
      state.initialRowId = card.dataset['annotationRowId'] ?? null;
    };
    const sample = (): void => {
      if (stopped) return;
      captureCard(document.querySelector<HTMLElement>('.abyss-annotation-card'));
      const bounds = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      const populated =
        canvas.isConnected &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
      if (state.activationAt !== null && !populated) state.surfaceFailuresAfterActivation += 1;
      populatedFrames = populated ? populatedFrames + 1 : 0;
      state.maxPopulatedFrames = Math.max(state.maxPopulatedFrames, populatedFrames);
      frame = requestAnimationFrame(sample);
    };
    const activation = popover.querySelector<HTMLElement>('[aria-label="Comment"]');
    if (activation === null) throw new Error('Creation metadata input is unavailable.');
    const removesTarget = (removed: Node, target: Node): boolean =>
      removed === target || (removed.instanceOf(Element) && removed.contains(target));
    const record = (
      type: string,
      card = document.querySelector<HTMLElement>('.abyss-annotation-card'),
    ): void => {
      state.timeline.push({
        at: performance.now(),
        card: card !== null,
        ids: Array.from(
          document.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
          (candidate) => candidate.dataset['annotationId'] ?? '',
        ),
        provisional: card?.hasAttribute('data-annotation-provisional') ?? false,
        type,
      });
    };
    const observer = new MutationObserver((records) => {
      for (const recordValue of records) {
        if (
          recordValue.type === 'attributes' &&
          recordValue.target.instanceOf(HTMLElement) &&
          recordValue.target.matches('.abyss-annotation-card')
        ) {
          captureCard(recordValue.target);
          state.provisionalObserved ||=
            recordValue.oldValue === 'true' ||
            recordValue.target.hasAttribute('data-annotation-provisional');
          record(`attribute:${recordValue.oldValue ?? 'null'}`, recordValue.target);
        }
        if (recordValue.type === 'attributes' && recordValue.target === popover) {
          const popoverStyle = getComputedStyle(popover);
          state.popoverHidden ||=
            popover.hidden ||
            popoverStyle.display === 'none' ||
            popoverStyle.visibility === 'hidden';
        }
        if (recordValue.type !== 'childList') continue;
        for (const removed of Array.from(recordValue.removedNodes)) {
          state.cardRemoved ||= cardRow !== null && removesTarget(removed, cardRow);
          state.canvasRemoved ||= removesTarget(removed, canvas);
          state.pageRemoved ||= removesTarget(removed, page);
          state.popoverRemoved ||= removesTarget(removed, popover);
          state.viewerRemoved ||= removesTarget(removed, viewer);
        }
      }
      const current = document.querySelector<HTMLElement>('.abyss-annotation-card');
      if (current?.hasAttribute('data-annotation-provisional') === true) {
        captureCard(current);
        state.provisionalObserved = true;
      }
      record('mutation', current);
    });
    observer.observe(document.body, {
      attributeFilter: ['class', 'data-annotation-provisional', 'hidden', 'style'],
      attributeOldValue: true,
      attributes: true,
      childList: true,
      subtree: true,
    });
    const onBubble = (): void => {
      record('bubble');
    };
    const onActivation = (): void => {
      if (activation.textContent === '' && 'value' in activation) {
        const value = String(activation.value);
        if (value.length === 0) return;
        state.activationValue = value;
      }
      activation.removeEventListener('input', onActivation, { capture: true });
      state.activationAt ??= performance.now();
      record('capture');
      queueMicrotask(() => {
        record('microtask');
      });
      requestAnimationFrame(() => {
        captureCard(document.querySelector<HTMLElement>('.abyss-annotation-card'));
        state.nextFrameCard = state.card?.isConnected === true;
        const cardText = state.card?.textContent ?? '';
        state.nextFrameText = cardText;
        state.nextFrameMetadata =
          state.activationValue.length > 0 && cardText.includes(state.activationValue);
        record('raf', state.card);
      });
    };
    activation.addEventListener('input', onActivation, { capture: true });
    document.addEventListener('input', onBubble, { once: true });
    frame = requestAnimationFrame(sample);
    host.__abyssTask9Creation = {
      ...state,
      get activationAt() {
        return state.activationAt;
      },
      get card() {
        return state.card;
      },
      get cardRemoved() {
        return state.cardRemoved;
      },
      get canvasRemoved() {
        return state.canvasRemoved;
      },
      get initialAnnotationId() {
        return state.initialAnnotationId;
      },
      get initialRowId() {
        return state.initialRowId;
      },
      get maxPopulatedFrames() {
        return state.maxPopulatedFrames;
      },
      get nextFrameCard() {
        return state.nextFrameCard;
      },
      get nextFrameMetadata() {
        return state.nextFrameMetadata;
      },
      get nextFrameText() {
        return state.nextFrameText;
      },
      get pageRemoved() {
        return state.pageRemoved;
      },
      get popoverHidden() {
        return state.popoverHidden;
      },
      get popoverRemoved() {
        return state.popoverRemoved;
      },
      get provisionalObserved() {
        return state.provisionalObserved;
      },
      get timeline() {
        return state.timeline;
      },
      get surfaceFailuresAfterActivation() {
        return state.surfaceFailuresAfterActivation;
      },
      get viewerRemoved() {
        return state.viewerRemoved;
      },
      cleanup() {
        stopped = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        activation.removeEventListener('input', onActivation, { capture: true });
        document.removeEventListener('input', onBubble);
      },
    };
  }, selectionEditorSelector);
}

async function setMetadataByNextFrames(
  inputSelector: string,
  value: string,
  expectedText: string,
): Promise<{ latencyMs: number; sameCard: boolean; sustained: boolean }> {
  await browser.execute(
    (selector, targetValue, expected) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      const card = document.querySelector<HTMLElement>('.abyss-annotation-card');
      if (input === null || card === null)
        throw new Error('Metadata continuity targets are missing.');
      const host = window as Window & {
        __abyssTask9Metadata?: {
          latencyMs: number | null;
          firstText: string | null;
          secondText: string | null;
          sameCard: boolean;
          settled: boolean;
          sustained: boolean;
        };
      };
      const state = {
        latencyMs: null as number | null,
        firstText: null as string | null,
        secondText: null as string | null,
        sameCard: false,
        settled: false,
        sustained: false,
      };
      const sampleSecondFrame = (firstUpdated: boolean): void => {
        const second = document.querySelector<HTMLElement>('.abyss-annotation-card');
        state.secondText = second?.textContent ?? null;
        state.sustained =
          firstUpdated &&
          second === card &&
          card.isConnected &&
          second.textContent.includes(expected);
        state.settled = true;
      };
      const sampleFirstFrame = (inputAt: number): void => {
        const first = document.querySelector<HTMLElement>('.abyss-annotation-card');
        state.firstText = first?.textContent ?? null;
        state.sameCard = first === card && card.isConnected;
        const firstUpdated = state.sameCard && first?.textContent.includes(expected) === true;
        state.latencyMs = performance.now() - inputAt;
        requestAnimationFrame(() => {
          sampleSecondFrame(firstUpdated);
        });
      };
      const onInput = (): void => {
        if (input.value !== targetValue) return;
        input.removeEventListener('input', onInput, { capture: true });
        const inputAt = performance.now();
        requestAnimationFrame(() => {
          sampleFirstFrame(inputAt);
        });
      };
      input.addEventListener('input', onInput, { capture: true });
      host.__abyssTask9Metadata = {
        get firstText() {
          return state.firstText;
        },
        get latencyMs() {
          return state.latencyMs;
        },
        get sameCard() {
          return state.sameCard;
        },
        get settled() {
          return state.settled;
        },
        get sustained() {
          return state.sustained;
        },
        get secondText() {
          return state.secondText;
        },
      };
    },
    inputSelector,
    value,
    expectedText,
  );
  await $(inputSelector).setValue(value);
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            (
              window as Window & {
                __abyssTask9Metadata?: { readonly settled: boolean };
              }
            ).__abyssTask9Metadata?.settled === true,
        ),
      {
        interval: 20,
        timeout: 2_000,
        timeoutMsg: `Metadata did not render by two frames: ${expectedText}`,
      },
    );
  } catch (cause) {
    const diagnostic = await browser.execute(
      (selector) => ({
        card: document.querySelector<HTMLElement>('.abyss-annotation-card')?.textContent ?? null,
        input:
          document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value ?? null,
        probe: (window as Window & { __abyssTask9Metadata?: unknown }).__abyssTask9Metadata ?? null,
      }),
      inputSelector,
    );
    throw new Error(
      `Metadata frame diagnostic: ${JSON.stringify(diagnostic)}; cause: ${String(cause)}`,
    );
  }
  return browser.execute(() => {
    const state = (
      window as Window & {
        __abyssTask9Metadata?: {
          readonly latencyMs: number | null;
          readonly firstText: string | null;
          readonly secondText: string | null;
          readonly sameCard: boolean;
          readonly sustained: boolean;
        };
      }
    ).__abyssTask9Metadata;
    if (state?.latencyMs === null || state?.latencyMs === undefined)
      throw new Error('Metadata continuity probe did not observe input.');
    return {
      latencyMs: state.latencyMs,
      firstText: state.firstText,
      secondText: state.secondText,
      sameCard: state.sameCard,
      sustained: state.sustained,
    };
  });
}

async function cleanupTask9SelectionProbes(): Promise<void> {
  await browser.execute(() => {
    const host = window as Window & {
      __abyssTask9Creation?: { cleanup(): void };
      __abyssTask9Metadata?: unknown;
      __abyssTask9Selection?: { cleanup(): void };
    };
    host.__abyssTask9Creation?.cleanup();
    host.__abyssTask9Selection?.cleanup();
    delete host.__abyssTask9Creation;
    delete host.__abyssTask9Metadata;
    delete host.__abyssTask9Selection;
  });
}

describe('reader selection-first annotations', () => {
  const workingPath = 'Documents/e2e-selection-first.pdf';

  beforeEach(async () => {
    await resetWorkingPdf('Documents/text-12-pages.pdf', workingPath);
    await openPdf(workingPath);
  });

  afterEach(async () => {
    await closeReaders();
  });

  it('offers annotation actions for an ordinary neutral text selection', async () => {
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'false');

    await selectFixtureText();

    await $(selectionEditorSelector).waitForDisplayed({ timeout: 5_000 });
    await expect($(`${selectionEditorSelector} [aria-label="Comment"]`)).toExist();
  });

  it('waits for a genuine primary text drag to end before showing selection actions', async () => {
    await dragFixtureTextWhileInspectingPalette();

    await $(selectionEditorSelector).waitForDisplayed({ timeout: 5_000 });
    await expect($(`${selectionEditorSelector} [aria-label="Comment"]`)).toExist();
  });

  it('creates enriches saves and reloads one selection-first annotation without remounting', async () => {
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-annotations-status]')).toHaveText('No annotations');
    const beforeHash = await vaultFileSha256(workingPath);
    await installSelectionTimingProbe();
    try {
      await dragFixtureTextWhileInspectingPalette();
      await $(selectionEditorSelector).waitForDisplayed({ timeout: 5_000 });
      await browser.waitUntil(async () => (await selectionTiming()).nextFrameVisible, {
        timeout: 2_000,
        timeoutMsg: 'Selection editor missed the first animation frame after pointer-up.',
      });
      const timing = await selectionTiming();
      expect(timing.latencyMs).toBeGreaterThanOrEqual(0);
      expect(timing.latencyMs).toBeLessThanOrEqual(100);

      const comment = `${selectionEditorSelector} [aria-label="Comment"]`;
      const tags = `${selectionEditorSelector} [aria-label="Tags"]`;
      const links = `${selectionEditorSelector} [aria-label="Links"]`;
      const saveBaseline = await captureAnnotationSaveBaseline();
      await installCreationContinuityProbe();
      await $(comment).click();
      await browser.keys('D');
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              (
                window as Window & {
                  __abyssTask9Creation?: { readonly nextFrameCard: boolean };
                }
              ).__abyssTask9Creation?.nextFrameCard === true,
          ),
        {
          timeout: 2_000,
          timeoutMsg: 'Provisional annotation card missed the first frame after metadata input.',
        },
      );
      const initialCommentTiming = await setMetadataByNextFrames(comment, 'Draft', 'Draft');
      const initialTagTiming = await setMetadataByNextFrames(tags, '#review', '#review');
      const initialLinkTiming = await setMetadataByNextFrames(
        links,
        '[[Draft note]]',
        'Draft note',
      );
      expect(initialCommentTiming).toMatchObject({ sameCard: true, sustained: true });
      expect(initialTagTiming).toMatchObject({ sameCard: true, sustained: true });
      expect(initialLinkTiming).toMatchObject({ sameCard: true, sustained: true });
      expect(initialCommentTiming.latencyMs).toBeLessThanOrEqual(100);
      expect(initialTagTiming.latencyMs).toBeLessThanOrEqual(100);
      expect(initialLinkTiming.latencyMs).toBeLessThanOrEqual(100);
      const beforeSwatch = await browser.execute(() => ({
        cards: document.querySelectorAll('.abyss-annotation-card').length,
        editors: document.querySelectorAll('.highlightEditor').length,
      }));
      await $(`${selectionEditorSelector} [data-editor-color="#ffd400"]`).click();
      await browser.execute(
        () =>
          new Promise<boolean>((resolve) => {
            requestAnimationFrame(() => {
              resolve(true);
            });
          }),
      );
      expect(
        await browser.execute(() => ({
          cards: document.querySelectorAll('.abyss-annotation-card').length,
          editors: document.querySelectorAll('.highlightEditor').length,
        })),
      ).toEqual(beforeSwatch);
      try {
        await $('.abyss-annotation-card').waitForExist({ timeout: 5_000 });
      } catch (cause) {
        const diagnostic = await browser.execute(() => ({
          activeSelection: document.getSelection()?.toString() ?? null,
          cards: Array.from(document.querySelectorAll('.abyss-annotation-card')).length,
          creation:
            (
              window as Window & {
                __abyssTask9Creation?: { readonly timeline: readonly unknown[] };
              }
            ).__abyssTask9Creation?.timeline ?? [],
          popover:
            document.querySelector<HTMLElement>('[data-annotation-editor-popover]')?.outerHTML ??
            null,
        }));
        throw new Error(
          `Selection activation diagnostic: ${JSON.stringify(diagnostic)}; cause: ${String(cause)}`,
        );
      }
      const creationProbe = await browser.execute(() => {
        const state = (
          window as Window & {
            __abyssTask9Creation?: {
              readonly activationAt: number | null;
              readonly card: HTMLElement | null;
              readonly nextFrameCard: boolean;
              readonly nextFrameMetadata: boolean;
              readonly nextFrameText: string;
              readonly provisionalObserved: boolean;
              readonly timeline: ReadonlyArray<{
                readonly at: number;
                readonly card: boolean;
                readonly ids: readonly string[];
                readonly provisional: boolean;
                readonly type: string;
              }>;
            };
          }
        ).__abyssTask9Creation;
        return {
          activationAt: state?.activationAt ?? null,
          cardConnected: state?.card?.isConnected ?? false,
          nextFrameCard: state?.nextFrameCard ?? false,
          nextFrameMetadata: state?.nextFrameMetadata ?? false,
          nextFrameText: state?.nextFrameText ?? '',
          provisionalObserved: state?.provisionalObserved ?? false,
          timeline: state?.timeline ?? [],
        };
      });
      if (
        !creationProbe.nextFrameCard ||
        !creationProbe.nextFrameMetadata ||
        !creationProbe.provisionalObserved
      )
        throw new Error(`Creation timing diagnostic: ${JSON.stringify(creationProbe)}`);
      expect(creationProbe).toMatchObject({
        activationAt: expect.any(Number),
        cardConnected: true,
        nextFrameCard: true,
        nextFrameMetadata: true,
        provisionalObserved: true,
      });
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              (
                window as Window & {
                  __abyssTask9Creation?: { readonly nextFrameCard: boolean };
                }
              ).__abyssTask9Creation?.nextFrameCard === true,
          ),
        {
          timeout: 2_000,
          timeoutMsg: 'Provisional annotation card missed the first frame after metadata input.',
        },
      );
      if (!(await $(selectionEditorSelector).isDisplayed())) {
        const popover = await browser.execute(
          () =>
            document.querySelector<HTMLElement>('[data-annotation-editor-popover]')?.outerHTML ??
            null,
        );
        throw new Error(`Selection editor continuity diagnostic: ${JSON.stringify(popover)}`);
      }
      await expect($('[data-annotations-status]')).not.toBeDisplayed();
      await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(1);

      const commentTiming = await setMetadataByNextFrames(
        comment,
        'Résumé — проверка',
        'Résumé — проверка',
      );
      const linkTiming = await setMetadataByNextFrames(links, '[[Linked note]]', 'Linked note');
      expect(commentTiming).toMatchObject({ sameCard: true, sustained: true });
      expect(linkTiming).toMatchObject({ sameCard: true, sustained: true });
      expect(commentTiming.latencyMs).toBeLessThanOrEqual(100);
      expect(linkTiming.latencyMs).toBeLessThanOrEqual(100);

      await browser.waitUntil(
        async () =>
          isVerifiedAnnotationSaveSettled(
            await readAnnotationSaveLifecycleSnapshot(),
            saveBaseline,
          ),
        { timeout: 15_000, timeoutMsg: 'Selection-first save lifecycle did not settle.' },
      );
      await browser.waitUntil(async () => (await vaultFileSha256(workingPath)) !== beforeHash, {
        timeout: 15_000,
        timeoutMsg: 'Selection-first PDF bytes did not change.',
      });
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              ((
                window as Window & {
                  __abyssTask9Creation?: { readonly maxPopulatedFrames: number };
                }
              ).__abyssTask9Creation?.maxPopulatedFrames ?? 0) >= 5,
          ),
        { timeout: 2_000, timeoutMsg: 'Reader did not retain five populated mutation frames.' },
      );

      const continuity = await browser.execute((editorSelector) => {
        const state = (
          window as Window & {
            __abyssTask9Creation?: {
              readonly card: HTMLElement | null;
              readonly cardRemoved: boolean;
              readonly canvas: HTMLCanvasElement;
              readonly canvasRemoved: boolean;
              readonly initialAnnotationId: string | null;
              readonly initialRowId: string | null;
              readonly maxPopulatedFrames: number;
              readonly page: HTMLElement;
              readonly pageRemoved: boolean;
              readonly popover: HTMLElement;
              readonly popoverHidden: boolean;
              readonly popoverRemoved: boolean;
              readonly scrollTop: number;
              readonly surfaceFailuresAfterActivation: number;
              readonly viewer: HTMLElement;
              readonly viewerRemoved: boolean;
            };
          }
        ).__abyssTask9Creation;
        const card = document.querySelector<HTMLElement>('.abyss-annotation-card');
        const popover = document.querySelector<HTMLElement>(editorSelector);
        const page = document.querySelector<HTMLElement>('[data-page-number="1"]');
        const canvas = page?.querySelector<HTMLCanvasElement>('canvas') ?? null;
        const viewer = document.querySelector<HTMLElement>('.pdfViewerContainer');
        const scrollHost = document.querySelector<HTMLElement>('[data-annotation-scroll-host]');
        if (
          state === undefined ||
          card === null ||
          popover === null ||
          page === null ||
          canvas === null ||
          viewer === null ||
          scrollHost === null
        )
          throw new Error('Selection-first continuity state is incomplete.');
        return {
          annotationId: card.dataset['annotationId'] ?? '',
          cardCount: document.querySelectorAll('.abyss-annotation-card').length,
          cardRemoved: state.cardRemoved,
          currentRowId: card.dataset['annotationRowId'] ?? '',
          canvasRemoved: state.canvasRemoved,
          focusLabel: document.activeElement?.getAttribute('aria-label') ?? null,
          initialAnnotationId: state.initialAnnotationId ?? '',
          initialRowId: state.initialRowId ?? '',
          maxPopulatedFrames: state.maxPopulatedFrames,
          pageRemoved: state.pageRemoved,
          popoverHidden: state.popoverHidden,
          popoverRemoved: state.popoverRemoved,
          provisionalCleared: !card.hasAttribute('data-annotation-provisional'),
          sameCanvas: state.canvas === canvas,
          sameCard: state.card === card && card.isConnected,
          samePage: state.page === page,
          samePopover: state.popover === popover && popover.isConnected && !popover.hidden,
          sameScroll: state.scrollTop === scrollHost.scrollTop,
          sameViewer: state.viewer === viewer,
          surfaceFailuresAfterActivation: state.surfaceFailuresAfterActivation,
          viewerRemoved: state.viewerRemoved,
        };
      }, selectionEditorSelector);
      if (!continuity.sameCard)
        throw new Error(`Stable card continuity diagnostic: ${JSON.stringify(continuity)}`);
      expect(continuity).toMatchObject({
        cardCount: 1,
        cardRemoved: false,
        canvasRemoved: false,
        focusLabel: 'Links',
        pageRemoved: false,
        popoverHidden: false,
        popoverRemoved: false,
        provisionalCleared: true,
        sameCanvas: true,
        sameCard: true,
        samePage: true,
        samePopover: true,
        sameScroll: true,
        sameViewer: true,
        surfaceFailuresAfterActivation: 0,
        viewerRemoved: false,
      });
      expect(continuity.initialAnnotationId).not.toBe('');
      expect(continuity.annotationId).not.toBe(continuity.initialAnnotationId);
      expect(continuity.currentRowId).toBe(continuity.initialRowId);
      expect(continuity.maxPopulatedFrames).toBeGreaterThanOrEqual(5);

      await reopenPdf(workingPath);
      await $('.annotationLayer .highlightAnnotation').waitForExist({ timeout: 10_000 });
      const writable = (await nativePageOneAnnotations()).filter(
        ({ annotationType }) => annotationType !== 16,
      );
      expect(writable).toEqual([
        {
          annotationType: 9,
          color: [255, 212, 0],
          contents: 'Résumé — проверка #review [[Linked note]]',
        },
      ]);
      await $('[data-control="sidebar"]').click();
      await $('[data-tab="annotations"]').click();
      await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(1);
      await expect($('.abyss-annotation-card')).toHaveText(
        expect.stringContaining('Résumé — проверка'),
      );
      try {
        await browser.waitUntil(
          async () =>
            browser.execute(
              () =>
                document.querySelector('[data-annotation-card-tag]')?.textContent === '#review' &&
                document.querySelector('[data-annotation-link]')?.textContent === 'Linked note',
            ),
          { timeout: 10_000, timeoutMsg: 'Reloaded annotation metadata did not settle.' },
        );
      } catch (cause) {
        const card = await browser.execute(
          () => document.querySelector<HTMLElement>('.abyss-annotation-card')?.outerHTML ?? null,
        );
        throw new Error(
          `Reloaded metadata diagnostic: ${JSON.stringify(card)}; cause: ${String(cause)}`,
        );
      }
      await expect($('[data-annotation-card-tag]')).toHaveText('#review');
      await expect($('[data-annotation-link]')).toHaveText(expect.stringContaining('Linked note'));
    } finally {
      await cleanupTask9SelectionProbes();
    }
  });

  it('lets native Quick Highlight create one editor without opening the selection palette', async () => {
    await $('[data-annotation-tool="highlight"]').click();
    await expect($('[data-annotation-tool="highlight"]')).toHaveAttribute('aria-pressed', 'true');

    await selectFixtureText();
    await $('.highlightEditor').waitForExist({ timeout: 10_000 });

    const editorCount = await browser.execute(
      () => document.querySelectorAll('.highlightEditor').length,
    );
    expect(editorCount).toBe(1);
    await expect($(selectionEditorSelector)).not.toBeDisplayed();
  });

  it('saves and reopens neutral highlight comment link and tag selections', async () => {
    let hash = await vaultFileSha256(workingPath);

    await selectFixtureText(1);
    const selectionEditor = $(selectionEditorSelector);
    await selectionEditor.waitForDisplayed({ timeout: 5_000 });
    await selectionEditor.$('[data-editor-color="#ffd400"]').click();
    await $('.highlightEditor').waitForExist({ timeout: 10_000 });
    await expect(selectionEditor).toBeDisplayed();
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect(selectionEditor).toBeDisplayed();

    await $('[data-control="quick-highlight-menu"]').click();
    await $(
      '//*[contains(@class, "menu-item-title") and contains(normalize-space(.), "Green")]',
    ).click();

    await createSelectionComment(2, 'neutral link [[Linked note]]');
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect($(selectionEditorSelector)).toBeDisplayed();
    await browser.keys(Key.Escape);
    await createSelectionComment(3, 'neutral tag #review');
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect($(selectionEditorSelector)).toBeDisplayed();
    await browser.keys(Key.Escape);
    await createSelectionComment(4, 'Neutral comment');
    await waitForPdfBytesToChange(workingPath, hash);
    await expect($(selectionEditorSelector)).toBeDisplayed();

    await reopenPdf(workingPath);
    await browser.waitUntil(
      async () => {
        const annotations = await nativePageOneAnnotations();
        return annotations.filter(({ annotationType }) => annotationType !== 16).length === 4;
      },
      { timeout: 15_000, timeoutMsg: 'Saved neutral selection annotations did not reopen.' },
    );
    const reopened = await nativePageOneAnnotations();
    expect(reopened.filter(({ annotationType }) => annotationType !== 16)).toEqual([
      { annotationType: 9, color: [255, 212, 0], contents: '' },
      {
        annotationType: 9,
        color: [95, 178, 54],
        contents: 'neutral link [[Linked note]]',
      },
      { annotationType: 9, color: [95, 178, 54], contents: 'neutral tag #review' },
      { annotationType: 9, color: [95, 178, 54], contents: 'Neutral comment' },
    ]);
    expect(reopened.filter(({ annotationType }) => annotationType === 16)).toHaveLength(3);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    try {
      await browser.waitUntil(
        async () => {
          const text = await $('[data-sidebar-panel="annotations"]').getText();
          return (
            text.includes('Neutral comment') &&
            text.includes('neutral link [[Linked note]]') &&
            text.includes('neutral tag #review')
          );
        },
        { timeout: 15_000, timeoutMsg: 'Saved comment/link/tag content did not reopen from PDF.' },
      );
      await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(4);
    } catch (cause) {
      const diagnostics = await browser.executeObsidian(async ({ app }) => {
        const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
          controller?: {
            viewport?: {
              pdf?: {
                getPage(pageNumber: number): Promise<{
                  getAnnotations(): Promise<unknown[]>;
                }>;
              };
            };
          };
        };
        const page = await view.controller?.viewport?.pdf?.getPage(1);
        return {
          nativeAnnotations: await page?.getAnnotations(),
          panelText:
            view instanceof Object
              ? document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]')?.innerText
              : undefined,
        };
      });
      throw new Error(`${String(cause)}; ${JSON.stringify(diagnostics)}`);
    }
  });

  it('uses one selected Quick Highlight color for two gestures then disarms with Escape', async () => {
    let hash = await vaultFileSha256(workingPath);
    await $('[data-control="quick-highlight-menu"]').click();
    await $(
      '//*[contains(@class, "menu-item-title") and contains(normalize-space(.), "Green")]',
    ).click();
    const quick = $('[data-annotation-tool="highlight"]');
    await expect(quick).toHaveAttribute('aria-label', expect.stringContaining('Green'));
    await quick.click();
    await expect(quick).toHaveAttribute('aria-pressed', 'true');

    await selectFixtureText(1);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.highlightEditor').length)) === 1,
      { timeout: 10_000, timeoutMsg: 'First Quick Highlight gesture was not singular.' },
    );
    await expect(quick).toHaveAttribute('aria-pressed', 'true');
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await selectFixtureText(2);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.highlightEditor').length)) === 2,
      { timeout: 10_000, timeoutMsg: 'Second Quick Highlight gesture was not singular.' },
    );
    await expect($(selectionEditorSelector)).not.toBeDisplayed();

    await browser.keys(Key.Escape);
    await expect(quick).toHaveAttribute('aria-pressed', 'false');
    await waitForPdfBytesToChange(workingPath, hash);
    await reopenPdf(workingPath);
    await browser.waitUntil(
      async () => {
        const annotations = await nativePageOneAnnotations();
        return annotations.filter(({ annotationType }) => annotationType !== 16).length === 2;
      },
      { timeout: 15_000, timeoutMsg: 'Two Quick Highlight annotations did not reopen.' },
    );
    expect(
      (await nativePageOneAnnotations()).filter(({ annotationType }) => annotationType !== 16),
    ).toEqual([
      { annotationType: 9, color: [95, 178, 54], contents: '' },
      { annotationType: 9, color: [95, 178, 54], contents: '' },
    ]);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-annotation-color="#5fb236"]')).toExist();
  });

  for (const fixture of persistedWritableFixtures) {
    it(`materializes, edits, verifies, and deletes a persisted ${fixture.kind} from a neutral click`, async () => {
      let hash = await vaultFileSha256(workingPath);
      await createPersistedWritableAnnotation(fixture);
      hash = await waitForPdfBytesToChange(workingPath, hash);

      await reopenPdf(workingPath);
      await assertFreshNeutralReader(fixture);
      await installPersistedActivationTrace(fixture);
      await $(activeReaderDescendant(fixture.persistedSelector)).click();
      await assertEditablePersistedActivation(fixture);
      const comment = `Persisted ${fixture.kind} activation`;
      await updateActivatedPersistedAnnotation(comment);
      hash = await waitForPdfBytesToChange(workingPath, hash);

      await reopenPdf(workingPath);
      const native = (await nativePageOneAnnotations()).filter(
        ({ annotationType }) => annotationType === fixture.nativeType,
      );
      expect(native).toHaveLength(1);
      expect(native[0]?.color).toEqual(fixture.kind === 'freetext' ? [94, 178, 54] : [95, 178, 54]);
      await $('[data-control="sidebar"]').click();
      await $('[data-tab="annotations"]').click();
      await $('.abyss-annotation-card').waitForExist({ timeout: 10_000 });
      await installPersistedActivationTrace(fixture);
      await $('.abyss-annotation-card').click();
      await assertEditablePersistedActivation(fixture);
      await expect($(`${nativeEditorSelector} [aria-label="Comment"]`)).toHaveValue(comment);
      const deletedId = await $('.abyss-annotation-card').getAttribute('data-annotation-id');
      expect(deletedId).not.toBeNull();
      await $(nativeEditorSelector).$('[data-action="delete-annotation"]').click();
      await waitForPdfBytesToChange(workingPath, hash);

      await reopenPdf(workingPath);
      await expect($(activeReaderDescendant(fixture.persistedSelector))).not.toExist();
      expect(
        (await nativePageOneAnnotations()).filter(
          ({ annotationType }) => annotationType === fixture.nativeType,
        ),
      ).toHaveLength(0);
      await $('[data-control="sidebar"]').click();
      await $('[data-tab="annotations"]').click();
      await expect($(activeReaderDescendant('[data-annotations-status]'))).toHaveText(
        'No annotations',
      );
      await browser.waitUntil(
        async () =>
          browser.execute(
            (readerSelector, removedId) => {
              const reader = document.querySelector<HTMLElement>(readerSelector);
              if (reader === null) return false;
              return Array.from(
                reader.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
              ).every((card) => !Object.is(card.dataset['annotationId'], removedId));
            },
            activeReaderSelector,
            deletedId,
          ),
        {
          timeout: 10_000,
          timeoutMsg: 'Deleted annotation card survived destroyed-reader reopen.',
        },
      );
    });

    it(`materializes a persisted ${fixture.kind} through one sidebar-card activation`, async () => {
      const hash = await vaultFileSha256(workingPath);
      await createPersistedWritableAnnotation(fixture);
      await waitForPdfBytesToChange(workingPath, hash);
      await reopenPdf(workingPath);
      await assertFreshNeutralReader(fixture);

      await $('[data-control="sidebar"]').click();
      await $('[data-tab="annotations"]').click();
      await $('.abyss-annotation-card').waitForExist({ timeout: 10_000 });
      await installPersistedActivationTrace(fixture);
      await $('.abyss-annotation-card').click();

      await assertEditablePersistedActivation(fixture);
      await expect($(`${fixture.editorSelector}.selectedEditor`)).toExist();
    });
  }

  it('recolors and enriches one writable annotation contextually then deletes it', async () => {
    let hash = await vaultFileSha256(workingPath);
    await selectFixtureText(1);
    const selectionEditor = $(selectionEditorSelector);
    await selectionEditor.waitForDisplayed({ timeout: 5_000 });
    await selectionEditor.$('[data-editor-color="#ffd400"]').click();
    await $('.highlightEditor').waitForExist({ timeout: 10_000 });
    await expect(selectionEditor).toBeDisplayed();
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect(selectionEditor).toBeDisplayed();

    await browser.keys(Key.Escape);
    await expect(selectionEditor).not.toBeDisplayed();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await $('.abyss-annotation-card').waitForExist({ timeout: 5_000 });
    await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.abyss-annotation-card');
      if (card === null) throw new Error('Expected the existing annotation card.');
      card.dataset['task9ExistingCard'] = '';
    });
    await expect($('.highlightEditor')).toExist();
    await $('.abyss-annotation-card').click();
    const popover = $(nativeEditorSelector);
    try {
      await popover.waitForDisplayed({ timeout: 5_000 });
    } catch (cause) {
      const diagnostic = await browser.execute(() => ({
        activeElement:
          document.activeElement instanceof HTMLElement
            ? {
                className: document.activeElement.className,
                outerHTML: document.activeElement.outerHTML,
              }
            : null,
        cards: Array.from(document.querySelectorAll<HTMLElement>('.abyss-annotation-card')).map(
          (card) => ({
            annotationId: card.dataset['annotationId'] ?? null,
            current: card.getAttribute('aria-current'),
            rowId: card.dataset['annotationRowId'] ?? null,
          }),
        ),
        editors: Array.from(document.querySelectorAll<HTMLElement>('.highlightEditor')).map(
          (editor) => ({ className: editor.className, id: editor.id }),
        ),
        popover:
          document.querySelector<HTMLElement>('[data-annotation-editor-popover]')?.outerHTML ??
          null,
      }));
      throw new Error(`${String(cause)}; diagnostic=${JSON.stringify(diagnostic)}`);
    }
    await expect($('.highlightEditor.selectedEditor')).toExist();
    try {
      await expect(popover.$('.abyss-annotation-editor-palette')).toBeDisplayed();
    } catch (cause) {
      const diagnostic = await browser.execute(() => {
        const editor = document.querySelector<HTMLElement>('[data-annotation-editor-popover]');
        return {
          label: editor?.getAttribute('aria-label') ?? null,
          hidden: editor?.hidden ?? null,
          paletteHidden:
            editor?.querySelector<HTMLElement>('.abyss-annotation-editor-palette')?.hidden ?? null,
          readOnlyHidden:
            editor?.querySelector<HTMLElement>('.abyss-annotation-editor-readonly-metadata')
              ?.hidden ?? null,
          cardId:
            document.querySelector<HTMLElement>('.abyss-annotation-card[aria-current="true"]')
              ?.dataset['annotationId'] ?? null,
        };
      });
      throw new Error(`${String(cause)}; diagnostic=${JSON.stringify(diagnostic)}`);
    }
    await popover.$('[data-editor-color="#5fb236"]').click();
    await expect(popover.$('[data-editor-color="#5fb236"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const comment = popover.$('[aria-label="Comment"]');
    const commentTiming = await setMetadataByNextFrames(
      `${nativeEditorSelector} [aria-label="Comment"]`,
      'Contextual comment',
      'Contextual comment',
    );
    const linkTiming = await setMetadataByNextFrames(
      `${nativeEditorSelector} [aria-label="Links"]`,
      '[[Link]]',
      'Link',
    );
    const tagTiming = await setMetadataByNextFrames(
      `${nativeEditorSelector} [aria-label="Tags"]`,
      '#tag',
      '#tag',
    );
    if (!commentTiming.sameCard || !commentTiming.sustained) {
      throw new Error(`Comment metadata continuity failed: ${JSON.stringify(commentTiming)}`);
    }
    expect(linkTiming).toMatchObject({ sameCard: true, sustained: true });
    expect(tagTiming).toMatchObject({ sameCard: true, sustained: true });
    expect(
      Math.max(commentTiming.latencyMs, linkTiming.latencyMs, tagTiming.latencyMs),
    ).toBeLessThanOrEqual(100);
    await expect($('[data-task9-existing-card]')).toExist();
    await expect(comment).toHaveValue('Contextual comment');
    const retainedFocus = await browser.execute(
      (editorSelector) =>
        new Promise<boolean>((resolve) => {
          const started = performance.now();
          const sample = (): void => {
            const editor = document.querySelector<HTMLElement>(editorSelector);
            const focused = document.activeElement;
            if (editor === null || editor.hidden || focused === null || !editor.contains(focused)) {
              resolve(false);
              return;
            }
            if (performance.now() - started >= 775) {
              resolve(true);
              return;
            }
            requestAnimationFrame(sample);
          };
          sample();
        }),
      nativeEditorSelector,
    );
    expect(retainedFocus).toBe(true);
    hash = await waitForPdfBytesToChange(workingPath, hash);
    await expect(popover).toBeDisplayed();
    await expect(comment).toHaveValue('Contextual comment');
    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(1);
    await popover.$('[data-action="delete-annotation"]').click();
    const immediateDeletion = await browser.execute(
      () =>
        new Promise<{ cards: number; native: number; status: string | null }>((resolve) => {
          requestAnimationFrame(() => {
            resolve({
              cards: document.querySelectorAll('.abyss-annotation-card').length,
              native: document.querySelectorAll(
                '.annotationLayer .highlightAnnotation, .highlightEditor',
              ).length,
              status:
                document.querySelector<HTMLElement>('[data-annotations-status]')?.textContent ??
                null,
            });
          });
        }),
    );
    if (
      immediateDeletion.cards !== 0 ||
      immediateDeletion.native !== 0 ||
      immediateDeletion.status !== 'No annotations'
    ) {
      throw new Error(`Immediate delete projection failed: ${JSON.stringify(immediateDeletion)}`);
    }
    await waitForPdfBytesToChange(workingPath, hash);

    await reopenPdf(workingPath);
    await expect($('.annotationLayer .highlightAnnotation')).not.toExist();
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-annotations-status]')).toHaveText('No annotations');
  });

  it('keeps two writable highlights over the exact same geometry independently addressable', async () => {
    let hash = await vaultFileSha256(workingPath);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-annotations-status]')).toHaveText('No annotations');

    for (const comment of ['Overlap first', 'Overlap second']) {
      if (comment === 'Overlap second') {
        await $('[data-control="previous-page"]').click();
        await browser.waitUntil(
          async () =>
            browser.execute(() => {
              const span = Array.from(
                document.querySelectorAll<HTMLElement>('[data-page-number="1"] .textLayer span'),
              ).find((candidate) => candidate.getBoundingClientRect().width >= 40);
              const bounds = span?.getBoundingClientRect();
              return bounds !== undefined && bounds.top >= 0 && bounds.bottom <= window.innerHeight;
            }),
          { timeout: 5_000, timeoutMsg: 'Page 1 selection geometry did not return to view.' },
        );
      }
      await dragFixtureTextWhileInspectingPalette();
      const popover = $(nativeEditorSelector);
      await popover.waitForDisplayed({ timeout: 5_000 });
      await popover.$('[aria-label="Comment"]').click();
      await browser.keys('O');
      await browser.waitUntil(
        async () => {
          const expected = comment === 'Overlap first' ? 1 : 2;
          return browser.execute(
            (count) =>
              document.querySelectorAll('.highlightEditor').length === count &&
              document.querySelectorAll('.abyss-annotation-card').length === count,
            expected,
          );
        },
        { timeout: 10_000, timeoutMsg: `${comment} did not create one independent highlight.` },
      );
      await $(`${nativeEditorSelector} [aria-label="Comment"]`).setValue(comment);
      await browser.waitUntil(
        async () =>
          browser.execute(
            (expectedComment) =>
              Array.from(document.querySelectorAll<HTMLElement>('.abyss-annotation-card')).some(
                (card) => card.innerText.includes(expectedComment),
              ),
            comment,
          ),
        {
          timeout: 2_000,
          timeoutMsg: `${comment} did not reach its independent annotation card.`,
        },
      );
      await browser.keys(Key.Escape);
      await expect(popover).not.toBeDisplayed();
      if (comment === 'Overlap first') hash = await waitForPdfBytesToChange(workingPath, hash);
    }

    const identities = await browser.execute(() => ({
      cards: Array.from(
        document.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
        (card) => card.dataset['annotationId'] ?? '',
      ),
      editors: Array.from(
        document.querySelectorAll<HTMLElement>('.highlightEditor'),
        (editor) => editor.id,
      ),
    }));
    expect(new Set(identities.cards).size).toBe(2);
    expect(new Set(identities.editors).size).toBe(2);

    for (const comment of ['Overlap first', 'Overlap second']) {
      const annotationId = await browser.execute((expectedComment) => {
        const candidate = Array.from(
          document.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
        ).find((card) => card.innerText.includes(expectedComment));
        return candidate?.dataset['annotationId'] ?? null;
      }, comment);
      if (annotationId === null) {
        const cardTexts = await browser.execute(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
            (candidate) => candidate.innerText,
          ),
        );
        throw new Error(`Missing exact overlap card: ${JSON.stringify({ cardTexts, comment })}`);
      }
      const card = $(`[data-annotation-id=${JSON.stringify(annotationId)}]`);
      await card.click();
      await expect($(nativeEditorSelector)).toBeDisplayed();
      await expect($(`${nativeEditorSelector} [aria-label="Comment"]`)).toHaveValue(comment);
    }

    await waitForPdfBytesToChange(workingPath, hash);
    await reopenPdf(workingPath);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelectorAll('.annotationLayer .highlightAnnotation').length === 2,
        ),
      { timeout: 15_000, timeoutMsg: 'Exact overlapping highlights did not both reopen.' },
    );
    const reopenedIds = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.annotationLayer .highlightAnnotation'),
        (annotation) => annotation.dataset['annotationId'] ?? '',
      ),
    );
    expect(new Set(reopenedIds).size).toBe(2);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($$('.abyss-annotation-card')).toBeElementsArrayOfSize(2);
  });

  it('disables persisted overlap batches selected separately with Shift and the platform modifier', async () => {
    let hash = await vaultFileSha256(workingPath);
    await $('[data-control="sidebar"]').click();
    await $('[data-tab="annotations"]').click();
    await expect($('[data-annotations-status]')).toHaveText('No annotations');

    for (const [index, fixture] of [
      { comment: 'Multi first', endRatio: 0.35, startRatio: 0.1 },
      { comment: 'Multi second', endRatio: 0.9, startRatio: 0.65 },
    ].entries()) {
      if (index > 0) {
        await $('[data-control="previous-page"]').click();
        await $('[data-page-number="1"] .textLayer span').waitForDisplayed({ timeout: 5_000 });
      }
      await dragFixtureTextWhileInspectingPalette({
        endRatio: fixture.endRatio,
        startRatio: fixture.startRatio,
      });
      await $(nativeEditorSelector).waitForDisplayed({ timeout: 5_000 });
      await $(`${nativeEditorSelector} [aria-label="Comment"]`).click();
      await browser.keys('M');
      await browser.waitUntil(
        async () =>
          browser.execute(
            (count) =>
              document.querySelectorAll('.highlightEditor').length === count &&
              document.querySelectorAll('.abyss-annotation-card').length === count,
            index + 1,
          ),
        {
          timeout: 10_000,
          timeoutMsg: `${fixture.comment} did not create an independent writable highlight.`,
        },
      );
      await $(`${nativeEditorSelector} [aria-label="Comment"]`).setValue(fixture.comment);
      await browser.waitUntil(
        async () =>
          browser.execute(
            (comment) =>
              Array.from(document.querySelectorAll<HTMLElement>('.abyss-annotation-card')).some(
                (card) => card.innerText.includes(comment),
              ),
            fixture.comment,
          ),
        {
          timeout: 10_000,
          timeoutMsg: `${fixture.comment} did not reach its annotation card.`,
        },
      );
      await browser.keys(Key.Escape);
      await expect($(nativeEditorSelector)).not.toBeDisplayed();
      hash = await waitForPdfBytesToChange(workingPath, hash);
    }

    await reopenPdf(workingPath);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelectorAll('.annotationLayer .highlightAnnotation').length === 2 &&
            document.querySelectorAll('.highlightEditor').length === 0,
        ),
      { timeout: 15_000, timeoutMsg: 'Persisted overlap annotations did not reopen neutrally.' },
    );
    await $$('.annotationLayer .highlightAnnotation')[0]?.click();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelectorAll('.highlightEditor.selectedEditor').length === 1,
        ),
      { timeout: 5_000, timeoutMsg: 'The first native highlight was not selected.' },
    );
    await clickNativeHighlight(1, [Key.Shift]);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelectorAll('.highlightEditor.selectedEditor').length === 2,
        ),
      { timeout: 5_000, timeoutMsg: 'The Shift gesture did not select two persisted editors.' },
    );

    const batchMutationState = async () =>
      browser.execute((selector) => {
        const editor = document.querySelector<HTMLElement>(selector);
        return {
          actionLabels: Array.from(
            editor?.querySelectorAll('button[data-action]') ?? [],
            (button) => button.getAttribute('aria-label'),
          ),
          paletteHidden:
            editor?.querySelector<HTMLElement>('.abyss-annotation-editor-palette')?.hidden ?? true,
          nativeToolbarVisible: Array.from(
            document.querySelectorAll<HTMLElement>('.selectedEditor .editToolbar'),
          ).some(
            (toolbar) =>
              !toolbar.hidden &&
              getComputedStyle(toolbar).display !== 'none' &&
              getComputedStyle(toolbar).visibility !== 'hidden',
          ),
          readOnly: editor?.innerText.includes('Read-only') ?? false,
          status: editor?.querySelector<HTMLElement>('[role="status"]')?.textContent ?? '',
        };
      }, nativeEditorSelector);
    const assertFailClosedBatchContract = async (): Promise<void> => {
      expect(await batchMutationState()).toEqual({
        actionLabels: ['Delete annotations'],
        nativeToolbarVisible: false,
        paletteHidden: false,
        readOnly: false,
        status: '2 annotations selected',
      });
      const green = $(`${nativeEditorSelector} [data-editor-color="#5fb236"]`);
      await browser.execute((selector) => {
        const button = document.querySelector<HTMLButtonElement>(
          `${selector} [data-editor-color="#5fb236"]`,
        );
        if (button === null || button.hidden || button.disabled)
          throw new Error('Unified batch palette action is unavailable.');
        button.click();
      }, nativeEditorSelector);
      await expect(green).toHaveAttribute('aria-pressed', 'false');
      await browser.execute((selector) => {
        const button = document.querySelector<HTMLButtonElement>(
          `${selector} [data-action="delete-annotation"]`,
        );
        if (button === null || button.hidden || button.disabled)
          throw new Error('Unified batch delete action is unavailable.');
        button.click();
      }, nativeEditorSelector);
      await expect($(nativeEditorSelector)).toBeDisplayed();
      await expect($$('.highlightEditor.selectedEditor')).toBeElementsArrayOfSize(2);
    };
    await assertFailClosedBatchContract();

    await reopenPdf(workingPath);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.querySelectorAll('.annotationLayer .highlightAnnotation').length === 2 &&
            document.querySelectorAll('.highlightEditor').length === 0,
        ),
      {
        timeout: 15_000,
        timeoutMsg: 'Persisted overlap annotations did not reopen for the platform gesture.',
      },
    );
    await $$('.annotationLayer .highlightAnnotation')[0]?.click();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelectorAll('.highlightEditor.selectedEditor').length === 1,
        ),
      { timeout: 5_000, timeoutMsg: 'The platform gesture baseline was not selected.' },
    );
    const platformModifier = process.platform === 'darwin' ? Key.Command : Key.Control;
    await clickNativeHighlight(1, [platformModifier]);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelectorAll('.highlightEditor.selectedEditor').length === 2,
        ),
      { timeout: 5_000, timeoutMsg: 'The platform-modifier gesture did not select two editors.' },
    );
    await assertFailClosedBatchContract();
  });
});
