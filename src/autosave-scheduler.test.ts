import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutosaveScheduler } from './autosave-scheduler.js';

describe('AutosaveScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits 750ms of idle time and imposes a 5000ms maximum dirty latency', async () => {
    const save = vi.fn(async (_generation: number, _reason: string) => undefined);
    const scheduler = new AutosaveScheduler(save);
    scheduler.markDirty(1);
    await vi.advanceTimersByTimeAsync(749);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledWith(1, 'autosave');

    scheduler.markDirty(2);
    for (let elapsed = 0; elapsed < 5000; elapsed += 500) {
      await vi.advanceTimersByTimeAsync(500);
      if (elapsed < 4500) scheduler.markDirty(2 + elapsed / 500);
    }
    expect(save.mock.calls.some(([, reason]) => reason === 'maximum-latency')).toBe(true);
  });

  it('coalesces edits during one in-flight save into the newest following generation', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn(async (_generation: number, _reason: string) => {
      if (save.mock.calls.length === 1) await first;
    });
    const scheduler = new AutosaveScheduler(save);
    scheduler.markDirty(1);
    const flush = scheduler.flush();
    scheduler.markDirty(2);
    scheduler.markDirty(3);
    release();
    await flush;
    await vi.runAllTimersAsync();

    expect(save.mock.calls.map(([generation]) => generation)).toEqual([1, 3]);
  });

  it('defers automatic serialization while an editor is open and drains immediately when editing ends', async () => {
    let editing = true;
    const save = vi.fn(async (_generation: number, _reason: string) => undefined);
    const scheduler = new AutosaveScheduler(save, {
      shouldDeferAutomaticSave: () => editing,
    });
    scheduler.markDirty(1);

    await vi.advanceTimersByTimeAsync(5_250);
    expect(save).not.toHaveBeenCalled();
    expect(scheduler.lifecycleSnapshot()).toMatchObject({
      newestGeneration: 1,
      savedGeneration: 0,
    });

    editing = false;
    await scheduler.resumeAutomaticSave();
    expect(save).toHaveBeenCalledExactlyOnceWith(1, 'autosave');
  });

  it('lets an explicit flush bypass an open editor deferral', async () => {
    const save = vi.fn(async (_generation: number, _reason: string) => undefined);
    const scheduler = new AutosaveScheduler(save, {
      shouldDeferAutomaticSave: () => true,
    });
    scheduler.markDirty(2);

    await scheduler.flush();

    expect(save).toHaveBeenCalledExactlyOnceWith(2, 'manual');
  });

  it('pauses after failure, retains the generation for explicit Retry, and cancels teardown', async () => {
    const failure = new Error('disk full');
    const save = vi
      .fn<(generation: number, reason: string) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const onFailure = vi.fn();
    const scheduler = new AutosaveScheduler(save, { onFailure });
    scheduler.markDirty(4);

    await expect(scheduler.flush()).rejects.toBe(failure);
    expect(scheduler.isPaused).toBe(true);
    expect(onFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledOnce();
    await scheduler.retry();
    expect(save).toHaveBeenLastCalledWith(4, 'retry');

    scheduler.markDirty(5);
    scheduler.destroy();
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('rejects non-retry flush while paused and treats clean/destroyed retry as a no-op', async () => {
    const save = vi.fn(async () => Promise.reject(new Error('failed')));
    const scheduler = new AutosaveScheduler(save);
    scheduler.markDirty(1);
    await expect(scheduler.flush()).rejects.toThrow('failed');
    await expect(scheduler.flush()).rejects.toMatchObject({ name: 'InvalidStateError' });

    const clean = new AutosaveScheduler(vi.fn(async () => undefined));
    await clean.flush();
    clean.destroy();
    await clean.retry();
  });

  it('waits on the same in-flight generation when forced twice without a newer edit', async () => {
    const gate = deferred<void>();
    const save = vi.fn(async () => gate.promise);
    const scheduler = new AutosaveScheduler(save);
    scheduler.markDirty(1);
    const first = scheduler.flush();
    const second = scheduler.flush();
    gate.resolve();
    await Promise.all([first, second]);
    expect(save).toHaveBeenCalledOnce();
  });

  it('releases a covered external pause after in-flight success and drains the newer generation', async () => {
    const gate = deferred<void>();
    const save = vi.fn(async (generation: number) => {
      if (generation === 1) await gate.promise;
    });
    const scheduler = new AutosaveScheduler(save);
    scheduler.markDirty(1);
    const saving = scheduler.flush();
    scheduler.pauseForFailure(new Error('peer save'), 1);
    scheduler.markDirty(2);

    gate.resolve();
    await saving;

    expect(save.mock.calls.map(([generation]) => generation)).toEqual([1, 2]);
    expect(scheduler.lifecycleSnapshot()).toMatchObject({
      newestGeneration: 2,
      paused: false,
      savedGeneration: 2,
    });
  });

  it('does not publish an actionable failure after its owner is destroyed in flight', async () => {
    const gate = deferred<void>();
    const onFailure = vi.fn();
    const scheduler = new AutosaveScheduler(
      vi.fn(async () => gate.promise),
      { onFailure },
    );
    scheduler.markDirty(1);
    const saving = scheduler.flush();
    scheduler.destroy();
    gate.reject(new Error('late failure'));

    await expect(saving).rejects.toThrow('late failure');
    expect(onFailure).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
