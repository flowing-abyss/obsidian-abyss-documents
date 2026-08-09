import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { assertNoRelativeUrls, assertScopedSelectors, prefixPdfStyles } from './build-styles.mjs';

describe('PDF.js style build', () => {
  it('prefixes outer rules without changing native nested selectors', async () => {
    const output = await prefixPdfStyles(`
.messageBar {
  > div {
    &::before { content: ""; }
  }
}
.textLayer {
  &.highlighting { touch-action: none; }
  > :not(.markedContent),
  .markedContent span:not(.markedContent) { z-index: 1; }
}
`);
    const selectors = [];
    postcss
      .parse(output)
      .walkRules((rule) => selectors.push(...rule.selectors.map((selector) => selector.trim())));

    expect(selectors).toEqual([
      '.abyss-documents .messageBar',
      '> div',
      '&::before',
      '.abyss-documents .textLayer',
      '&.highlighting',
      '> :not(.markedContent)',
      '.markedContent span:not(.markedContent)',
    ]);
    expect(() => assertScopedSelectors(output)).not.toThrow();
  });

  it('inlines PDF.js assets and leaves no unresolved relative URLs', async () => {
    const output = await prefixPdfStyles(
      '.messageBar { --icon: url(images/messageBar_info.svg); }',
    );

    expect(output).toContain('url(data:image/svg+xml;base64,');
    expect(() => assertNoRelativeUrls(output)).not.toThrow();
  });

  it('keeps production messageBar and text-layer nesting intact with no relative assets', async () => {
    const output = await readFile('styles.css', 'utf8');
    const root = postcss.parse(output);
    const selectors = [];
    root.walkRules((rule) => selectors.push(rule.selector));

    expect(selectors).toContain('.abyss-documents .messageBar');
    expect(selectors).toContain('> div');
    expect(selectors).toContain('&::before');
    expect(selectors).toContain('.abyss-documents .textLayer');
    expect(selectors).toContain('&.highlighting');
    expect(() => assertNoRelativeUrls(output)).not.toThrow();
  });
});
