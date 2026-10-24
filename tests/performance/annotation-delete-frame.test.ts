import { afterEach, describe, expect, it, vi } from 'vitest';
// Load the browser command declarations while keeping the launcher out of the test runtime.
import type {} from 'wdio-obsidian-service';
import {
  installTenThousandDeleteFrameTrace,
  readTenThousandDeleteFrameStatus,
  readTenThousandDeleteFrameTrace,
} from '../e2e/annotation-performance-oracle.js';

const transport = vi.hoisted(() => ({
  execute: vi.fn<(script: unknown, ...args: unknown[]) => Promise<unknown>>(),
  executeObsidian: vi.fn<(script: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('@wdio/globals', () => ({ browser: transport }));
vi.mock('webdriverio', () => ({ Key: { ArrowDown: 'ArrowDown' } }));

let installed = false;
afterEach(async () => {
  const cleanup = installed;
  installed = false;
  if (cleanup) await readTenThousandDeleteFrameTrace();
  document.body.replaceChildren();
});

function invoke(script: unknown, ...args: unknown[]): unknown {
  if (typeof script !== 'function') throw new Error('Expected a browser transport callback.');
  return (script as (...values: unknown[]) => unknown)(...args);
}

function createFixtureReader(): HTMLElement {
  const reader = createEl('main');
  reader.dataset['abyssDocument'] = '';
  const panel = createEl('section');
  panel.dataset['sidebarPanel'] = 'annotations';
  for (const rowId of ['delete-row', 'retained-row']) {
    const row = createEl('article');
    row.className = 'abyss-annotation-card-row';
    row.setAttribute('aria-setsize', '10000');
    const card = createEl('button');
    card.className = 'abyss-annotation-card';
    card.dataset['annotationRowId'] = rowId;
    row.append(card);
    panel.append(row);
  }
  const remove = createEl('button');
  remove.dataset['action'] = 'delete-annotation';
  remove.textContent = 'Delete';
  reader.append(panel, remove);
  return reader;
}

function fixture() {
  document.body.append(createFixtureReader());
  const reader = document.querySelector<HTMLElement>('[data-abyss-document]');
  const target = document.querySelector<HTMLElement>('[data-annotation-row-id="delete-row"]');
  const retained = document.querySelector<HTMLElement>('[data-annotation-row-id="retained-row"]');
  const remove = document.querySelector<HTMLElement>('[data-action="delete-annotation"]');
  if (reader === null || target === null || retained === null || remove === null)
    throw new Error('Expected the deletion fixture.');
  const targetRow = target.closest('article');
  const retainedRow = retained.closest('article');
  if (targetRow === null || retainedRow === null) throw new Error('Expected annotation rows.');
  const originalApply = vi.fn<(events: readonly unknown[]) => boolean>(() => true);
  const projection = { applyViewportBatch: originalApply };
  const app = {
    workspace: {
      getLeavesOfType: () => [{ view: { controller: { annotationProjection: projection } } }],
    },
  };
  transport.executeObsidian.mockImplementation(async (script, ...args) =>
    invoke(script, { app }, ...args),
  );
  transport.execute.mockImplementation(async (script, ...args) => invoke(script, ...args));
  const frames = new Map<number, FrameRequestCallback>();
  let callbackClock = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => callbackClock);
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    reader,
    projection,
    originalApply,
    frames,
    cancel,
    clock,
    focus,
    visibility,
    retainedRow,
    advance(milliseconds: number) {
      callbackClock += milliseconds;
    },
    async install() {
      await installTenThousandDeleteFrameTrace({
        annotationId: 'delete-annotation',
        rowId: 'delete-row',
      });
      installed = true;
    },
    async finish() {
      const result = await readTenThousandDeleteFrameTrace();
      installed = false;
      return result;
    },
    frame(timestamp: number, callbackAt = timestamp) {
      callbackClock = callbackAt;
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) callback(timestamp);
    },
    removeTarget() {
      targetRow.remove();
      retainedRow.setAttribute('aria-setsize', '9999');
    },
    restoreTarget() {
      retainedRow.before(targetRow);
    },
    setSize(size: number) {
      retainedRow.setAttribute('aria-setsize', String(size));
    },
    click(callbackAt = callbackClock) {
      callbackClock = callbackAt;
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
  };
}

describe('passive ten-thousand deletion frame budget', () => {
  it.each([100, 100.1, 150])(
    'preserves a raw %sms frame interval without subtraction',
    async (gap) => {
      const current = fixture();
      await current.install();
      current.frame(0);
      current.click();
      current.removeTarget();
      current.frame(gap);
      expect((await readTenThousandDeleteFrameStatus()).settledFrames).toBe(0);
      current.projection.applyViewportBatch([]);
      for (let index = 1; index <= 5; index += 1) current.frame(gap + index * 16);
      current.frame(gap + 500);

      const trace = await current.finish();

      expect(trace).toEqual({
        deleteClickTrusted: false,
        indexedBatches: 1,
        maxRafGapMs: gap,
        diagnostics: {
          installedAtMs: 0,
          deleteClickedAtMs: 0,
          completedAtMs: gap + 80,
          installedDocument: { visibilityState: 'visible', hasFocus: true },
          finalDocument: { visibilityState: 'visible', hasFocus: true },
          indexedApply: {
            lastStartedAtMs: gap,
            lastEndedAtMs: gap,
            lastDurationMs: 0,
            maxDurationMs: 0,
          },
          statusReads: 1,
          maxStatusReadMs: 0,
          maxGap: {
            fromFrameAtMs: 0,
            toFrameAtMs: gap,
            fromCallbackAtMs: 0,
            toCallbackAtMs: gap,
            previousCallbackDurationMs: 0,
            fromSettledFrames: 0,
            toSettledFrames: 0,
            fromIndexedBatches: 0,
            toIndexedBatches: 0,
          },
        },
        setSize: 9999,
        settledFrames: 5,
        targetPresent: false,
      });
    },
  );

  it('records raw and callback endpoints separately without resetting the interval at click', async () => {
    const current = fixture();
    await current.install();
    current.frame(0, 7);
    current.click(10);
    current.removeTarget();
    current.projection.applyViewportBatch([]);
    current.frame(150, 180);
    for (const timestamp of [166, 182, 198, 214]) current.frame(timestamp, timestamp + 35);

    const trace = await current.finish();

    expect(trace.maxRafGapMs).toBe(150);
    expect(trace.diagnostics).toEqual({
      installedAtMs: 0,
      deleteClickedAtMs: 10,
      completedAtMs: 249,
      installedDocument: { visibilityState: 'visible', hasFocus: true },
      finalDocument: { visibilityState: 'visible', hasFocus: true },
      indexedApply: {
        lastStartedAtMs: 10,
        lastEndedAtMs: 10,
        lastDurationMs: 0,
        maxDurationMs: 0,
      },
      statusReads: 0,
      maxStatusReadMs: 0,
      maxGap: {
        fromFrameAtMs: 0,
        toFrameAtMs: 150,
        fromCallbackAtMs: 7,
        toCallbackAtMs: 180,
        previousCallbackDurationMs: 0,
        fromSettledFrames: 0,
        toSettledFrames: 1,
        fromIndexedBatches: 0,
        toIndexedBatches: 1,
      },
    });
  });

  it('records callback, indexing and poll cost without excluding an unfocused interval', async () => {
    const current = fixture();
    current.focus.mockReturnValue(false);
    current.visibility.mockReturnValue('hidden');
    await current.install();
    for (const row of current.reader.querySelectorAll<HTMLElement>('.abyss-annotation-card-row')) {
      const originalGet = row.getAttribute.bind(row);
      vi.spyOn(row, 'getAttribute').mockImplementation((name) => {
        if (name === 'aria-setsize') current.advance(4);
        return originalGet(name);
      });
    }
    current.frame(100);
    current.click();
    current.removeTarget();
    current.originalApply.mockImplementationOnce(() => {
      current.advance(7);
      return true;
    });
    current.projection.applyViewportBatch([]);
    current.clock.mockReturnValueOnce(200).mockReturnValueOnce(203);
    await readTenThousandDeleteFrameStatus();
    current.frame(250);
    current.focus.mockReturnValue(true);
    current.visibility.mockReturnValue('visible');
    for (const timestamp of [266, 282, 298, 314]) current.frame(timestamp);
    // Final document state belongs to measurement completion, not a later read.
    current.focus.mockReturnValue(false);
    current.visibility.mockReturnValue('hidden');

    const trace = await current.finish();

    expect(trace.maxRafGapMs).toBe(150);
    expect(trace.settledFrames).toBe(5);
    expect(trace.diagnostics).toEqual({
      installedAtMs: 0,
      deleteClickedAtMs: 104,
      completedAtMs: 318,
      installedDocument: { visibilityState: 'hidden', hasFocus: false },
      finalDocument: { visibilityState: 'visible', hasFocus: true },
      indexedApply: {
        lastStartedAtMs: 104,
        lastEndedAtMs: 111,
        lastDurationMs: 7,
        maxDurationMs: 7,
      },
      statusReads: 1,
      maxStatusReadMs: 3,
      maxGap: {
        fromFrameAtMs: 100,
        toFrameAtMs: 250,
        fromCallbackAtMs: 100,
        toCallbackAtMs: 250,
        previousCallbackDurationMs: 4,
        fromSettledFrames: 0,
        toSettledFrames: 1,
        fromIndexedBatches: 0,
        toIndexedBatches: 1,
      },
    });
  });

  it('preserves an indexing failure and records its duration before restoring ownership', async () => {
    const current = fixture();
    await current.install();
    const failure = new Error('indexing failed');
    current.originalApply.mockImplementationOnce(() => {
      current.advance(9);
      throw failure;
    });

    expect(() => current.projection.applyViewportBatch([])).toThrow(failure);
    const trace = await current.finish();

    expect(trace.diagnostics.indexedApply).toEqual({
      lastStartedAtMs: 0,
      lastEndedAtMs: 9,
      lastDurationMs: 9,
      maxDurationMs: 9,
    });
    expect(trace.diagnostics.statusReads).toBe(0);
    expect(trace.diagnostics.completedAtMs).toBeNull();
    expect(current.projection.applyViewportBatch).toBe(current.originalApply);
    expect(current.frames.size).toBe(0);
  });

  it('keeps a pre-click stall inside the monitoring interval', async () => {
    const current = fixture();
    await current.install();
    current.frame(0);
    current.frame(150);
    current.click();
    current.removeTarget();
    current.projection.applyViewportBatch([]);
    for (const timestamp of [166, 182, 198, 214, 230]) current.frame(timestamp);

    expect((await current.finish()).maxRafGapMs).toBe(150);
  });

  it('includes the last interval before the fifth confirmed frame', async () => {
    const current = fixture();
    await current.install();
    current.frame(0);
    current.click();
    current.removeTarget();
    current.projection.applyViewportBatch([]);
    for (const timestamp of [16, 32, 48, 64, 214]) current.frame(timestamp);

    expect((await current.finish()).maxRafGapMs).toBe(150);
  });

  it('requires confirmed indexing and resets five-frame convergence after transient unsettled state', async () => {
    const current = fixture();
    await current.install();
    current.removeTarget();
    for (const timestamp of [0, 16, 32, 48, 64]) current.frame(timestamp);
    expect((await readTenThousandDeleteFrameStatus()).settledFrames).toBe(0);
    current.projection.applyViewportBatch([]);
    current.frame(80);
    current.frame(96);
    expect((await readTenThousandDeleteFrameStatus()).settledFrames).toBe(2);
    current.restoreTarget();
    current.frame(112);
    expect((await readTenThousandDeleteFrameStatus()).settledFrames).toBe(0);
    current.removeTarget();
    current.frame(128);
    current.setSize(10000);
    current.frame(144);
    expect((await readTenThousandDeleteFrameStatus()).settledFrames).toBe(0);
    current.setSize(9999);
    for (const timestamp of [160, 176, 192, 208, 224]) current.frame(timestamp);

    expect(await current.finish()).toMatchObject({
      indexedBatches: 1,
      maxRafGapMs: 16,
      settledFrames: 5,
      setSize: 9999,
      targetPresent: false,
    });
  });

  it('measures without computing styles or installing a mutation observer', async () => {
    const current = fixture();
    const styles = vi.fn();
    vi.stubGlobal('getComputedStyle', styles);
    const observer = vi.fn();
    vi.stubGlobal('MutationObserver', observer);
    await current.install();
    current.click();
    current.removeTarget();
    current.projection.applyViewportBatch([]);
    for (const timestamp of [0, 16, 32, 48, 64]) current.frame(timestamp);
    await current.finish();

    expect(styles).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it('restores the projection hook, removes the click listener, and cancels outstanding frames on cleanup', async () => {
    const current = fixture();
    const add = vi.spyOn(current.reader, 'addEventListener');
    const remove = vi.spyOn(current.reader, 'removeEventListener');
    await current.install();
    const listener = add.mock.calls.find(([name]) => name === 'click')?.[1];
    const pending = Array.from(current.frames.values());
    current.projection.applyViewportBatch([]);
    expect(current.originalApply).toHaveBeenCalledExactlyOnceWith([]);
    expect(current.projection.applyViewportBatch).not.toBe(current.originalApply);

    await current.finish();
    for (const callback of pending) callback(1000);

    expect(current.projection.applyViewportBatch).toBe(current.originalApply);
    expect(remove).toHaveBeenCalledWith('click', listener, true);
    expect(current.cancel).toHaveBeenCalledOnce();
    expect(current.frames.size).toBe(0);
    await expect(readTenThousandDeleteFrameStatus()).rejects.toThrow(/unavailable/u);
  });
});
