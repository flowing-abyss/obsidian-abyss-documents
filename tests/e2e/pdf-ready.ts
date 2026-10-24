import { browser } from '@wdio/globals';

export async function focusObsidianWindow(): Promise<void> {
  if (browser.isAndroid || browser.isIOS) return;
  await browser.execute(() => {
    // Use the same native window bridge as Obsidian's own focus command.
    const host = window as Window & {
      electron?: { remote?: { app?: { focus(options: { steal: boolean }): void } } };
      electronWindow?: { isMinimized(): boolean; restore(): void; focus(): void };
    };
    const native = host.electronWindow;
    if (native === undefined) throw new Error('The native Obsidian window is unavailable.');
    if (native.isMinimized()) native.restore();
    host.electron?.remote?.app?.focus({ steal: true });
    native.focus();
  });
  await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
    timeout: 5_000,
    timeoutMsg: 'The Obsidian window did not receive focus.',
  });
}

export async function waitForPdfPageReady(pageIndex = 0): Promise<void> {
  await focusObsidianWindow();
  await browser.waitUntil(
    async () =>
      browser.executeObsidian(async ({ app }, index) => {
        const view = app.workspace.getMostRecentLeaf()?.view as unknown as {
          controller?: {
            viewport?: {
              pagesInitialized?: boolean;
              colorRebindActive?: boolean;
              pendingPagesInit?: unknown;
              resizeFrame?: number | null;
              viewer?: {
                getPageView?(
                  pageIndex: number,
                ): { div: HTMLElement; renderingState: number } | undefined;
              };
            };
          };
        };
        const viewport = view.controller?.viewport;
        const page = viewport?.viewer?.getPageView?.(index);
        const canvas = page?.div.querySelector<HTMLCanvasElement>('canvas:not(.detailView)');
        const idle = (): boolean =>
          viewport?.pagesInitialized === true &&
          viewport.colorRebindActive === false &&
          viewport.pendingPagesInit === null &&
          viewport.resizeFrame === null &&
          page?.renderingState === 3 &&
          canvas?.isConnected === true &&
          canvas.width > 0 &&
          canvas.height > 0;
        const owner = page?.div.ownerDocument.defaultView;
        if (!idle() || owner === undefined || owner === null || canvas == null) return false;
        const before = canvas.getBoundingClientRect();
        const nextFrame = (): Promise<number> =>
          new Promise((resolve) => {
            owner.requestAnimationFrame(resolve);
          });
        await nextFrame();
        await nextFrame();
        const after = canvas.getBoundingClientRect();
        return (
          idle() &&
          viewport?.viewer?.getPageView?.(index) === page &&
          before.width === after.width &&
          before.height === after.height &&
          before.left === after.left &&
          before.top === after.top
        );
      }, pageIndex),
    {
      timeout: 20_000,
      interval: 50,
      timeoutMsg: `PDF page ${String(pageIndex + 1)} did not finish rendering and refitting.`,
    },
  );
}
