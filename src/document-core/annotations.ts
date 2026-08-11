import { InvalidAnnotationMutationError } from './errors.js';

declare const annotationIdBrand: unique symbol;
declare const generatedAnnotationIdBrand: unique symbol;
declare const utcTimestampBrand: unique symbol;

export type AnnotationId = string & { readonly [annotationIdBrand]: true };
export type GeneratedAnnotationId = AnnotationId & {
  readonly [generatedAnnotationIdBrand]: true;
};
export type UtcTimestamp = string & { readonly [utcTimestampBrand]: true };

export type AnnotationType =
  'highlight' | 'underline' | 'ink' | 'text-note' | 'free-text' | 'unsupported';

export type ConvertibleAnnotationType = 'highlight' | 'underline';
export type WritableAnnotationType = Exclude<AnnotationType, 'unsupported'>;

export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface AnnotationRectangle extends AnnotationPoint {
  readonly width: number;
  readonly height: number;
}

export interface AnnotationQuadrilateral {
  readonly bottomLeft: AnnotationPoint;
  readonly bottomRight: AnnotationPoint;
  readonly topLeft: AnnotationPoint;
  readonly topRight: AnnotationPoint;
}

export type AnnotationGeometry =
  | { readonly kind: 'point'; readonly point: AnnotationPoint }
  | { readonly kind: 'rectangle'; readonly rectangle: AnnotationRectangle }
  | {
      readonly kind: 'quadrilaterals';
      readonly quadrilaterals: readonly AnnotationQuadrilateral[];
    }
  | { readonly kind: 'ink'; readonly paths: ReadonlyArray<readonly AnnotationPoint[]> };

export type AnnotationAnchor =
  | {
      readonly kind: 'fixed-page';
      readonly pageIndex: number;
      readonly coordinateSpace: 'page-points-top-left';
      readonly geometry: AnnotationGeometry;
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

export type AnnotationUnavailableCode =
  | 'document-read-only'
  | 'signed-document'
  | 'encrypted-document'
  | 'permission-restricted'
  | 'pure-xfa'
  | 'unsupported-annotation'
  | 'unsupported-adapter'
  | 'identity-conflict'
  | 'lossy-conversion';

export interface AnnotationUnavailableReason {
  readonly code: AnnotationUnavailableCode;
  readonly message: string;
}

export type AnnotationCapability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: AnnotationUnavailableReason };

export interface AnnotationCapabilities {
  readonly geometry: AnnotationCapability;
  readonly comment: AnnotationCapability;
  readonly color: AnnotationCapability;
  readonly deletion: AnnotationCapability;
  readonly metadata: AnnotationCapability;
  readonly conversions: Readonly<Record<ConvertibleAnnotationType, AnnotationCapability>>;
}

export interface StableAnnotationIdentity {
  readonly kind: 'stable';
  readonly id: AnnotationId;
}

export interface LegacyAnnotationIdentity {
  readonly kind: 'legacy';
  readonly fingerprint: string;
}

export type AnnotationIdentity = StableAnnotationIdentity | LegacyAnnotationIdentity;

export type AnnotationMutationTarget =
  | StableAnnotationIdentity
  | {
      readonly kind: 'legacy';
      readonly fingerprint: string;
      readonly promoteTo: GeneratedAnnotationId;
    };

export interface DocumentAnnotation {
  readonly identity: AnnotationIdentity;
  readonly type: AnnotationType;
  readonly externalType?: string;
  readonly anchor: AnnotationAnchor;
  readonly color: string | null;
  readonly selectedText: string | null;
  readonly author: string;
  readonly createdAt: UtcTimestamp | null;
  readonly modifiedAt: UtcTimestamp | null;
  readonly comment: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly capabilities: AnnotationCapabilities;
}

export interface AnnotationMetadataPatch {
  readonly author: string;
  readonly modifiedAt: UtcTimestamp;
}

export type AnnotationMutation =
  | {
      readonly kind: 'create';
      readonly id: GeneratedAnnotationId;
      readonly type: WritableAnnotationType;
      readonly anchor: AnnotationAnchor;
      readonly color: string | null;
      readonly selectedText: string | null;
      readonly author: string;
      readonly createdAt: UtcTimestamp;
      readonly modifiedAt: UtcTimestamp;
      readonly comment: string;
    }
  | {
      readonly kind: 'set-geometry';
      readonly target: AnnotationMutationTarget;
      readonly anchor: AnnotationAnchor;
    }
  | {
      readonly kind: 'set-comment';
      readonly target: AnnotationMutationTarget;
      readonly comment: string;
    }
  | {
      readonly kind: 'set-color';
      readonly target: AnnotationMutationTarget;
      readonly color: string | null;
    }
  | {
      readonly kind: 'convert-type';
      readonly target: AnnotationMutationTarget;
      readonly type: ConvertibleAnnotationType;
    }
  | { readonly kind: 'delete'; readonly target: AnnotationMutationTarget }
  | {
      readonly kind: 'set-metadata';
      readonly target: AnnotationMutationTarget;
      readonly metadata: AnnotationMetadataPatch;
    };

export interface AnnotationFilter {
  readonly query: string;
  readonly types: readonly AnnotationType[];
  readonly colors: readonly string[];
  readonly tags: readonly string[];
  readonly pageRange: { readonly first: number; readonly last: number } | null;
}

export interface AnnotationExportRecord {
  readonly documentPath: string;
  readonly documentFingerprint: string;
  readonly annotation: DocumentAnnotation;
}

export type AnnotationResolution =
  | { readonly status: 'resolved'; readonly annotation: DocumentAnnotation }
  | {
      readonly status: 'unresolved';
      readonly reason: 'external-delete';
      readonly reference: AnnotationIdentity;
    }
  | {
      readonly status: 'conflict';
      readonly reason: 'duplicate-identity';
      readonly candidates: readonly DocumentAnnotation[];
    };

export type AnnotationSink = (batch: readonly DocumentAnnotation[]) => void;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function asAnnotationId(value: string): AnnotationId {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('An annotation id must be a non-empty string.');
  }
  return value as AnnotationId;
}

export function asGeneratedAnnotationId(value: string): GeneratedAnnotationId {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError('A generated annotation id must be a UUID string.');
  }
  return value as GeneratedAnnotationId;
}

export function asUtcTimestamp(value: string): UtcTimestamp {
  if (typeof value !== 'string') {
    throw new TypeError('An annotation timestamp must be a normalized UTC string.');
  }
  let normalized: string;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw new TypeError('An annotation timestamp must be a normalized UTC timestamp.');
  }
  if (normalized !== value) {
    throw new TypeError('An annotation timestamp must be a normalized UTC timestamp.');
  }
  return value as UtcTimestamp;
}

export function canConvertAnnotation(
  capabilities: AnnotationCapabilities,
  target: AnnotationType,
): AnnotationCapability {
  if (target === 'highlight' || target === 'underline') {
    return freezeCapability(cloneCapability(capabilities.conversions[target]));
  }
  return Object.freeze({
    available: false,
    reason: Object.freeze({
      code: 'lossy-conversion',
      message: `Converting this annotation to ${target} would lose information.`,
    }),
  });
}

export function resolveAnnotationReference(
  reference: AnnotationIdentity,
  annotations: readonly DocumentAnnotation[],
): AnnotationResolution {
  const candidates = annotations.filter((annotation) => identityMatches(annotation, reference));
  if (candidates.length === 0) {
    return Object.freeze({ status: 'unresolved', reason: 'external-delete', reference });
  }
  if (candidates.length === 1) {
    return Object.freeze({ status: 'resolved', annotation: candidates[0] as DocumentAnnotation });
  }
  return Object.freeze({
    status: 'conflict',
    reason: 'duplicate-identity',
    candidates: Object.freeze([...candidates]),
  });
}

export function freezeAnnotationMutation(mutation: AnnotationMutation): AnnotationMutation {
  let kind: unknown;
  try {
    const source = requireRecord(mutation, 'An annotation mutation');
    kind = source.kind;
    const cloned = cloneMutation(source, kind);
    validateMutationValue(cloned);
    return freezeMutation(cloned);
  } catch (cause) {
    if (cause instanceof InvalidAnnotationMutationError) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new InvalidAnnotationMutationError(typeof kind === 'string' ? kind : '<unknown>', reason);
  }
}

function validateMutationValue(mutation: AnnotationMutation): void {
  requireKnownDiscriminant(
    mutation.kind,
    [
      'create',
      'set-geometry',
      'set-comment',
      'set-color',
      'convert-type',
      'delete',
      'set-metadata',
    ],
    'annotation mutation',
  );
  switch (mutation.kind) {
    case 'create':
      validateCreateMutation(mutation);
      return;
    case 'set-geometry':
      validateMutationTarget(mutation.target);
      validateAnchor(mutation.anchor);
      return;
    case 'set-metadata':
      validateMutationTarget(mutation.target);
      validateString(mutation.metadata.author, 'Annotation metadata author');
      asUtcTimestamp(mutation.metadata.modifiedAt);
      return;
    case 'set-comment':
      validateMutationTarget(mutation.target);
      validateString(mutation.comment, 'Annotation comment');
      return;
    case 'set-color':
      validateMutationTarget(mutation.target);
      validateNullableString(mutation.color, 'Annotation color');
      return;
    case 'convert-type':
      validateMutationTarget(mutation.target);
      if (!isConvertibleAnnotationType(mutation.type)) {
        throw new TypeError('An annotation conversion has an unsupported target type.');
      }
      return;
    case 'delete':
      validateMutationTarget(mutation.target);
      return;
  }
}

function validateCreateMutation(
  mutation: Extract<AnnotationMutation, { readonly kind: 'create' }>,
): void {
  asGeneratedAnnotationId(mutation.id);
  asUtcTimestamp(mutation.createdAt);
  asUtcTimestamp(mutation.modifiedAt);
  validateNullableString(mutation.color, 'Annotation color');
  validateNullableString(mutation.selectedText, 'Annotation selected text');
  validateString(mutation.author, 'Annotation author');
  validateString(mutation.comment, 'Annotation comment');
  validateAnchor(mutation.anchor);
  if (!createAnchorMatchesType(mutation.type, mutation.anchor)) {
    throw new InvalidAnnotationMutationError(
      mutation.kind,
      `${mutation.type} does not support a ${anchorDescription(mutation.anchor)} anchor.`,
    );
  }
}

function createAnchorMatchesType(type: WritableAnnotationType, anchor: AnnotationAnchor): boolean {
  const runtimeType: unknown = type;
  if (typeof runtimeType !== 'string') return false;
  if (anchor.kind === 'reflowable-text') {
    return (
      runtimeType === 'highlight' || runtimeType === 'underline' || runtimeType === 'text-note'
    );
  }
  const geometry = anchor.geometry.kind;
  if (runtimeType === 'highlight' || runtimeType === 'underline') {
    return geometry === 'quadrilaterals';
  }
  if (runtimeType === 'ink') return geometry === 'ink';
  if (runtimeType === 'text-note') return geometry === 'point';
  return runtimeType === 'free-text' && geometry === 'rectangle';
}

function anchorDescription(anchor: AnnotationAnchor): string {
  return anchor.kind === 'reflowable-text' ? anchor.kind : anchor.geometry.kind;
}

function validateMutationTarget(target: AnnotationMutationTarget): void {
  const runtimeTarget = target as {
    readonly kind?: unknown;
    readonly id?: unknown;
    readonly fingerprint?: unknown;
    readonly promoteTo?: unknown;
  };
  if (runtimeTarget.kind === 'stable') {
    asAnnotationId(runtimeTarget.id as AnnotationId);
    return;
  }
  if (runtimeTarget.kind !== 'legacy') {
    throw new TypeError('An annotation mutation target has an unsupported kind.');
  }
  if (
    typeof runtimeTarget.fingerprint !== 'string' ||
    runtimeTarget.fingerprint.trim().length === 0
  ) {
    throw new TypeError('A legacy annotation fingerprint cannot be empty.');
  }
  asGeneratedAnnotationId(runtimeTarget.promoteTo as string);
}

function validateAnchor(anchor: AnnotationAnchor): void {
  const runtimeKind = (anchor as { readonly kind?: unknown }).kind;
  if (runtimeKind === 'reflowable-text') {
    validateReflowableAnchor(
      anchor as Extract<AnnotationAnchor, { readonly kind: 'reflowable-text' }>,
    );
    return;
  }
  if (runtimeKind !== 'fixed-page') {
    throw new TypeError('An annotation anchor has an unsupported kind.');
  }
  const fixed = anchor as Extract<AnnotationAnchor, { readonly kind: 'fixed-page' }>;
  const coordinateSpace: unknown = fixed.coordinateSpace;
  if (coordinateSpace !== 'page-points-top-left') {
    throw new TypeError('A fixed-page anchor has an unsupported coordinate space.');
  }
  if (!Number.isInteger(fixed.pageIndex) || fixed.pageIndex < 0) {
    throw new TypeError('A fixed-page anchor requires a non-negative integer page index.');
  }
  validateGeometry(fixed.geometry);
}

function validateReflowableAnchor(
  anchor: Extract<AnnotationAnchor, { readonly kind: 'reflowable-text' }>,
): void {
  const { exact, prefix, suffix } = anchor.selector;
  if (typeof exact !== 'string' || typeof prefix !== 'string' || typeof suffix !== 'string') {
    throw new TypeError('A reflowable text selector requires string fields.');
  }
  if (exact.trim().length === 0) {
    throw new TypeError('A reflowable text selector requires exact text.');
  }
  const progression = anchor.progression;
  if (
    progression !== null &&
    (!Number.isFinite(progression) || progression < 0 || progression > 1)
  ) {
    throw new TypeError('A reflowable progression must be between zero and one.');
  }
}

function validateGeometry(geometry: AnnotationGeometry): void {
  requireKnownDiscriminant(
    geometry.kind,
    ['point', 'rectangle', 'quadrilaterals', 'ink'],
    'annotation geometry',
  );
  switch (geometry.kind) {
    case 'point':
      validatePoint(geometry.point);
      return;
    case 'rectangle':
      validateRectangle(geometry.rectangle);
      return;
    case 'quadrilaterals':
      validateQuadrilaterals(geometry.quadrilaterals);
      return;
    case 'ink':
      validateInk(geometry.paths);
      return;
  }
}

function requireKnownDiscriminant(
  value: string,
  supported: readonly string[],
  subject: string,
): void {
  if (!supported.includes(value)) throw new TypeError(`${subject} has an unsupported kind.`);
}

function validateString(value: unknown, subject: string): void {
  if (typeof value !== 'string') throw new TypeError(`${subject} must be a string.`);
}

function validateNullableString(value: unknown, subject: string): void {
  if (value !== null) validateString(value, subject);
}

function isConvertibleAnnotationType(value: unknown): value is ConvertibleAnnotationType {
  return value === 'highlight' || value === 'underline';
}

function validatePoint(point: AnnotationPoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError('Annotation coordinates must be finite numbers.');
  }
}

function validateRectangle(rectangle: AnnotationRectangle): void {
  validatePoint(rectangle);
  if (
    !Number.isFinite(rectangle.width) ||
    !Number.isFinite(rectangle.height) ||
    rectangle.width < 0 ||
    rectangle.height < 0
  ) {
    throw new TypeError('Annotation rectangle dimensions must be finite and non-negative.');
  }
}

function validateQuadrilaterals(quadrilaterals: readonly AnnotationQuadrilateral[]): void {
  if (quadrilaterals.length === 0) {
    throw new TypeError('A text markup annotation requires at least one quadrilateral.');
  }
  for (const quadrilateral of quadrilaterals) {
    validatePoint(quadrilateral.bottomLeft);
    validatePoint(quadrilateral.bottomRight);
    validatePoint(quadrilateral.topLeft);
    validatePoint(quadrilateral.topRight);
  }
}

function validateInk(paths: ReadonlyArray<readonly AnnotationPoint[]>): void {
  if (paths.length === 0 || paths.some((path) => path.length === 0)) {
    throw new TypeError('An ink annotation requires at least one non-empty path.');
  }
  for (const path of paths) {
    for (const point of path) validatePoint(point);
  }
}

function identityMatches(annotation: DocumentAnnotation, reference: AnnotationIdentity): boolean {
  if (reference.kind === 'stable') {
    return annotation.identity.kind === 'stable' && annotation.identity.id === reference.id;
  }
  return (
    annotation.identity.kind === 'legacy' &&
    annotation.identity.fingerprint === reference.fingerprint
  );
}

interface RuntimeRecord {
  readonly [key: string]: unknown;
  readonly anchor?: unknown;
  readonly author?: unknown;
  readonly bottomLeft?: unknown;
  readonly bottomRight?: unknown;
  readonly color?: unknown;
  readonly comment?: unknown;
  readonly coordinateSpace?: unknown;
  readonly createdAt?: unknown;
  readonly exact?: unknown;
  readonly fingerprint?: unknown;
  readonly geometry?: unknown;
  readonly height?: unknown;
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly metadata?: unknown;
  readonly modifiedAt?: unknown;
  readonly pageIndex?: unknown;
  readonly paths?: unknown;
  readonly point?: unknown;
  readonly prefix?: unknown;
  readonly progression?: unknown;
  readonly promoteTo?: unknown;
  readonly quadrilaterals?: unknown;
  readonly rectangle?: unknown;
  readonly selectedText?: unknown;
  readonly selector?: unknown;
  readonly suffix?: unknown;
  readonly target?: unknown;
  readonly topLeft?: unknown;
  readonly topRight?: unknown;
  readonly type?: unknown;
  readonly width?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
}

function cloneMutation(source: RuntimeRecord, kind: unknown): AnnotationMutation {
  switch (kind) {
    case 'create':
      return {
        kind: 'create',
        id: source.id as GeneratedAnnotationId,
        type: source.type as WritableAnnotationType,
        anchor: cloneAnchor(source.anchor),
        color: source.color as string | null,
        selectedText: source.selectedText as string | null,
        author: source.author as string,
        createdAt: source.createdAt as UtcTimestamp,
        modifiedAt: source.modifiedAt as UtcTimestamp,
        comment: source.comment as string,
      };
    case 'set-geometry':
      return {
        kind: 'set-geometry',
        target: cloneMutationTarget(source.target),
        anchor: cloneAnchor(source.anchor),
      };
    case 'set-comment':
      return {
        kind: 'set-comment',
        target: cloneMutationTarget(source.target),
        comment: source.comment as string,
      };
    case 'set-color':
      return {
        kind: 'set-color',
        target: cloneMutationTarget(source.target),
        color: source.color as string | null,
      };
    case 'convert-type':
      return {
        kind: 'convert-type',
        target: cloneMutationTarget(source.target),
        type: source.type as ConvertibleAnnotationType,
      };
    case 'delete':
      return { kind: 'delete', target: cloneMutationTarget(source.target) };
    case 'set-metadata':
      return {
        kind: 'set-metadata',
        target: cloneMutationTarget(source.target),
        metadata: cloneMetadata(source.metadata),
      };
  }
  throw new TypeError('An annotation mutation has an unsupported kind.');
}

function cloneCapability(capability: AnnotationCapability): AnnotationCapability {
  if (capability.available) return { available: true };
  return {
    available: false,
    reason: { code: capability.reason.code, message: capability.reason.message },
  };
}

function freezeCapability(capability: AnnotationCapability): AnnotationCapability {
  return deepFreeze(capability);
}

function cloneMutationTarget(value: unknown): AnnotationMutationTarget {
  const source = requireRecord(value, 'An annotation mutation target');
  const kind = source.kind;
  if (kind === 'stable') return { kind: 'stable', id: source.id as AnnotationId };
  if (kind === 'legacy') {
    return {
      kind: 'legacy',
      fingerprint: source.fingerprint as string,
      promoteTo: source.promoteTo as GeneratedAnnotationId,
    };
  }
  throw new TypeError('An annotation mutation target has an unsupported kind.');
}

function cloneMetadata(value: unknown): AnnotationMetadataPatch {
  const source = requireRecord(value, 'Annotation metadata');
  return {
    author: source.author as string,
    modifiedAt: source.modifiedAt as UtcTimestamp,
  };
}

function cloneAnchor(value: unknown): AnnotationAnchor {
  const source = requireRecord(value, 'An annotation anchor');
  const kind = source.kind;
  if (kind === 'fixed-page') {
    return {
      kind: 'fixed-page',
      pageIndex: source.pageIndex as number,
      coordinateSpace: source.coordinateSpace as 'page-points-top-left',
      geometry: cloneGeometry(source.geometry),
    };
  }
  if (kind === 'reflowable-text') {
    const selector = requireRecord(source.selector, 'A reflowable text selector');
    return {
      kind: 'reflowable-text',
      selector: {
        exact: selector.exact as string,
        prefix: selector.prefix as string,
        suffix: selector.suffix as string,
      },
      progression: source.progression as number | null,
    };
  }
  throw new TypeError('An annotation anchor has an unsupported kind.');
}

function cloneGeometry(value: unknown): AnnotationGeometry {
  const source = requireRecord(value, 'Annotation geometry');
  switch (source.kind) {
    case 'point':
      return { kind: 'point', point: clonePoint(source.point) };
    case 'rectangle':
      return { kind: 'rectangle', rectangle: cloneRectangle(source.rectangle) };
    case 'quadrilaterals':
      return {
        kind: 'quadrilaterals',
        quadrilaterals: cloneArray(source.quadrilaterals, cloneQuadrilateral),
      };
    case 'ink':
      return {
        kind: 'ink',
        paths: cloneArray(source.paths, (path) => cloneArray(path, clonePoint)),
      };
  }
  throw new TypeError('Annotation geometry has an unsupported kind.');
}

function cloneRectangle(value: unknown): AnnotationRectangle {
  const source = requireRecord(value, 'An annotation rectangle');
  return {
    x: source.x as number,
    y: source.y as number,
    width: source.width as number,
    height: source.height as number,
  };
}

function cloneQuadrilateral(value: unknown): AnnotationQuadrilateral {
  const source = requireRecord(value, 'An annotation quadrilateral');
  return {
    bottomLeft: clonePoint(source.bottomLeft),
    bottomRight: clonePoint(source.bottomRight),
    topLeft: clonePoint(source.topLeft),
    topRight: clonePoint(source.topRight),
  };
}

function clonePoint(value: unknown): AnnotationPoint {
  const source = requireRecord(value, 'An annotation point');
  return { x: source.x as number, y: source.y as number };
}

function cloneArray<T>(value: unknown, clone: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new TypeError('Annotation collections must be arrays.');
  const length = value.length;
  const copy = new Array<T>(length);
  for (let index = 0; index < length; index += 1) copy[index] = clone(value[index]);
  return copy;
}

function requireRecord(value: unknown, subject: string): RuntimeRecord {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${subject} must be an object.`);
  }
  return value as RuntimeRecord;
}

function freezeMutation(mutation: AnnotationMutation): AnnotationMutation {
  return deepFreeze(mutation);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
