import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import type {
  AnnotationCapability,
  AnnotationUnavailableReason,
} from '../../document-core/annotations.js';
import type { DocumentEditingCapabilities } from '../../document-core/editable-document.js';

export type PdfAnnotationCapabilityReasonCode =
  'engine-unsupported' | 'permission-restricted' | 'pure-xfa' | 'signed-document';

interface PdfAnnotationCapabilityReason {
  readonly code: PdfAnnotationCapabilityReasonCode;
  readonly message: string;
}

type PdfDocumentReadOnlyReason = PdfAnnotationCapabilityReason & {
  readonly code: Exclude<PdfAnnotationCapabilityReasonCode, 'engine-unsupported'>;
};

type PdfAnnotationCapability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: PdfAnnotationCapabilityReason };

type PdfAnnotationType = 'highlight' | 'ink' | 'free-text' | 'underline' | 'text-note';

interface PdfAnnotationTypeCapabilities {
  readonly visible: true;
  readonly indexable: true;
  readonly create: PdfAnnotationCapability;
  readonly edit: PdfAnnotationCapability;
  readonly convert: PdfAnnotationCapability;
}

export interface PdfAnnotationCapabilities {
  readonly editing: DocumentEditingCapabilities;
  readonly readOnlyReason: PdfDocumentReadOnlyReason | null;
  readonly types: Readonly<Record<PdfAnnotationType, PdfAnnotationTypeCapabilities>>;
}

interface PermissionFlags {
  readonly MODIFY_CONTENTS: number;
}

const AVAILABLE: PdfAnnotationCapability = Object.freeze({ available: true });
const CORE_AVAILABLE: AnnotationCapability = Object.freeze({ available: true });
const CORE_UNSUPPORTED_CREATE: AnnotationCapability = Object.freeze({
  available: false,
  reason: Object.freeze({
    code: 'unsupported-annotation',
    message: 'PDF.js cannot create this annotation type.',
  }),
});
const ENGINE_UNSUPPORTED = unavailable(
  'engine-unsupported',
  'PDF.js cannot create, edit, or convert this annotation type.',
);

export async function loadPdfAnnotationCapabilities(
  pdf: PDFDocumentProxy,
  permissionFlags: PermissionFlags,
): Promise<PdfAnnotationCapabilities> {
  const [permissions, signatures] = await Promise.all([pdf.getPermissions(), pdf.getSignatures()]);
  const readOnlyReason = documentReadOnlyReason(
    pdf.isPureXfa,
    permissions,
    signatures,
    permissionFlags,
  );
  const native = readOnlyReason === null ? AVAILABLE : unavailableFrom(readOnlyReason);
  const coreNative = readOnlyReason === null ? CORE_AVAILABLE : coreUnavailableFrom(readOnlyReason);

  return Object.freeze({
    editing: Object.freeze({
      mutation: coreNative,
      create: Object.freeze({
        highlight: coreNative,
        ink: coreNative,
        'free-text': coreNative,
        underline: CORE_UNSUPPORTED_CREATE,
        'text-note': CORE_UNSUPPORTED_CREATE,
      }),
    }),
    readOnlyReason,
    types: Object.freeze({
      highlight: nativeCapabilities(native),
      ink: nativeCapabilities(native),
      'free-text': nativeCapabilities(native),
      underline: unsupportedCapabilities(),
      'text-note': unsupportedCapabilities(),
    }),
  });
}

function documentReadOnlyReason(
  isPureXfa: boolean,
  permissions: readonly number[] | null,
  signatures: readonly object[] | null,
  permissionFlags: PermissionFlags,
): PdfDocumentReadOnlyReason | null {
  if (isPureXfa) {
    return documentReason(
      'pure-xfa',
      'PDF.js does not support annotation editing in pure XFA documents.',
    );
  }
  if (signatures !== null && signatures.length > 0) {
    return documentReason(
      'signed-document',
      'Signed PDF documents are opened read-only to preserve signatures.',
    );
  }
  if (permissions !== null && !permissions.includes(permissionFlags.MODIFY_CONTENTS)) {
    return documentReason(
      'permission-restricted',
      'This PDF does not grant permission to modify its contents.',
    );
  }
  return null;
}

function nativeCapabilities(write: PdfAnnotationCapability): PdfAnnotationTypeCapabilities {
  return Object.freeze({
    visible: true,
    indexable: true,
    create: write,
    edit: write,
    convert: ENGINE_UNSUPPORTED,
  });
}

function unsupportedCapabilities(): PdfAnnotationTypeCapabilities {
  return Object.freeze({
    visible: true,
    indexable: true,
    create: ENGINE_UNSUPPORTED,
    edit: ENGINE_UNSUPPORTED,
    convert: ENGINE_UNSUPPORTED,
  });
}

function reason(
  code: PdfAnnotationCapabilityReasonCode,
  message: string,
): PdfAnnotationCapabilityReason {
  return Object.freeze({ code, message });
}

function documentReason(
  code: PdfDocumentReadOnlyReason['code'],
  message: string,
): PdfDocumentReadOnlyReason {
  return Object.freeze({ code, message });
}

function unavailable(
  code: PdfAnnotationCapabilityReasonCode,
  message: string,
): PdfAnnotationCapability {
  return Object.freeze({ available: false, reason: reason(code, message) });
}

function unavailableFrom(value: PdfAnnotationCapabilityReason): PdfAnnotationCapability {
  return Object.freeze({ available: false, reason: value });
}

function coreUnavailableFrom(value: PdfDocumentReadOnlyReason): AnnotationCapability {
  const reason: AnnotationUnavailableReason = Object.freeze({
    code: value.code,
    message: value.message,
  });
  return Object.freeze({ available: false, reason });
}
