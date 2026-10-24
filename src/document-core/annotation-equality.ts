import type {
  AnnotationAnchor,
  AnnotationCapabilities,
  AnnotationCapability,
  AnnotationGeometry,
  AnnotationIdentity,
  AnnotationPoint,
  AnnotationQuadrilateral,
  AnnotationRectangle,
  DocumentAnnotation,
} from './annotations.js';

export function annotationsEqual(left: DocumentAnnotation, right: DocumentAnnotation): boolean {
  return (
    left === right ||
    (annotationValuesEqual(left, right) &&
      identitiesEqual(left.identity, right.identity) &&
      anchorsEqual(left.anchor, right.anchor) &&
      arraysEqual(left.tags, right.tags, stringsEqual) &&
      arraysEqual(left.links, right.links, stringsEqual) &&
      capabilitiesEqual(left.capabilities, right.capabilities))
  );
}

function annotationValuesEqual(left: DocumentAnnotation, right: DocumentAnnotation): boolean {
  return (
    left.type === right.type &&
    left.externalType === right.externalType &&
    left.color === right.color &&
    left.selectedText === right.selectedText &&
    left.author === right.author &&
    left.createdAt === right.createdAt &&
    left.modifiedAt === right.modifiedAt &&
    left.comment === right.comment
  );
}

function identitiesEqual(left: AnnotationIdentity, right: AnnotationIdentity): boolean {
  if (left === right) return true;
  switch (left.kind) {
    case 'stable':
      return right.kind === 'stable' && left.id === right.id;
    case 'legacy':
      return right.kind === 'legacy' && left.fingerprint === right.fingerprint;
  }
}

function anchorsEqual(left: AnnotationAnchor, right: AnnotationAnchor): boolean {
  if (left === right) return true;
  switch (left.kind) {
    case 'fixed-page':
      return (
        right.kind === 'fixed-page' &&
        left.pageIndex === right.pageIndex &&
        stringsEqual(left.coordinateSpace, right.coordinateSpace) &&
        geometriesEqual(left.geometry, right.geometry)
      );
    case 'reflowable-text':
      return (
        right.kind === 'reflowable-text' &&
        left.progression === right.progression &&
        selectorsEqual(left.selector, right.selector)
      );
  }
}

function selectorsEqual(
  left: Extract<AnnotationAnchor, { kind: 'reflowable-text' }>['selector'],
  right: Extract<AnnotationAnchor, { kind: 'reflowable-text' }>['selector'],
): boolean {
  return (
    left === right ||
    (left.exact === right.exact && left.prefix === right.prefix && left.suffix === right.suffix)
  );
}

function geometriesEqual(left: AnnotationGeometry, right: AnnotationGeometry): boolean {
  if (left === right) return true;
  switch (left.kind) {
    case 'point':
      return right.kind === 'point' && pointsEqual(left.point, right.point);
    case 'rectangle':
      return right.kind === 'rectangle' && rectanglesEqual(left.rectangle, right.rectangle);
    case 'quadrilaterals':
      return (
        right.kind === 'quadrilaterals' &&
        arraysEqual(left.quadrilaterals, right.quadrilaterals, quadrilateralsEqual)
      );
    case 'ink':
      return right.kind === 'ink' && arraysEqual(left.paths, right.paths, pathsEqual);
  }
}

function pointsEqual(left: AnnotationPoint, right: AnnotationPoint): boolean {
  return left === right || (left.x === right.x && left.y === right.y);
}

function rectanglesEqual(left: AnnotationRectangle, right: AnnotationRectangle): boolean {
  return (
    left === right ||
    (pointsEqual(left, right) && left.width === right.width && left.height === right.height)
  );
}

function quadrilateralsEqual(
  left: AnnotationQuadrilateral,
  right: AnnotationQuadrilateral,
): boolean {
  return (
    pointsEqual(left.topLeft, right.topLeft) &&
    pointsEqual(left.topRight, right.topRight) &&
    pointsEqual(left.bottomLeft, right.bottomLeft) &&
    pointsEqual(left.bottomRight, right.bottomRight)
  );
}

function pathsEqual(left: readonly AnnotationPoint[], right: readonly AnnotationPoint[]): boolean {
  return arraysEqual(left, right, pointsEqual);
}

function stringsEqual(left: string, right: string): boolean {
  return left === right;
}

function arraysEqual<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (left: T, right: T) => boolean,
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (
      leftValue !== rightValue &&
      (leftValue === undefined || rightValue === undefined || !equal(leftValue, rightValue))
    )
      return false;
  }
  return true;
}

function capabilitiesEqual(left: AnnotationCapabilities, right: AnnotationCapabilities): boolean {
  return (
    left === right ||
    (capabilityEqual(left.geometry, right.geometry) &&
      capabilityEqual(left.comment, right.comment) &&
      capabilityEqual(left.color, right.color) &&
      capabilityEqual(left.deletion, right.deletion) &&
      capabilityEqual(left.metadata, right.metadata) &&
      conversionsEqual(left.conversions, right.conversions))
  );
}

function conversionsEqual(
  left: AnnotationCapabilities['conversions'],
  right: AnnotationCapabilities['conversions'],
): boolean {
  return (
    left === right ||
    (capabilityEqual(left.highlight, right.highlight) &&
      capabilityEqual(left.underline, right.underline))
  );
}

function capabilityEqual(left: AnnotationCapability, right: AnnotationCapability): boolean {
  if (left === right) return true;
  if (left.available) return right.available;
  return (
    !right.available &&
    left.reason.code === right.reason.code &&
    left.reason.message === right.reason.message
  );
}
