import { describe, expect, it, vi } from 'vitest';
import type {
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfSelectionAction,
} from '../adapters/pdf/pdf-annotation-editor.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import {
  AnnotationInteractionController,
  type AnnotationInteractionHost,
  type QuickHighlightState,
} from './annotation-interaction-controller.js';
import type { SelectionAnnotationPopoverRequest } from './selection-annotation-popover.js';

const palette = [
  { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
  { color: '#5fb236', meaning: 'Definition', name: 'Green' },
] as const;

function textSelection(token = 'selection-1'): PdfTextSelection {
  return {
    clientRect: { bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 },
    input: 'pointer',
    text: 'Selected text',
    token,
  };
}

function deferred<T>() {
  let reject!: (cause?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function fixture(initialMode: PdfAnnotationLogicalMode = 'neutral') {
  let mode = initialMode;
  const modeListeners = new Set<(value: PdfAnnotationLogicalMode) => void>();
  const selectionListeners = new Set<(value: PdfTextSelection | null) => void>();
  const commitSelection = vi.fn(
    async (
      _token: string,
      _action: PdfSelectionAction,
      _signal?: AbortSignal,
    ): Promise<'created'> => 'created',
  );
  const setQuickHighlight = vi.fn(
    async (state: { readonly enabled: boolean; readonly color: string }): Promise<void> => {
      mode = state.enabled ? 'quick-highlight' : 'neutral';
      for (const listener of modeListeners) listener(mode);
    },
  );
  const interaction: PdfAnnotationInteraction = {
    commitSelection,
    onMode(listener) {
      modeListeners.add(listener);
      listener(mode);
      return () => modeListeners.delete(listener);
    },
    onSelection(listener) {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    setQuickHighlight,
  };
  const opened: SelectionAnnotationPopoverRequest[] = [];
  const states: QuickHighlightState[] = [];
  const closeSelectionPopover = vi.fn();
  const host: AnnotationInteractionHost = {
    closeSelectionPopover,
    openSelectionPopover: (request) => opened.push(request),
    setQuickHighlightState: (state) => states.push(state),
  };
  const failures: Array<{ action: string; cause: unknown }> = [];
  const observedColors: string[] = [];
  const observedModes: PdfAnnotationLogicalMode[] = [];
  const controller = new AnnotationInteractionController(interaction, host, palette, {
    onColorChange: (color) => observedColors.push(color),
    onFailure: (action, cause) => failures.push({ action, cause }),
    onModeChange: (nextMode) => observedModes.push(nextMode),
  });
  return {
    closeSelectionPopover,
    commitSelection,
    controller,
    emitMode(next: PdfAnnotationLogicalMode) {
      mode = next;
      for (const listener of modeListeners) listener(next);
    },
    emitSelection(selection: PdfTextSelection | null) {
      for (const listener of selectionListeners) listener(selection);
    },
    failures,
    opened,
    observedColors,
    observedModes,
    modeListenerCount: () => modeListeners.size,
    selectionListenerCount: () => selectionListeners.size,
    setQuickHighlight,
    states,
  };
}

describe('AnnotationInteractionController', () => {
  it('shows the palette only in neutral mode', () => {
    const test = fixture();
    test.emitSelection(textSelection('neutral'));
    expect(test.opened).toHaveLength(1);

    test.emitMode('quick-highlight');
    test.emitSelection(textSelection('quick'));

    expect(test.opened).toHaveLength(1);
    expect(test.closeSelectionPopover).toHaveBeenCalled();
    test.controller.destroy();
  });

  it('maps comment link and tag to one seeded comment commit', async () => {
    const test = fixture();
    let expectedCommitCount = 0;
    for (const [type, token] of [
      ['comment', 'comment-selection'],
      ['link', 'link-selection'],
      ['tag', 'tag-selection'],
    ] as const) {
      expectedCommitCount += 1;
      test.emitSelection(textSelection(token));
      test.opened[test.opened.length - 1]?.onIntent({ color: '#ffd400', type });
      await vi.waitFor(() => {
        expect(test.commitSelection).toHaveBeenCalledTimes(expectedCommitCount);
      });
    }

    expect(test.commitSelection.mock.calls.map(([token, action]) => [token, action])).toEqual([
      ['comment-selection', { color: '#ffd400', kind: 'comment', seed: '' }],
      ['link-selection', { color: '#ffd400', kind: 'comment', seed: '[[' }],
      ['tag-selection', { color: '#ffd400', kind: 'comment', seed: '#' }],
    ]);
    test.controller.destroy();
  });

  it('commits one neutral highlight and returns neutral', async () => {
    const test = fixture();
    test.emitSelection(textSelection());

    test.opened[0]?.onIntent({ color: '#5fb236', type: 'highlight' });

    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledExactlyOnceWith(
        'selection-1',
        { color: '#5fb236', kind: 'highlight' },
        expect.any(AbortSignal),
      );
    });
    expect(test.setQuickHighlight).not.toHaveBeenCalled();
    expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#5fb236' });
    expect(test.observedColors).toEqual(['#5fb236']);
    test.controller.destroy();
  });

  it('arms and disarms Quick Highlight', async () => {
    const test = fixture();

    test.controller.requestTool('highlight');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledWith({
        color: '#ffd400',
        enabled: true,
      });
    });
    expect(test.states[test.states.length - 1]).toEqual({ armed: true, color: '#ffd400' });

    test.controller.requestTool('select');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#ffd400',
        enabled: false,
      });
    });
    expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#ffd400' });
    test.controller.destroy();
  });

  it('closes stale UI and resynchronizes after a Quick Highlight failure', async () => {
    const test = fixture();
    const failure = new Error('native mode failed');
    test.setQuickHighlight.mockRejectedValueOnce(failure);

    test.controller.requestTool('highlight');

    await vi.waitFor(() => {
      expect(test.failures).toEqual([{ action: 'arm Quick Highlight', cause: failure }]);
    });
    expect(test.closeSelectionPopover).toHaveBeenCalled();
    expect(test.observedModes).toEqual(['neutral', 'neutral']);
    expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#ffd400' });
    test.controller.destroy();
  });

  it('ignores stale commit rejections after invalidation and teardown', async () => {
    const invalidated = fixture();
    const staleCommit = deferred<'created'>();
    invalidated.commitSelection.mockImplementationOnce(() => staleCommit.promise);
    invalidated.emitSelection(textSelection('stale-commit'));
    invalidated.opened[0]?.onIntent({ color: '#ffd400', type: 'highlight' });
    await vi.waitFor(() => {
      expect(invalidated.commitSelection).toHaveBeenCalledOnce();
    });
    invalidated.controller.invalidate('zoom');
    invalidated.emitSelection(textSelection('new-selection'));
    const closesAfterNewSelection = invalidated.closeSelectionPopover.mock.calls.length;

    staleCommit.reject(new Error('late stale failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidated.failures).toEqual([]);
    expect(invalidated.closeSelectionPopover).toHaveBeenCalledTimes(closesAfterNewSelection);
    expect(invalidated.opened).toHaveLength(2);
    invalidated.controller.destroy();

    const destroyed = fixture();
    const closedCommit = deferred<'created'>();
    destroyed.commitSelection.mockImplementationOnce(() => closedCommit.promise);
    destroyed.emitSelection(textSelection('closed-commit'));
    destroyed.opened[0]?.onIntent({ color: '#ffd400', type: 'highlight' });
    destroyed.controller.destroy();
    const closesAfterDestroy = destroyed.closeSelectionPopover.mock.calls.length;

    closedCommit.reject(new Error('late closed failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(destroyed.failures).toEqual([]);
    expect(destroyed.closeSelectionPopover).toHaveBeenCalledTimes(closesAfterDestroy);
  });

  it('creates exactly one highlight per quick gesture', async () => {
    const test = fixture('quick-highlight');

    test.emitSelection(textSelection('native-quick-selection'));
    await Promise.resolve();

    expect(test.commitSelection).not.toHaveBeenCalled();
    expect(test.opened).toHaveLength(0);
    test.controller.destroy();
  });

  it('synchronizes external native mode changes', () => {
    const test = fixture();

    test.emitMode('quick-highlight');
    expect(test.states[test.states.length - 1]).toEqual({ armed: true, color: '#ffd400' });
    test.emitMode('neutral');
    expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#ffd400' });
    expect(test.observedModes).toEqual(['neutral', 'quick-highlight', 'neutral']);

    test.controller.destroy();
  });

  it('invalidates palette on zoom layout navigation save and session change', () => {
    const test = fixture();

    for (const reason of ['zoom', 'layout', 'navigation', 'save', 'session'] as const) {
      test.emitSelection(textSelection(reason));
      test.controller.invalidate(reason);
    }

    expect(test.opened).toHaveLength(5);
    expect(test.closeSelectionPopover).toHaveBeenCalledTimes(5);
    test.controller.destroy();
  });

  it('does not intercept Ink FreeText or read-only sessions', () => {
    const test = fixture('ink');
    test.emitSelection(textSelection('ink'));
    test.emitMode('freetext');
    test.emitSelection(textSelection('freetext'));
    test.emitMode('disabled');
    test.emitSelection(textSelection('read-only'));

    expect(test.opened).toHaveLength(0);
    expect(test.commitSelection).not.toHaveBeenCalled();
    expect(test.setQuickHighlight).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('rejects unsupported or closed tool requests and releases native listeners once', () => {
    const test = fixture();

    expect(test.controller.requestTool('ink')).toBe(false);
    expect(test.controller.quickHighlightArmed).toBe(false);
    expect(test.modeListenerCount()).toBe(1);
    expect(test.selectionListenerCount()).toBe(1);

    test.controller.destroy();
    test.controller.destroy();

    expect(test.controller.requestTool('highlight')).toBe(false);
    expect(test.controller.selectColor('#5fb236')).toBe(false);
    expect(test.modeListenerCount()).toBe(0);
    expect(test.selectionListenerCount()).toBe(0);
    expect(test.setQuickHighlight).not.toHaveBeenCalled();
  });

  it('updates the available palette and reapplies an armed semantic color', async () => {
    const test = fixture('quick-highlight');

    expect(test.controller.quickHighlightArmed).toBe(true);
    expect(test.controller.selectColor('#5FB236')).toBe(true);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#5FB236',
        enabled: true,
      });
    });

    test.controller.updatePalette([{ color: '#e56eee', meaning: 'Question', name: 'Magenta' }]);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#e56eee',
        enabled: true,
      });
    });
    expect(test.controller.color).toBe('#e56eee');
    expect(test.observedColors).toEqual(['#5FB236', '#e56eee']);

    test.controller.destroy();
    test.controller.updatePalette(palette);
    expect(test.controller.color).toBe('#e56eee');
  });

  it('keeps palette selection passive outside neutral and quick modes', () => {
    for (const mode of ['ink', 'freetext', 'disabled'] as const) {
      const test = fixture(mode);
      expect(test.controller.selectColor('#5fb236')).toBe(false);
      expect(test.controller.color).toBe('#ffd400');
      expect(test.observedColors).toEqual([]);
      expect(test.setQuickHighlight).not.toHaveBeenCalled();
      test.controller.destroy();
    }

    const neutral = fixture();
    expect(neutral.controller.selectColor('#ffd400')).toBe(true);
    expect(neutral.observedColors).toEqual([]);
    expect(neutral.setQuickHighlight).not.toHaveBeenCalled();
    neutral.controller.destroy();
  });

  it('ignores dismissed and stale selection intents', () => {
    const test = fixture();
    test.emitSelection(textSelection('first'));
    const first = test.opened[0];
    test.emitSelection(textSelection('second'));

    first?.onIntent({ color: '#5fb236', type: 'highlight' });
    test.opened[1]?.onIntent({ type: 'dismiss' });

    expect(test.commitSelection).not.toHaveBeenCalled();
    expect(test.controller.color).toBe('#ffd400');
    test.controller.destroy();
  });

  it('reports a current commit failure with intent context but suppresses abort failures', async () => {
    const failed = fixture();
    const cause = new Error('writer rejected annotation');
    failed.commitSelection.mockRejectedValueOnce(cause);
    failed.emitSelection(textSelection('failure-token'));
    failed.opened[0]?.onIntent({ color: '#5fb236', type: 'tag' });

    await vi.waitFor(() => {
      expect(failed.failures).toEqual([{ action: 'create selection annotation', cause }]);
    });
    expect(failed.closeSelectionPopover).toHaveBeenCalled();
    failed.controller.destroy();

    const aborted = fixture();
    aborted.commitSelection.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    aborted.emitSelection(textSelection('abort-token'));
    aborted.opened[0]?.onIntent({ color: '#ffd400', type: 'comment' });
    await vi.waitFor(() => {
      expect(aborted.commitSelection).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(aborted.failures).toEqual([]);
    aborted.controller.destroy();
  });

  it('aborts an active selection commit during teardown', async () => {
    const test = fixture();
    const pending = deferred<'created'>();
    test.commitSelection.mockImplementationOnce((_token, _action, signal) => {
      signal?.addEventListener('abort', () => {
        pending.reject(signal.reason);
      });
      return pending.promise;
    });
    test.emitSelection(textSelection('pending'));
    test.opened[0]?.onIntent({ color: '#ffd400', type: 'highlight' });
    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledOnce();
    });

    const signal = test.commitSelection.mock.calls[0]?.[2];
    test.controller.destroy();

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(test.failures).toEqual([]);
  });
});
