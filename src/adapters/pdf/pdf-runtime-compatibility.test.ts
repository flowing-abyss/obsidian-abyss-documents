import { describe, expect, it } from 'vitest';
import {
  assertPdfRuntimeCompatibility,
  readPdfChromiumVersion,
  readPdfElectronVersion,
  UnsupportedPdfRuntimeError,
} from './pdf-runtime-compatibility.js';

describe('readPdfElectronVersion', () => {
  it('reads the desktop Electron version independently of its Chromium version', () => {
    expect(
      readPdfElectronVersion({
        process: { versions: { electron: '43.1.1', chrome: '150.0.7871.114' } },
      }),
    ).toBe('43.1.1');
  });

  it.each([
    undefined,
    null,
    {},
    { process: null },
    { process: { versions: null } },
    { process: { versions: { electron: 43 } } },
    { process: { versions: { chrome: '150.0.7871.114' } } },
    { navigator: { userAgentData: { brands: [{ brand: 'Chromium', version: '130' }] } } },
  ])('does not invent an Electron version from other or malformed metadata: %j', (metadata) => {
    expect(readPdfElectronVersion(metadata)).toBeUndefined();
  });
});

describe('readPdfChromiumVersion', () => {
  it.each([
    ['120.0.6099.291', '150'],
    ['126.0.6478.185', '120'],
  ])('prefers Electron engine metadata %s over client hints %s', (electron, hint) => {
    expect(
      readPdfChromiumVersion({
        process: { versions: { chrome: electron } },
        navigator: { userAgentData: { brands: [{ brand: 'Chromium', version: hint }] } },
      }),
    ).toBe(electron);
  });

  it.each(['Chromium', 'Android WebView'])(
    'reads the known %s brand while ignoring GREASE',
    (brand) => {
      expect(
        readPdfChromiumVersion({
          process: { versions: { node: '26.0.0' } },
          navigator: {
            userAgentData: {
              brands: [
                { brand: 'Not A;Brand', version: '8' },
                { brand, version: '124' },
              ],
            },
          },
        }),
      ).toBe('124');
    },
  );

  it('does not depend on the position of a known brand', () => {
    expect(
      readPdfChromiumVersion({
        navigator: {
          userAgentData: {
            brands: [
              { brand: 'Chromium', version: '125' },
              { brand: 'Not A;Brand', version: '8' },
            ],
          },
        },
      }),
    ).toBe('125');
  });

  it.each([
    undefined,
    null,
    42,
    {},
    { process: null },
    { process: { versions: null } },
    { process: { versions: { chrome: 120 } } },
    { navigator: {} },
    { navigator: { userAgentData: { brands: '120' } } },
    {
      navigator: {
        userAgentData: { brands: [null, { brand: 'Chromium', version: 120 }] },
      },
    },
    {
      navigator: {
        userAgentData: {
          brands: [
            { brand: 'Not A;Brand', version: '8' },
            { brand: 'Safari', version: '18' },
          ],
        },
      },
    },
  ])('leaves absent, unknown, or malformed host metadata unchanged: %j', (metadata) => {
    const version = readPdfChromiumVersion(metadata);

    expect(version).toBeUndefined();
    expect(() => {
      assertPdfRuntimeCompatibility(version);
    }).not.toThrow();
  });
});

describe('assertPdfRuntimeCompatibility', () => {
  it.each(['31.6.0', '39.8.3', '42.11.18'])(
    'rejects an older desktop Electron even when Chromium is recent: %s',
    (electronVersion) => {
      expect(() => {
        assertPdfRuntimeCompatibility('150.0.7871.250', electronVersion);
      }).toThrow(UnsupportedPdfRuntimeError);
    },
  );

  it('gives desktop recovery guidance when Chromium itself meets the PDF.js floor', () => {
    expect(() => {
      assertPdfRuntimeCompatibility('126.0.6478.234', '31.6.0');
    }).toThrow(/desktop Obsidian installer/);
    expect(() => {
      assertPdfRuntimeCompatibility('126.0.6478.234', '31.6.0');
    }).toThrow(/installer 1\.13\.4/);
    let failure: unknown;
    try {
      assertPdfRuntimeCompatibility('126.0.6478.234', '31.6.0');
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(UnsupportedPdfRuntimeError);
    expect(failure instanceof Error ? failure.message : '').not.toContain('Chromium 125');
  });

  it.each(['43.1.1', '44.0.0', '45.0.0'])(
    'accepts a supported desktop Electron major: %s',
    (electronVersion) => {
      expect(() => {
        assertPdfRuntimeCompatibility('150.0.7871.250', electronVersion);
      }).not.toThrow();
    },
  );

  it('rejects an older desktop Electron when Chromium metadata is unavailable', () => {
    expect(() => {
      assertPdfRuntimeCompatibility(undefined, '42.11.18');
    }).toThrow(UnsupportedPdfRuntimeError);
  });

  it.each([undefined, '', 'unknown', '42 beta', '42.', '42\n'])(
    'leaves unknown or malformed Electron metadata unchanged: %s',
    (electronVersion) => {
      expect(() => {
        assertPdfRuntimeCompatibility('130.0.6723.91', electronVersion);
      }).not.toThrow();
    },
  );

  it('retains the Chromium floor when Electron metadata is supported', () => {
    expect(() => {
      assertPdfRuntimeCompatibility('124.0.6367.207', '43.1.1');
    }).toThrow(/Chromium 125/);
  });

  it.each(['120', '120.0.6099.291', '124', '124.0.6367.207'])(
    'rejects a known unsupported Chromium version: %s',
    (version) => {
      expect(() => {
        assertPdfRuntimeCompatibility(version);
      }).toThrow(UnsupportedPdfRuntimeError);
    },
  );

  it.each(['125', '125.0.6422.76', '126.0.6478.185', '150.0.7871.250'])(
    'allows a Chromium version at or above the supported floor: %s',
    (version) => {
      expect(() => {
        assertPdfRuntimeCompatibility(version);
      }).not.toThrow();
    },
  );

  it.each([undefined, '', 'unknown', '124unsupported', '124 beta', '-120', '120.', '120\n'])(
    'leaves unknown or malformed version metadata unchanged: %s',
    (version) => {
      expect(() => {
        assertPdfRuntimeCompatibility(version);
      }).not.toThrow();
    },
  );

  it('explains the desktop installer and Android WebView recovery actions', () => {
    const failure = new UnsupportedPdfRuntimeError();

    expect(failure.name).toBe('UnsupportedPdfRuntimeError');
    expect(failure.message).toContain('Chromium 125');
    expect(failure.message).toContain('installer 1.13.4');
    expect(failure.message).toMatch(/in-app update.*not enough/i);
    expect(failure.message).toContain('Android System WebView');
    expect(failure.message).toContain('restart Obsidian');
  });
});
