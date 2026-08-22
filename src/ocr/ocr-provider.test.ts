import { describe, expect, it, vi } from 'vitest';
import {
  assertOcrRequestSupported,
  createOcrLanguageId,
  type OcrCapabilities,
  OcrContractError,
  type OcrContractErrorCode,
  type OcrDocumentSafety,
  type OcrPageRecognitionRequest,
  type OcrPlatform,
  type OcrProgress,
  type OcrProgressPhase,
  type OcrProvider,
  type OcrRecognitionRequest,
  type OcrRecognitionResult,
  type OcrScope,
} from './ocr-provider.js';

const platform: OcrPlatform = 'android';
const capabilities: OcrCapabilities = {
  available: true,
  platform,
  scopes: { page: true, document: true },
  languages: [createOcrLanguageId('eng'), createOcrLanguageId('rus')],
  replacement: { sameFile: true, preservesAnnotations: true, atomic: true },
};

describe('local OCR provider contract', () => {
  it('carries languages, progress, cancellation, and page/document request shapes', async () => {
    const progress: OcrProgress[] = [];
    const provider = {
      capabilities: () => capabilities,
      recognizePage: vi.fn(
        async (request: OcrPageRecognitionRequest): Promise<OcrRecognitionResult> => {
          request.onProgress({ phase: 'recognizing', completed: 1, total: 1 });
          return { bytes: new Uint8Array([1]), languages: request.languages };
        },
      ),
      recognizeDocument: vi.fn(
        async (request: OcrRecognitionRequest): Promise<OcrRecognitionResult> => {
          request.onProgress({ phase: 'writing', completed: 2, total: 2 });
          return { bytes: new Uint8Array([2]), languages: request.languages };
        },
      ),
    } satisfies OcrProvider;
    const signal = new AbortController().signal;
    await provider.recognizePage({
      pdf: new Uint8Array(),
      pageIndex: 0,
      languages: [createOcrLanguageId('eng')],
      signal,
      onProgress: (value: OcrProgress) => {
        progress.push(value);
      },
    });
    await provider.recognizeDocument({
      pdf: new Uint8Array(),
      languages: [createOcrLanguageId('rus')],
      signal,
      onProgress: (value: OcrProgress) => {
        progress.push(value);
      },
    });
    expect(progress).toEqual([
      { phase: 'recognizing', completed: 1, total: 1 },
      { phase: 'writing', completed: 2, total: 2 },
    ]);
    expect(progress.map(({ phase }): OcrProgressPhase => phase)).toEqual([
      'recognizing',
      'writing',
    ]);
  });

  it('rejects unavailable scopes, languages, signatures, permissions, encryption, and unsafe replacement', () => {
    const scope: OcrScope = 'document';
    const document: OcrDocumentSafety = {
      signed: false,
      encrypted: false,
      allowsModification: true,
    };
    const safe = {
      scope,
      languages: [createOcrLanguageId('eng')],
      document,
    };
    expect(() => {
      assertOcrRequestSupported(capabilities, safe);
    }).not.toThrow();
    expect(() => {
      assertOcrRequestSupported(capabilities, {
        ...safe,
        document: { ...safe.document, signed: true },
      });
    }).toThrow(expect.objectContaining({ code: 'signed-document' }));
    expect(() => {
      assertOcrRequestSupported(capabilities, {
        ...safe,
        document: { ...safe.document, encrypted: true },
      });
    }).toThrow(expect.objectContaining({ code: 'encrypted-document' }));
    expect(() => {
      assertOcrRequestSupported(capabilities, {
        ...safe,
        document: { ...safe.document, allowsModification: false },
      });
    }).toThrow(expect.objectContaining({ code: 'permission-denied' }));
    expect(() => {
      assertOcrRequestSupported(capabilities, {
        ...safe,
        languages: [createOcrLanguageId('deu')],
      });
    }).toThrow(expect.objectContaining({ code: 'language-unavailable' }));
    expect(() => {
      assertOcrRequestSupported(
        {
          ...capabilities,
          replacement: { sameFile: true, preservesAnnotations: false, atomic: true },
        },
        safe,
      );
    }).toThrow(expect.objectContaining({ code: 'unsafe-replacement' }));
    const deniedCapabilities: ReadonlyArray<
      readonly [OcrCapabilities, OcrScope, OcrContractErrorCode]
    > = [
      [{ ...capabilities, available: false }, 'document', 'provider-unavailable'],
      [{ ...capabilities, scopes: { page: false, document: true } }, 'page', 'scope-unavailable'],
      [
        { ...capabilities, scopes: { page: true, document: false } },
        'document',
        'scope-unavailable',
      ],
      [
        {
          ...capabilities,
          replacement: { sameFile: false, preservesAnnotations: true, atomic: true },
        },
        'document',
        'unsafe-replacement',
      ],
      [
        {
          ...capabilities,
          replacement: { sameFile: true, preservesAnnotations: true, atomic: false },
        },
        'document',
        'unsafe-replacement',
      ],
    ];
    for (const [denied, deniedScope, code] of deniedCapabilities) {
      expect(() => {
        assertOcrRequestSupported(denied, { ...safe, scope: deniedScope });
      }).toThrow(expect.objectContaining({ code }));
    }
  });

  it('uses typed cancellation and validates language ids', () => {
    expect([
      createOcrLanguageId('pt-BR'),
      createOcrLanguageId('chi_sim'),
      createOcrLanguageId('srp_latn'),
    ]).toEqual(['pt-br', 'chi_sim', 'srp_latn']);
    for (const invalid of [
      '',
      'en us',
      ' eng ',
      '../eng',
      'eng/path',
      'eng\\path',
      'eng\u0000sim',
      '_eng',
      'eng__sim',
      'eng-',
    ]) {
      expect(() => {
        createOcrLanguageId(invalid);
      }).toThrow(TypeError);
    }
    const abort = new AbortController();
    abort.abort();
    let failure: unknown;
    try {
      assertOcrRequestSupported(capabilities, {
        scope: 'page',
        languages: [createOcrLanguageId('eng')],
        document: { signed: false, encrypted: false, allowsModification: true },
        signal: abort.signal,
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(OcrContractError);
    if (!(failure instanceof OcrContractError)) throw new Error('Expected OCR contract error.');
    const code: OcrContractErrorCode = failure.code;
    expect(code).toBe('cancelled');
  });
});
