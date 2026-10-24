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
        ) {
          trace.durationMs = performance.now() - trace.startedAt;
          trace.abort.abort();
        }
      },
      { capture: true, signal: trace.abort.signal },
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

export interface TenThousandDeleteStatus {
  readonly indexedBatches: number;
  readonly setSize: number;
  readonly settledFrames: number;
  readonly targetPresent: boolean;
}

interface DeleteTiming {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly maxStartedAtMs: number | null;
}

export interface TenThousandDeleteTrace {
  readonly diagnostics: {
    readonly deleteClickedAtMs: number | null;
    readonly deleteClickTrusted: boolean | null;
    readonly measurementCompletedAtMs: number | null;
    readonly stoppedAtMs: number | null;
    readonly statusReads: number;
    readonly timings: {
      readonly frameSample: DeleteTiming;
      readonly mutationSample: DeleteTiming;
      readonly snapshot: DeleteTiming;
      readonly apply: DeleteTiming;
      readonly render: DeleteTiming;
    };
    readonly maxGap: {
      readonly fromFrameAtMs: number | null;
      readonly toFrameAtMs: number | null;
      readonly fromCallbackAtMs: number | null;
      readonly toCallbackAtMs: number | null;
      readonly frameSampleMs: number;
      readonly frameSamples: number;
      readonly mutationSampleMs: number;
      readonly mutationSamples: number;
      readonly applyMs: number;
      readonly renderMs: number;
    };
    readonly phases: ReadonlyArray<{
      readonly phase: 'apply' | 'render';
      readonly startedAtMs: number;
      readonly durationMs: number;
    }>;
    readonly droppedPhases: number;
  };
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
    const visibleNativeBySemanticId = (
      result = new Map<string, Set<HTMLElement>>(),
      reusableSets?: Map<string, Set<HTMLElement>>,
    ): ReadonlyMap<string, ReadonlySet<HTMLElement>> => {
      result.clear();
      for (const node of document.querySelectorAll<HTMLElement>(nativeSelector)) {
        if (node.hidden !== false) continue;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
          continue;
        const dataSemanticId = node.dataset['annotationId']?.trim();
        const semanticId =
          dataSemanticId !== undefined && dataSemanticId.length > 0
            ? dataSemanticId
            : (controller.viewport?.annotationEditor?.resolveNativeEditor(node.id.trim())?.id ??
              node.id.trim());
        if (semanticId.length === 0) continue;
        let nodes = result.get(semanticId);
        if (nodes === undefined) {
          nodes = reusableSets?.get(semanticId) ?? new Set<HTMLElement>();
          nodes.clear();
          reusableSets?.set(semanticId, nodes);
          result.set(semanticId, nodes);
        }
        nodes.add(node);
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

    // Reuse current-sample storage; baseline nodes remain independent identity witnesses.
    const sampledNativeNodes = new Map<string, Set<HTMLElement>>();
    const reusableNativeSets = new Map<string, Set<HTMLElement>>();
    const currentCards = new Map<string, HTMLElement>();

    // Diagnostic timestamps start after the baseline native scan.
    const installedAt = performance.now();
    const now = (): number => performance.now() - installedAt;
    const timing = () => ({
      count: 0,
      totalMs: 0,
      maxMs: 0,
      maxStartedAtMs: null as number | null,
    });
    const timings = {
      frameSample: timing(),
      mutationSample: timing(),
      snapshot: timing(),
      apply: timing(),
      render: timing(),
    };
    const recordTiming = (
      metric: ReturnType<typeof timing>,
      startedAtMs: number,
      endedAtMs: number,
    ): void => {
      const durationMs = endedAtMs - startedAtMs;
      metric.count += 1;
      metric.totalMs += durationMs;
      if (durationMs > metric.maxMs) {
        metric.maxMs = durationMs;
        metric.maxStartedAtMs = startedAtMs;
      }
    };
    // Fixed diagnostic storage avoids allocating timing records per sample.
    const maxGap = {
      fromFrameAtMs: null as number | null,
      toFrameAtMs: null as number | null,
      fromCallbackAtMs: null as number | null,
      toCallbackAtMs: null as number | null,
      frameSampleMs: 0,
      frameSamples: 0,
      mutationSampleMs: 0,
      mutationSamples: 0,
      applyMs: 0,
      renderMs: 0,
    };
    const previousFrameTimings = {
      frameSampleMs: 0,
      frameSamples: 0,
      mutationSampleMs: 0,
      mutationSamples: 0,
      applyMs: 0,
      renderMs: 0,
    };
    const phaseKinds = new Uint8Array(16);
    const phaseStarts = new Float64Array(16);
    const phaseDurations = new Float64Array(16);
    let phaseCount = 0;
    let droppedPhases = 0;
    const recordPhase = (kind: 0 | 1, startedAtMs: number, endedAtMs: number): void => {
      if (phaseCount === phaseKinds.length) {
        droppedPhases += 1;
        return;
      }
      phaseKinds[phaseCount] = kind;
      phaseStarts[phaseCount] = startedAtMs;
      phaseDurations[phaseCount] = endedAtMs - startedAtMs;
      phaseCount += 1;
    };
    const originalApply = projection.applyViewportBatch;
    const originalRender = controller.renderAnnotationProjection;
    const brokenCards = new WeakSet<HTMLElement>();
    const state = {
      frame: 0,
      indexedBatches: 0,
      indexedRenderCalls: 0,
      lastFrameAt: null as number | null,
      lastCallbackAtMs: null as number | null,
      deleteClickedAtMs: null as number | null,
      deleteClickTrusted: null as boolean | null,
      measurementCompletedAtMs: null as number | null,
      stoppedAtMs: null as number | null,
      statusReads: 0,
      setSize: Number(
        panel.querySelector('.abyss-annotation-card-row')?.getAttribute('aria-setsize'),
      ),
      targetPresent: true,
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
      const startedAtMs = now();
      const cards = panel.querySelectorAll<HTMLElement>('.abyss-annotation-card');
      const currentNativeBySemanticId = visibleNativeBySemanticId(
        sampledNativeNodes,
        reusableNativeSets,
      );
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
        if (baselineNodes !== undefined) {
          let retainsBaselineNode = false;
          for (const node of currentNodes) {
            if (baselineNodes.has(node)) {
              retainsBaselineNode = true;
              break;
            }
          }
          if (!retainsBaselineNode) state.replacedRetainedNativeSemanticIds.add(semanticId);
        }
      }
      const signature = Array.from(cards, (card) => card.dataset['annotationRowId'] ?? '').join(
        '|',
      );
      currentCards.clear();
      for (const card of cards) currentCards.set(card.dataset['annotationRowId'] ?? '', card);
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
      state.targetPresent = !targetAbsent;
      state.setSize = setSize;
      if (source === 'frame')
        state.settledFrames =
          targetAbsent && setSize === 9_999 && state.indexedBatches >= 1
            ? state.settledFrames + 1
            : 0;
      recordTiming(
        source === 'frame' ? timings.frameSample : timings.mutationSample,
        startedAtMs,
        now(),
      );
    };
    const onDeleteClick = (event: MouseEvent): void => {
      if (
        state.deleteClickedAtMs === null &&
        event.target instanceof Element &&
        event.target.closest('[data-action="delete-annotation"]') !== null
      ) {
        state.deleteClickedAtMs = now();
        state.deleteClickTrusted = event.isTrusted;
      }
    };
    reader.addEventListener('click', onDeleteClick, true);
    const observer = new MutationObserver((records) => {
      state.mutationSamples += records.length;
      sample('mutation');
    });
    observer.observe(reader, { attributes: true, childList: true, subtree: true });
    const onFrame = (frameAt: number): void => {
      if (state.stopped) return;
      const callbackAtMs = performance.now() - installedAt;
      if (!state.measurementComplete && state.lastFrameAt !== null) {
        const gapMs = frameAt - state.lastFrameAt;
        if (gapMs > state.maxRafGapMs) {
          state.maxRafGapMs = gapMs;
          maxGap.fromFrameAtMs = state.lastFrameAt - installedAt;
          maxGap.toFrameAtMs = frameAt - installedAt;
          maxGap.fromCallbackAtMs = state.lastCallbackAtMs;
          maxGap.toCallbackAtMs = callbackAtMs;
          maxGap.frameSampleMs = timings.frameSample.totalMs - previousFrameTimings.frameSampleMs;
          maxGap.frameSamples = timings.frameSample.count - previousFrameTimings.frameSamples;
          maxGap.mutationSampleMs =
            timings.mutationSample.totalMs - previousFrameTimings.mutationSampleMs;
          maxGap.mutationSamples =
            timings.mutationSample.count - previousFrameTimings.mutationSamples;
          maxGap.applyMs = timings.apply.totalMs - previousFrameTimings.applyMs;
          maxGap.renderMs = timings.render.totalMs - previousFrameTimings.renderMs;
        }
      }
      previousFrameTimings.frameSampleMs = timings.frameSample.totalMs;
      previousFrameTimings.frameSamples = timings.frameSample.count;
      previousFrameTimings.mutationSampleMs = timings.mutationSample.totalMs;
      previousFrameTimings.mutationSamples = timings.mutationSample.count;
      previousFrameTimings.applyMs = timings.apply.totalMs;
      previousFrameTimings.renderMs = timings.render.totalMs;
      state.lastFrameAt = frameAt;
      state.lastCallbackAtMs = callbackAtMs;
      sample('frame');
      if (!state.measurementComplete && state.settledFrames >= 5) {
        state.measurementComplete = true;
        state.measurementCompletedAtMs = performance.now() - installedAt;
      }
      state.frame = requestAnimationFrame(onFrame);
    };
    projection.applyViewportBatch = (events) => {
      state.indexedBatches += 1;
      const startedAtMs = now();
      try {
        const changed = originalApply.call(projection, events);
        state.pendingIndexedRender ||= changed;
        return changed;
      } finally {
        const endedAtMs = now();
        recordTiming(timings.apply, startedAtMs, endedAtMs);
        recordPhase(0, startedAtMs, endedAtMs);
      }
    };
    controller.renderAnnotationProjection = (...args) => {
      state.renderCalls += 1;
      if (state.pendingIndexedRender) {
        state.indexedRenderCalls += 1;
        state.pendingIndexedRender = false;
      }
      const startedAtMs = now();
      try {
        originalRender.call(controller, ...args);
      } finally {
        const endedAtMs = now();
        recordTiming(timings.render, startedAtMs, endedAtMs);
        recordPhase(1, startedAtMs, endedAtMs);
      }
    };
    const status = (): TenThousandDeleteStatus => {
      state.statusReads += 1;
      return {
        indexedBatches: state.indexedBatches,
        setSize: state.setSize,
        settledFrames: state.settledFrames,
        targetPresent: state.targetPresent,
      };
    };
    const snapshot = (): TenThousandDeleteTrace => {
      const startedAtMs = now();
      const currentNativeSemanticIds = new Set(visibleNativeBySemanticId().keys());
      const currentRetainedNativeSemanticIds = new Set(currentNativeSemanticIds);
      currentRetainedNativeSemanticIds.delete(target.annotationId);
      const finalNativeSemanticMismatches = [
        ...[...baselineRetainedNativeSemanticIds].filter(
          (id) => !currentRetainedNativeSemanticIds.has(id),
        ),
        ...[...currentRetainedNativeSemanticIds].filter(
          (id) => !baselineRetainedNativeSemanticIds.has(id),
        ),
      ];
      const result: TenThousandDeleteTrace = {
        diagnostics: {
          deleteClickedAtMs: state.deleteClickedAtMs,
          deleteClickTrusted: state.deleteClickTrusted,
          measurementCompletedAtMs: state.measurementCompletedAtMs,
          stoppedAtMs: state.stoppedAtMs,
          statusReads: state.statusReads,
          timings,
          maxGap,
          phases: Array.from({ length: phaseCount }, (_, index) => ({
            phase: phaseKinds[index] === 0 ? ('apply' as const) : ('render' as const),
            startedAtMs: phaseStarts[index] ?? 0,
            durationMs: phaseDurations[index] ?? 0,
          })),
          droppedPhases,
        },
        baselineNativeSemanticCount: baselineNativeBySemanticId.size,
        finalNativeSemanticMismatches,
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
      recordTiming(timings.snapshot, startedAtMs, now());
      return result;
    };
    state.frame = requestAnimationFrame(onFrame);
    (
      window as Window & {
        __abyssTask7DeleteTrace?: {
          cleanup(): TenThousandDeleteTrace;
          status(): TenThousandDeleteStatus;
        };
      }
    ).__abyssTask7DeleteTrace = {
      cleanup() {
        state.stopped = true;
        state.stoppedAtMs = now();
        cancelAnimationFrame(state.frame);
        reader.removeEventListener('click', onDeleteClick, true);
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
      status,
    };
  }, deleteTarget);
}

export async function readTenThousandDeleteStatus(): Promise<TenThousandDeleteStatus> {
  return browser.execute(() => {
    const monitor = (
      window as Window & {
        __abyssTask7DeleteTrace?: { status(): TenThousandDeleteStatus };
      }
    ).__abyssTask7DeleteTrace;
    if (monitor === undefined) throw new Error('Ten-thousand delete trace is unavailable.');
    return monitor.status();
  });
}

// Full native snapshots run only after cancelling the measured animation loop.
export async function readTenThousandDeleteTrace(): Promise<TenThousandDeleteTrace> {
  return browser.execute(() => {
    const host = window as Window & {
      __abyssTask7DeleteTrace?: {
        cleanup(): TenThousandDeleteTrace;
        status(): TenThousandDeleteStatus;
      };
    };
    const monitor = host.__abyssTask7DeleteTrace;
    if (monitor === undefined) throw new Error('Ten-thousand delete trace is unavailable.');
    const result = monitor.cleanup();
    delete host.__abyssTask7DeleteTrace;
    return result;
  });
}

export interface TenThousandDeleteFrameTrace extends TenThousandDeleteStatus {
  readonly deleteClickTrusted: boolean | null;
  readonly maxRafGapMs: number;
  readonly diagnostics: {
    readonly installedAtMs: number;
    readonly deleteClickedAtMs: number | null;
    readonly completedAtMs: number | null;
    readonly maxGap: {
      readonly fromFrameAtMs: number | null;
      readonly toFrameAtMs: number | null;
      readonly fromCallbackAtMs: number | null;
      readonly toCallbackAtMs: number | null;
    };
  };
}

export async function installTenThousandDeleteFrameTrace(
  deleteTarget: TenThousandDeleteTarget,
): Promise<void> {
  await browser.executeObsidian(({ app }, target) => {
    interface ProjectionFrameTrace {
      applyViewportBatch: (events: readonly unknown[]) => boolean;
    }
    const view = app.workspace.getLeavesOfType('abyss-document-view')[0]?.view as unknown as
      { controller?: { annotationProjection: ProjectionFrameTrace } } | undefined;
    const projection = view?.controller?.annotationProjection;
    const panel = document.querySelector<HTMLElement>('[data-sidebar-panel="annotations"]');
    const reader = document.querySelector<HTMLElement>('[data-abyss-document]');
    const selector = `.abyss-annotation-card[data-annotation-row-id="${CSS.escape(target.rowId)}"]`;
    if (
      projection === undefined ||
      panel === null ||
      reader === null ||
      panel.querySelector(selector) === null
    )
      throw new Error('Ten-thousand delete frame boundary is unavailable.');
    const state = {
      complete: false,
      installedAtMs: performance.now(),
      deleteClickedAtMs: null as number | null,
      completedAtMs: null as number | null,
      deleteClickTrusted: null as boolean | null,
      frame: null as number | null,
      indexedBatches: 0,
      lastFrameAt: null as number | null,
      lastCallbackAtMs: null as number | null,
      maxRafGapMs: 0,
      fromFrameAtMs: null as number | null,
      toFrameAtMs: null as number | null,
      fromCallbackAtMs: null as number | null,
      toCallbackAtMs: null as number | null,
      setSize: Number(
        panel.querySelector('.abyss-annotation-card-row')?.getAttribute('aria-setsize'),
      ),
      settledFrames: 0,
      stopped: false,
      targetPresent: true,
    };
    const originalApply = projection.applyViewportBatch;
    const apply = (events: readonly unknown[]): boolean => {
      state.indexedBatches += 1;
      return originalApply.call(projection, events);
    };
    const onClick = (event: MouseEvent): void => {
      if (
        state.deleteClickTrusted === null &&
        event.target instanceof Element &&
        event.target.closest('[data-action="delete-annotation"]') !== null
      ) {
        state.deleteClickTrusted = event.isTrusted;
        state.deleteClickedAtMs = performance.now();
      }
    };
    const onFrame = (frameAt: number): void => {
      if (state.stopped || state.complete) return;
      state.frame = null;
      const callbackAtMs = performance.now();
      if (state.lastFrameAt !== null) {
        const gapMs = frameAt - state.lastFrameAt;
        if (gapMs > state.maxRafGapMs) {
          state.maxRafGapMs = gapMs;
          state.fromFrameAtMs = state.lastFrameAt;
          state.toFrameAtMs = frameAt;
          state.fromCallbackAtMs = state.lastCallbackAtMs;
          state.toCallbackAtMs = callbackAtMs;
        }
      }
      state.lastFrameAt = frameAt;
      state.lastCallbackAtMs = callbackAtMs;
      state.targetPresent = panel.querySelector(selector) !== null;
      state.setSize = Number(
        panel.querySelector('.abyss-annotation-card-row')?.getAttribute('aria-setsize'),
      );
      state.settledFrames =
        !state.targetPresent && state.setSize === 9_999 && state.indexedBatches >= 1
          ? state.settledFrames + 1
          : 0;
      if (state.settledFrames >= 5) {
        state.complete = true;
        state.completedAtMs = performance.now();
        return;
      }
      state.frame = requestAnimationFrame(onFrame);
    };
    const status = (): TenThousandDeleteStatus => ({
      indexedBatches: state.indexedBatches,
      setSize: state.setSize,
      settledFrames: state.settledFrames,
      targetPresent: state.targetPresent,
    });
    projection.applyViewportBatch = apply;
    reader.addEventListener('click', onClick, true);
    state.frame = requestAnimationFrame(onFrame);
    (
      window as Window & {
        __abyssTask7DeleteFrameTrace?: {
          cleanup(): TenThousandDeleteFrameTrace;
          status(): TenThousandDeleteStatus;
        };
      }
    ).__abyssTask7DeleteFrameTrace = {
      cleanup() {
        state.stopped = true;
        if (state.frame !== null) cancelAnimationFrame(state.frame);
        reader.removeEventListener('click', onClick, true);
        if (projection.applyViewportBatch === apply) projection.applyViewportBatch = originalApply;
        return {
          ...status(),
          deleteClickTrusted: state.deleteClickTrusted,
          maxRafGapMs: state.maxRafGapMs,
          diagnostics: {
            installedAtMs: state.installedAtMs,
            deleteClickedAtMs: state.deleteClickedAtMs,
            completedAtMs: state.completedAtMs,
            maxGap: {
              fromFrameAtMs: state.fromFrameAtMs,
              toFrameAtMs: state.toFrameAtMs,
              fromCallbackAtMs: state.fromCallbackAtMs,
              toCallbackAtMs: state.toCallbackAtMs,
            },
          },
        };
      },
      status,
    };
  }, deleteTarget);
}

export async function readTenThousandDeleteFrameStatus(): Promise<TenThousandDeleteStatus> {
  return browser.execute(() => {
    const monitor = (
      window as Window & {
        __abyssTask7DeleteFrameTrace?: { status(): TenThousandDeleteStatus };
      }
    ).__abyssTask7DeleteFrameTrace;
    if (monitor === undefined) throw new Error('Ten-thousand delete frame trace is unavailable.');
    return monitor.status();
  });
}

export async function readTenThousandDeleteFrameTrace(): Promise<TenThousandDeleteFrameTrace> {
  return browser.execute(() => {
    const host = window as Window & {
      __abyssTask7DeleteFrameTrace?: { cleanup(): TenThousandDeleteFrameTrace };
    };
    const monitor = host.__abyssTask7DeleteFrameTrace;
    if (monitor === undefined) throw new Error('Ten-thousand delete frame trace is unavailable.');
    try {
      return monitor.cleanup();
    } finally {
      delete host.__abyssTask7DeleteFrameTrace;
    }
  });
}
