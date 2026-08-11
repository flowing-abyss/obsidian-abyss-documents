import {
  App,
  TFile as MockTFile,
  WorkspaceLeaf as MockWorkspaceLeaf,
  Notice,
  Scope,
} from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DocumentOpenError } from '../document-core/errors.js';
import {
  AbyssDocumentView,
  DOCUMENT_VIEW_TYPE,
  type ReaderViewController,
} from './document-view.js';

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
  const open = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const showOutline = vi.fn();
  const searchDocument = vi.fn();
  const refreshReadingSettings = vi.fn();
  const reader: ReaderViewController = {
    open,
    close,
    refreshReadingSettings,
    searchDocument,
    showOutline,
  };
  return { close, open, reader, refreshReadingSettings, searchDocument, showOutline };
}

describe('AbyssDocumentView', () => {
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
