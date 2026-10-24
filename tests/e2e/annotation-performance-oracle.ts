import { browser } from '@wdio/globals';
import { Key } from 'webdriverio';

export async function waitForAnimationFrames(frameCount: number): Promise<void> {
  await browser.execute(
    (count) =>
      new Promise<void>((resolve) => {
        let remaining = count;
        const onFrame = (): void => {
          remaining -= 1;
          if (remaining === 0) resolve();
          else requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
      }),
    frameCount,
  );
}

export async function measureNextAnnotationCardNavigation(): Promise<number> {
  await browser.execute(() => {
    const first = document.querySelector<HTMLButtonElement>('.abyss-annotation-card');
    if (first === null) throw new Error('The first annotation card is unavailable.');
    first.focus();
    const trace = {
      abort: new AbortController(),
      durationMs: null as number | null,
      startedAt: null as number | null,
    };
    first.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'ArrowDown') trace.startedAt = performance.now();
      },
      { capture: true, once: true, signal: trace.abort.signal },
    );
    document.addEventListener(
      'focusin',
      (event) => {
        if (
          trace.startedAt !== null &&
          event.target instanceof HTMLElement &&
          event.target.closest('.abyss-annotation-card-row')?.getAttribute('aria-posinset') === '2'
        )
          trace.durationMs = performance.now() - trace.startedAt;
      },
      { capture: true, once: true, signal: trace.abort.signal },
    );
    (
      window as Window & {
        __abyssTask7NavigationTrace?: typeof trace;
      }
    ).__abyssTask7NavigationTrace = trace;
  });
  let lastSample = { durationMs: null as number | null, position: null as string | null };
  try {
    await browser.keys(Key.ArrowDown);
    await browser.waitUntil(
      async () => {
        lastSample = await browser.execute(() => ({
          durationMs:
            (
              window as Window & {
                __abyssTask7NavigationTrace?: { readonly durationMs: number | null };
              }
            ).__abyssTask7NavigationTrace?.durationMs ?? null,
          position:
            document.activeElement
              ?.closest('.abyss-annotation-card-row')
              ?.getAttribute('aria-posinset') ?? null,
        }));
        return lastSample.durationMs !== null && lastSample.position === '2';
      },
      { timeout: 2_000, timeoutMsg: 'Ten-thousand-card keyboard navigation did not settle.' },
    );
    if (lastSample.durationMs === null)
      throw new Error(`Keyboard navigation trace is incomplete: ${JSON.stringify(lastSample)}`);
    return lastSample.durationMs;
  } catch (cause) {
    throw new Error(
      `Ten-thousand-card keyboard navigation did not settle: ${JSON.stringify(lastSample)}; ${String(cause)}`,
    );
  } finally {
    await browser.execute(() => {
      const host = window as Window & {
        __abyssTask7NavigationTrace?: { abort: AbortController };
      };
      host.__abyssTask7NavigationTrace?.abort.abort();
      delete host.__abyssTask7NavigationTrace;
    });
  }
}

export interface TenThousandDeleteTarget {
  readonly annotationId: string;
  readonly rowId: string;
}

export interface TenThousandDeleteTrace {
  readonly baselineNativeSemanticCount: number;
  readonly finalNativeSemanticMismatches: readonly string[];
  readonly indexedBatches: number;
  readonly indexedRenderCalls: number;
  readonly maxRafGapMs: number;
  readonly missingRetainedNativeSemanticIds: readonly string[];
  readonly mountedBursts: number;
  readonly mutationSamples: number;
  readonly replacedRetainedNativeSemanticIds: readonly string[];
  readonly renderCalls: number;
  readonly settledFrames: number;
  readonly targetNativeSemanticPresent: boolean;
  readonly targetPresent: boolean;
  readonly unrelatedCardIdentityBreaks: number;
  readonly zeroCardFrames: number;
  readonly zeroCardMutationSamples: number;
  readonly zeroNativeFrames: number;
  readonly zeroNativeMutationSamples: number;
}

export async function waitForAnnotationProjectionToSettle(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(({ app }) => {
        const view = app.workspace.getLeavesOfType('abyss-document-view')[0]?.view as unknown as
          | {
              controller?: {
                annotationProjectionEvents?: readonly unknown[];
                annotationProjectionFrame?: number | null;
              };
            }
          | undefined;
        const controller = view?.controller;
        return (
          controller?.annotationProjectionFrame === null &&
          (controller.annotationProjectionEvents?.length ?? 0) === 0
        );
      }),
    { timeout: 3_000, timeoutMsg: 'Annotation projection queue did not settle.' },
  );
}

export async function installTenThousandDeleteTrace(
  deleteTarget: TenThousandDeleteTarget,
): Promise<void> {
  await browser.executeObsidian(({ app }, target) => {
    interface ProjectionTrace {
      applyViewportBatch: (events: readonly unknown[]) => boolean;
    }
    interface ControllerTrace {
      annotationProjection: ProjectionTrace;
      renderAnnotationProjection: (...args: readonly unknown[]) => void;
      viewport?: {
        annotationEditor?: {
          resolveNativeEditor(internalId: string): { readonly id: string } | null;
        } | null;
      };
    }
    const view = app.workspace.getLeavesOfType('abyss-document-view')[0]?.view as unknown as
      | {
          controller?: ControllerTrace;
        }
      | undefined;
    const controller = view?.controller;
    const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
    const reader = document.querySelector<HTMLElement>('[data-abyss-document]');
    const targetCard = panel?.querySelector<HTMLElement>(
      `.abyss-annotation-card[data-annotation-row-id="${CSS.escape(target.rowId)}"]`,
    );
    if (controller === undefined || panel === null || reader === null || targetCard === null)
      throw new Error('Ten-thousand delete trace boundary is unavailable.');
    const projection = controller.annotationProjection;
    const unrelatedCards = new Map(
      Array.from(panel.querySelectorAll<HTMLElement>('.abyss-annotation-card'))
        .filter((card) => card !== targetCard)
        .map((card) => [card.dataset['annotationRowId'] ?? '', card] as const),
    );
    if (unrelatedCards.size === 0 || unrelatedCards.has(''))
      throw new Error('Unrelated mounted card identities are incomplete.');
    const nativeSelector =
      '.annotationLayer [data-annotation-id], .annotationEditorLayer :is(.highlightEditor, .inkEditor, .freeTextEditor)[id]';
    const visibleNativeBySemanticId = (): ReadonlyMap<string, ReadonlySet<HTMLElement>> => {
      const result = new Map<string, Set<HTMLElement>>();
      for (const node of Array.from(document.querySelectorAll<HTMLElement>(nativeSelector))) {
        const style = getComputedStyle(node);
        if (
          node.hidden !== false ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        )
          continue;
        const dataSemanticId = node.dataset['annotationId']?.trim();
        const semanticId =
          dataSemanticId !== undefined && dataSemanticId.length > 0
            ? dataSemanticId
            : (controller.viewport?.annotationEditor?.resolveNativeEditor(node.id.trim())?.id ??
              node.id.trim());
        if (semanticId.length === 0) continue;
        const nodes = result.get(semanticId) ?? new Set<HTMLElement>();
        nodes.add(node);
        result.set(semanticId, nodes);
      }
      return result;
    };
    const baselineNativeBySemanticId = visibleNativeBySemanticId();
    const baselineRetainedNativeSemanticIds = new Set(baselineNativeBySemanticId.keys());
    baselineRetainedNativeSemanticIds.delete(target.annotationId);
    if (
      !baselineNativeBySemanticId.has(target.annotationId) ||
      baselineRetainedNativeSemanticIds.size === 0
    )
      throw new Error(
        `Mounted native annotation identities are incomplete: ${JSON.stringify({
          nativeIds: [...baselineNativeBySemanticId.keys()].slice(0, 5),
          nativeSize: baselineNativeBySemanticId.size,
          target: target.annotationId,
        })}`,
      );

    const originalApply = projection.applyViewportBatch;
    const originalRender = controller.renderAnnotationProjection;
    const brokenCards = new WeakSet<HTMLElement>();
    const state = {
      frame: 0,
      indexedBatches: 0,
      indexedRenderCalls: 0,
      lastFrameAt: null as number | null,
      maxRafGapMs: 0,
      measurementComplete: false,
      missingRetainedNativeSemanticIds: new Set<string>(),
      mountedBursts: 0,
      mutationSamples: 0,
      previousSignature: Array.from(
        panel.querySelectorAll<HTMLElement>('.abyss-annotation-card'),
        (card) => card.dataset['annotationRowId'] ?? '',
      ).join('|'),
      pendingIndexedRender: false,
      renderCalls: 0,
      replacedRetainedNativeSemanticIds: new Set<string>(),
      settledFrames: 0,
      stopped: false,
      unrelatedCardIdentityBreaks: 0,
      zeroCardFrames: 0,
      zeroCardMutationSamples: 0,
      zeroNativeFrames: 0,
      zeroNativeMutationSamples: 0,
    };
    const sample = (source: 'frame' | 'mutation'): void => {
      const cards = Array.from(panel.querySelectorAll<HTMLElement>('.abyss-annotation-card'));
      const currentNativeBySemanticId = visibleNativeBySemanticId();
      if (cards.length === 0) {
        if (source === 'frame') state.zeroCardFrames += 1;
        else state.zeroCardMutationSamples += 1;
      }
      if (currentNativeBySemanticId.size === 0) {
        if (source === 'frame') state.zeroNativeFrames += 1;
        else state.zeroNativeMutationSamples += 1;
      }
      for (const semanticId of baselineRetainedNativeSemanticIds) {
        const currentNodes = currentNativeBySemanticId.get(semanticId);
        if (currentNodes === undefined) {
          state.missingRetainedNativeSemanticIds.add(semanticId);
          continue;
        }
        const baselineNodes = baselineNativeBySemanticId.get(semanticId);
        if (
          baselineNodes !== undefined &&
          [...currentNodes].every((node) => !baselineNodes.has(node))
        )
          state.replacedRetainedNativeSemanticIds.add(semanticId);
      }
      const signature = cards.map((card) => card.dataset['annotationRowId'] ?? '').join('|');
      const currentCards = new Map(
        cards.map((card) => [card.dataset['annotationRowId'] ?? '', card] as const),
      );
      if (signature !== state.previousSignature) {
        state.previousSignature = signature;
        state.mountedBursts += 1;
      }
      for (const [rowId, card] of unrelatedCards) {
        if ((!card.isConnected || currentCards.get(rowId) !== card) && !brokenCards.has(card)) {
          brokenCards.add(card);
          state.unrelatedCardIdentityBreaks += 1;
        }
      }
      const targetAbsent =
        panel.querySelector(
          `.abyss-annotation-card[data-annotation-row-id="${CSS.escape(target.rowId)}"]`,
        ) === null;
      const setSize = Number(
        panel.querySelector('.abyss-annotation-card-row')?.getAttribute('aria-setsize'),
      );
      if (source === 'frame')
        state.settledFrames =
          targetAbsent && setSize === 9_999 && state.indexedBatches >= 1
            ? state.settledFrames + 1
            : 0;
    };
    const observer = new MutationObserver((records) => {
      state.mutationSamples += records.length;
      sample('mutation');
    });
    observer.observe(reader, { attributes: true, childList: true, subtree: true });
    const onFrame = (now: number): void => {
      if (state.stopped) return;
      if (!state.measurementComplete && state.lastFrameAt !== null)
        state.maxRafGapMs = Math.max(state.maxRafGapMs, now - state.lastFrameAt);
      state.lastFrameAt = now;
      sample('frame');
      if (state.settledFrames >= 5) state.measurementComplete = true;
      state.frame = requestAnimationFrame(onFrame);
    };
    projection.applyViewportBatch = (events) => {
      state.indexedBatches += 1;
      const changed = originalApply.call(projection, events);
      state.pendingIndexedRender ||= changed;
      return changed;
    };
    controller.renderAnnotationProjection = (...args) => {
      state.renderCalls += 1;
      if (state.pendingIndexedRender) {
        state.indexedRenderCalls += 1;
        state.pendingIndexedRender = false;
      }
      originalRender.call(controller, ...args);
    };
    const snapshot = (): TenThousandDeleteTrace => {
      const currentNativeSemanticIds = new Set(visibleNativeBySemanticId().keys());
      const currentRetainedNativeSemanticIds = new Set(currentNativeSemanticIds);
      currentRetainedNativeSemanticIds.delete(target.annotationId);
      return {
        baselineNativeSemanticCount: baselineNativeBySemanticId.size,
        finalNativeSemanticMismatches: [
          ...[...baselineRetainedNativeSemanticIds].filter(
            (id) => !currentRetainedNativeSemanticIds.has(id),
          ),
          ...[...currentRetainedNativeSemanticIds].filter(
            (id) => !baselineRetainedNativeSemanticIds.has(id),
          ),
        ],
        indexedBatches: state.indexedBatches,
        indexedRenderCalls: state.indexedRenderCalls,
        maxRafGapMs: state.maxRafGapMs,
        missingRetainedNativeSemanticIds: [...state.missingRetainedNativeSemanticIds],
        mountedBursts: state.mountedBursts,
        mutationSamples: state.mutationSamples,
        replacedRetainedNativeSemanticIds: [...state.replacedRetainedNativeSemanticIds],
        renderCalls: state.renderCalls,
        settledFrames: state.settledFrames,
        targetNativeSemanticPresent: currentNativeSemanticIds.has(target.annotationId),
        targetPresent:
          panel.querySelector(
            `.abyss-annotation-card[data-annotation-row-id="${CSS.escape(target.rowId)}"]`,
          ) !== null,
        unrelatedCardIdentityBreaks: state.unrelatedCardIdentityBreaks,
        zeroCardFrames: state.zeroCardFrames,
        zeroCardMutationSamples: state.zeroCardMutationSamples,
        zeroNativeFrames: state.zeroNativeFrames,
        zeroNativeMutationSamples: state.zeroNativeMutationSamples,
      };
    };
    state.frame = requestAnimationFrame(onFrame);
    (
      window as Window & {
        __abyssTask7DeleteTrace?: {
          cleanup(): TenThousandDeleteTrace;
          snapshot(): TenThousandDeleteTrace;
        };
      }
    ).__abyssTask7DeleteTrace = {
      cleanup() {
        state.stopped = true;
        cancelAnimationFrame(state.frame);
        const pending = observer.takeRecords();
        if (pending.length > 0) {
          state.mutationSamples += pending.length;
          sample('mutation');
        }
        observer.disconnect();
        projection.applyViewportBatch = originalApply;
        controller.renderAnnotationProjection = originalRender;
        return snapshot();
      },
      snapshot,
    };
  }, deleteTarget);
}

export async function readTenThousandDeleteTrace(cleanup = false): Promise<TenThousandDeleteTrace> {
  return browser.execute((shouldCleanup) => {
    const host = window as Window & {
      __abyssTask7DeleteTrace?: {
        cleanup(): TenThousandDeleteTrace;
        snapshot(): TenThousandDeleteTrace;
      };
    };
    const monitor = host.__abyssTask7DeleteTrace;
    if (monitor === undefined) throw new Error('Ten-thousand delete trace is unavailable.');
    const result = shouldCleanup ? monitor.cleanup() : monitor.snapshot();
    if (shouldCleanup) delete host.__abyssTask7DeleteTrace;
    return result;
  }, cleanup);
}
