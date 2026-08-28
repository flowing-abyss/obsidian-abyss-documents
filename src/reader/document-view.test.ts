import {
  App,
  TFile as MockTFile,
  WorkspaceLeaf as MockWorkspaceLeaf,
  Notice,
  Scope,
} from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DocumentOpenError } from '../document-core/errors.js';
import type { AnnotationHrefReference } from './annotation-transfer.js';
import {
  ANNOTATION_LINK_RESOLVED_EVENT,
  AbyssDocumentView,
  DOCUMENT_VIEW_TYPE,
  type ReaderViewController,
} from './document-view.js';
import type { AnnotationSaveLifecycleSnapshot } from './reader-controller.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function viewFixture(controller: ReaderViewController, path = 'Books/Guide.pdf') {
  const app = App.createConfigured__({ files: { [path]: '' } });
  const source = app.vault.getAbstractFileByPath(path);
  if (!(source instanceof MockTFile)) throw new Error(`Expected a test file at ${path}.`);
  const leaf = MockWorkspaceLeaf.create2__(app).asOriginalType3__();
  const view = new AbyssDocumentView(leaf, { createController: () => controller });
  return { file: source.asOriginalType2__(), leaf, view };
}

function controller() {
  const lifecycle: AnnotationSaveLifecycleSnapshot = {
    activeSerializations: 0,
    activeWrites: 0,
    committedRevision: 3,
    failures: 0,
    inFlight: false,
    isDirty: false,
    newestGeneration: 2,
    paused: false,
    pendingRevision: 3,
    recoveries: 0,
    savedGeneration: 2,
    saves: 1,
  };
  const annotationSaveLifecycleSnapshot = vi.fn(() => lifecycle);
  const setAnnotationLoadTestFault = vi.fn();
  const open = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const showOutline = vi.fn();
  const searchDocument = vi.fn();
  const refreshReadingSettings = vi.fn();
  const saveDocument = vi.fn(async () => undefined);
  const resolveAnnotationLink = vi.fn(async (_reference: AnnotationHrefReference) => true);
  const reader: ReaderViewController = {
    annotationSaveLifecycleSnapshot,
    open,
    close,
    refreshReadingSettings,
    resolveAnnotationLink,
    saveDocument,
    searchDocument,
    showOutline,
    setAnnotationLoadTestFault,
  };
  return {
    annotationSaveLifecycleSnapshot,
    close,
    open,
    reader,
    refreshReadingSettings,
    resolveAnnotationLink,
    saveDocument,
    searchDocument,
    showOutline,
    setAnnotationLoadTestFault,
  };
}

describe('AbyssDocumentView', () => {
  it('exposes only the typed read-only save lifecycle through the public view boundary', () => {
    const reader = controller();
    const fixture = viewFixture(reader.reader);

    expect(fixture.view.annotationSaveLifecycleSnapshot()).toEqual(
      reader.annotationSaveLifecycleSnapshot(),
    );
  });

  it('forwards only the narrow typed annotation-load test fault through the public view', () => {
    const reader = controller();
    const fixture = viewFixture(reader.reader);

    fixture.view.setAnnotationLoadTestFault({ cacheRead: 'fail', extractionDelayMs: 350 });
    fixture.view.setAnnotationLoadTestFault(null);

    expect(reader.setAnnotationLoadTestFault.mock.calls).toEqual([
      [{ cacheRead: 'fail', extractionDelayMs: 350 }],
      [null],
    ]);
  });

  it('forwards canonical deep-link state after the PDF is mounted and rejects malformed state', async () => {
    const reader = controller();
    const fixture = viewFixture(reader.reader);
    await fixture.view.setState(
      {
        file: fixture.file.path,
        subpath: '#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4',
      },
      { history: false },
    );
    await fixture.view.onLoadFile(fixture.file);
    expect(reader.resolveAnnotationLink).toHaveBeenCalledWith({
      id: '12R',
      page: 2,
      fingerprint: 'rectangle:1,2,3,4',
    });

    fixture.view.setEphemeralState({ subpath: '#annotation=x&page=0&fingerprint=y' });
    expect(reader.resolveAnnotationLink).toHaveBeenCalledOnce();
  });

  it('acknowledges only a successfully resolved annotation link with its exact path and subpath', async () => {
    const reader = controller();
    const fixture = viewFixture(reader.reader);
    const subpath = '#annotation=12R&page=2&fingerprint=rectangle%3A1%2C2%2C3%2C4';
    const resolved = vi.fn();
    const dispatchEvent = vi.spyOn(fixture.view.contentEl, 'dispatchEvent');
    fixture.view.contentEl.ownerDocument.body.append(fixture.view.contentEl);
    fixture.view.contentEl.ownerDocument.addEventListener(ANNOTATION_LINK_RESOLVED_EVENT, resolved);
    reader.resolveAnnotationLink.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await fixture.view.setState({ file: fixture.file.path, subpath }, { history: false });
    await fixture.view.onLoadFile(fixture.file);
    expect(resolved).not.toHaveBeenCalled();

    fixture.view.setEphemeralState({ subpath });
    await vi.waitFor(() => {
      expect(reader.resolveAnnotationLink).toHaveBeenCalledTimes(2);
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(resolved).toHaveBeenCalledOnce();
    });
    const event = resolved.mock.calls[0]?.[0] as CustomEvent<unknown> | undefined;
    expect(event?.detail).toEqual({ path: fixture.file.path, subpath });
    fixture.view.contentEl.ownerDocument.removeEventListener(
      ANNOTATION_LINK_RESOLVED_EVENT,
      resolved,
    );
    fixture.view.contentEl.remove();
  });
  it('identifies the PDF document view and uses the current basename as its title', async () => {
    const fixture = viewFixture(controller().reader);

    expect(fixture.view.getViewType()).toBe(DOCUMENT_VIEW_TYPE);
    expect(fixture.view.getDisplayText()).toBe('Document');

    await fixture.view.onLoadFile(fixture.file);

    expect(fixture.view.getDisplayText()).toBe('Guide');
  });

  it('opens through the controller after the FileView adopts the file', async () => {
    const reader = controller();
    const fixture = viewFixture(reader.reader);

    await fixture.view.onLoadFile(fixture.file);

    expect(reader.open).toHaveBeenCalledWith(fixture.file, fixture.view.contentEl);
    expect(fixture.view.file).toBe(fixture.file);
  });

  it('is the single open-failure boundary with a notice, diagnostic log, and retry', async () => {
    const cause = new DocumentOpenError('Books/Guide.pdf', 'The PDF is damaged.');
    const reader = controller();
    reader.open.mockRejectedValueOnce(cause).mockResolvedValueOnce(undefined);
    const fixture = viewFixture(reader.reader);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(fixture.view.onLoadFile(fixture.file)).resolves.toBeUndefined();

    expect(notice).toHaveBeenCalledWith('Could not open Guide.pdf: The PDF is damaged.', undefined);
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to open PDF', {
      path: 'Books/Guide.pdf',
      cause,
    });
    const retry = fixture.view.contentEl.querySelector<HTMLButtonElement>('[data-action="retry"]');
    expect(retry?.textContent).toBe('Retry');

    retry?.click();
    await vi.waitFor(() => {
      expect(reader.open).toHaveBeenCalledTimes(2);
    });
    expect(fixture.view.contentEl.querySelector('[data-action="retry"]')).toBeNull();
  });

  it('does not stack duplicate notices when retry repeats the same open failure', async () => {
    const cause = new DocumentOpenError('Books/Guide.pdf', 'The PDF is damaged.');
    const reader = controller();
    reader.open.mockRejectedValue(cause);
    const fixture = viewFixture(reader.reader);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await fixture.view.onLoadFile(fixture.file);
    fixture.view.contentEl.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(2);
    });

    expect(notice).toHaveBeenCalledOnce();
    expect(fixture.view.contentEl.querySelectorAll('[data-reader-error="open"]')).toHaveLength(1);
  });

  it('silences a stale same-file rejection after a newer open wins', async () => {
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    const reader = controller();
    reader.open
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const fixture = viewFixture(reader.reader);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const firstOpen = fixture.view.onLoadFile(fixture.file);
    await vi.waitFor(() => {
      expect(reader.open).toHaveBeenCalledOnce();
    });
    const secondOpen = fixture.view.onLoadFile(fixture.file);
    await vi.waitFor(() => {
      expect(reader.open).toHaveBeenCalledTimes(2);
    });

    second.resolve(undefined);
    await secondOpen;
    first.reject(new DOMException('Superseded', 'AbortError'));
    await firstOpen;

    expect(notice).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(fixture.view.contentEl.querySelector('[data-action="retry"]')).toBeNull();
  });

  it('closes the controller before delegating file unload', async () => {
    const reader = controller();
    const fixture = viewFixture(reader.reader);
    await fixture.view.onLoadFile(fixture.file);

    await fixture.view.onUnloadFile(fixture.file);

    expect(reader.close).toHaveBeenCalledOnce();
  });

  it('forwards outline and document-search commands to its reader controller', () => {
    const reader = controller();
    const fixture = viewFixture(reader.reader);

    fixture.view.showOutline();
    fixture.view.searchDocument();
    fixture.view.refreshReadingSettings();

    expect(reader.showOutline).toHaveBeenCalledOnce();
    expect(reader.searchDocument).toHaveBeenCalledOnce();
    expect(reader.refreshReadingSettings).toHaveBeenCalledOnce();
  });

  it('registers view-local Mod+F through the Obsidian scope', () => {
    const reader = controller();
    const register = vi.spyOn(Scope.prototype, 'register');

    viewFixture(reader.reader);

    expect(register).toHaveBeenCalledWith(['Mod'], 'f', expect.any(Function));
    const callback = register.mock.calls[0]?.[2];
    if (callback === undefined) throw new Error('Expected the scoped search callback.');
    expect(callback(new KeyboardEvent('keydown'), {} as never)).toBe(false);
    expect(reader.searchDocument).toHaveBeenCalledOnce();
  });

  it('registers view-local Mod+S and leaves Notice ownership to the shared controller boundary', async () => {
    const reader = controller();
    const cause = new Error('vault rejected write');
    reader.saveDocument.mockRejectedValue(cause);
    const register = vi.spyOn(Scope.prototype, 'register');
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fixture = viewFixture(reader.reader);

    const callback = register.mock.calls.find(([, key]) => key === 's')?.[2];
    if (callback === undefined) throw new Error('Expected the scoped save callback.');
    expect(callback(new KeyboardEvent('keydown'), {} as never)).toBe(false);
    await vi.waitFor(() => {
      expect(reader.saveDocument).toHaveBeenCalledOnce();
    });

    expect(notice).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to save PDF annotations', {
      path: null,
      cause,
    });
    expect(fixture.view.contentEl.querySelector('[data-autosave]')).toBeNull();
  });

  it('contains an unexpected rejection at the view-local save callback', async () => {
    const reader = controller();
    const cause = new Error('unexpected boundary rejection');
    const register = vi.spyOn(Scope.prototype, 'register');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fixture = viewFixture(reader.reader);
    Object.assign(fixture.view, {
      saveAtBoundary: vi.fn(async () => Promise.reject(cause)),
    });
    const callback = register.mock.calls.find(([, key]) => key === 's')?.[2];
    if (callback === undefined) throw new Error('Expected the scoped save callback.');

    callback(new KeyboardEvent('keydown'), {} as never);

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('[abyss-documents] Failed to contain PDF save boundary', {
        cause,
      });
    });
  });

  it('ignores unrelated clicks and presents a safe reason for a non-error failure', async () => {
    const reader = controller();
    reader.open.mockRejectedValueOnce('worker disappeared');
    const fixture = viewFixture(reader.reader);
    const notice = vi.spyOn(Notice.prototype, 'constructor__');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fixture.view.contentEl.click();
    await fixture.view.onLoadFile(fixture.file);

    expect(reader.open).toHaveBeenCalledOnce();
    expect(notice).toHaveBeenCalledWith('Could not open Guide.pdf: Unknown failure.', undefined);
    expect(log).toHaveBeenCalledOnce();
  });
});
