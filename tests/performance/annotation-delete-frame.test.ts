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
    frame(timestamp: number) {
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
    click() {
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
        setSize: 9999,
        settledFrames: 5,
        targetPresent: false,
      });
    },
  );

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
