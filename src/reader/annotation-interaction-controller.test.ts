import { describe, expect, it, vi } from 'vitest';
import type {
  PdfAnnotationInteraction,
  PdfAnnotationLogicalMode,
  PdfSelectionAction,
} from '../adapters/pdf/pdf-annotation-editor.js';
import type { PdfAnnotationFocus } from '../adapters/pdf/pdf-comment-bridge.js';
import type { PdfTextSelection } from '../adapters/pdf/pdf-selection-observer.js';
import { asAnnotationId, type DocumentAnnotation } from '../document-core/annotations.js';
import type {
  AnnotationEditorCreation,
  AnnotationEditorPopoverRequest,
} from './annotation-editor-popover.js';
import {
  AnnotationInteractionController,
  type AnnotationInteractionControllerOptions,
  type AnnotationInteractionHost,
  type QuickHighlightState,
} from './annotation-interaction-controller.js';
import { ReaderShell } from './reader-shell.js';

const palette = [
  { color: '#ffd400', meaning: 'Key idea', name: 'Yellow' },
  { color: '#5fb236', meaning: 'Definition', name: 'Green' },
] as const;

function textSelection(token = 'selection-1'): PdfTextSelection {
  return {
    clientRect: { bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 },
    clientRects: [{ bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100 }],
    input: 'pointer',
    pageIndex: 0,
    text: 'Selected text',
    token,
  };
}

function nativeAnnotation(comment = 'F', id = 'created-native'): DocumentAnnotation {
  const available = { available: true } as const;
  return {
    anchor: {
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 10, y: 20 } },
      kind: 'fixed-page',
      pageIndex: 0,
    },
    author: '',
    capabilities: {
      color: available,
      comment: available,
      conversions: { highlight: available, underline: available },
      deletion: available,
      geometry: available,
      metadata: available,
    },
    color: '#ffd400',
    comment,
    createdAt: null,
    identity: { id: asAnnotationId(id), kind: 'stable' },
    links: [],
    modifiedAt: null,
    selectedText: 'Selected text',
    tags: [],
    type: 'highlight',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fixture(
  initialMode: PdfAnnotationLogicalMode = 'neutral',
  options: AnnotationInteractionControllerOptions = {},
) {
  const annotationFocusListeners = new Set<(value: PdfAnnotationFocus | null) => void>();
  const colorListeners = new Set<(value: string) => void>();
  let mode = initialMode;
  const modeListeners = new Set<(value: PdfAnnotationLogicalMode) => void>();
  const selectionListeners = new Set<(value: PdfTextSelection | null) => void>();
  const commitSelection = vi.fn(
    async (
      _token: string,
      _action: PdfSelectionAction,
      _signal?: AbortSignal,
    ): Promise<DocumentAnnotation | 'dismissed'> => nativeAnnotation(''),
  );
  const setQuickHighlight = vi.fn(
    async (_state: { readonly enabled: boolean; readonly color: string }): Promise<void> => {
      mode = 'neutral';
      for (const listener of modeListeners) listener(mode);
    },
  );
  const updateAnnotations = vi.fn<PdfAnnotationInteraction['updateAnnotations']>(() => true);
  const deleteAnnotations = vi.fn(() => true);
  const focusAnnotation = vi.fn(async () => 'editable' as const);
  const abortInteraction = vi.fn(async () => undefined);
  const interaction: PdfAnnotationInteraction = {
    abortInteraction,
    commitSelection,
    deleteAnnotations,
    focusAnnotation,
    onAnnotationFocus(listener) {
      annotationFocusListeners.add(listener);
      return () => annotationFocusListeners.delete(listener);
    },
    onColor(listener) {
      colorListeners.add(listener);
      return () => colorListeners.delete(listener);
    },
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
    updateAnnotations,
  };
  const opened: AnnotationEditorPopoverRequest[] = [];
  const states: QuickHighlightState[] = [];
  const closeAnnotationEditor = vi.fn(() => true);
  const flushAnnotationEditor = vi.fn(async () => true);
  const openAnnotationEditor = vi.fn((request: AnnotationEditorPopoverRequest) => {
    opened.push(request);
    return true;
  });
  const host: AnnotationInteractionHost = {
    closeAnnotationEditor,
    flushAnnotationEditor,
    openAnnotationEditor,
    setQuickHighlightState: (state) => states.push(state),
  };
  const failures: Array<{ action: string; cause: unknown }> = [];
  const observedColors: string[] = [];
  const observedModes: PdfAnnotationLogicalMode[] = [];
  const controller = new AnnotationInteractionController(interaction, host, palette, {
    ...options,
    onColorChange: (color) => observedColors.push(color),
    onFailure: (action, cause) => failures.push({ action, cause }),
    onModeChange: (nextMode) => observedModes.push(nextMode),
  });
  return {
    abortInteraction,
    closeAnnotationEditor,
    commitSelection,
    controller,
    deleteAnnotations,
    emitColor(color: string) {
      for (const listener of colorListeners) listener(color);
    },
    emitAnnotationFocus(focus: PdfAnnotationFocus | null) {
      for (const listener of annotationFocusListeners) listener(focus);
    },
    emitMode(next: PdfAnnotationLogicalMode) {
      mode = next;
      for (const listener of modeListeners) listener(next);
    },
    emitSelection(selection: PdfTextSelection | null) {
      for (const listener of selectionListeners) listener(selection);
    },
    failures,
    flushAnnotationEditor,
    focusAnnotation,
    modeListenerCount: () => modeListeners.size,
    observedColors,
    observedModes,
    openAnnotationEditor,
    opened,
    selectionListenerCount: () => selectionListeners.size,
    setQuickHighlight,
    states,
    updateAnnotations,
  };
}

describe('AnnotationInteractionController', () => {
  it('publishes a successful contextual deletion to the live projection', () => {
    const deleted: DocumentAnnotation[][] = [];
    const test = fixture('neutral', {
      onAnnotationDelete: (annotations) => deleted.push([...annotations]),
    });
    const annotation = nativeAnnotation();
    test.emitAnnotationFocus({
      annotations: [annotation],
      editable: true,
      position: { x: 10, y: 20 },
    });
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected an existing annotation request.');

    expect(request.onDelete([annotation])).toBe(true);

    expect(test.deleteAnnotations).toHaveBeenCalledWith([annotation]);
    expect(deleted).toEqual([[annotation]]);
    test.controller.destroy();
  });

  it('publishes only successful native editor updates to the live projection', () => {
    const projected: Array<AnnotationEditorPopoverRequest['onUpdate']> = [];
    const updates: Array<Parameters<AnnotationEditorPopoverRequest['onUpdate']>[0]> = [];
    const previews: Array<Parameters<AnnotationEditorPopoverRequest['onUpdate']>[0]> = [];
    const test = fixture('neutral', {
      onAnnotationPreview: (update) => previews.push(update),
      onAnnotationUpdate: (update) => updates.push(update),
    });
    test.emitSelection(textSelection());
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');
    projected.push(request.onUpdate);
    const annotation = nativeAnnotation();
    const successful = { annotations: [annotation], comment: 'Updated' };
    const rejected = { annotations: [annotation], color: '#5fb236' };

    request.onPreviewUpdate?.(successful);
    expect(request.onUpdate(successful)).toBe(true);
    test.updateAnnotations.mockReturnValueOnce(false);
    expect(request.onUpdate(rejected)).toBe(false);

    expect(projected).toHaveLength(1);
    expect(previews).toEqual([successful]);
    expect(updates).toEqual([successful]);
  });

  it('publishes a provisional selection synchronously and discards it only on dismissal', async () => {
    const started: AnnotationEditorCreation[] = [];
    const previewed: AnnotationEditorCreation[] = [];
    const discarded: AnnotationEditorCreation[] = [];
    const test = fixture('neutral', {
      onSelectionCreateDiscard: (creation) => discarded.push(creation),
      onSelectionCreatePreview: (creation) => previewed.push(creation),
      onSelectionCreateStart: (creation) => started.push(creation),
    });
    const pending = deferred<DocumentAnnotation | 'dismissed'>();
    test.commitSelection.mockImplementationOnce(async () => pending.promise);
    const selection = textSelection('provisional-selection');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');
    const creation = { color: '#ffd400', comment: '', selection };

    const committing = request.onCreate(creation);
    request.onSelectionPreview?.({ ...creation, comment: 'Draft after activation' });
    expect(started).toEqual([creation]);
    expect(previewed).toEqual([{ ...creation, comment: 'Draft after activation' }]);
    expect(discarded).toEqual([]);
    pending.resolve('dismissed');
    await expect(committing).resolves.toBe('dismissed');
    expect(discarded).toEqual([creation]);
  });

  it('cleans the active selection transaction when synchronous provisional projection fails', async () => {
    const cause = new Error('projection render failed');
    const discarded: AnnotationEditorCreation[] = [];
    const test = fixture('neutral', {
      onSelectionCreateDiscard: (creation) => discarded.push(creation),
      onSelectionCreateStart: () => {
        throw cause;
      },
    });
    const selection = textSelection('projection-failure');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');
    const creation = { color: '#ffd400', comment: '#review', selection };
    const statesBefore = test.states.length;

    await expect(request.onCreate(creation)).rejects.toBe(cause);

    expect(test.commitSelection).not.toHaveBeenCalled();
    expect(discarded).toEqual([creation]);
    expect(test.failures).toEqual([{ action: 'create selection annotation', cause }]);
    expect(test.states).toHaveLength(statesBefore + 2);
  });

  it('publishes the committed native identity with its originating selection token', async () => {
    const committed: Array<{
      readonly annotation: DocumentAnnotation;
      readonly creation: AnnotationEditorCreation;
    }> = [];
    const test = fixture('neutral', {
      onSelectionCreateCommit: (creation, annotation) => committed.push({ annotation, creation }),
    });
    const selection = textSelection('commit-binding');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    const annotation = await request.onCreate({ color: '#ffd400', comment: '', selection });

    expect(committed).toEqual([
      {
        annotation,
        creation: { color: '#ffd400', comment: '', selection },
      },
    ]);
  });

  it('keeps the selection editor open when the active one-shot commit clears native selection', async () => {
    const test = fixture();
    const pending = deferred<DocumentAnnotation | 'dismissed'>();
    test.commitSelection.mockImplementationOnce(async () => pending.promise);
    const selection = textSelection('one-shot-selection');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');
    const committing = request.onCreate({ color: '#ffd400', comment: '', selection });

    test.emitMode('one-shot');
    test.emitMode('neutral');
    test.emitSelection(null);

    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    pending.resolve(nativeAnnotation('Created'));
    await expect(committing).resolves.toMatchObject({
      identity: { id: 'created-native', kind: 'stable' },
    });
  });

  it('retains the owned selection draft when focusing metadata clears native text selection', async () => {
    const test = fixture();
    const selection = textSelection('metadata-draft');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    test.emitSelection(null);

    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    await expect(
      request.onCreate({ color: '#ffd400', comment: '#review [[Source]]', selection }),
    ).resolves.toMatchObject({ identity: { kind: 'stable' } });
  });

  it('keeps the created annotation editor open when PDF.js later clears its text selection', async () => {
    const test = fixture();
    const selection = textSelection('committed-selection');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await expect(
      request.onCreate({ color: '#ffd400', comment: '', selection }),
    ).resolves.toMatchObject({ identity: { kind: 'stable' } });
    test.emitSelection(null);

    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
  });

  it('routes normalized single and exact multiple identities into the unified editor', () => {
    const test = fixture();
    const first = nativeAnnotation('First');
    const second = {
      ...nativeAnnotation('Second'),
      identity: { id: asAnnotationId('created-native-2'), kind: 'stable' as const },
    };

    test.emitAnnotationFocus({
      annotations: [first],
      editable: true,
      position: { x: 12, y: 34 },
    });
    test.emitAnnotationFocus({
      annotations: [first, second],
      editable: true,
      position: { x: 56, y: 78 },
    });

    expect(test.opened).toEqual([
      expect.objectContaining({
        position: { x: 12, y: 34 },
        target: { annotation: first, kind: 'annotation' },
      }),
      expect.objectContaining({
        position: { x: 56, y: 78 },
        target: { annotations: [first, second], kind: 'multiple' },
      }),
    ]);
    expect(test.commitSelection).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('opens a single annotation editor only after a finite native or sidebar anchor exists', () => {
    const test = fixture();
    const focused = nativeAnnotation('Anchored once');

    test.emitAnnotationFocus({ annotations: [focused], editable: true });
    expect(test.opened).toEqual([]);

    test.emitAnnotationFocus({
      annotations: [focused],
      editable: true,
      position: { x: 72, y: 288 },
    });

    expect(test.opened).toHaveLength(1);
    expect(test.opened[0]).toMatchObject({
      position: { x: 72, y: 288 },
      target: { annotation: focused, kind: 'annotation' },
    });
    test.controller.destroy();
  });

  it('routes sidebar activation through the public interaction boundary exactly once', async () => {
    const test = fixture();
    test.emitSelection(textSelection('stale-selection'));
    const abort = new AbortController();

    await expect(
      test.controller.activateAnnotation('persisted-highlight', {
        kind: 'sidebar',
        signal: abort.signal,
      }),
    ).resolves.toBe('editable');

    expect(test.closeAnnotationEditor).toHaveBeenCalledTimes(1);
    expect(test.focusAnnotation).toHaveBeenCalledExactlyOnceWith('persisted-highlight', {
      kind: 'sidebar',
      signal: abort.signal,
    });
  });

  it('keeps a sidebar-focused writable annotation open when PDF.js clears text selection', () => {
    const test = fixture();
    const focused = nativeAnnotation('Sidebar focus');

    test.emitAnnotationFocus({
      annotations: [focused],
      editable: true,
      position: { x: 12, y: 34 },
    });
    test.emitSelection(null);

    expect(test.opened[test.opened.length - 1]?.target).toEqual({
      annotation: focused,
      kind: 'annotation',
    });
    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('returns a dismissed native creation outcome without closing the unified draft', async () => {
    const test = fixture();
    test.commitSelection.mockResolvedValueOnce('dismissed');
    test.emitSelection(textSelection('dismissed-selection'));
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await expect(
      request.onCreate({
        color: '#5fb236',
        comment: '',
        selection: textSelection('dismissed-selection'),
      }),
    ).resolves.toBe('dismissed');

    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    expect(test.commitSelection).toHaveBeenCalledExactlyOnceWith(
      'dismissed-selection',
      { color: '#5fb236', kind: 'highlight' },
      expect.any(AbortSignal),
    );
    test.controller.destroy();
  });

  it('passes the complete unified metadata draft to native comment creation', async () => {
    const test = fixture();
    const selection = textSelection('comment-selection');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await request.onCreate({
      color: '#5fb236',
      comment: 'Review [[Source]] #later',
      selection,
    });

    expect(test.commitSelection).toHaveBeenCalledExactlyOnceWith(
      'comment-selection',
      { color: '#5fb236', kind: 'comment', seed: 'Review [[Source]] #later' },
      expect.any(AbortSignal),
    );
    expect(test.observedColors).toEqual(['#5fb236']);
    test.controller.destroy();
  });

  it('hands the created native identity into the same shell editor and persists the latest draft', async () => {
    const host = document.body.createDiv();
    const shell = new ReaderShell(host);
    const selectionListeners = new Set<(selection: PdfTextSelection | null) => void>();
    const modeListeners = new Set<(mode: PdfAnnotationLogicalMode) => void>();
    const created = deferred<DocumentAnnotation>();
    const updateAnnotations = vi.fn(() => true);
    const deleteAnnotations = vi.fn(() => true);
    const interaction = {
      commitSelection: () => created.promise,
      deleteAnnotations,
      onColor: () => () => undefined,
      onAnnotationFocus: () => () => undefined,
      onMode(listener: (mode: PdfAnnotationLogicalMode) => void) {
        modeListeners.add(listener);
        listener('neutral');
        return () => modeListeners.delete(listener);
      },
      onSelection(listener: (selection: PdfTextSelection | null) => void) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
      setQuickHighlight: vi.fn(),
      updateAnnotations,
    } as unknown as PdfAnnotationInteraction;
    const controller = new AnnotationInteractionController(interaction, shell, palette);
    const selection = textSelection('created-handoff');
    for (const listener of selectionListeners) listener(selection);
    const element = host.querySelector<HTMLElement>('[data-annotation-editor-popover]');
    if (element === null) throw new Error('Expected the shell-owned selection editor.');
    const comment = element.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]');
    if (comment === null) throw new Error('Expected the shell-owned selection editor.');
    expect(element.querySelector('[aria-label="Tags"], [aria-label="Links"]')).toBeNull();

    comment.value = 'F';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    comment.value = 'Final draft #review [[Source]]';
    comment.dispatchEvent(new Event('input', { bubbles: true }));
    element.querySelector<HTMLButtonElement>('[data-editor-color="#ffd400"]')?.click();
    const annotation = nativeAnnotation();
    created.resolve(annotation);

    await vi.waitFor(() => {
      expect(element.querySelector('[data-action="delete-annotation"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-annotation-editor-popover]')).toBe(element);
    expect(element.isConnected).toBe(true);
    expect(element.hidden).toBe(false);
    expect(comment.value).toBe('Final draft #review [[Source]]');
    expect(updateAnnotations).toHaveBeenCalledWith({
      annotations: [annotation],
      comment: 'Final draft #review [[Source]]',
    });

    element.querySelector<HTMLButtonElement>('[data-action="delete-annotation"]')?.click();
    expect(deleteAnnotations).toHaveBeenCalledWith([annotation]);
    controller.destroy();
    shell.destroy();
    host.remove();
  });

  it('opens selection UI only in neutral mode and closes it on true invalidation', () => {
    const test = fixture();
    test.emitSelection(textSelection('neutral'));
    test.emitMode('quick-highlight');
    test.emitSelection(textSelection('quick'));
    for (const reason of ['zoom', 'layout', 'navigation', 'session'] as const) {
      test.emitMode('neutral');
      test.emitSelection(textSelection(reason));
      test.controller.invalidate(reason);
    }

    expect(test.opened).toHaveLength(5);
    expect(test.closeAnnotationEditor).toHaveBeenCalled();
    test.controller.destroy();
  });

  it('arms, recolors, and disarms Quick Highlight through the native logical mode', async () => {
    const test = fixture();

    expect(test.controller.requestTool('highlight')).toBe(true);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#ffd400',
        enabled: true,
      });
    });
    expect(test.controller.selectColor('#5fb236')).toBe(true);
    expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    expect(test.controller.requestTool('select')).toBe(true);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#5fb236',
        enabled: false,
      });
    });

    expect(test.controller.quickHighlightArmed).toBe(false);
    test.controller.destroy();
  });

  it('arms Sticky Highlight with the color carried by its tool request', async () => {
    const test = fixture();

    expect(test.controller.requestTool('highlight', '#ff6666')).toBe(true);

    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenLastCalledWith({
        color: '#ff6666',
        enabled: true,
      });
    });
    expect(test.controller.color).toBe('#ff6666');
  });

  it.each(['ink', 'freetext'] as const)(
    'gates selection and publishes disarmed while Sticky Highlight leaves delayed %s mode',
    async (initialMode) => {
      const nativeNeutral = deferred<void>();
      const test = fixture(initialMode);
      test.setQuickHighlight.mockImplementationOnce(async () => {
        await nativeNeutral.promise;
        test.emitMode('neutral');
      });

      expect(test.controller.requestTool('highlight', '#5fb236')).toBe(true);
      expect(test.controller.quickHighlightArmed).toBe(false);
      expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#5fb236' });

      test.emitSelection(textSelection(`arming-from-${initialMode}`));
      expect(test.openAnnotationEditor).not.toHaveBeenCalled();
      expect(test.commitSelection).not.toHaveBeenCalled();

      nativeNeutral.resolve(undefined);
      await vi.waitFor(() => {
        expect(test.controller.quickHighlightArmed).toBe(true);
      });
      expect(test.states[test.states.length - 1]).toEqual({ armed: true, color: '#5fb236' });
      test.controller.destroy();
    },
  );

  it.each(['ink', 'freetext'] as const)(
    'cancels delayed Sticky Highlight arming when a newer %s mode wins',
    async (newerMode) => {
      const delayedArm = deferred<void>();
      const test = fixture();
      test.setQuickHighlight.mockImplementationOnce(() => delayedArm.promise);

      test.controller.requestTool('highlight');
      expect(test.controller.quickHighlightArmed).toBe(false);
      test.emitMode(newerMode);
      delayedArm.resolve(undefined);
      await delayedArm.promise;
      await Promise.resolve();

      expect(test.controller.quickHighlightArmed).toBe(false);
      expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#ffd400' });
      test.emitSelection(textSelection(`after-${newerMode}`));
      expect(test.commitSelection).not.toHaveBeenCalled();
      expect(test.openAnnotationEditor).not.toHaveBeenCalled();
      test.controller.destroy();
    },
  );

  it('clears arming without reporting a failure when native neutralization is superseded', async () => {
    const test = fixture();
    test.setQuickHighlight.mockRejectedValueOnce(new DOMException('Newer tool won.', 'AbortError'));

    test.controller.requestTool('highlight');

    await vi.waitFor(() => {
      expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#ffd400' });
    });
    expect(test.controller.quickHighlightArmed).toBe(false);
    expect(test.failures).toEqual([]);
    test.controller.destroy();
  });

  it('commits an armed Sticky Highlight selection exactly once without opening the editor', async () => {
    const started: AnnotationEditorCreation[] = [];
    const committed: Array<{ annotation: DocumentAnnotation; creation: AnnotationEditorCreation }> =
      [];
    const test = fixture('neutral', {
      onSelectionCreateCommit: (creation, annotation) => committed.push({ annotation, creation }),
      onSelectionCreateStart: (creation) => started.push(creation),
    });

    expect(test.controller.requestTool('highlight', '#5fb236')).toBe(true);
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    });
    test.emitMode('neutral');
    const selection = textSelection('sticky-once');
    test.emitSelection(selection);

    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledOnce();
    });
    expect(test.commitSelection).toHaveBeenCalledExactlyOnceWith(
      'sticky-once',
      { color: '#5fb236', kind: 'highlight' },
      expect.any(AbortSignal),
    );
    expect(test.openAnnotationEditor).not.toHaveBeenCalled();
    expect(started).toEqual([{ color: '#5fb236', comment: '', selection }]);
    expect(committed).toEqual([
      {
        annotation: nativeAnnotation(''),
        creation: { color: '#5fb236', comment: '', selection },
      },
    ]);
    expect(test.controller.quickHighlightArmed).toBe(true);
    test.controller.destroy();
  });

  it('keeps Sticky Highlight armed across two independent selections and isolates their colors', async () => {
    const committed: string[] = [];
    const test = fixture('neutral', {
      onSelectionCreateCommit: (_creation, annotation) =>
        committed.push(
          annotation.identity.kind === 'stable' ? String(annotation.identity.id) : 'legacy',
        ),
    });
    test.commitSelection
      .mockResolvedValueOnce(nativeAnnotation('', 'sticky-first-native'))
      .mockResolvedValueOnce(nativeAnnotation('', 'sticky-second-native'));

    test.controller.requestTool('highlight', '#ffd400');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    });
    test.emitMode('neutral');
    test.emitSelection(textSelection('sticky-first'));
    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledTimes(1);
    });

    expect(test.controller.selectColor('#5fb236')).toBe(true);
    expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    test.emitMode('neutral');
    test.emitSelection(textSelection('sticky-second'));
    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledTimes(2);
    });

    expect(test.commitSelection.mock.calls.map(([token, action]) => ({ action, token }))).toEqual([
      { action: { color: '#ffd400', kind: 'highlight' }, token: 'sticky-first' },
      { action: { color: '#5fb236', kind: 'highlight' }, token: 'sticky-second' },
    ]);
    expect(committed).toEqual(['sticky-first-native', 'sticky-second-native']);
    expect(test.openAnnotationEditor).not.toHaveBeenCalled();
    expect(test.controller.quickHighlightArmed).toBe(true);
    test.controller.destroy();
  });

  it('defers a Sticky Highlight palette change during a commit to the next gesture', async () => {
    const first = deferred<DocumentAnnotation | 'dismissed'>();
    const test = fixture();
    test.commitSelection
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(nativeAnnotation('', 'sticky-next-color'));

    test.controller.requestTool('highlight', '#ffd400');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    });
    test.emitMode('neutral');
    test.emitSelection(textSelection('sticky-current-color'));
    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledOnce();
    });

    expect(test.controller.selectColor('#5fb236')).toBe(true);
    expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    first.resolve(nativeAnnotation('', 'sticky-current-color'));
    await vi.waitFor(() => {
      expect(test.controller.quickHighlightArmed).toBe(true);
    });

    test.emitSelection(textSelection('sticky-next-color'));
    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledTimes(2);
    });
    expect(test.commitSelection.mock.calls.map(([, action]) => action)).toEqual([
      { color: '#ffd400', kind: 'highlight' },
      { color: '#5fb236', kind: 'highlight' },
    ]);
    test.controller.destroy();
  });

  it('does not disarm Sticky Highlight or double-create from native mode callbacks', async () => {
    const pending = deferred<DocumentAnnotation | 'dismissed'>();
    const test = fixture();
    test.commitSelection.mockImplementationOnce(() => pending.promise);

    test.controller.requestTool('highlight');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    });
    test.emitMode('neutral');
    test.emitSelection(textSelection('sticky-native-callback'));
    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledOnce();
    });

    test.emitMode('quick-highlight');
    test.emitMode('neutral');
    test.emitSelection(textSelection('sticky-native-callback'));

    expect(test.commitSelection).toHaveBeenCalledOnce();
    expect(test.controller.quickHighlightArmed).toBe(true);
    pending.resolve(nativeAnnotation(''));
    await vi.waitFor(() => {
      expect(test.controller.quickHighlightArmed).toBe(true);
    });
    test.controller.destroy();
  });

  it('disarms and discards a pending Sticky Highlight transaction when Select is requested', async () => {
    const discarded: AnnotationEditorCreation[] = [];
    const pending = deferred<DocumentAnnotation | 'dismissed'>();
    let transactionSignal: AbortSignal | undefined;
    const test = fixture('neutral', {
      onSelectionCreateDiscard: (creation) => discarded.push(creation),
    });
    test.commitSelection.mockImplementationOnce((_token, _action, signal) => {
      transactionSignal = signal;
      signal?.addEventListener(
        'abort',
        () => {
          pending.reject(signal.reason);
        },
        { once: true },
      );
      return pending.promise;
    });

    test.controller.requestTool('highlight');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    });
    test.emitMode('neutral');
    const selection = textSelection('sticky-cancel');
    test.emitSelection(selection);
    await vi.waitFor(() => {
      expect(test.commitSelection).toHaveBeenCalledOnce();
    });

    expect(test.controller.requestTool('select')).toBe(true);
    await vi.waitFor(() => {
      expect(transactionSignal?.aborted).toBe(true);
    });

    expect(discarded).toEqual([{ color: '#ffd400', comment: '', selection }]);
    expect(test.controller.quickHighlightArmed).toBe(false);
    expect(test.failures).toEqual([]);
    test.controller.destroy();
  });

  it('reports one Sticky Highlight failure and discards its provisional projection once', async () => {
    const cause = new Error('sticky native creation failed');
    const discarded: AnnotationEditorCreation[] = [];
    const started: AnnotationEditorCreation[] = [];
    const test = fixture('neutral', {
      onSelectionCreateDiscard: (creation) => discarded.push(creation),
      onSelectionCreateStart: (creation) => started.push(creation),
    });
    test.commitSelection.mockRejectedValueOnce(cause);

    test.controller.requestTool('highlight');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    });
    test.emitMode('neutral');
    const selection = textSelection('sticky-failure');
    test.emitSelection(selection);

    await vi.waitFor(() => {
      expect(test.failures).toEqual([{ action: 'create selection annotation', cause }]);
    });
    expect(started).toEqual([{ color: '#ffd400', comment: '', selection }]);
    expect(discarded).toEqual([{ color: '#ffd400', comment: '', selection }]);
    expect(test.openAnnotationEditor).not.toHaveBeenCalled();
    expect(test.controller.quickHighlightArmed).toBe(true);
    test.controller.destroy();
  });

  it('keeps ordinary neutral selection as one unified editor request', () => {
    const test = fixture();
    const selection = textSelection('ordinary-selection');

    test.emitSelection(selection);
    test.emitSelection(selection);

    expect(test.openAnnotationEditor).toHaveBeenCalledOnce();
    expect(test.opened[0]?.target).toEqual({ kind: 'selection', selection });
    expect(test.commitSelection).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('keeps Ink FreeText and disabled modes owned by PDF.js', () => {
    for (const mode of ['ink', 'freetext', 'disabled'] as const) {
      const test = fixture(mode);
      test.emitSelection(textSelection(mode));
      expect(test.opened).toHaveLength(0);
      expect(test.controller.selectColor('#5fb236')).toBe(false);
      expect(test.setQuickHighlight).not.toHaveBeenCalled();
      test.controller.destroy();
    }
  });

  it('does not let native Ink or FreeText colors replace the Sticky Highlight color', () => {
    const test = fixture();

    test.emitMode('ink');
    test.emitColor('#ff6666');
    test.emitMode('freetext');
    test.emitColor('#2ea8e5');

    expect(test.controller.color).toBe('#ffd400');
    expect(test.observedColors).toEqual([]);
    expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#ffd400' });
    test.controller.destroy();
  });

  it('routes contextual Ink and FreeText recolors without changing Sticky Highlight', () => {
    const contextualColors: Array<{ color: string; tool: 'ink' | 'freetext' }> = [];
    const test = fixture('neutral', {
      onToolColorChange: (tool, color) => contextualColors.push({ color, tool }),
    });

    for (const [type, color] of [
      ['ink', '#ff6666'],
      ['free-text', '#2ea8e5'],
    ] as const) {
      const annotation = { ...nativeAnnotation(), color: '#ffd400', type };
      test.emitAnnotationFocus({
        annotations: [annotation],
        editable: true,
        position: { x: 10, y: 20 },
      });
      const request = test.opened[test.opened.length - 1];
      if (request === undefined) throw new Error('Expected a contextual annotation request.');
      test.updateAnnotations.mockImplementationOnce((update) => {
        if (update.color !== undefined) test.emitColor(update.color);
        return true;
      });

      expect(request.onUpdate({ annotations: [annotation], color })).toBe(true);
    }

    expect(test.controller.color).toBe('#ffd400');
    expect(test.observedColors).toEqual([]);
    expect(contextualColors).toEqual([
      { color: '#ff6666', tool: 'ink' },
      { color: '#2ea8e5', tool: 'freetext' },
    ]);
    test.controller.destroy();
  });

  it('contains native creation failures while retaining the unified editor for retry', async () => {
    const test = fixture();
    const cause = new Error('native creation failed');
    test.commitSelection.mockRejectedValueOnce(cause);
    const selection = textSelection('failed-selection');
    test.emitSelection(selection);
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a unified selection request.');

    await expect(request.onCreate({ color: '#ffd400', comment: '', selection })).rejects.toBe(
      cause,
    );

    expect(test.failures).toEqual([{ action: 'create selection annotation', cause }]);
    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('falls back when a palette refresh removes the active Sticky Highlight color', async () => {
    const test = fixture();
    test.controller.requestTool('highlight', '#ff6666');
    await vi.waitFor(() => {
      expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    });
    test.controller.updatePalette([{ color: '#e56eee', meaning: 'Question', name: 'Magenta' }]);

    expect(test.setQuickHighlight).toHaveBeenCalledOnce();
    expect(test.controller.color).toBe('#e56eee');
    expect(test.observedColors).toEqual(['#ff6666', '#e56eee']);
    test.controller.destroy();
  });

  it('blocks tool, activation, invalidation, and destroy while the active editor refuses to close', async () => {
    const test = fixture();
    test.closeAnnotationEditor.mockReturnValue(false);

    expect(test.controller.requestTool('highlight')).toBe(false);
    await expect(test.controller.activateAnnotation('blocked', { kind: 'sidebar' })).resolves.toBe(
      'cancelled',
    );
    test.controller.updatePalette([palette[1]]);
    test.controller.invalidate('navigation');
    expect(test.controller.destroy()).toBe(false);

    expect(test.focusAnnotation).not.toHaveBeenCalled();
    expect(test.setQuickHighlight).not.toHaveBeenCalled();
    expect(test.modeListenerCount()).toBe(1);
  });

  it('keeps a materialized annotation editor visible while another annotation activates', async () => {
    const test = fixture();
    test.emitAnnotationFocus({
      annotations: [nativeAnnotation('Current annotation')],
      editable: true,
      position: { x: 10, y: 20 },
    });
    test.closeAnnotationEditor.mockClear();

    await expect(
      test.controller.activateAnnotation('next-annotation', { kind: 'sidebar' }),
    ).resolves.toBe('editable');

    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    expect(test.flushAnnotationEditor).toHaveBeenCalledOnce();
    expect(test.focusAnnotation).toHaveBeenCalledExactlyOnceWith('next-annotation', {
      kind: 'sidebar',
    });
    test.controller.destroy();
  });

  it('does not move native focus when the current annotation draft refuses to flush', async () => {
    const test = fixture();
    test.emitAnnotationFocus({
      annotations: [nativeAnnotation('Current annotation')],
      editable: true,
      position: { x: 10, y: 20 },
    });
    test.flushAnnotationEditor.mockResolvedValueOnce(false);

    await expect(
      test.controller.activateAnnotation('next-annotation', { kind: 'sidebar' }),
    ).resolves.toBe('cancelled');

    expect(test.focusAnnotation).not.toHaveBeenCalled();
    expect(test.closeAnnotationEditor).not.toHaveBeenCalled();
    expect(test.opened).toHaveLength(1);
    test.controller.destroy();
  });

  it('neutralizes the native contextual editor when its unified popover closes', async () => {
    const test = fixture();
    test.emitAnnotationFocus({
      annotations: [nativeAnnotation('Closing annotation')],
      editable: true,
      position: { x: 10, y: 20 },
    });
    const request = test.opened[test.opened.length - 1];
    if (request === undefined) throw new Error('Expected an annotation editor request.');

    request.onClose('escape');
    await vi.waitFor(() => {
      expect(test.abortInteraction).toHaveBeenCalledExactlyOnceWith(
        'The PDF annotation editor was closed.',
      );
    });
    test.controller.destroy();
  });

  it('still neutralizes a contextual editor after PDF.js clears focus first', async () => {
    const test = fixture();
    test.emitAnnotationFocus({
      annotations: [nativeAnnotation('Focus cleared first')],
      editable: true,
      position: { x: 10, y: 20 },
    });
    const request = test.opened[test.opened.length - 1];
    if (request === undefined) throw new Error('Expected an annotation editor request.');

    test.emitAnnotationFocus(null);
    request.onClose('click-away');

    await vi.waitFor(() => {
      expect(test.abortInteraction).toHaveBeenCalledExactlyOnceWith(
        'The PDF annotation editor was closed.',
      );
    });
    test.controller.destroy();
  });

  it('neutralizes a selection editor after its optimistic draft materializes', async () => {
    const test = fixture();
    test.emitSelection(textSelection('materialized-selection'));
    const request = test.opened[test.opened.length - 1];
    if (request === undefined) throw new Error('Expected a selection editor request.');

    await expect(
      request.onCreate({
        color: '#ffd400',
        comment: '',
        selection: textSelection('materialized-selection'),
      }),
    ).resolves.not.toBe('dismissed');
    request.onClose('escape');

    await vi.waitFor(() => {
      expect(test.abortInteraction).toHaveBeenCalledExactlyOnceWith(
        'The PDF annotation editor was closed.',
      );
    });
    test.controller.destroy();
  });

  it('keeps revisions neutral when the host rejects editors and classifies read-only focus', () => {
    const test = fixture();
    test.openAnnotationEditor.mockReturnValue(false);
    test.emitSelection(textSelection('rejected-selection'));
    test.emitSelection(null);
    test.emitAnnotationFocus({
      annotations: [nativeAnnotation('Rejected focus')],
      editable: true,
      position: { x: 10, y: 20 },
    });
    test.emitAnnotationFocus(null);

    test.openAnnotationEditor.mockReturnValue(true);
    const readonly = nativeAnnotation('Read only');
    test.emitAnnotationFocus({
      annotations: [readonly],
      editable: false,
      position: { x: 20, y: 30 },
    });

    expect(test.openAnnotationEditor).toHaveBeenCalledTimes(3);
    expect(test.openAnnotationEditor.mock.calls[2]?.[0].target).toEqual({
      annotation: readonly,
      kind: 'readonly',
    });
    test.controller.destroy();
  });

  it('reports failed arm and disarm requests without leaking the active editor', async () => {
    const test = fixture();
    const armFailure = new Error('arm failed');
    const disarmFailure = new Error('disarm failed');
    test.setQuickHighlight.mockRejectedValueOnce(armFailure).mockRejectedValueOnce(disarmFailure);

    expect(test.controller.requestTool('highlight')).toBe(true);
    await vi.waitFor(() => {
      expect(test.failures).toContainEqual({ action: 'arm Quick Highlight', cause: armFailure });
    });
    expect(test.controller.requestTool('select')).toBe(true);
    await vi.waitFor(() => {
      expect(test.failures).toContainEqual({
        action: 'disarm Quick Highlight',
        cause: disarmFailure,
      });
    });

    expect(test.closeAnnotationEditor).toHaveBeenCalledTimes(4);
    expect(test.states[test.states.length - 1]).toEqual({ armed: false, color: '#ffd400' });
    test.controller.destroy();
  });

  it('rejects native deletion and does not remember a mixed contextual color', () => {
    const contextualColors: unknown[] = [];
    const deleted: unknown[] = [];
    const test = fixture('neutral', {
      onAnnotationDelete: (annotations) => deleted.push(annotations),
      onToolColorChange: (tool, color) => contextualColors.push({ color, tool }),
    });
    const highlight = nativeAnnotation();
    const ink = { ...nativeAnnotation(), type: 'ink' as const };
    test.emitAnnotationFocus({
      annotations: [highlight],
      editable: true,
      position: { x: 10, y: 20 },
    });
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected an annotation request.');
    test.deleteAnnotations.mockReturnValueOnce(false);

    expect(request.onDelete([highlight])).toBe(false);
    expect(request.onUpdate({ annotations: [highlight, ink], color: '#ff6666' })).toBe(true);

    expect(deleted).toEqual([]);
    expect(contextualColors).toEqual([]);
    expect(test.controller.color).toBe('#ffd400');
    test.controller.destroy();
  });

  it('supports neutral recolor, remembers highlight edits, and ignores stale or aborted activation', async () => {
    const test = fixture();
    expect(test.controller.selectColor('#5fb236')).toBe(true);
    expect(test.setQuickHighlight).not.toHaveBeenCalled();
    test.emitSelection(textSelection('contextual-highlight'));
    const request = test.opened[0];
    if (request === undefined) throw new Error('Expected a selection request.');
    const highlight = nativeAnnotation();

    expect(request.onUpdate({ annotations: [highlight], color: '#ff6666' })).toBe(true);
    expect(test.controller.color).toBe('#ff6666');
    request.onClose('escape');
    request.onClose('escape');
    test.controller.updatePalette([
      { color: '#ff6666', meaning: 'Important', name: 'Red' },
      palette[0],
    ]);
    const abort = new AbortController();
    abort.abort();

    await expect(
      test.controller.activateAnnotation('aborted', { kind: 'sidebar', signal: abort.signal }),
    ).resolves.toBe('cancelled');
    expect(test.focusAnnotation).not.toHaveBeenCalled();
    test.controller.destroy();
  });

  it('releases native listeners once and rejects closed requests', () => {
    const test = fixture();
    expect(test.modeListenerCount()).toBe(1);
    expect(test.selectionListenerCount()).toBe(1);

    test.controller.destroy();
    test.controller.destroy();

    expect(test.controller.requestTool('highlight')).toBe(false);
    expect(test.controller.selectColor('#5fb236')).toBe(false);
    expect(test.modeListenerCount()).toBe(0);
    expect(test.selectionListenerCount()).toBe(0);
  });
});
