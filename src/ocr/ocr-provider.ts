declare const OCR_LANGUAGE_ID: unique symbol;

export type OcrLanguageId = string & { readonly [OCR_LANGUAGE_ID]: true };
export type OcrPlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';
export type OcrScope = 'page' | 'document';
export type OcrProgressPhase = 'loading' | 'recognizing' | 'writing' | 'verifying';

export interface OcrProgress {
  readonly phase: OcrProgressPhase;
  readonly completed: number;
  readonly total: number;
}

export interface OcrCapabilities {
  readonly available: boolean;
  readonly platform: OcrPlatform;
  readonly scopes: { readonly page: boolean; readonly document: boolean };
  readonly languages: readonly OcrLanguageId[];
  readonly replacement: {
    readonly sameFile: boolean;
    readonly preservesAnnotations: boolean;
    readonly atomic: boolean;
  };
}

export interface OcrRecognitionRequest {
  readonly pdf: Uint8Array;
  readonly languages: readonly OcrLanguageId[];
  readonly signal: AbortSignal;
  readonly onProgress: (progress: OcrProgress) => void;
}

export interface OcrPageRecognitionRequest extends OcrRecognitionRequest {
  readonly pageIndex: number;
}

export interface OcrRecognitionResult {
  readonly bytes: Uint8Array;
  readonly languages: readonly OcrLanguageId[];
}

export interface OcrProvider {
  capabilities(): OcrCapabilities | Promise<OcrCapabilities>;
  recognizePage(request: OcrPageRecognitionRequest): Promise<OcrRecognitionResult>;
  recognizeDocument(request: OcrRecognitionRequest): Promise<OcrRecognitionResult>;
}

export interface OcrDocumentSafety {
  readonly signed: boolean;
  readonly encrypted: boolean;
  readonly allowsModification: boolean;
}

export interface OcrCapabilityRequest {
  readonly scope: OcrScope;
  readonly languages: readonly OcrLanguageId[];
  readonly document: OcrDocumentSafety;
  readonly signal?: AbortSignal;
}

export type OcrContractErrorCode =
  | 'cancelled'
  | 'provider-unavailable'
  | 'scope-unavailable'
  | 'language-unavailable'
  | 'signed-document'
  | 'encrypted-document'
  | 'permission-denied'
  | 'unsafe-replacement';

export class OcrContractError extends Error {
  constructor(
    readonly code: OcrContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OcrContractError';
  }
}

export function createOcrLanguageId(value: string): OcrLanguageId {
  const normalized = value.toLowerCase();
  if (
    normalized.length < 2 ||
    normalized.length > 35 ||
    !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u.test(normalized)
  )
    throw new TypeError('An OCR language id must be a non-empty BCP-47 or engine language id.');
  return normalized as OcrLanguageId;
}

export function assertOcrRequestSupported(
  capabilities: OcrCapabilities,
  request: OcrCapabilityRequest,
): void {
  if (request.signal?.aborted === true)
    throw new OcrContractError('cancelled', 'OCR was cancelled.');
  if (!capabilities.available)
    throw new OcrContractError('provider-unavailable', 'Local OCR is unavailable.');
  if (!capabilities.scopes[request.scope])
    throw new OcrContractError('scope-unavailable', `OCR does not support ${request.scope} mode.`);
  assertLanguagesSupported(capabilities.languages, request.languages);
  assertDocumentEligible(request.document);
  assertReplacementSafe(capabilities.replacement);
}

function assertLanguagesSupported(
  supportedLanguages: readonly OcrLanguageId[],
  requestedLanguages: readonly OcrLanguageId[],
): void {
  const supported = new Set(supportedLanguages);
  if (requestedLanguages.length === 0 || requestedLanguages.some((id) => !supported.has(id)))
    throw new OcrContractError('language-unavailable', 'A requested OCR language is unavailable.');
}

function assertDocumentEligible(document: OcrDocumentSafety): void {
  if (document.signed)
    throw new OcrContractError('signed-document', 'OCR cannot replace a signed PDF.');
  if (document.encrypted)
    throw new OcrContractError('encrypted-document', 'OCR cannot replace an encrypted PDF.');
  if (!document.allowsModification)
    throw new OcrContractError('permission-denied', 'This PDF does not permit modification.');
}

function assertReplacementSafe(replacement: OcrCapabilities['replacement']): void {
  if (!replacement.sameFile || !replacement.preservesAnnotations || !replacement.atomic)
    throw new OcrContractError(
      'unsafe-replacement',
      'The OCR provider cannot safely replace this PDF while preserving annotations.',
    );
}
