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
  if (value.trim().length === 0) throw new TypeError('An annotation id cannot be empty.');
  return value as AnnotationId;
}

export function asGeneratedAnnotationId(value: string): GeneratedAnnotationId {
  if (!UUID_PATTERN.test(value)) throw new TypeError('A generated annotation id must be a UUID.');
  return value as GeneratedAnnotationId;
}

export function asUtcTimestamp(value: string): UtcTimestamp {
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
  return freezeMutation(cloneMutation(mutation));
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

function cloneMutation(mutation: AnnotationMutation): AnnotationMutation {
  switch (mutation.kind) {
    case 'create':
      return { ...mutation, anchor: cloneAnchor(mutation.anchor) };
    case 'set-geometry':
      return {
        kind: 'set-geometry',
        target: cloneMutationTarget(mutation.target),
        anchor: cloneAnchor(mutation.anchor),
      };
    case 'set-comment':
      return { ...mutation, target: cloneMutationTarget(mutation.target) };
    case 'set-color':
      return { ...mutation, target: cloneMutationTarget(mutation.target) };
    case 'convert-type':
      return { ...mutation, target: cloneMutationTarget(mutation.target) };
    case 'delete':
      return { ...mutation, target: cloneMutationTarget(mutation.target) };
    case 'set-metadata':
      return {
        ...mutation,
        target: cloneMutationTarget(mutation.target),
        metadata: { ...mutation.metadata },
      };
  }
}

function cloneCapability(capability: AnnotationCapability): AnnotationCapability {
  if (capability.available) return { available: true };
  return { available: false, reason: { ...capability.reason } };
}

function freezeCapability(capability: AnnotationCapability): AnnotationCapability {
  return deepFreeze(capability);
}

function cloneMutationTarget(target: AnnotationMutationTarget): AnnotationMutationTarget {
  return { ...target };
}

function cloneAnchor(anchor: AnnotationAnchor): AnnotationAnchor {
  if (anchor.kind === 'fixed-page') {
    return { ...anchor, geometry: cloneGeometry(anchor.geometry) };
  }
  return { ...anchor, selector: { ...anchor.selector } };
}

function cloneGeometry(geometry: AnnotationGeometry): AnnotationGeometry {
  switch (geometry.kind) {
    case 'point':
      return { kind: 'point', point: { ...geometry.point } };
    case 'rectangle':
      return { kind: 'rectangle', rectangle: { ...geometry.rectangle } };
    case 'quadrilaterals':
      return {
        kind: 'quadrilaterals',
        quadrilaterals: geometry.quadrilaterals.map((quad) => ({
          bottomLeft: { ...quad.bottomLeft },
          bottomRight: { ...quad.bottomRight },
          topLeft: { ...quad.topLeft },
          topRight: { ...quad.topRight },
        })),
      };
    case 'ink':
      return {
        kind: 'ink',
        paths: geometry.paths.map((path) => path.map((point) => ({ ...point }))),
      };
  }
}

function freezeMutation(mutation: AnnotationMutation): AnnotationMutation {
  return deepFreeze(mutation);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
