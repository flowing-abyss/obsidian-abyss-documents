import type { DocumentAnnotation } from '../document-core/annotations.js';
import type { ReaderLayout } from '../document-core/reading.js';
import type { AnnotationPaletteEntry } from '../settings.js';
import { FocusReturn, PoliteAnnouncer } from './a11y.js';
import {
  AnnotationEditorPopover,
  type AnnotationEditorCloseContext,
  type AnnotationEditorCloseReason,
  type AnnotationEditorPopoverRequest,
  type AnnotationEditorTarget,
} from './annotation-editor-popover.js';
import type {
  AnnotationInteractionHost,
  QuickHighlightState,
} from './annotation-interaction-controller.js';
import { AnnotationToolbar, type AnnotationToolbarIntent } from './annotation-toolbar.js';
import type { ResolvedAnnotationPanelActivation } from './annotations-panel.js';
import type { AnnotationSuggestionProvider } from './link-suggestions.js';
import type { ObsidianTheme } from './reading-profiles.js';
import { ReaderSidebar, type ReaderSidebarCallbacks, type ReaderSidebarTab } from './sidebar.js';
import { ReaderToolbar, type ReaderToolbarIntent } from './toolbar.js';

export type ReaderShellIntent =
  | ReaderToolbarIntent
  | AnnotationToolbarIntent
  | { readonly type: 'open-sidebar'; readonly tab: ReaderSidebarTab };

export interface ReaderShellOptions {
  readonly annotationSuggestions?: AnnotationSuggestionProvider;
  readonly sidebarWidth?: number;
  readonly sourcePath?: string;
}

const DEFAULT_SIDEBAR_WIDTH = 320;
const MINIMUM_SIDEBAR_WIDTH = 240;
const MAXIMUM_SIDEBAR_WIDTH = 480;

interface AnnotationEditorOpenOptions {
  readonly preserveResolvedRow?: boolean;
  readonly sidebarInvokerRowId?: string | undefined;
}

interface AnnotationEditorLifecycle {
  readonly generation: number;
  readonly selectedRowId?: string | undefined;
  readonly sidebarInvoker?: HTMLButtonElement | undefined;
}

export class ReaderShell implements AnnotationInteractionHost {
  readonly root: HTMLElement;
  readonly documentHost: HTMLElement;
  readonly toolbar: ReaderToolbar;

  private annotationToolbarValue: AnnotationToolbar | null = null;

  private readonly cleanups: Array<() => void> = [];
  private readonly annotationEditorCloseListeners = new Set<() => void>();
  private readonly annotationEditor: AnnotationEditorPopover;
  private readonly announcer: PoliteAnnouncer;
  private readonly body: HTMLElement;
  private readonly focusReturn = new FocusReturn();
  private readonly intentHandler: (intent: ReaderShellIntent) => void;
  private annotationEditorGeneration = 0;
  private quickHighlightState: QuickHighlightState = { armed: false, color: '#ffd400' };
  private currentLayout: ReaderLayout = { pages: 'single', scrolling: 'continuous' };
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
    this.annotationEditor = new AnnotationEditorPopover(
      this.root,
      options.annotationSuggestions ?? null,
      options.sourcePath ?? '',
    );
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

  get annotationEditorOpen(): boolean {
    return this.annotationEditor.isOpen;
  }

  get annotationEditorPendingChanges(): boolean {
    return this.annotationEditor.hasPendingChanges;
  }

  setLayout(layout: ReaderLayout): void {
    this.currentLayout = { ...layout };
    this.toolbar.setLayout(layout);
  }

  configureAnnotationToolbar(
    palette: readonly AnnotationPaletteEntry[],
    readOnlyReason: string | null,
  ): AnnotationToolbar {
    this.annotationToolbarValue?.destroy();
    this.annotationToolbarValue = new AnnotationToolbar(
      this.toolbar.annotationHost,
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

  openAnnotationEditor(
    request: AnnotationEditorPopoverRequest,
    options: AnnotationEditorOpenOptions = {},
  ): boolean {
    const annotation = editorTargetAnnotation(request.target);
    this.synchronizeAnnotationSelection(annotation, options);
    const generation = this.annotationEditorGeneration + 1;
    const lifecycle = this.captureAnnotationEditorLifecycle(
      annotation !== undefined || options.sidebarInvokerRowId !== undefined,
      options.sidebarInvokerRowId,
      generation,
    );
    const focusReturnTargetOwned = this.ownsSidebarFocusTransfer(lifecycle.sidebarInvoker);
    const opened = this.annotationEditor.open(
      {
        ...request,
        onClose: (reason, context) => {
          this.handleAnnotationEditorClose(request, lifecycle, reason, context);
        },
      },
      { focusReturnTarget: lifecycle.sidebarInvoker, focusReturnTargetOwned },
    );
    if (opened) this.annotationEditorGeneration = generation;
    return opened;
  }

  private synchronizeAnnotationSelection(
    annotation: DocumentAnnotation | undefined,
    options: AnnotationEditorOpenOptions,
  ): void {
    if (annotation === undefined || options.preserveResolvedRow === true) return;
    const id =
      annotation.identity.kind === 'stable'
        ? annotation.identity.id
        : annotation.identity.fingerprint;
    this.sidebarValue?.annotationsPanel.selectAnnotation(id, false);
  }

  private captureAnnotationEditorLifecycle(
    captureSelectedRow: boolean,
    sidebarInvokerRowId: string | undefined,
    generation: number,
  ): AnnotationEditorLifecycle {
    const selectedRow = captureSelectedRow
      ? (this.sidebarValue?.annotationsPanel.root.querySelector<HTMLButtonElement>(
          '.abyss-annotation-card[aria-current="true"]',
        ) ?? undefined)
      : undefined;
    const selectedRowId = selectedRow?.dataset['annotationRowId'];
    const sidebarInvoker =
      selectedRowId !== undefined && selectedRowId === sidebarInvokerRowId
        ? selectedRow
        : undefined;
    return { generation, selectedRowId, sidebarInvoker };
  }

  private ownsSidebarFocusTransfer(sidebarInvoker: HTMLButtonElement | undefined): boolean {
    if (sidebarInvoker === undefined) return false;
    const active = this.root.doc.activeElement;
    return (
      active === sidebarInvoker ||
      (active !== null &&
        (this.documentHost.contains(active) || this.annotationEditor.element.contains(active)))
    );
  }

  private handleAnnotationEditorClose(
    request: AnnotationEditorPopoverRequest,
    lifecycle: AnnotationEditorLifecycle,
    reason: AnnotationEditorCloseReason,
    context?: AnnotationEditorCloseContext,
  ): void {
    const focusAtCloseStart = this.root.doc.activeElement;
    try {
      if (context === undefined) request.onClose(reason);
      else request.onClose(reason, context);
    } finally {
      this.releaseAnnotationEditorLifecycle(lifecycle, reason, focusAtCloseStart, context);
      for (const listener of this.annotationEditorCloseListeners) listener();
    }
  }

  private releaseAnnotationEditorLifecycle(
    lifecycle: AnnotationEditorLifecycle,
    reason: AnnotationEditorCloseReason,
    focusAtCloseStart: Element | null,
    context: AnnotationEditorCloseContext | undefined,
  ): void {
    if (this.annotationEditorGeneration !== lifecycle.generation) return;
    const panel = this.sidebarValue?.annotationsPanel;
    if (this.ownsSidebarFocusReturn(lifecycle, reason, focusAtCloseStart, context))
      panel?.focusSelectedAnnotation();
    else if (
      reason === 'external' &&
      lifecycle.sidebarInvoker !== undefined &&
      !lifecycle.sidebarInvoker.isConnected
    )
      panel?.focusRovingAnnotation();
  }

  private ownsSidebarFocusReturn(
    lifecycle: AnnotationEditorLifecycle,
    reason: AnnotationEditorCloseReason,
    focusAtCloseStart: Element | null,
    context: AnnotationEditorCloseContext | undefined,
  ): boolean {
    const contextFocusTarget = context?.focusTarget;
    const currentSelected =
      this.sidebarValue?.annotationsPanel.root.querySelector<HTMLButtonElement>(
        '.abyss-annotation-card[aria-current="true"]',
      );
    return (
      reason === 'escape' &&
      this.root.doc.activeElement === focusAtCloseStart &&
      this.sidebarValue?.isOpen === true &&
      lifecycle.sidebarInvoker?.isConnected === true &&
      allowsSidebarFocusReturn(contextFocusTarget, lifecycle.sidebarInvoker) &&
      currentSelected === lifecycle.sidebarInvoker
    );
  }

  onAnnotationEditorClose(listener: () => void): () => void {
    this.annotationEditorCloseListeners.add(listener);
    return () => {
      this.annotationEditorCloseListeners.delete(listener);
    };
  }

  resolveAnnotationActivation(rowId: string): ResolvedAnnotationPanelActivation | null {
    return this.sidebarValue?.annotationsPanel.resolveActivation(rowId) ?? null;
  }

  closeAnnotationEditor(): boolean {
    return this.annotationEditor.close();
  }

  flushAnnotationEditor(): Promise<boolean> {
    return this.annotationEditor.flushPendingChanges();
  }

  updateAnnotationEditorTarget(target: AnnotationEditorTarget): boolean {
    return this.annotationEditor.updateTarget(target);
  }

  invalidateAnnotationEditorGeometry(): void {
    this.annotationEditor.invalidateGeometry();
  }

  retryAnnotationEditorUpdates(): boolean {
    return this.annotationEditor.retryPendingUpdates();
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
    if (this.sidebarValue.root.nextElementSibling !== this.documentHost)
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

  destroy(): boolean {
    if (this.destroyed) return true;
    if (!this.annotationEditor.destroy()) return false;
    this.destroyed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.annotationEditorCloseListeners.clear();
    this.sidebarValue?.destroy();
    this.sidebarValue = null;
    this.focusReturn.clear();
    this.announcer.destroy();
    this.annotationToolbarValue?.destroy();
    this.annotationToolbarValue = null;
    this.toolbar.destroy();
    this.root.remove();
    return true;
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
    if (
      event.key !== 'Escape' ||
      !this.quickHighlightState.armed ||
      this.annotationEditor.isOpen ||
      hasOpenReaderMenu(this.root)
    )
      return false;
    event.preventDefault();
    event.stopPropagation();
    this.intentHandler({ type: 'set-annotation-tool', tool: 'select' });
    return true;
  }

  private handleReaderShortcut(event: KeyboardEvent): void {
    if (this.handlePagedNavigationShortcut(event)) return;
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

  private handlePagedNavigationShortcut(event: KeyboardEvent): boolean {
    const intent = this.pagedNavigationIntent(event);
    if (intent === null) return false;
    event.preventDefault();
    event.stopPropagation();
    this.intentHandler(intent);
    return true;
  }

  private pagedNavigationIntent(event: KeyboardEvent): ReaderShellIntent | null {
    if (!this.pagedNavigationEnabled(event)) return null;
    const target = event.target;
    const owner = this.root.ownerDocument.defaultView;
    if (owner === null || !(target instanceof owner.Element)) return null;
    if (target.closest('[data-region="sidebar"], [data-region="toolbar"]') !== null) return null;
    if (event.key === 'ArrowLeft') return { type: 'previous-page' };
    return event.key === 'ArrowRight' ? { type: 'next-page' } : null;
  }

  private pagedNavigationEnabled(event: KeyboardEvent): boolean {
    return (
      this.currentLayout.scrolling === 'page-by-page' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      !this.annotationEditor.isOpen &&
      !hasOpenReaderMenu(this.root) &&
      !isTextEditingTarget(event.target, this.root)
    );
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

function editorTargetAnnotation(
  target: AnnotationEditorPopoverRequest['target'],
): DocumentAnnotation | undefined {
  if (target.kind === 'selection') return undefined;
  if (target.kind === 'multiple') return target.annotations[0];
  return target.annotation;
}

function allowsSidebarFocusReturn(
  contextFocusTarget: HTMLElement | undefined,
  sidebarInvoker: HTMLButtonElement | undefined,
): boolean {
  if (contextFocusTarget?.isConnected !== true) return true;
  return sidebarInvoker?.isSameNode(contextFocusTarget) === true;
}

function hasOpenReaderMenu(root: HTMLElement): boolean {
  if (root.querySelector('[data-abyss-menu-closing]') !== null) return true;
  const trigger = root.querySelector<HTMLElement>(
    '[aria-haspopup="menu"][aria-expanded="true"]:not([disabled])',
  );
  if (trigger === null) return false;
  return Array.from(root.ownerDocument.querySelectorAll<HTMLElement>('.menu')).some((menu) => {
    if (menu.hidden) return false;
    const style = menu.win.getComputedStyle(menu);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
      return false;
    const bounds = menu.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  });
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
