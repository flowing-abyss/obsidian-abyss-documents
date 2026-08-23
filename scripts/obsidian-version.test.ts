import { describe, expect, it } from 'vitest';
import {
  parseObsidianVersionEvidence,
  requireSuccessfulObsidianCliOutput,
} from './obsidian-version.mjs';

describe('Obsidian benchmark version evidence', () => {
  it('accepts the documented CLI version output', () => {
    expect(parseObsidianVersionEvidence('1.13.7', '')).toBe('1.13.7');
  });

  it('falls back to the renderer user agent when the CLI returns an exit-zero error', () => {
    expect(
      parseObsidianVersionEvidence(
        'Error: Command "version" not found. It may require a plugin to be enabled.',
        'Mozilla/5.0 obsidian/1.13.7 Chrome/150.0.0.0 Electron/43.3.0 Safari/537.36',
      ),
    ).toBe('1.13.7');
  });

  it('fails closed when neither source contains an exact semantic version', () => {
    expect(() => parseObsidianVersionEvidence('unknown', 'Mozilla/5.0 Chrome/150.0.0.0')).toThrow(
      'Obsidian version evidence',
    );
  });

  it('fails closed when Obsidian reports an exit-zero command or evaluation error', () => {
    expect(() => requireSuccessfulObsidianCliOutput('Error: abyss-probe')).toThrow('abyss-probe');
    expect(() => requireSuccessfulObsidianCliOutput('Evaluation error: missing helper')).toThrow(
      'missing helper',
    );
    expect(requireSuccessfulObsidianCliOutput('=> true\n')).toBe('=> true');
  });

  it('rejects an eval error on any output line even when a result was printed first', () => {
    expect(() =>
      requireSuccessfulObsidianCliOutput(
        '[error] offsetParent is not set -- cannot scroll\n=> true\nEvaluation error: missing helper',
      ),
    ).toThrow('missing helper');
  });
});
