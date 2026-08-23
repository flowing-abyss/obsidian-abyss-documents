import type { AnnotationPaletteEntry } from '../settings.js';
import { FocusReturn, PoliteAnnouncer } from './a11y.js';
import type {
  AnnotationInteractionHost,
  QuickHighlightState,
} from './annotation-interaction-controller.js';
import { AnnotationToolbar, type AnnotationToolbarIntent } from './annotation-toolbar.js';
import type { ObsidianTheme } from './reading-profiles.js';
import {
  SelectionAnnotationPopover,
  type SelectionAnnotationPopoverRequest,
} from './selection-annotation-popover.js';
import { ReaderSidebar, type ReaderSidebarCallbacks, type ReaderSidebarTab } from './sidebar.js';
import { ReaderToolbar, type ReaderToolbarIntent } from './toolbar.js';

export type ReaderShellIntent =
  | ReaderToolbarIntent
  | AnnotationToolbarIntent
  | { readonly type: 'open-sidebar'; readonly tab: ReaderSidebarTab };

export interface ReaderShellOptions {
  readonly sidebarWidth?: number;
}

const DEFAULT_SIDEBAR_WIDTH = 320;
const MINIMUM_SIDEBAR_WIDTH = 240;
const MAXIMUM_SIDEBAR_WIDTH = 480;

export class ReaderShell implements AnnotationInteractionHost {
  readonly root: HTMLElement;
  readonly documentHost: HTMLElement;
  readonly toolbar: ReaderToolbar;

  private annotationToolbarValue: AnnotationToolbar | null = null;

  private readonly cleanups: Array<() => void> = [];
  private readonly announcer: PoliteAnnouncer;
  private readonly body: HTMLElement;
  private readonly focusReturn = new FocusReturn();
  private readonly intentHandler: (intent: ReaderShellIntent) => void;
  private readonly selectionPopover: SelectionAnnotationPopover;
  private quickHighlightState: QuickHighlightState = { armed: false, color: '#ffd400' };
  private sidebarValue: ReaderSidebar | null = null;
  private destroyed = false;

  constructor(
    host: HTMLElement,
    onIntent: (intent: ReaderShellIntent) => void = () => undefined,
    options: ReaderShellOptions = {},
  ) {
    this.intentHandler = onIntent;
    this.root = host.createDiv({ cls: 'abyss-documents' });
    this.root.dataset['abyssDocument'] = '';
    this.root.dataset['readingProfile'] = 'default';
    this.root.style.setProperty(
      '--abyss-reader-sidebar-width',
      `${boundedSidebarWidth(options.sidebarWidth)}px`,
    );
    this.announcer = new PoliteAnnouncer(this.root);

    const toolbarHost = this.root.createDiv({
      attr: {
        'aria-label': 'Document controls',
        'data-region': 'toolbar',
        role: 'toolbar',
      },
    });
    this.toolbar = new ReaderToolbar(toolbarHost, onIntent);

    this.body = this.root.createDiv({ cls: 'abyss-reader-body' });
    this.documentHost = this.body.createDiv({ attr: { 'data-region': 'document' } });
    this.documentHost.tabIndex = -1;
    this.selectionPopover = new SelectionAnnotationPopover(this.root);
    const onKeyDown = (event: KeyboardEvent): void => {
      this.handleReaderShortcut(event);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (!event.defaultPrevented) this.handleQuickHighlightEscape(event);
    };
    this.root.addEventListener('keydown', onKeyDown, true);
    this.root.addEventListener('keydown', onEscape);
    this.cleanups.push(() => {
      this.root.removeEventListener('keydown', onKeyDown, true);
      this.root.removeEventListener('keydown', onEscape);
    });
  }

  get sidebar(): ReaderSidebar | null {
    return this.sidebarValue;
  }

  get annotationToolbar(): AnnotationToolbar | null {
    return this.annotationToolbarValue;
  }

  configureAnnotationToolbar(
    palette: readonly AnnotationPaletteEntry[],
    readOnlyReason: string | null,
  ): AnnotationToolbar {
    this.annotationToolbarValue?.destroy();
    this.annotationToolbarValue = new AnnotationToolbar(
      this.toolbar.root,
      palette,
      readOnlyReason,
      (intent) => {
        this.intentHandler(intent);
      },
    );
    this.applyQuickHighlightState();
    return this.annotationToolbarValue;
  }

  setQuickHighlightState(state: QuickHighlightState): void {
    this.quickHighlightState = state;
    this.applyQuickHighlightState();
  }

  openSelectionPopover(request: SelectionAnnotationPopoverRequest): void {
    this.selectionPopover.open(request);
  }

  closeSelectionPopover(): void {
    this.selectionPopover.close();
  }

  get obsidianTheme(): ObsidianTheme {
    return this.root.doc.body.hasClass('theme-dark') ? 'dark' : 'light';
  }

  onThemeChange(listener: (theme: ObsidianTheme) => void): () => void {
    if (this.destroyed) return () => undefined;
    let theme = this.obsidianTheme;
    const OwnerMutationObserver = (
      this.root.win as Window & { MutationObserver: typeof MutationObserver }
    ).MutationObserver;
    const observer = new OwnerMutationObserver(() => {
      const nextTheme = this.obsidianTheme;
      if (nextTheme === theme) return;
      theme = nextTheme;
      listener(theme);
    });
    const options: MutationObserverInit = { attributeFilter: ['class'], attributes: true };
    observer.observe(this.root.doc.body, options);
    observer.observe(this.root.doc.documentElement, options);
    const cleanup = (): void => {
      observer.disconnect();
      const index = this.cleanups.indexOf(cleanup);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
    this.cleanups.push(cleanup);
    return cleanup;
  }

  openSidebar(tab: ReaderSidebarTab, callbacks: ReaderSidebarCallbacks): ReaderSidebar {
    if (this.sidebarValue?.isOpen !== true) this.captureSidebarInvoker();
    this.sidebarValue ??= new ReaderSidebar(this.body, {
      ...callbacks,
      onClose: () => {
        this.setSidebarPressed(false);
        this.focusReturn.restore();
        this.announce('Document sidebar closed');
        callbacks.onClose();
      },
    });
    this.body.insertBefore(this.sidebarValue.root, this.documentHost);
    this.sidebarValue.open(tab);
    this.setSidebarPressed(true);
    this.announce(`${sidebarLabel(tab)} sidebar opened`);
    return this.sidebarValue;
  }

  closeSidebar(): void {
    this.sidebarValue?.close();
    this.setSidebarPressed(false);
  }

  announce(message: string): void {
    this.announcer.announce(message);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.sidebarValue?.destroy();
    this.sidebarValue = null;
    this.focusReturn.clear();
    this.announcer.destroy();
    this.selectionPopover.destroy();
    this.annotationToolbarValue?.destroy();
    this.annotationToolbarValue = null;
    this.toolbar.destroy();
    this.root.remove();
  }

  private setSidebarPressed(pressed: boolean): void {
    this.root
      .querySelector('[data-control="sidebar"]')
      ?.setAttribute('aria-pressed', String(pressed));
  }

  private applyQuickHighlightState(): void {
    const toolbar = this.annotationToolbarValue;
    if (toolbar === null) return;
    toolbar.setColor(this.quickHighlightState.color);
    if (this.quickHighlightState.armed) toolbar.setTool('highlight');
    else if (toolbar.tool === 'highlight') toolbar.setTool('select');
  }

  private handleQuickHighlightEscape(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape' || !this.quickHighlightState.armed || this.selectionPopover.isOpen)
      return false;
    event.preventDefault();
    event.stopPropagation();
    this.intentHandler({ type: 'set-annotation-tool', tool: 'select' });
    return true;
  }

  private handleReaderShortcut(event: KeyboardEvent): void {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;
    const key = event.key.toLocaleLowerCase();
    if (key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      this.intentHandler({ type: 'open-sidebar', tab: 'search' });
      return;
    }
    if (key !== 'z' || isTextEditingTarget(event.target, this.root)) return;
    event.preventDefault();
    event.stopPropagation();
    this.intentHandler({ type: event.shiftKey ? 'redo-annotation' : 'undo-annotation' });
  }

  private captureSidebarInvoker(): void {
    const active = this.root.doc.activeElement;
    const invoker =
      active !== null && this.root.contains(active) && 'focus' in active
        ? (active as HTMLElement)
        : this.toolbar.sidebarButton;
    this.focusReturn.capture(invoker);
  }
}

function isTextEditingTarget(target: EventTarget | null, root: HTMLElement): boolean {
  const owner = root.ownerDocument.defaultView;
  if (owner === null || !(target instanceof owner.Element)) return false;
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

function boundedSidebarWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAXIMUM_SIDEBAR_WIDTH, Math.max(MINIMUM_SIDEBAR_WIDTH, Math.round(value)));
}

function sidebarLabel(tab: ReaderSidebarTab): string {
  if (tab === 'outline') return 'Outline';
  if (tab === 'annotations') return 'Annotations';
  return 'Search';
}
