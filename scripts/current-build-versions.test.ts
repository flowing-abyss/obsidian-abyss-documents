import { describe, expect, it } from 'vitest';
import { parseCurrentBuildVersions } from './current-build-versions.mjs';

describe('current benchmark build versions', () => {
  it('ties evidence to the manifest plugin and runtime PDF.js versions', () => {
    expect(
      parseCurrentBuildVersions(
        { version: '0.1.0' },
        { dependencies: { 'pdfjs-dist': '6.2.108' }, version: '0.1.0' },
      ),
    ).toEqual({ pdfjs: '6.2.108', plugin: '0.1.0' });
  });

  it('rejects inconsistent plugin metadata and a missing runtime PDF.js dependency', () => {
    expect(() =>
      parseCurrentBuildVersions(
        { version: '0.1.0' },
        { dependencies: { 'pdfjs-dist': '6.2.108' }, version: '0.2.0' },
      ),
    ).toThrow('versions must match');
    expect(() =>
      parseCurrentBuildVersions({ version: '0.1.0' }, { dependencies: {}, version: '0.1.0' }),
    ).toThrow('dependencies.pdfjs-dist');
  });
});
