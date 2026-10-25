// Match the pinned PDF.js legacy build's declared Chromium target.
// https://github.com/mozilla/pdf.js/blob/v6.4.299/gulpfile.mjs#L93
const MINIMUM_PDF_CHROMIUM = 125;
export const MINIMUM_PDF_OBSIDIAN_INSTALLER = '1.7.4';

export class UnsupportedPdfRuntimeError extends Error {
  constructor() {
    super(
      `This PDF reader requires Chromium ${MINIMUM_PDF_CHROMIUM} or newer. ` +
        `On desktop, download and run Obsidian installer ${MINIMUM_PDF_OBSIDIAN_INSTALLER} or newer; ` +
        'an in-app update alone is not enough. ' +
        'On Android, update Android System WebView or Chrome, then restart Obsidian.',
    );
    this.name = 'UnsupportedPdfRuntimeError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// Electron exposes the actual engine version in renderers, including sandboxed ones.
// https://github.com/electron/electron/blob/v31.6.0/docs/api/process.md#processversionschrome-readonly
export function readPdfChromiumVersion(hostMetadata: unknown): string | undefined {
  const host = record(hostMetadata);
  const versions = record(record(host['process'])['versions']);
  const chrome = versions['chrome'];
  if (typeof chrome === 'string') return chrome;

  // Client Hints brands are optional; ignore arbitrary GREASE entries and ordering.
  // https://wicg.github.io/ua-client-hints/#interface
  const hints = record(record(host['navigator'])['userAgentData']);
  const brands = hints['brands'];
  if (!Array.isArray(brands)) return undefined;
  for (const candidate of brands as readonly unknown[]) {
    const entry = record(candidate);
    const brand = entry['brand'];
    const version = entry['version'];
    if ((brand === 'Chromium' || brand === 'Android WebView') && typeof version === 'string') {
      return version;
    }
  }
  return undefined;
}

export function assertPdfRuntimeCompatibility(chromiumVersion: string | undefined): void {
  const chromium = chromiumVersion === undefined ? null : /^(\d+)(?:\.\d+)*$/.exec(chromiumVersion);
  if (
    chromium !== null &&
    chromium[0] === chromiumVersion &&
    Number(chromium[1]) < MINIMUM_PDF_CHROMIUM
  ) {
    throw new UnsupportedPdfRuntimeError();
  }
}
