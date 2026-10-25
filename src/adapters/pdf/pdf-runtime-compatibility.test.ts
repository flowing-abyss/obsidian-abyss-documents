import { describe, expect, it } from 'vitest';
import {
  assertPdfRuntimeCompatibility,
  readPdfChromiumVersion,
  UnsupportedPdfRuntimeError,
} from './pdf-runtime-compatibility.js';

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
    expect(failure.message).toContain('installer 1.7.4');
    expect(failure.message).toMatch(/in-app update.*not enough/i);
    expect(failure.message).toContain('Android System WebView');
    expect(failure.message).toContain('restart Obsidian');
  });
});
