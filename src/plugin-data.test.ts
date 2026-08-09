import { describe, expect, it, vi } from 'vitest';
import { PluginDataStore } from './plugin-data.js';

function createStore() {
  const persistence = {
    loadData: vi.fn().mockResolvedValue(null),
    saveData: vi.fn().mockResolvedValue(undefined),
  };
  return { persistence, store: new PluginDataStore(persistence) };
}

describe('PluginDataStore', () => {
  it('serializes concurrent updates through one save queue', async () => {
    const { persistence, store } = createStore();
    await store.load();
    let resolveFirstSave: (() => void) | undefined;
    persistence.saveData.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveFirstSave = resolve)),
    );

    const first = store.update((data) => ({
      ...data,
      view: { ...data.view, selectedTab: 'search' },
    }));
    const second = store.update((data) => ({
      ...data,
      view: { ...data.view, sidebarWidth: 340 },
    }));

    await Promise.resolve();
    expect(persistence.saveData).toHaveBeenCalledTimes(1);
    resolveFirstSave?.();
    await Promise.all([first, second]);

    expect(store.snapshot.view).toMatchObject({
      selectedTab: 'search',
      sidebarWidth: 340,
    });
    expect(persistence.saveData).toHaveBeenLastCalledWith(store.snapshot);
  });

  it('keeps the committed snapshot when a save fails and continues later updates', async () => {
    const { persistence, store } = createStore();
    await store.load();
    persistence.saveData.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      store.update((data) => ({ ...data, view: { ...data.view, sidebarWidth: 340 } })),
    ).rejects.toThrow('disk full');
    await store.update((data) => ({ ...data, view: { ...data.view, selectedTab: 'search' } }));

    expect(store.snapshot.view).toMatchObject({ sidebarWidth: 320, selectedTab: 'search' });
  });
});
