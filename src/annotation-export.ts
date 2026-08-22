import {
  Modal,
  Notice,
  TFile,
  normalizePath,
  type App,
  type FileManager,
  type TAbstractFile,
  type Vault,
} from 'obsidian';
import type {
  AnnotationAnchor,
  AnnotationExportRecord,
  AnnotationGeometry,
  AnnotationIdentity,
  DocumentAnnotation,
} from './document-core/annotations.js';
import { buildAnnotationTransfer, renderAnnotationMarkdown } from './reader/annotation-transfer.js';
import { ownerWindow } from './reader/owner-dom.js';

export type AnnotationExportFormat = 'markdown' | 'json-v1';

export interface AnnotationExportChoice {
  readonly format: AnnotationExportFormat;
  readonly destination: string;
  readonly overwrite: boolean;
}

export interface AnnotationExportRequest extends AnnotationExportChoice {
  readonly vault: Pick<Vault, 'getAbstractFileByPath' | 'create' | 'modify' | 'read'>;
  readonly fileManager: Pick<FileManager, 'generateMarkdownLink'>;
  readonly source: TFile;
  readonly records: readonly AnnotationExportRecord[];
  readonly template: string;
}

export type AnnotationExportErrorCode =
  | 'invalid-destination'
  | 'destination-exists'
  | 'destination-not-file'
  | 'lookup-failed'
  | 'format-failed'
  | 'write-failed'
  | 'verification-failed';

interface AnnotationExportErrorOptions {
  readonly code: AnnotationExportErrorCode;
  readonly destination: string;
  readonly format: AnnotationExportFormat;
  readonly message: string;
  readonly cause?: unknown;
}

export class AnnotationExportError extends Error {
  readonly code: AnnotationExportErrorCode;
  readonly destination: string;
  readonly format: AnnotationExportFormat;
  readonly cause?: unknown;

  constructor(options: AnnotationExportErrorOptions) {
    super(options.message);
    this.name = 'AnnotationExportError';
    this.code = options.code;
    this.destination = options.destination;
    this.format = options.format;
    this.cause = options.cause;
  }
}

export async function exportAnnotations(request: AnnotationExportRequest): Promise<TFile> {
  const destination = safeExportDestination(request.destination, request.format);
  const content = renderExport(request, destination);
  const existing = lookupExportDestination(request.vault, destination, request.format);
  if (existing !== null && !(existing instanceof TFile))
    throw new AnnotationExportError({
      code: 'destination-not-file',
      destination,
      format: request.format,
      message: `The annotation export destination is not a file: ${destination}`,
    });
  if (existing !== null && !request.overwrite)
    throw new AnnotationExportError({
      code: 'destination-exists',
      destination,
      format: request.format,
      message: `The annotation export already exists: ${destination}`,
    });
  let artifact: TFile;
  try {
    if (existing === null) artifact = await request.vault.create(destination, content);
    else {
      await request.vault.modify(existing, content);
      artifact = existing;
    }
  } catch (cause) {
    throw new AnnotationExportError({
      code: 'write-failed',
      destination,
      format: request.format,
      message: `Could not write the ${request.format} annotation export to ${destination}.`,
      cause,
    });
  }
  try {
    if ((await request.vault.read(artifact)) !== content)
      throw new Error('The exported content did not match the committed vault file.');
  } catch (cause) {
    throw new AnnotationExportError({
      code: 'verification-failed',
      destination,
      format: request.format,
      message: `Could not verify the ${request.format} annotation export at ${destination}.`,
      cause,
    });
  }
  return artifact;
}

export function proposedAnnotationExportPath(
  source: TFile,
  format: AnnotationExportFormat,
): string {
  const slash = source.path.lastIndexOf('/');
  const folder = slash < 0 ? '' : source.path.slice(0, slash + 1);
  const extension = format === 'markdown' ? 'md' : 'json';
  return `${folder}${source.basename}.annotations.${extension}`;
}

export class AnnotationExportModal extends Modal {
  private choice: AnnotationExportChoice | null = null;
  private resolveChoice: ((choice: AnnotationExportChoice | null) => void) | null = null;
  private choicePromise: Promise<AnnotationExportChoice | null> | null = null;
  private format: AnnotationExportFormat = 'markdown';

  constructor(
    app: App,
    private readonly vault: Pick<Vault, 'getAbstractFileByPath'>,
    private readonly source: TFile,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.renderForm();
  }

  override onClose(): void {
    this.finish(this.choice);
    this.contentEl.empty();
  }

  waitForChoice(): Promise<AnnotationExportChoice | null> {
    this.choicePromise ??= new Promise((resolve) => {
      this.resolveChoice = resolve;
    });
    return this.choicePromise;
  }

  private renderForm(): void {
    this.setTitle('Export annotations');
    this.contentEl.empty();
    const owner = ownerWindow(this.contentEl);
    const formatLabel = owner.createEl('label');
    formatLabel.textContent = 'Format';
    const format = owner.createEl('select');
    format.setAttribute('aria-label', 'Export format');
    const markdownOption = owner.createEl('option');
    markdownOption.textContent = 'Markdown';
    markdownOption.value = 'markdown';
    const jsonOption = owner.createEl('option');
    jsonOption.textContent = 'JSON (version 1)';
    jsonOption.value = 'json-v1';
    format.append(markdownOption, jsonOption);
    format.value = this.format;
    const pathLabel = owner.createEl('label');
    pathLabel.textContent = 'Vault destination';
    const path = owner.createEl('input');
    path.type = 'text';
    path.setAttribute('aria-label', 'Vault destination');
    path.value = proposedAnnotationExportPath(this.source, this.format);
    format.addEventListener('change', () => {
      this.format = format.value === 'json-v1' ? 'json-v1' : 'markdown';
      path.value = proposedAnnotationExportPath(this.source, this.format);
    });
    const actions = owner.createDiv();
    actions.className = 'modal-button-container';
    actions.append(
      this.button('Export', 'export', () => {
        this.confirm(path.value);
      }),
      this.button('Cancel', 'cancel', () => {
        this.finish(null);
        this.close();
      }),
    );
    formatLabel.append(format);
    pathLabel.append(path);
    this.contentEl.append(formatLabel, pathLabel, actions);
    path.focus();
  }

  private confirm(destinationValue: string): void {
    let destination: string;
    try {
      destination = safeExportDestination(destinationValue, this.format);
    } catch (cause) {
      this.renderInlineError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    let existing: TAbstractFile | null;
    try {
      existing = lookupExportDestination(this.vault, destination, this.format);
    } catch (cause) {
      this.renderInlineError('Could not check the export destination. Try again.');
      console.error('[abyss-documents] Failed to inspect annotation export destination', {
        destination,
        format: this.format,
        cause,
      });
      return;
    }
    if (existing !== null && !(existing instanceof TFile)) {
      this.renderInlineError(`The export destination is not a file: ${destination}`);
      return;
    }
    if (existing !== null) {
      this.renderOverwriteConfirmation(destination);
      return;
    }
    this.complete({ format: this.format, destination, overwrite: false });
  }

  private renderOverwriteConfirmation(destination: string): void {
    this.contentEl.empty();
    const owner = ownerWindow(this.contentEl);
    const warning = owner.createEl('p');
    warning.textContent = `${destination} already exists. Replace it?`;
    const actions = owner.createDiv();
    actions.className = 'modal-button-container';
    actions.append(
      this.button(
        'Overwrite',
        'confirm-overwrite',
        () => {
          this.complete({ format: this.format, destination, overwrite: true });
        },
        true,
      ),
      this.button('Cancel', 'cancel', () => {
        this.finish(null);
        this.close();
      }),
    );
    this.contentEl.append(warning, actions);
    actions.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.focus();
  }

  private renderInlineError(message: string): void {
    let alert = this.contentEl.querySelector<HTMLElement>('[role="alert"]');
    alert ??= ownerWindow(this.contentEl).createEl('p');
    alert.setAttribute('role', 'alert');
    alert.textContent = message;
    this.contentEl.prepend(alert);
  }

  private button(
    label: string,
    action: string,
    callback: () => void,
    warning = false,
  ): HTMLButtonElement {
    const button = ownerWindow(this.contentEl).createEl('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset['action'] = action;
    if (warning) button.classList.add('mod-warning');
    button.addEventListener('click', callback);
    return button;
  }

  private complete(choice: AnnotationExportChoice): void {
    this.choice = choice;
    this.finish(choice);
    this.close();
  }

  private finish(choice: AnnotationExportChoice | null): void {
    this.resolveChoice?.(choice);
    this.resolveChoice = null;
  }
}

export interface AnnotationExportFlowOptions {
  readonly app: App;
  readonly vault: AnnotationExportRequest['vault'];
  readonly fileManager: AnnotationExportRequest['fileManager'];
  readonly template: () => string;
  readonly choose?: (
    source: TFile,
    proposed: AnnotationExportChoice,
  ) => Promise<AnnotationExportChoice | null>;
}

export class AnnotationExportFlow {
  private lastFailureKey: string | null = null;

  constructor(private readonly options: AnnotationExportFlowOptions) {}

  async run(source: TFile, records: readonly AnnotationExportRecord[]): Promise<TFile | null> {
    const proposed: AnnotationExportChoice = {
      format: 'markdown',
      destination: proposedAnnotationExportPath(source, 'markdown'),
      overwrite: false,
    };
    const choice = await (this.options.choose?.(source, proposed) ?? this.choose(source));
    if (choice === null) return null;
    try {
      const artifact = await exportAnnotations({
        ...choice,
        vault: this.options.vault,
        fileManager: this.options.fileManager,
        source,
        records,
        template: this.options.template(),
      });
      this.lastFailureKey = null;
      return artifact;
    } catch (cause) {
      const failure = asExportError(cause, choice);
      const key = `${failure.code}\u0000${failure.format}\u0000${failure.destination}\u0000${failure.message}`;
      if (key !== this.lastFailureKey) {
        this.lastFailureKey = key;
        new Notice(`Could not export annotations to ${failure.destination}.`);
        console.error('[abyss-documents] Failed to export PDF annotations', failure);
      }
      return null;
    }
  }

  private choose(source: TFile): Promise<AnnotationExportChoice | null> {
    const modal = new AnnotationExportModal(this.options.app, this.options.vault, source);
    const choice = modal.waitForChoice();
    modal.open();
    return choice;
  }
}

function safeExportDestination(value: string, format: AnnotationExportFormat): string {
  const raw = value.trim();
  if (
    raw.length === 0 ||
    raw.startsWith('/') ||
    raw.includes('\\') ||
    raw.includes('\u0000') ||
    raw.split('/').includes('..')
  )
    throw new AnnotationExportError({
      code: 'invalid-destination',
      destination: raw,
      format,
      message: 'Choose a safe vault-relative export destination.',
    });
  const destination = normalizePath(raw);
  const extension = format === 'markdown' ? '.md' : '.json';
  if (!destination.toLowerCase().endsWith(extension))
    throw new AnnotationExportError({
      code: 'invalid-destination',
      destination,
      format,
      message: `The ${format} export destination must end in ${extension}.`,
    });
  return destination;
}

function lookupExportDestination(
  vault: Pick<Vault, 'getAbstractFileByPath'>,
  destination: string,
  format: AnnotationExportFormat,
): TAbstractFile | null {
  try {
    return vault.getAbstractFileByPath(destination);
  } catch (cause) {
    throw new AnnotationExportError({
      code: 'lookup-failed',
      destination,
      format,
      message: `Could not inspect the ${format} annotation export destination at ${destination}.`,
      cause,
    });
  }
}

function renderExport(request: AnnotationExportRequest, destination: string): string {
  try {
    if (request.format === 'json-v1') return renderJson(request.source, request.records);
    return renderMarkdown(request, destination);
  } catch (cause) {
    if (cause instanceof AnnotationExportError) throw cause;
    throw new AnnotationExportError({
      code: 'format-failed',
      destination,
      format: request.format,
      message: `Could not format the ${request.format} annotation export for ${destination}.`,
      cause,
    });
  }
}

export type AnnotationTypeJsonV1 =
  'highlight' | 'underline' | 'ink' | 'text-note' | 'free-text' | 'unsupported';

interface AnnotationJsonV1 {
  readonly identity: AnnotationIdentityJsonV1;
  readonly type: AnnotationTypeJsonV1;
  readonly externalType: string | null;
  readonly anchor: AnnotationAnchorJsonV1;
  readonly color: string | null;
  readonly selectedText: string | null;
  readonly author: string;
  readonly createdAt: string | null;
  readonly modifiedAt: string | null;
  readonly comment: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

type AnnotationIdentityJsonV1 =
  | { readonly kind: 'stable'; readonly id: string }
  | { readonly kind: 'legacy'; readonly fingerprint: string };

type AnnotationAnchorJsonV1 =
  | {
      readonly kind: 'fixed-page';
      readonly pageIndex: number;
      readonly coordinateSpace: 'page-points-top-left';
      readonly geometry: AnnotationGeometryJsonV1;
    }
  | {
      readonly kind: 'reflowable-text';
      readonly selector: {
        readonly exact: string;
        readonly prefix: string;
        readonly suffix: string;
      };
      readonly progression: number | null;
    };

type AnnotationGeometryJsonV1 =
  | { readonly kind: 'point'; readonly point: PointJsonV1 }
  | {
      readonly kind: 'rectangle';
      readonly rectangle: PointJsonV1 & { readonly width: number; readonly height: number };
    }
  | {
      readonly kind: 'quadrilaterals';
      readonly quadrilaterals: ReadonlyArray<{
        readonly bottomLeft: PointJsonV1;
        readonly bottomRight: PointJsonV1;
        readonly topLeft: PointJsonV1;
        readonly topRight: PointJsonV1;
      }>;
    }
  | { readonly kind: 'ink'; readonly paths: ReadonlyArray<readonly PointJsonV1[]> };

interface PointJsonV1 {
  readonly x: number;
  readonly y: number;
}

function renderJson(source: TFile, records: readonly AnnotationExportRecord[]): string {
  const first = records[0];
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      document: {
        path: source.path,
        fingerprint: first?.documentFingerprint ?? '',
      },
      annotations: records.map(({ annotation }) => annotationJsonV1(annotation)),
    },
    null,
    2,
  )}\n`;
}

function renderMarkdown(request: AnnotationExportRequest, destination: string): string {
  return request.records
    .map(({ annotation }) => renderMarkdownAnnotation(annotation, request, destination))
    .join('\n\n---\n\n');
}

function renderMarkdownAnnotation(
  annotation: DocumentAnnotation,
  request: AnnotationExportRequest,
  destination: string,
): string {
  if (annotation.identity.kind !== 'stable' || annotation.anchor.kind !== 'fixed-page') {
    const page =
      annotation.anchor.kind === 'fixed-page' ? `, page ${annotation.anchor.pageIndex + 1}` : '';
    return renderAnnotationMarkdown(
      annotation,
      request.template,
      `Source: ${request.source.name}${page}`,
    );
  }
  return buildAnnotationTransfer(annotation, request.source, request.template, {
    fileManager: request.fileManager,
    sourcePath: destination,
  }).markdown;
}

function annotationJsonV1(annotation: DocumentAnnotation): AnnotationJsonV1 {
  return Object.freeze({
    identity: identityJsonV1(annotation.identity),
    type: annotationTypeJsonV1(annotation.type),
    externalType: annotation.externalType ?? null,
    anchor: anchorJsonV1(annotation.anchor),
    color: annotation.color,
    selectedText: annotation.selectedText,
    author: annotation.author,
    createdAt: annotation.createdAt,
    modifiedAt: annotation.modifiedAt,
    comment: annotation.comment,
    tags: Object.freeze([...annotation.tags]),
    links: Object.freeze([...annotation.links]),
  });
}

function annotationTypeJsonV1(type: DocumentAnnotation['type']): AnnotationTypeJsonV1 {
  switch (type) {
    case 'highlight':
    case 'underline':
    case 'ink':
    case 'text-note':
    case 'free-text':
    case 'unsupported':
      return type;
    default:
      return rejectFutureAnnotationType(type);
  }
}

function rejectFutureAnnotationType(type: never): never {
  throw new TypeError(`Annotation type is not supported by JSON-v1: ${String(type)}`);
}

function identityJsonV1(identity: AnnotationIdentity): AnnotationIdentityJsonV1 {
  return identity.kind === 'stable'
    ? Object.freeze({ kind: identity.kind, id: identity.id })
    : Object.freeze({ kind: identity.kind, fingerprint: identity.fingerprint });
}

function anchorJsonV1(anchor: AnnotationAnchor): AnnotationAnchorJsonV1 {
  if (anchor.kind === 'fixed-page')
    return Object.freeze({
      kind: anchor.kind,
      pageIndex: anchor.pageIndex,
      coordinateSpace: anchor.coordinateSpace,
      geometry: geometryJsonV1(anchor.geometry),
    });
  return Object.freeze({
    kind: anchor.kind,
    selector: Object.freeze({ ...anchor.selector }),
    progression: anchor.progression,
  });
}

function geometryJsonV1(geometry: AnnotationGeometry): AnnotationGeometryJsonV1 {
  switch (geometry.kind) {
    case 'point':
      return Object.freeze({ kind: geometry.kind, point: pointJsonV1(geometry.point) });
    case 'rectangle':
      return Object.freeze({
        kind: geometry.kind,
        rectangle: Object.freeze({ ...geometry.rectangle }),
      });
    case 'quadrilaterals':
      return Object.freeze({
        kind: geometry.kind,
        quadrilaterals: Object.freeze(
          geometry.quadrilaterals.map((quadrilateral) =>
            Object.freeze({
              bottomLeft: pointJsonV1(quadrilateral.bottomLeft),
              bottomRight: pointJsonV1(quadrilateral.bottomRight),
              topLeft: pointJsonV1(quadrilateral.topLeft),
              topRight: pointJsonV1(quadrilateral.topRight),
            }),
          ),
        ),
      });
    case 'ink':
      return Object.freeze({
        kind: geometry.kind,
        paths: Object.freeze(
          geometry.paths.map((path) => Object.freeze(path.map((point) => pointJsonV1(point)))),
        ),
      });
  }
}

function pointJsonV1(point: PointJsonV1): PointJsonV1 {
  return Object.freeze({ x: point.x, y: point.y });
}

function asExportError(cause: unknown, choice: AnnotationExportChoice): AnnotationExportError {
  if (cause instanceof AnnotationExportError) return cause;
  return new AnnotationExportError({
    code: 'write-failed',
    destination: choice.destination,
    format: choice.format,
    message: `Could not export annotations to ${choice.destination}.`,
    cause,
  });
}
