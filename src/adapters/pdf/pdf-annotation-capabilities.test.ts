import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import {
  loadPdfAnnotationCapabilities,
  type PdfAnnotationCapabilityReasonCode,
} from './pdf-annotation-capabilities.js';

const MODIFY_CONTENTS = 0x08;

function pdf(
  options: {
    readonly isPureXfa?: boolean;
    readonly permissions?: readonly number[] | null;
    readonly signatures?: readonly object[] | null;
  } = {},
): PDFDocumentProxy {
  return {
    isPureXfa: options.isPureXfa ?? false,
    getPermissions: vi.fn(async () => options.permissions ?? null),
    getSignatures: vi.fn(async () => options.signatures ?? null),
  } as unknown as PDFDocumentProxy;
}

function unavailableCode(value: {
  readonly available: boolean;
  readonly reason?: { readonly code: PdfAnnotationCapabilityReasonCode };
}): PdfAnnotationCapabilityReasonCode | null {
  return value.available ? null : (value.reason?.code ?? null);
}

describe('loadPdfAnnotationCapabilities', () => {
  it('exposes only the three annotation types backed by native PDF.js writers', async () => {
    const capabilities = await loadPdfAnnotationCapabilities(pdf(), { MODIFY_CONTENTS });

    expect(capabilities.readOnlyReason).toBeNull();
    expect(capabilities.editing).toEqual({
      mutation: { available: true },
      create: {
        highlight: { available: true },
        ink: { available: true },
        'free-text': { available: true },
        underline: {
          available: false,
          reason: {
            code: 'unsupported-annotation',
            message: 'PDF.js cannot create this annotation type.',
          },
        },
        'text-note': {
          available: false,
          reason: {
            code: 'unsupported-annotation',
            message: 'PDF.js cannot create this annotation type.',
          },
        },
      },
    });
    expect(
      Object.fromEntries(
        Object.entries(capabilities.types).map(([type, value]) => [
          type,
          {
            visible: value.visible,
            indexable: value.indexable,
            create: unavailableCode(value.create),
            edit: unavailableCode(value.edit),
            convert: unavailableCode(value.convert),
          },
        ]),
      ),
    ).toEqual({
      highlight: {
        visible: true,
        indexable: true,
        create: null,
        edit: null,
        convert: 'engine-unsupported',
      },
      ink: {
        visible: true,
        indexable: true,
        create: null,
        edit: null,
        convert: 'engine-unsupported',
      },
      'free-text': {
        visible: true,
        indexable: true,
        create: null,
        edit: null,
        convert: 'engine-unsupported',
      },
      underline: {
        visible: true,
        indexable: true,
        create: 'engine-unsupported',
        edit: 'engine-unsupported',
        convert: 'engine-unsupported',
      },
      'text-note': {
        visible: true,
        indexable: true,
        create: 'engine-unsupported',
        edit: 'engine-unsupported',
        convert: 'engine-unsupported',
      },
    });
  });

  it.each([
    {
      label: 'pure XFA',
      document: pdf({ isPureXfa: true }),
      code: 'pure-xfa',
    },
    {
      label: 'a signed document',
      document: pdf({ signatures: [{ signerName: 'Example signer' }] }),
      code: 'signed-document',
    },
    {
      label: 'restricted permissions',
      document: pdf({ permissions: [0x04, 0x10] }),
      code: 'permission-restricted',
    },
  ] as const)('marks every native writer read-only for $label', async ({ document, code }) => {
    const capabilities = await loadPdfAnnotationCapabilities(document, { MODIFY_CONTENTS });

    expect(capabilities.readOnlyReason?.code).toBe(code);
    expect(capabilities.editing.mutation).toMatchObject({
      available: false,
      reason: { code },
    });
    for (const type of ['highlight', 'ink', 'free-text'] as const) {
      expect(unavailableCode(capabilities.types[type].create)).toBe(code);
      expect(unavailableCode(capabilities.types[type].edit)).toBe(code);
    }
    expect(capabilities.types.underline.visible).toBe(true);
    expect(capabilities.types['text-note'].indexable).toBe(true);
  });

  it('uses unrestricted PDF.js permissions when the document has no permission set', async () => {
    const capabilities = await loadPdfAnnotationCapabilities(pdf(), { MODIFY_CONTENTS });

    expect(capabilities.types.highlight.create).toEqual({ available: true });
  });
});
