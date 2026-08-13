import {
  MarkdownView,
  type FileManager,
  type MarkdownFileInfo,
  type TFile,
  type Workspace,
} from 'obsidian';
import type { AnnotationGeometry, DocumentAnnotation } from '../document-core/annotations.js';

export interface AnnotationHrefReference {
  readonly id: string;
  readonly page: number;
  readonly fingerprint: string;
}

export type AnnotationHrefResolution =
  | {
      readonly status: 'resolved';
      readonly annotation: DocumentAnnotation;
      readonly matchedBy: 'id' | 'geometry';
    }
  | { readonly status: 'unresolved' }
  | { readonly status: 'ambiguous'; readonly candidates: readonly DocumentAnnotation[] };

export interface AnnotationTransfer {
  readonly href: string;
  readonly markdown: string;
  readonly plain: string;
}

export interface AnnotationTransferContext {
  readonly fileManager: Pick<FileManager, 'generateMarkdownLink'>;
  readonly sourcePath: string;
}

export interface AnnotationTransferFailure {
  readonly action: 'copy' | 'insert';
  readonly annotation: string;
  readonly file: string;
  readonly cause: unknown;
}

export interface AnnotationTransferServiceOptions {
  readonly fileManager: Pick<FileManager, 'generateMarkdownLink'>;
  readonly workspace: Pick<Workspace, 'activeEditor' | 'getMostRecentLeaf'>;
  readonly clipboard: Pick<Clipboard, 'writeText'>;
  readonly template: () => string;
  readonly onFailure: (failure: AnnotationTransferFailure) => void;
}

export class AnnotationTransferService {
  private lastFailureKey: string | null = null;
  constructor(private readonly options: AnnotationTransferServiceOptions) {}

  build(annotation: DocumentAnnotation, file: TFile): AnnotationTransfer {
    return buildTargetIndependentTransfer(annotation, file, this.options.template());
  }

  async copyAnnotationLink(annotation: DocumentAnnotation, file: TFile): Promise<void> {
    try {
      const link = vaultAbsoluteAnnotationLink(file, buildAnnotationHref(annotation), false);
      await this.options.clipboard.writeText(link);
      this.lastFailureKey = null;
    } catch (cause) {
      this.reportFailure('copy', annotation, file, cause);
    }
  }

  insertAnnotationIntoActiveMarkdown(annotation: DocumentAnnotation, file: TFile): void {
    try {
      const active = this.markdownEditor();
      if (active?.editor === undefined || active.file === null)
        throw new DOMException('No active Markdown editor is available.', 'InvalidStateError');
      const transfer = buildAnnotationTransfer(annotation, file, this.options.template(), {
        fileManager: this.options.fileManager,
        sourcePath: active.file.path,
      });
      const cursor = active.editor.getCursor();
      active.editor.replaceRange(transfer.markdown, cursor);
      if (active === this.options.workspace.activeEditor) active.editor.focus();
      this.lastFailureKey = null;
    } catch (cause) {
      this.reportFailure('insert', annotation, file, cause);
    }
  }

  private markdownEditor(): MarkdownFileInfo | null {
    const active = this.options.workspace.activeEditor;
    if (active?.editor !== undefined && active.file !== null) return active;
    const recent = this.options.workspace.getMostRecentLeaf()?.view;
    if (recent instanceof MarkdownView && recent.file !== null) return recent;
    return null;
  }

  private reportFailure(
    action: AnnotationTransferFailure['action'],
    annotation: DocumentAnnotation,
    file: TFile,
    cause: unknown,
  ): void {
    const identity = annotationIdentity(annotation);
    const reason = cause instanceof Error ? cause.message : String(cause);
    const key = `${action}\u0000${file.path}\u0000${identity}\u0000${reason}`;
    if (key === this.lastFailureKey) return;
    this.lastFailureKey = key;
    this.options.onFailure({ action, annotation: identity, file: file.path, cause });
  }
}

export function buildAnnotationHref(annotation: DocumentAnnotation): string {
  if (annotation.identity.kind !== 'stable')
    throw new DOMException('Save the PDF annotation before creating a link.', 'InvalidStateError');
  if (annotation.anchor.kind !== 'fixed-page')
    throw new DOMException(
      'A fixed-page PDF annotation is required before creating a link.',
      'InvalidStateError',
    );
  const id = annotation.identity.id;
  const page = annotation.anchor.pageIndex + 1;
  const fingerprint = annotationGeometryFingerprint(annotation);
  return `#annotation=${encodeURIComponent(id)}&page=${page}&fingerprint=${encodeURIComponent(fingerprint)}`;
}

export function parseAnnotationHref(value: string): AnnotationHrefReference | null {
  const query = value.startsWith('#') ? value.slice(1) : value;
  try {
    const raw = Object.fromEntries(
      query.split('&').map((part) => {
        const separator = part.indexOf('=');
        return separator < 0
          ? [decodeURIComponent(part), '']
          : [
              decodeURIComponent(part.slice(0, separator)),
              decodeURIComponent(part.slice(separator + 1)),
            ];
      }),
    );
    const id = raw['annotation'];
    const pageValue = raw['page'];
    const fingerprint = raw['fingerprint'];
    if (
      id === undefined ||
      pageValue === undefined ||
      fingerprint === undefined ||
      id.length === 0 ||
      fingerprint.length === 0
    )
      return null;
    const page = Number(pageValue);
    if (!Number.isSafeInteger(page) || page <= 0) return null;
    return Object.freeze({ id, page, fingerprint });
  } catch {
    return null;
  }
}

export function resolveAnnotationHref(
  reference: AnnotationHrefReference,
  annotations: readonly DocumentAnnotation[],
): AnnotationHrefResolution {
  const byId = annotations.filter(
    (annotation) =>
      annotation.identity.kind === 'stable' && annotation.identity.id === reference.id,
  );
  if (byId.length === 1)
    return Object.freeze({ status: 'resolved', annotation: first(byId), matchedBy: 'id' });
  if (byId.length > 1) return Object.freeze({ status: 'ambiguous', candidates: byId });
  const byGeometry = annotations.filter(
    (annotation) =>
      annotation.anchor.kind === 'fixed-page' &&
      annotation.anchor.pageIndex + 1 === reference.page &&
      annotationGeometryFingerprint(annotation) === reference.fingerprint,
  );
  if (byGeometry.length === 1)
    return Object.freeze({
      status: 'resolved',
      annotation: first(byGeometry),
      matchedBy: 'geometry',
    });
  if (byGeometry.length > 1) return Object.freeze({ status: 'ambiguous', candidates: byGeometry });
  return Object.freeze({ status: 'unresolved' });
}

function annotationGeometryFingerprint(annotation: DocumentAnnotation): string {
  if (annotation.anchor.kind !== 'fixed-page')
    throw new DOMException('PDF annotation geometry is unavailable.', 'InvalidStateError');
  return `${annotation.type}:${geometryFingerprint(annotation.anchor.geometry)}`;
}

function buildTargetIndependentTransfer(
  annotation: DocumentAnnotation,
  file: TFile,
  template: string,
): AnnotationTransfer {
  const href = buildAnnotationHref(annotation);
  return renderAnnotationTransfer(annotation, file, {
    href,
    template,
    link: vaultAbsoluteAnnotationLink(file, href, true),
  });
}

export function buildAnnotationTransfer(
  annotation: DocumentAnnotation,
  file: TFile,
  template: string,
  context: AnnotationTransferContext,
): AnnotationTransfer {
  const href = buildAnnotationHref(annotation);
  const generated = context.fileManager.generateMarkdownLink(file, context.sourcePath, href);
  const link = generated.startsWith('!') ? generated : `!${generated}`;
  return renderAnnotationTransfer(annotation, file, { href, template, link });
}

interface RenderAnnotationTransferOptions {
  readonly href: string;
  readonly link: string;
  readonly template: string;
}

function renderAnnotationTransfer(
  annotation: DocumentAnnotation,
  file: TFile,
  options: RenderAnnotationTransferOptions,
): AnnotationTransfer {
  const { href, link, template } = options;
  const quote = annotation.selectedText ?? '';
  const values = {
    quote: escapeTemplateValue(quote),
    comment: escapeTemplateValue(annotation.comment),
    link,
  };
  const markdown = template.replace(
    /\{\{(quote|comment|link)\}\}/gu,
    (_match, key: keyof typeof values) => values[key],
  );
  const plain = [quote, annotation.comment, `${file.path}${href}`]
    .filter((part) => part.length > 0)
    .join('\n\n');
  return Object.freeze({ href, markdown, plain });
}

function vaultAbsoluteAnnotationLink(file: TFile, href: string, embed: boolean): string {
  const path = encodeURI(file.path).replaceAll('#', '%23');
  return `${embed ? '!' : ''}[[${path}${href}]]`;
}

export function applyAnnotationTransfer(
  transfer: Pick<DataTransfer, 'setData'>,
  payload: AnnotationTransfer,
): void {
  transfer.setData('text/plain', payload.plain);
  transfer.setData('text/markdown', payload.markdown);
}

function geometryFingerprint(geometry: AnnotationGeometry): string {
  switch (geometry.kind) {
    case 'point':
      return `point:${numbers(geometry.point.x, geometry.point.y)}`;
    case 'rectangle':
      return `rectangle:${numbers(geometry.rectangle.x, geometry.rectangle.y, geometry.rectangle.width, geometry.rectangle.height)}`;
    case 'quadrilaterals':
      return `quadrilaterals:${geometry.quadrilaterals
        .map((quad) =>
          numbers(
            quad.topLeft.x,
            quad.topLeft.y,
            quad.topRight.x,
            quad.topRight.y,
            quad.bottomLeft.x,
            quad.bottomLeft.y,
            quad.bottomRight.x,
            quad.bottomRight.y,
          ),
        )
        .join(';')}`;
    case 'ink':
      return `ink:${geometry.paths.map((path) => path.map((point) => numbers(point.x, point.y)).join(';')).join('|')}`;
  }
}

function numbers(...values: number[]): string {
  return values.map((value) => Number(value.toFixed(4))).join(',');
}

function escapeTemplateValue(value: string): string {
  return value.replaceAll(']]>', ']\\]>').replaceAll('{{', '\\{{').replaceAll('}}', '\\}}');
}

function annotationIdentity(annotation: DocumentAnnotation): string {
  return annotation.identity.kind === 'stable'
    ? annotation.identity.id
    : annotation.identity.fingerprint;
}

function first(annotations: readonly DocumentAnnotation[]): DocumentAnnotation {
  const annotation = annotations[0];
  if (annotation === undefined) throw new TypeError('Expected one resolved annotation.');
  return annotation;
}
