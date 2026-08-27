import {
  AnnotationPopover,
  type AnnotationCommentCloseReason,
} from '../../reader/annotation-popover.js';
import type { AnnotationLinkSuggestionProvider } from '../../reader/link-suggestions.js';
import { PDFJS_ANNOTATION_EDITOR_PARAMS_TYPE } from './pdf-runtime.js';

const COMMENT_DIALOG_RESERVATION_TIMEOUT_MS = 2_000;

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
  deleteComment?(editor: PdfCommentEditor, savedData: unknown): void;
  readonly firstSelectedEditor?: PdfCommentEditor | undefined;
  setSelected(editor: PdfCommentEditor): void;
  updateParams(type: number, value: unknown): void;
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
  readonly closed: Promise<AnnotationCommentCloseReason>;
  readonly opened: Promise<void>;
}

interface PendingCommentDialogReservation extends PdfCommentDialogReservation {
  active: boolean;
  isOpen: boolean;
  settled: boolean;
  readonly seed: '' | '[[' | '#';
  readonly clearOpenTimeout: () => void;
  readonly cleanup: () => void;
  readonly rejectClosed: (cause: unknown) => void;
  readonly rejectOpened: (cause: unknown) => void;
  readonly resolveClosed: (reason: AnnotationCommentCloseReason) => void;
  readonly resolveOpened: () => void;
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

/** Exact structural seam consumed by pdfjs-dist 6.2.108 but omitted from PDFViewerOptions. */
export class PdfCommentBridge implements PdfJsCommentManagerRuntime {
  readonly dialogElement: HTMLElement;

  private readonly popover: AnnotationPopover;
  private readonly comments = new Map<string, PdfCommentData>();
  private activeSource: PdfCommentEditor | null = null;
  private popupSelected = false;
  private popupVisible = false;
  private sidebarUiManager: PdfCommentUiManager | null = null;
  private activeDialogEditor: PdfCommentEditor | null = null;
  private activeDialogReservation: PendingCommentDialogReservation | null = null;
  private nextDialogReservation: PendingCommentDialogReservation | null = null;
  private nativeMutationDepth = 0;
  private disposed = false;

  constructor(
    host: HTMLElement,
    private readonly options: PdfCommentBridgeOptions = {},
    sourcePath = '',
    linkSuggestions: AnnotationLinkSuggestionProvider | null = null,
  ) {
    this.popover = new AnnotationPopover(host, linkSuggestions, sourcePath);
    this.dialogElement = this.popover.element;
  }

  reserveNextDialog(seed: '' | '[[' | '#', signal?: AbortSignal): PdfCommentDialogReservation {
    if (this.disposed) throw new DOMException('PDF comment bridge disposed.', 'InvalidStateError');
    if (this.nextDialogReservation !== null) {
      this.cancelReservation(
        this.nextDialogReservation,
        new DOMException('The PDF comment reservation was superseded.', 'AbortError'),
      );
    }
    const opened = deferred<void>();
    const closed = deferred<AnnotationCommentCloseReason>();
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
      resolveOpened: () => {
        opened.resolve(undefined);
      },
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

  // PDF.js 6.2.108 calls this exact five-argument manager seam.
  // eslint-disable-next-line complexity, max-params, sonarjs/cognitive-complexity -- exact upstream callback and dialog transaction orchestration
  async showDialog(
    uiManager: unknown,
    editor: PdfCommentEditor,
    posX: number,
    posY: number,
    options?: { readonly height?: number | undefined },
  ): Promise<void> {
    if (
      this.nextDialogReservation === null &&
      this.activeDialogReservation !== null &&
      sameCommentEditor(this.activeDialogEditor, editor) &&
      !this.dialogElement.hidden
    )
      return;
    const reservation = this.nextDialogReservation;
    try {
      if (this.disposed)
        throw new DOMException('PDF comment bridge disposed.', 'InvalidStateError');
      const data = editor.getData();
      this.nextDialogReservation = null;
      if (reservation !== null) {
        reservation.clearOpenTimeout();
        reservation.active = true;
        this.activeDialogReservation = reservation;
        this.activeDialogEditor = editor;
      }
      const manager = isPdfCommentUiManager(uiManager) ? uiManager : this.sidebarUiManager;
      const readOnlyReason = annotationReadOnlyReason(editor, manager);
      this.applyDialogHeight(options?.height);
      const editable = readOnlyReason === undefined && manager !== null;
      const comment = reservation?.seed ?? data.contentsObj?.str ?? '';
      let changed = false;
      this.popover.open({
        ...(editable ? this.colorActions(editor, data, manager) : {}),
        canDeleteAnnotation: editable,
        comment,
        deferFocus: reservation !== null,
        protectFocus: reservation !== null,
        onChange: (comment) => {
          changed = true;
          return this.mutate('save-comment', () => {
            editor.comment = comment;
          });
        },
        onDeleteAnnotation: () => {
          return this.mutate('delete-annotation', () => {
            this.deleteAnnotation(manager, editor);
          });
        },
        onDeleteComment: () => {
          return this.mutate('delete-comment', () => {
            this.deleteComment(manager, editor);
          });
        },
        onClose: (reason) => {
          this.commitAcceptedSeed(reservation, { changed, comment, reason }, editor);
          this.closeReservation(reservation, reason);
        },
        ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
        x: posX,
        y: posY,
      });
      if (reservation !== null) {
        reservation.isOpen = true;
        reservation.resolveOpened();
      }
    } catch (cause) {
      const failure = asError(cause);
      if (reservation !== null) this.cancelReservation(reservation, failure);
      console.error('[abyss-documents] Failed to open PDF annotation comment', { cause: failure });
    }
  }

  toggleCommentPopup(
    editor: PdfCommentEditor | null,
    isSelected = false,
    visibility?: boolean,
    isEditable = true,
  ): void {
    if (editor === null) {
      this.destroyPopup();
      return;
    }
    if (!isSelected && this.popupSelected) return;
    const nextVisibility = this.resolvePopupVisibility(editor, isSelected, visibility);
    if (!nextVisibility) {
      this.destroyPopup();
      return;
    }
    this.activatePopupSource(editor, isSelected);
    this.openPassivePopup(editor, {
      isEditable,
      isSelected,
      ...this.popupPosition(editor),
    });
  }

  private popupPosition(editor: PdfCommentEditor): { readonly x: number; readonly y: number } {
    const rect = popupAnchor(editor)?.getBoundingClientRect();
    return { x: rect?.x ?? 0, y: rect?.bottom ?? 0 };
  }

  destroyPopup(): void {
    if (this.activeDialogReservation !== null || this.nativeMutationDepth > 0) return;
    this.popover.close(false);
    this.releasePopupState();
  }

  private releasePopupState(): void {
    this.activeSource?.setCommentButtonStates?.({ hasPopup: false, selected: false });
    this.activeSource = null;
    this.popupSelected = false;
    this.popupVisible = false;
  }

  makeCommentColor(color: readonly number[] | null, opacity = 1): string | null {
    if (color === null || color.length < 3) return null;
    const [red = 0, green = 0, blue = 0] = color;
    return `rgb(${clampByte(red)} ${clampByte(green)} ${clampByte(blue)} / ${clampOpacity(opacity)})`;
  }

  setSidebarUiManager(uiManager: unknown): void {
    this.sidebarUiManager = isPdfCommentUiManager(uiManager) ? uiManager : null;
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
    this.popover.updateColor(rgbToHex(editor.getData().color));
  }

  destroy(): void {
    if (this.disposed) return;
    this.destroyPopup();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failure = new DOMException('PDF comment bridge disposed.', 'AbortError');
    if (this.nextDialogReservation !== null) {
      this.cancelReservation(this.nextDialogReservation, failure);
    }
    if (this.activeDialogReservation !== null) {
      this.cancelReservation(this.activeDialogReservation, failure);
    }
    this.popover.destroy();
  }

  private closeReservation(
    reservation: PendingCommentDialogReservation | null,
    reason: AnnotationCommentCloseReason,
  ): void {
    if (reservation === null || reservation.settled) return;
    reservation.settled = true;
    reservation.cleanup();
    if (this.activeDialogReservation === reservation) this.activeDialogReservation = null;
    if (this.activeDialogReservation === null) this.activeDialogEditor = null;
    reservation.resolveClosed(reason);
  }

  private cancelReservation(reservation: PendingCommentDialogReservation, cause: Error): void {
    if (reservation.settled) return;
    reservation.settled = true;
    reservation.cleanup();
    if (this.nextDialogReservation === reservation) this.nextDialogReservation = null;
    if (this.activeDialogReservation === reservation) this.activeDialogReservation = null;
    if (this.activeDialogReservation === null) this.activeDialogEditor = null;
    if (!reservation.isOpen) reservation.rejectOpened(cause);
    reservation.rejectClosed(cause);
    if (reservation.active) this.popover.close(false, 'external');
  }

  private storeComment(value: unknown): void {
    if (!isCommentData(value)) return;
    if (value.popupRef === false || value.contentsObj?.str === '') this.comments.delete(value.id);
    else this.comments.set(value.id, value);
  }

  private updateCommentCount(): void {
    this.dialogElement.dataset['commentCount'] = String(this.comments.size);
  }

  private applyDialogHeight(height: number | undefined): void {
    if (height === undefined) this.dialogElement.style.removeProperty('--abyss-comment-height');
    else this.dialogElement.style.setProperty('--abyss-comment-height', `${height}px`);
  }

  private activatePopupSource(editor: PdfCommentEditor, isSelected: boolean): void {
    this.activeSource?.setCommentButtonStates?.({ hasPopup: false, selected: false });
    this.activeSource = editor;
    this.popupSelected = isSelected;
    this.popupVisible = true;
    editor.setCommentButtonStates?.({ hasPopup: true, selected: isSelected });
  }

  private colorActions(
    editor: PdfCommentEditor,
    data: PdfCommentData,
    manager: PdfCommentUiManager,
  ): { readonly color: string; readonly onColor: (color: string) => void } {
    return {
      color: rgbToHex(data.color),
      onColor: (color) => {
        const parameter = annotationColorParameter(editor);
        if (parameter === null) return;
        const changed = this.mutate('change-color', () => {
          manager.setSelected(editor);
          manager.updateParams(parameter, color);
        });
        if (changed) this.options.onColorChange?.(color);
      },
    };
  }

  private deleteAnnotation(manager: PdfCommentUiManager | null, editor: PdfCommentEditor): void {
    if (manager === null) return;
    manager.setSelected(editor);
    manager.delete();
  }

  private deleteComment(manager: PdfCommentUiManager | null, editor: PdfCommentEditor): void {
    const savedData = editor.comment;
    if (manager?.deleteComment !== undefined) {
      manager.deleteComment(editor, savedData);
    } else editor.comment = null;
    editor.focusCommentButton?.();
  }

  private resolvePopupVisibility(
    editor: PdfCommentEditor,
    isSelected: boolean,
    visibility: boolean | undefined,
  ): boolean {
    if (visibility !== undefined) return visibility;
    if (isSelected) {
      return this.activeSource !== editor || !this.popupSelected || !this.popupVisible;
    }
    return !this.popupSelected && !this.popupVisible;
  }

  private openPassivePopup(
    editor: PdfCommentEditor,
    options: {
      readonly isEditable: boolean;
      readonly isSelected: boolean;
      readonly x: number;
      readonly y: number;
    },
  ): void {
    try {
      if (this.disposed)
        throw new DOMException('PDF comment bridge disposed.', 'InvalidStateError');
      const reason = annotationReadOnlyReason(editor, this.sidebarUiManager);
      const { isEditable, isSelected, x, y } = options;
      const canEdit =
        isSelected &&
        isEditable &&
        reason === undefined &&
        typeof editor.editComment === 'function';
      this.popover.openPassive({
        comment: editor.getData().contentsObj?.str ?? '',
        ...(canEdit
          ? {
              onEdit: () => {
                this.releasePopupState();
                Promise.resolve(editor.editComment?.()).catch((cause: unknown) => {
                  console.error('[abyss-documents] Failed to edit PDF annotation comment', {
                    cause,
                  });
                });
              },
            }
          : {}),
        ...(reason === undefined ? {} : { readOnlyReason: reason }),
        selected: isSelected,
        x,
        y,
      });
    } catch (cause) {
      console.error('[abyss-documents] Failed to open PDF annotation comment', { cause });
    }
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

  private commitAcceptedSeed(
    reservation: PendingCommentDialogReservation | null,
    state: {
      readonly changed: boolean;
      readonly comment: string;
      readonly reason: AnnotationCommentCloseReason;
    },
    editor: PdfCommentEditor,
  ): void {
    const { changed, comment, reason } = state;
    if (
      reservation === null ||
      changed ||
      comment.length === 0 ||
      (reason !== 'blur' && reason !== 'escape')
    )
      return;
    this.mutate('save-comment', () => {
      editor.comment = comment;
    });
  }
}

function annotationReadOnlyReason(
  editor: PdfCommentEditor,
  manager: PdfCommentUiManager | null,
): string | undefined {
  const subtype = annotationDomSubtype(editor);
  if (subtype === 'underlineAnnotation') return 'Underline annotations are read-only.';
  if (subtype === 'textAnnotation') return 'Text Note annotations are read-only.';
  if (!isSupportedNativeEditor(editor) || manager?.firstSelectedEditor !== editor)
    return 'This annotation is read-only.';
  return undefined;
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

function sameCommentEditor(active: PdfCommentEditor | null, candidate: PdfCommentEditor): boolean {
  if (active === candidate) return true;
  const activeId = active?.uid?.trim();
  const candidateId = candidate.uid?.trim();
  return (
    activeId !== undefined &&
    activeId.length > 0 &&
    candidateId !== undefined &&
    candidateId === activeId
  );
}

function rgbToHex(color: readonly number[] | undefined): string {
  const [red = 0, green = 0, blue = 0] = color ?? [];
  return `#${[red, green, blue]
    .map((value) => clampByte(value).toString(16).padStart(2, '0'))
    .join('')}`;
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
  return new DOMException('The PDF comment reservation was cancelled.', 'AbortError');
}

function asError(cause: unknown): Error {
  if (
    cause instanceof Error ||
    (typeof cause === 'object' && cause !== null && 'name' in cause && 'message' in cause)
  ) {
    return cause as Error;
  }
  return new Error(String(cause));
}
