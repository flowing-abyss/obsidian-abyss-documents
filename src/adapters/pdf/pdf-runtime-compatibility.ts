// Match the pinned PDF.js legacy build's declared Chromium target.
// https://github.com/mozilla/pdf.js/blob/v6.4.299/gulpfile.mjs#L93
const MINIMUM_PDF_CHROMIUM = 125;
// Desktop qualification starts with Electron 43, shipped in Obsidian 1.13.4.
// Current installers remain recommended for subsequent security fixes.
// https://obsidian.md/changelog/2026-07-30-desktop-v1.13.4/
const MINIMUM_PDF_ELECTRON = 43;
export const MINIMUM_PDF_OBSIDIAN_INSTALLER = '1.13.4';

export class UnsupportedPdfRuntimeError extends Error {
  constructor(runtime: 'chromium' | 'desktop' = 'chromium') {
    super(
      runtime === 'desktop'
        ? 'This PDF reader requires a newer desktop Obsidian installer. ' +
            `Download and run Obsidian installer ${MINIMUM_PDF_OBSIDIAN_INSTALLER} or newer; ` +
            'an in-app update alone is not enough. ' +
            'Use the latest installer for security updates, then restart Obsidian.'
        : `This PDF reader requires Chromium ${MINIMUM_PDF_CHROMIUM} or newer. ` +
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

// https://github.com/electron/electron/blob/v43.1.1/docs/api/process.md#processversionselectron-readonly
export function readPdfElectronVersion(hostMetadata: unknown): string | undefined {
  const host = record(hostMetadata);
  const versions = record(record(host['process'])['versions']);
  const electron = versions['electron'];
  return typeof electron === 'string' ? electron : undefined;
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

function versionMajor(version: string | undefined): number | undefined {
  const match = version === undefined ? null : /^(\d+)(?:\.\d+)*$/.exec(version);
  return match !== null && match[0] === version ? Number(match[1]) : undefined;
}

export function assertPdfRuntimeCompatibility(
  chromiumVersion: string | undefined,
  electronVersion?: string,
): void {
  const electronMajor = versionMajor(electronVersion);
  if (electronMajor !== undefined && electronMajor < MINIMUM_PDF_ELECTRON) {
    throw new UnsupportedPdfRuntimeError('desktop');
  }
  const chromiumMajor = versionMajor(chromiumVersion);
  if (chromiumMajor !== undefined && chromiumMajor < MINIMUM_PDF_CHROMIUM) {
    throw new UnsupportedPdfRuntimeError();
  }
}
