import { asAnnotationId, type DocumentAnnotation } from '../../document-core/annotations.js';
import { ownerWindow } from '../../reader/owner-dom.js';
import { PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE } from './pdf-runtime.js';

const COMMENT_DIALOG_RESERVATION_TIMEOUT_MS = 2_000;
const ANNOTATION_FOCUS_READINESS_TIMEOUT_MS = 2_000;
const NATIVE_EDITOR_SELECTOR = '.highlightEditor[id], .inkEditor[id], .freeTextEditor[id]';
const ANNOTATION_FOCUS_SELECTOR = `${NATIVE_EDITOR_SELECTOR}, .annotationLayer [data-annotation-id]`;
const SELECTED_EDITOR_SELECTOR =
  '.annotationEditorLayer .selectedEditor[id], .annotationLayer .selectedEditor[data-annotation-id]';

interface PdfCommentData {
  readonly annotationType?: number | undefined;
  readonly color?: readonly number[] | undefined;
  readonly contentsObj?: { readonly str?: string | undefined } | undefined;
  readonly id?: string | undefined;
  readonly opacity?: number | undefined;
  readonly popupRef?: unknown;
  readonly richText?: unknown;
}

export interface PdfCommentEditor {
  comment: unknown;
  readonly annotationEditorType?: number | undefined;
  readonly editorType?: string | undefined;
  readonly elementBeforePopup?: Element | null | undefined;
  readonly mode?: number | undefined;
  readonly propertiesToUpdate?: readonly unknown[] | undefined;
  readonly uid?: string | undefined;
  editComment?(): Promise<void> | void;
  focusCommentButton?(): void;
  getData(): PdfCommentData;
  select?(): void;
  setCommentButtonStates?(options: {
    readonly hasPopup: boolean;
    readonly selected: boolean;
  }): void;
}

interface PdfCommentUiManager {
  delete(): void;
  readonly firstSelectedEditor?: PdfCommentEditor | undefined;
  getEditor?(id: string): PdfCommentEditor | undefined;
  setSelected(editor: PdfCommentEditor): void;
  updateParams(type: number, value: unknown): void;
}

interface NativeAnnotationBinding {
  readonly editor: PdfCommentEditor;
  readonly manager: PdfCommentUiManager;
}

export interface PdfCommentMutationFailure {
  readonly action: 'change-color' | 'delete-annotation' | 'delete-comment' | 'save-comment';
  readonly cause: unknown;
}

export interface PdfCommentBridgeOptions {
  readonly onColorChange?: ((color: string) => void) | undefined;
  readonly onFailure?: ((failure: PdfCommentMutationFailure) => void) | undefined;
  readonly onNativeMutation?: (() => void) | undefined;
}

export interface PdfCommentDialogReservation {
  readonly closed: Promise<PdfCommentDialogCloseReason>;
  readonly opened: Promise<DocumentAnnotation>;
}

export type PdfCommentDialogCloseReason =
  'blur' | 'click-away' | 'delete-annotation' | 'escape' | 'external' | 'focus-away';

export interface PdfAnnotationFocus {
  readonly annotations: readonly DocumentAnnotation[];
  readonly editable: boolean;
  readonly position: { readonly x: number; readonly y: number };
}

export interface PdfAnnotationUpdate {
  readonly annotations: readonly DocumentAnnotation[];
  readonly color?: string | undefined;
  readonly comment?: string | undefined;
}

interface PendingCommentDialogReservation extends PdfCommentDialogReservation {
  active: boolean;
  isOpen: boolean;
  settled: boolean;
  readonly seed: string;
  readonly clearOpenTimeout: () => void;
  readonly cleanup: () => void;
  readonly rejectClosed: (cause: unknown) => void;
  readonly rejectOpened: (cause: unknown) => void;
  readonly resolveClosed: (reason: PdfCommentDialogCloseReason) => void;
  readonly resolveOpened: (annotation: DocumentAnnotation) => void;
}

export interface PdfJsCommentManagerRuntime {
  readonly dialogElement: HTMLElement;
  addComment(annotation: unknown): void;
  destroy(): void;
  destroyPopup(): void;
  hideSidebar(): void;
  makeCommentColor(color: readonly number[] | null, opacity?: number): string | null;
  removeComments(ids: readonly string[]): void;
  selectComment(id: string): void;
  setSidebarUiManager(uiManager: unknown): void;
  showDialog(
    uiManager: unknown,
    editor: PdfCommentEditor,
    posX: number,
    posY: number,
    options?: { readonly height?: number | undefined },
  ): Promise<void>;
  showSidebar(annotations: readonly unknown[]): void;
  toggleCommentPopup(
    editor: PdfCommentEditor | null,
    isSelected?: boolean,
    visibility?: boolean,
    isEditable?: boolean,
  ): void;
  updateComment(annotation: unknown): void;
  updatePopupColor(editor: PdfCommentEditor): void;
}

/** Headless structural seam consumed by pdfjs-dist 6.2.108's comment manager. */
export class PdfCommentBridge implements PdfJsCommentManagerRuntime {
  readonly dialogElement: HTMLElement;

  private readonly bindings = new Map<string, NativeAnnotationBinding>();
  private readonly bindingIds = new WeakMap<PdfCommentEditor, string>();
  private readonly comments = new Map<string, PdfCommentData>();
  private readonly fallbackIds = new WeakMap<object, string>();
  private readonly focusListeners = new Set<(focus: PdfAnnotationFocus | null) => void>();
  private readonly focusProjections = new Map<string, DocumentAnnotation>();
  private readonly focusReadinessChecks = new Set<() => void>();
  private activeSource: PdfCommentEditor | null = null;
  private activeBinding: NativeAnnotationBinding | null = null;
  private sidebarUiManager: PdfCommentUiManager | null = null;
  private activeDialogReservation: PendingCommentDialogReservation | null = null;
  private nextDialogReservation: PendingCommentDialogReservation | null = null;
  private nativeMutationDepth = 0;
  private persistenceDepth = 0;
  private persistenceFocusInvalidated = false;
  private fallbackIdSequence = 0;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: PdfCommentBridgeOptions = {},
  ) {
    this.dialogElement = ownerWindow(host).createDiv();
    this.dialogElement.dataset['pdfCommentBridge'] = '';
    this.dialogElement.hidden = true;
    host.append(this.dialogElement);
  }

  onAnnotationFocus(listener: (focus: PdfAnnotationFocus | null) => void): () => void {
    if (this.disposed) return () => undefined;
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }

  beginPersistence(): void {
    if (this.disposed) return;
    this.persistenceDepth += 1;
  }

  endPersistence(): void {
    if (this.persistenceDepth === 0) return;
    if (this.persistenceDepth > 1) {
      this.persistenceDepth -= 1;
      return;
    }
    try {
      if (!this.persistenceFocusInvalidated) return;
      const binding = this.activeBinding;
      if (binding !== null) binding.manager.setSelected(binding.editor);
      this.activeSource?.setCommentButtonStates?.({ hasPopup: true, selected: true });
    } finally {
      this.persistenceFocusInvalidated = false;
      this.persistenceDepth = 0;
    }
  }

  focusFromPointer(target: EventTarget | null): void {
    if (this.disposed) return;
    const owner = this.host.ownerDocument.defaultView;
    if (owner === null) return;
    const node = nativeEditorNode(target, owner);
    if (node === null) return;
    const manager = this.sidebarUiManager;
    const internalId = selectedEditorId(node);
    const editor = internalId.length === 0 ? undefined : manager?.getEditor?.(internalId);
    if (editor !== undefined) {
      this.publishFocus(editor, true, true, node.getBoundingClientRect());
      return;
    }
    const id = importedAnnotationId(node, internalId);
    if (id.length === 0 || !node.matches('.annotationLayer [data-annotation-id]')) return;
    const anchor = node.getBoundingClientRect();
    this.emitFocus({
      annotations: [
        mergeProjectedAnnotation(
          readOnlyAnnotationFromNode(node, id),
          this.focusProjections.get(id),
        ),
      ],
      editable: false,
      position: { x: anchor.left, y: anchor.bottom },
    });
  }

  async focusAnnotation(
    nativeId: string,
    signal?: AbortSignal,
    projected?: DocumentAnnotation,
  ): Promise<boolean> {
    if (this.disposed || signal?.aborted === true) return false;
    const id = nativeId.trim();
    if (id.length === 0) return false;
    if (projected !== undefined) this.focusProjections.set(id, projected);
    try {
      if (this.tryFocusAnnotation(id)) return true;
      return await this.waitForAnnotationFocus(id, signal);
    } finally {
      if (projected !== undefined && this.focusProjections.get(id) === projected)
        this.focusProjections.delete(id);
    }
  }

  private waitForAnnotationFocus(id: string, signal?: AbortSignal): Promise<boolean> {
    const owner = this.host.ownerDocument.defaultView;
    if (owner === null) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (focused: boolean): void => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        owner.clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        this.focusReadinessChecks.delete(check);
        resolve(focused);
      };
      const check = (): void => {
        if (this.disposed || signal?.aborted === true) finish(false);
        else if (this.tryFocusAnnotation(id)) finish(true);
      };
      const onAbort = (): void => {
        finish(false);
      };
      const observer = new owner.MutationObserver(check);
      const timeout = owner.setTimeout(() => {
        finish(false);
      }, ANNOTATION_FOCUS_READINESS_TIMEOUT_MS);
      observer.observe(this.host, {
        attributeFilter: ['class', 'data-annotation-id', 'id'],
        attributes: true,
        childList: true,
        subtree: true,
      });
      this.focusReadinessChecks.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  private tryFocusAnnotation(id: string): boolean {
    const manager = this.sidebarUiManager;
    if (manager !== null) {
      for (const node of Array.from(
        this.host.querySelectorAll<HTMLElement>(NATIVE_EDITOR_SELECTOR),
      )) {
        const domId = selectedEditorId(node);
        if (domId.length === 0) continue;
        const editor = manager.getEditor?.(domId);
        if (
          editor !== undefined &&
          (domId === id || editorRuntimeId(editor) === id || editorAnnotationId(editor) === id)
        )
          return this.focusWritableAnnotation(editor, manager, id);
      }
    }
    return this.focusImportedAnnotation(id);
  }

  private focusImportedAnnotation(id: string): boolean {
    const imported = Array.from(
      this.host.querySelectorAll<HTMLElement>('.annotationLayer [data-annotation-id]'),
    ).find((node) => node.dataset['annotationId'] === id);
    if (imported === undefined) return false;
    this.focusFromPointer(imported);
    return true;
  }

  private focusWritableAnnotation(
    editor: PdfCommentEditor,
    manager: PdfCommentUiManager,
    stableId: string,
  ): boolean {
    this.bindingIds.set(editor, stableId);
    manager.setSelected(editor);
    const editable = isSupportedNativeEditor(editor);
    const annotation = this.annotationFromEditor(
      editor,
      editorComment(editor),
      editable,
      writableManager(editable, manager),
    );
    if (editable) this.retainActiveBinding(editor, manager);
    else {
      this.activeSource = editor;
      this.activeBinding = null;
    }
    setFocusedCommentButton(editor);
    this.emitFocus({
      annotations: [annotation],
      editable,
      position: focusedEditorPosition(editor),
    });
    return true;
  }

  reserveNextDialog(seed: string, signal?: AbortSignal): PdfCommentDialogReservation {
    if (this.disposed) throw new DOMException('PDF comment bridge disposed.', 'InvalidStateError');
    if (this.nextDialogReservation !== null) {
      this.cancelReservation(
        this.nextDialogReservation,
        new DOMException('The PDF comment reservation was superseded.', 'AbortError'),
      );
    }
    const opened = deferred<DocumentAnnotation>();
    const closed = deferred<PdfCommentDialogCloseReason>();
    void opened.promise.catch(() => undefined);
    void closed.promise.catch(() => undefined);
    const owner = this.dialogElement.ownerDocument.defaultView;
    let timeoutId: number | null = null;
    const clearOpenTimeout = (): void => {
      if (timeoutId === null) return;
      owner?.clearTimeout(timeoutId);
      timeoutId = null;
    };
    const onAbort = (): void => {
      this.cancelReservation(reservation, abortReason(signal));
    };
    const reservation: PendingCommentDialogReservation = {
      active: false,
      isOpen: false,
      settled: false,
      seed,
      clearOpenTimeout,
      opened: opened.promise,
      closed: closed.promise,
      cleanup: () => {
        clearOpenTimeout();
        signal?.removeEventListener('abort', onAbort);
      },
      rejectClosed: closed.reject,
      rejectOpened: opened.reject,
      resolveOpened: opened.resolve,
      resolveClosed: closed.resolve,
    };
    this.nextDialogReservation = reservation;
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    if (!reservation.settled) {
      timeoutId =
        owner?.setTimeout(() => {
          this.cancelReservation(
            reservation,
            new DOMException('The PDF comment dialog did not open in time.', 'TimeoutError'),
          );
        }, COMMENT_DIALOG_RESERVATION_TIMEOUT_MS) ?? null;
    }
    return reservation;
  }

  // eslint-disable-next-line max-params -- exact upstream PDF.js callback signature
  async showDialog(
    uiManager: unknown,
    editor: PdfCommentEditor,
    posX: number,
    posY: number,
    _options?: { readonly height?: number | undefined },
  ): Promise<void> {
    const reservation = this.nextDialogReservation;
    try {
      if (this.disposed)
        throw new DOMException('PDF comment bridge disposed.', 'InvalidStateError');
      const manager = isPdfCommentUiManager(uiManager) ? uiManager : this.sidebarUiManager;
      this.nextDialogReservation = null;
      if (reservation !== null) {
        reservation.clearOpenTimeout();
        reservation.active = true;
        this.activeDialogReservation = reservation;
        this.commitReservedSelection(reservation, editor, manager);
        return;
      }
      this.publishFocus(editor, true, true, { bottom: posY, left: posX });
    } catch (cause) {
      const failure = asError(cause);
      if (reservation !== null) this.cancelReservation(reservation, failure);
      console.error('[abyss-documents] Failed to normalize PDF annotation comment', {
        cause: failure,
      });
    }
  }

  private commitReservedSelection(
    reservation: PendingCommentDialogReservation,
    editor: PdfCommentEditor,
    manager: PdfCommentUiManager | null,
  ): void {
    if (
      manager === null ||
      !isSupportedNativeEditor(editor) ||
      !this.mutate('save-comment', () => {
        editor.comment = reservation.seed;
      })
    ) {
      throw new DOMException(
        'The PDF selection comment could not be persisted.',
        'InvalidStateError',
      );
    }
    const annotation = this.annotationFromEditor(editor, reservation.seed, true, manager);
    this.retainActiveBinding(editor, manager);
    reservation.isOpen = true;
    reservation.resolveOpened(annotation);
    this.closeReservation(reservation, 'external');
  }

  nativeEditorIds(uiManager?: unknown): ReadonlySet<string> {
    const ids = new Set<string>();
    const manager = isPdfCommentUiManager(uiManager) ? uiManager : this.sidebarUiManager;
    const selected = manager?.firstSelectedEditor;
    if (selected !== undefined) {
      const selectedId = editorRuntimeId(selected);
      if (selectedId.length > 0) ids.add(selectedId);
    }
    for (const node of Array.from(
      this.host.querySelectorAll<HTMLElement>(NATIVE_EDITOR_SELECTOR),
    )) {
      const id = node.id.trim();
      if (id.length === 0) continue;
      ids.add(id);
      const resolved = manager?.getEditor?.(id);
      if (resolved !== undefined) ids.add(editorRuntimeId(resolved));
    }
    return ids;
  }

  normalizeCreatedAnnotation(uiManager: unknown): DocumentAnnotation | null {
    const manager = isPdfCommentUiManager(uiManager) ? uiManager : this.sidebarUiManager;
    if (manager === null) return null;
    const editor =
      manager.firstSelectedEditor ??
      this.firstSelectedEditor(manager) ??
      this.uniqueSupportedNativeEditor(manager);
    if (editor === undefined || !isSupportedNativeEditor(editor)) return null;
    const annotation = this.annotationFromEditor(
      editor,
      editor.getData().contentsObj?.str ?? '',
      true,
      manager,
    );
    this.retainActiveBinding(editor, manager);
    return annotation;
  }

  normalizeSelectionHighlight(
    uiManager: unknown,
    existingIds: ReadonlySet<string> = new Set(),
  ): DocumentAnnotation | null {
    const manager = isPdfCommentUiManager(uiManager) ? uiManager : this.sidebarUiManager;
    if (manager === null) return null;
    const editor = this.createdSelectionHighlight(manager, existingIds);
    if (editor === undefined) return null;
    const annotation = this.annotationFromEditor(
      editor,
      editor.getData().contentsObj?.str ?? '',
      true,
      manager,
    );
    this.retainActiveBinding(editor, manager);
    return annotation;
  }

  private createdSelectionHighlight(
    manager: PdfCommentUiManager,
    existingIds: ReadonlySet<string>,
  ): PdfCommentEditor | undefined {
    const candidates = new Map<string, PdfCommentEditor>();
    const selected = manager.firstSelectedEditor ?? this.firstSelectedEditor(manager);
    if (selected !== undefined) addSelectionHighlightCandidate(candidates, selected, existingIds);
    if (manager.getEditor === undefined)
      return candidates.size === 1 ? candidates.values().next().value : undefined;
    for (const node of Array.from(
      this.host.querySelectorAll<HTMLElement>(NATIVE_EDITOR_SELECTOR),
    )) {
      const id = node.id.trim();
      if (id.length === 0 || existingIds.has(id)) continue;
      const editor = manager.getEditor(id);
      if (editor !== undefined) addSelectionHighlightCandidate(candidates, editor, existingIds);
    }
    return candidates.size === 1 ? candidates.values().next().value : undefined;
  }

  private uniqueSupportedNativeEditor(manager: PdfCommentUiManager): PdfCommentEditor | undefined {
    if (manager.getEditor === undefined) return undefined;
    const candidates = new Map<string, PdfCommentEditor>();
    for (const node of Array.from(
      this.host.querySelectorAll<HTMLElement>(NATIVE_EDITOR_SELECTOR),
    )) {
      const id = node.id.trim();
      if (id.length === 0) continue;
      const editor = manager.getEditor(id);
      if (editor === undefined || !isSupportedNativeEditor(editor)) continue;
      candidates.set(editorRuntimeId(editor), editor);
    }
    return candidates.size === 1 ? candidates.values().next().value : undefined;
  }

  updateAnnotations(update: PdfAnnotationUpdate): boolean {
    const bindings = this.resolveBindings(update.annotations);
    if (bindings === null) return false;
    if (update.color !== undefined && !this.updateColors(bindings, update.color)) return false;
    if (update.comment !== undefined && !this.updateComments(bindings, update.comment))
      return false;
    return true;
  }

  private updateColors(bindings: readonly NativeAnnotationBinding[], color: string): boolean {
    const changes: Array<{
      readonly binding: NativeAnnotationBinding;
      readonly parameter: number;
    }> = [];
    for (const binding of bindings) {
      const parameter = annotationColorParameter(binding.editor);
      if (parameter === null) return false;
      changes.push({ binding, parameter });
    }
    for (const { binding, parameter } of changes) {
      if (
        !this.mutate('change-color', () => {
          binding.manager.setSelected(binding.editor);
          binding.manager.updateParams(parameter, color);
        })
      )
        return false;
    }
    this.options.onColorChange?.(color);
    return true;
  }

  private updateComments(bindings: readonly NativeAnnotationBinding[], comment: string): boolean {
    for (const { editor } of bindings) {
      if (
        !this.mutate('save-comment', () => {
          editor.comment = comment;
        })
      )
        return false;
    }
    return true;
  }

  deleteAnnotations(annotations: readonly DocumentAnnotation[]): boolean {
    const bindings = this.resolveBindings(annotations);
    if (bindings === null) return false;
    return this.mutate('delete-annotation', () => {
      for (const { editor, manager } of bindings) {
        manager.setSelected(editor);
        manager.delete();
      }
    });
  }

  private resolveBindings(
    annotations: readonly DocumentAnnotation[],
  ): readonly NativeAnnotationBinding[] | null {
    const bindings = annotations.map((annotation) => {
      const id = stableAnnotationId(annotation);
      return id === null ? undefined : this.bindings.get(id);
    });
    return bindings.some((binding) => binding === undefined)
      ? null
      : (bindings as readonly NativeAnnotationBinding[]);
  }

  toggleCommentPopup(
    editor: PdfCommentEditor | null,
    isSelected = false,
    visibility?: boolean,
    isEditable = true,
  ): void {
    if (editor === null || visibility === false) {
      this.destroyPopup();
      return;
    }
    this.publishFocus(editor, isSelected, isEditable, popupAnchor(editor)?.getBoundingClientRect());
  }

  private publishFocus(
    editor: PdfCommentEditor,
    isSelected: boolean,
    isEditable: boolean,
    anchor: Pick<DOMRect, 'bottom' | 'left'> | undefined,
  ): void {
    const manager = this.sidebarUiManager;
    const selected = this.selectedEditors(editor, isSelected, manager);
    const editable = isWritableFocus(selected, manager, isSelected, isEditable);
    const sources = selected.length > 0 ? selected : [editor];
    const annotations = sources.map((source) =>
      this.annotationFromEditor(
        source,
        source.getData().contentsObj?.str ?? '',
        editable,
        editable ? manager : null,
      ),
    );
    if (editable && manager !== null) this.retainActiveBinding(editor, manager);
    else {
      this.activeSource = editor;
      this.activeBinding = null;
    }
    editor.setCommentButtonStates?.({ hasPopup: true, selected: isSelected });
    this.emitFocus({
      annotations,
      editable,
      position: { x: anchor?.left ?? 0, y: anchor?.bottom ?? 0 },
    });
  }

  private selectedEditors(
    editor: PdfCommentEditor,
    isSelected: boolean,
    manager: PdfCommentUiManager | null,
  ): readonly PdfCommentEditor[] {
    if (!isSelected || manager?.getEditor === undefined) return [editor];
    const selected: PdfCommentEditor[] = [];
    const seen = new Set<PdfCommentEditor>();
    for (const node of Array.from(
      this.host.querySelectorAll<HTMLElement>(SELECTED_EDITOR_SELECTOR),
    )) {
      const id = selectedEditorId(node);
      const resolved = id.length === 0 ? undefined : manager.getEditor(id);
      if (resolved === undefined || seen.has(resolved)) continue;
      seen.add(resolved);
      selected.push(resolved);
    }
    if (!seen.has(editor)) selected.unshift(editor);
    return selected;
  }

  private firstSelectedEditor(manager: PdfCommentUiManager): PdfCommentEditor | undefined {
    if (manager.getEditor === undefined) return undefined;
    for (const node of Array.from(
      this.host.querySelectorAll<HTMLElement>(SELECTED_EDITOR_SELECTOR),
    )) {
      const id = selectedEditorId(node);
      const resolved = id.length === 0 ? undefined : manager.getEditor(id);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }

  private emitFocus(focus: PdfAnnotationFocus | null): void {
    for (const listener of [...this.focusListeners]) listener(focus);
  }

  destroyPopup(): void {
    if (this.activeDialogReservation !== null || this.nativeMutationDepth > 0) return;
    if (this.persistenceDepth > 0) {
      this.persistenceFocusInvalidated = true;
      return;
    }
    this.releasePopupState();
    this.emitFocus(null);
  }

  private releasePopupState(): void {
    this.activeSource?.setCommentButtonStates?.({ hasPopup: false, selected: false });
    this.activeSource = null;
    this.activeBinding = null;
  }

  private retainActiveBinding(editor: PdfCommentEditor, manager: PdfCommentUiManager): void {
    this.activeSource = editor;
    this.activeBinding = { editor, manager };
  }

  makeCommentColor(color: readonly number[] | null, opacity = 1): string | null {
    if (color === null || color.length < 3) return null;
    const [red = 0, green = 0, blue = 0] = color;
    return `rgb(${clampByte(red)} ${clampByte(green)} ${clampByte(blue)} / ${clampOpacity(opacity)})`;
  }

  setSidebarUiManager(uiManager: unknown): void {
    this.sidebarUiManager = isPdfCommentUiManager(uiManager) ? uiManager : null;
    for (const check of [...this.focusReadinessChecks]) check();
  }

  showSidebar(annotations: readonly unknown[]): void {
    this.comments.clear();
    for (const annotation of annotations) this.storeComment(annotation);
    this.dialogElement.dataset['sidebarVisible'] = 'true';
    this.updateCommentCount();
  }

  hideSidebar(): void {
    this.dialogElement.dataset['sidebarVisible'] = 'false';
  }

  removeComments(ids: readonly string[]): void {
    for (const id of ids) this.comments.delete(id);
    if (ids.includes(this.dialogElement.dataset['selectedCommentId'] ?? '')) {
      delete this.dialogElement.dataset['selectedCommentId'];
    }
    this.updateCommentCount();
  }

  selectComment(id: string): void {
    if (this.comments.has(id)) this.dialogElement.dataset['selectedCommentId'] = id;
  }

  addComment(annotation: unknown): void {
    this.storeComment(annotation);
    this.updateCommentCount();
  }

  updateComment(annotation: unknown): void {
    this.storeComment(annotation);
    this.updateCommentCount();
  }

  updatePopupColor(editor: PdfCommentEditor): void {
    if (this.activeSource !== editor) return;
    this.publishFocus(editor, true, true, popupAnchor(editor)?.getBoundingClientRect());
  }

  destroy(): void {
    if (this.disposed) return;
    this.resetManagerLifecycle(new DOMException('PDF comment manager destroyed.', 'AbortError'));
  }

  dispose(): boolean {
    if (this.disposed) return true;
    try {
      const failure = new DOMException('PDF comment bridge disposed.', 'AbortError');
      this.resetManagerLifecycle(failure);
      this.disposed = true;
      for (const check of [...this.focusReadinessChecks]) check();
      this.focusListeners.clear();
      this.dialogElement.remove();
      return true;
    } catch {
      return false;
    }
  }

  private resetManagerLifecycle(failure: Error): void {
    if (this.nextDialogReservation !== null)
      this.cancelReservation(this.nextDialogReservation, failure);
    if (this.activeDialogReservation !== null)
      this.cancelReservation(this.activeDialogReservation, failure);
    this.sidebarUiManager = null;
    this.comments.clear();
    this.updateCommentCount();
    delete this.dialogElement.dataset['selectedCommentId'];
    this.dialogElement.dataset['sidebarVisible'] = 'false';
    this.releasePopupState();
    this.emitFocus(null);
    this.bindings.clear();
    this.persistenceDepth = 0;
    this.persistenceFocusInvalidated = false;
  }

  private closeReservation(
    reservation: PendingCommentDialogReservation,
    reason: PdfCommentDialogCloseReason,
  ): void {
    if (reservation.settled) return;
    reservation.settled = true;
    reservation.cleanup();
    if (this.activeDialogReservation === reservation) this.activeDialogReservation = null;
    reservation.resolveClosed(reason);
  }

  private cancelReservation(reservation: PendingCommentDialogReservation, cause: Error): void {
    if (reservation.settled) return;
    reservation.settled = true;
    reservation.cleanup();
    if (this.nextDialogReservation === reservation) this.nextDialogReservation = null;
    if (this.activeDialogReservation === reservation) this.activeDialogReservation = null;
    if (!reservation.isOpen) reservation.rejectOpened(cause);
    reservation.rejectClosed(cause);
  }

  private storeComment(value: unknown): void {
    if (!isCommentData(value)) return;
    if (value.popupRef === false || value.contentsObj?.str === '') this.comments.delete(value.id);
    else this.comments.set(value.id, value);
  }

  private updateCommentCount(): void {
    this.dialogElement.dataset['commentCount'] = String(this.comments.size);
  }

  private mutate(action: PdfCommentMutationFailure['action'], mutation: () => void): boolean {
    this.nativeMutationDepth += 1;
    try {
      mutation();
      this.options.onNativeMutation?.();
      return true;
    } catch (cause) {
      this.options.onFailure?.({ action, cause });
      return false;
    } finally {
      this.nativeMutationDepth -= 1;
    }
  }

  private annotationFromEditor(
    editor: PdfCommentEditor,
    comment: string,
    writable: boolean,
    manager: PdfCommentUiManager | null,
  ): DocumentAnnotation {
    const data = editor.getData();
    const id =
      firstNonEmpty(this.bindingIds.get(editor), editorAnnotationId(editor)) ??
      this.fallbackId(editor);
    const capability = writable
      ? ({ available: true } as const)
      : ({
          available: false,
          reason: {
            code: 'unsupported-annotation',
            message: annotationReadOnlyReason(editor),
          },
        } as const);
    const annotation: DocumentAnnotation = {
      anchor: {
        coordinateSpace: 'page-points-top-left',
        geometry: { kind: 'point', point: { x: 0, y: 0 } },
        kind: 'fixed-page',
        pageIndex: annotationPageIndex(editor),
      },
      author: '',
      capabilities: {
        color: capability,
        comment: capability,
        conversions: { highlight: capability, underline: capability },
        deletion: capability,
        geometry: capability,
        metadata: capability,
      },
      color: rgbToHex(data.color),
      comment,
      createdAt: null,
      identity: { id: asAnnotationId(id), kind: 'stable' },
      links: [],
      modifiedAt: null,
      selectedText: null,
      tags: [],
      type: annotationType(editor),
    };
    if (writable && manager !== null) {
      this.bindings.set(id, { editor, manager });
      this.bindingIds.set(editor, id);
    }
    return mergeProjectedAnnotation(annotation, this.focusProjections.get(id));
  }

  private fallbackId(editor: PdfCommentEditor): string {
    const existing = this.fallbackIds.get(editor);
    if (existing !== undefined) return existing;
    const id = `pdf-comment-${String(++this.fallbackIdSequence)}`;
    this.fallbackIds.set(editor, id);
    return id;
  }
}

function nativeEditorNode(
  target: EventTarget | null,
  owner: { readonly Element: typeof Element },
): HTMLElement | null {
  if (!(target instanceof owner.Element)) return null;
  if (target.closest('a, button, input, select, textarea') !== null) return null;
  const node = target.closest<HTMLElement>(ANNOTATION_FOCUS_SELECTOR);
  if (node === null) return null;
  if (node.matches(NATIVE_EDITOR_SELECTOR) && node.closest('.annotationEditorLayer') === null)
    return null;
  return node;
}

function editorComment(editor: PdfCommentEditor): string {
  return editor.getData().contentsObj?.str ?? '';
}

function editorRuntimeId(editor: PdfCommentEditor): string {
  return firstNonEmpty(editor.uid, editor.getData().id) ?? '';
}

function editorAnnotationId(editor: PdfCommentEditor): string {
  return firstNonEmpty(editor.getData().id, editor.uid) ?? '';
}

function writableManager(
  editable: boolean,
  manager: PdfCommentUiManager,
): PdfCommentUiManager | null {
  return editable ? manager : null;
}

function setFocusedCommentButton(editor: PdfCommentEditor): void {
  editor.setCommentButtonStates?.({ hasPopup: true, selected: true });
}

function focusedEditorPosition(editor: PdfCommentEditor): {
  readonly x: number;
  readonly y: number;
} {
  const anchor = popupAnchor(editor)?.getBoundingClientRect();
  return { x: anchor?.left ?? 0, y: anchor?.bottom ?? 0 };
}

function readOnlyAnnotationFromNode(node: HTMLElement, id: string): DocumentAnnotation {
  const reason = {
    code: 'unsupported-annotation' as const,
    message: 'This imported annotation is read-only.',
  };
  const unavailable = { available: false as const, reason };
  const pageNumber = Number(node.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber']);
  const selectedText = node.textContent.trim();
  const type = annotationTypeFromNode(node);
  return {
    anchor: {
      coordinateSpace: 'page-points-top-left',
      geometry: { kind: 'point', point: { x: 0, y: 0 } },
      kind: 'fixed-page',
      pageIndex: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber - 1 : 0,
    },
    author: '',
    capabilities: {
      color: unavailable,
      comment: unavailable,
      conversions: { highlight: unavailable, underline: unavailable },
      deletion: unavailable,
      geometry: unavailable,
      metadata: unavailable,
    },
    color: null,
    comment: node.dataset['comment'] ?? '',
    createdAt: null,
    identity: { id: asAnnotationId(id), kind: 'stable' },
    links: [],
    modifiedAt: null,
    selectedText: selectedText.length === 0 ? null : selectedText,
    tags: [],
    type,
    ...(type === 'unsupported' ? { externalType: node.className } : {}),
  };
}

function mergeProjectedAnnotation(
  native: DocumentAnnotation,
  projected: DocumentAnnotation | undefined,
): DocumentAnnotation {
  if (projected === undefined) return native;
  return {
    ...native,
    anchor: projected.anchor,
    author: projected.author,
    color: native.color ?? projected.color,
    comment: native.comment.length > 0 ? native.comment : projected.comment,
    createdAt: projected.createdAt,
    links: native.links.length > 0 ? native.links : projected.links,
    modifiedAt: projected.modifiedAt,
    selectedText: native.selectedText ?? projected.selectedText,
    tags: native.tags.length > 0 ? native.tags : projected.tags,
    type: native.type === 'unsupported' ? projected.type : native.type,
  };
}

function annotationTypeFromNode(node: HTMLElement): DocumentAnnotation['type'] {
  if (node.matches('.underlineAnnotation')) return 'underline';
  if (node.matches('.textAnnotation')) return 'text-note';
  if (node.matches('.highlightAnnotation')) return 'highlight';
  if (node.matches('.inkAnnotation')) return 'ink';
  if (node.matches('.freeTextAnnotation')) return 'free-text';
  return 'unsupported';
}

function isWritableFocus(
  selected: readonly PdfCommentEditor[],
  manager: PdfCommentUiManager | null,
  isSelected: boolean,
  isEditable: boolean,
): boolean {
  return (
    isSelected &&
    isEditable &&
    manager !== null &&
    selected.length > 0 &&
    selected.every(isSupportedNativeEditor)
  );
}

function annotationReadOnlyReason(editor: PdfCommentEditor): string {
  const subtype = annotationDomSubtype(editor);
  if (subtype === 'underlineAnnotation') return 'Underline annotations are read-only.';
  if (subtype === 'textAnnotation') return 'Text Note annotations are read-only.';
  return isSupportedNativeEditor(editor)
    ? 'This annotation is read-only.'
    : 'Unsupported annotation.';
}

function selectedEditorId(node: HTMLElement): string {
  const elementId = node.id.trim();
  if (elementId.length > 0) return elementId;
  return node.dataset['annotationId']?.trim() ?? '';
}

function importedAnnotationId(node: HTMLElement, fallback: string): string {
  const annotationId = node.dataset['annotationId']?.trim();
  return annotationId ?? fallback;
}

function stableAnnotationId(annotation: DocumentAnnotation): string | null {
  return annotation.identity.kind === 'stable' ? String(annotation.identity.id) : null;
}

function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? '').find((value) => value.length > 0);
}

function annotationDomSubtype(editor: PdfCommentEditor): string | undefined {
  const anchor = popupAnchor(editor);
  const annotation =
    anchor?.closest(
      '.underlineAnnotation, .textAnnotation, .highlightAnnotation, .inkAnnotation, .freeTextAnnotation',
    ) ??
    anchor?.previousElementSibling?.closest(
      '.underlineAnnotation, .textAnnotation, .highlightAnnotation, .inkAnnotation, .freeTextAnnotation',
    );
  for (const subtype of ANNOTATION_DOM_SUBTYPES) {
    if (annotation?.classList.contains(subtype) === true) return subtype;
  }
  return undefined;
}

const ANNOTATION_DOM_SUBTYPES = [
  'underlineAnnotation',
  'textAnnotation',
  'highlightAnnotation',
  'inkAnnotation',
  'freeTextAnnotation',
] as const;

function popupAnchor(editor: PdfCommentEditor): Element | null {
  return editor.elementBeforePopup ?? null;
}

function annotationColorParameter(editor: PdfCommentEditor): number | null {
  const type = editor.mode;
  if (type === 9 && editor.editorType === 'highlight')
    return PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE.HIGHLIGHT_COLOR;
  if (type === 15 && editor.editorType === 'ink')
    return PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE.INK_COLOR;
  if (type === 3 && editor.editorType === 'freetext')
    return PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE.FREETEXT_COLOR;
  return null;
}

function isSupportedNativeEditor(editor: PdfCommentEditor): boolean {
  return (
    typeof editor.uid === 'string' &&
    typeof editor.select === 'function' &&
    Array.isArray(editor.propertiesToUpdate) &&
    ((editor.mode === 3 && editor.editorType === 'freetext') ||
      (editor.mode === 9 && editor.editorType === 'highlight') ||
      (editor.mode === 15 && editor.editorType === 'ink'))
  );
}

function addSelectionHighlightCandidate(
  candidates: Map<string, PdfCommentEditor>,
  editor: PdfCommentEditor,
  existingIds: ReadonlySet<string>,
): void {
  const id = editorRuntimeId(editor);
  if (
    existingIds.has(id) ||
    editor.mode !== 9 ||
    editor.editorType !== 'highlight' ||
    !isSupportedNativeEditor(editor)
  )
    return;
  candidates.set(id, editor);
}

function rgbToHex(color: readonly number[] | undefined): string {
  const [red = 0, green = 0, blue = 0] = color ?? [];
  return `#${[red, green, blue]
    .map((value) => clampByte(value).toString(16).padStart(2, '0'))
    .join('')}`;
}

function annotationPageIndex(editor: PdfCommentEditor): number {
  const value = Number(
    popupAnchor(editor)?.closest<HTMLElement>('[data-page-number]')?.dataset['pageNumber'],
  );
  return Number.isInteger(value) && value > 0 ? value - 1 : 0;
}

function annotationType(editor: PdfCommentEditor): DocumentAnnotation['type'] {
  const subtype = annotationDomSubtype(editor);
  if (subtype === 'underlineAnnotation') return 'underline';
  if (subtype === 'textAnnotation') return 'text-note';
  if (editor.mode === 9 || editor.editorType === 'highlight') return 'highlight';
  if (editor.mode === 15 || editor.editorType === 'ink') return 'ink';
  if (editor.mode === 3 || editor.editorType === 'freetext') return 'free-text';
  return 'unsupported';
}

function isPdfCommentUiManager(value: unknown): value is PdfCommentUiManager {
  if (typeof value !== 'object' || value === null) return false;
  const manager = value as Partial<PdfCommentUiManager>;
  return (
    typeof manager.delete === 'function' &&
    typeof manager.setSelected === 'function' &&
    typeof manager.updateParams === 'function'
  );
}

function isCommentData(value: unknown): value is PdfCommentData & { readonly id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly id?: unknown }).id === 'string'
  );
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (cause?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (typeof reason === 'object' && reason !== null && 'name' in reason && 'message' in reason) {
    return reason as Error;
  }
  return new DOMException('The PDF annotation interaction was cancelled.', 'AbortError');
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
