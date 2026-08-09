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

  it('maps :root to the plugin wrapper without damaging selector lists', async () => {
    const output = await prefixPdfStyles(':root, .messageBar { --pdfjs-test: 1; }');
    const [rule] = postcss.parse(output).nodes;

    expect(rule.selectors.map((selector) => selector.trim())).toEqual([
      '.abyss-documents',
      '.abyss-documents .messageBar',
    ]);
    expect(output).not.toContain('.abyss-documents :root');
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
    expect(selectors).toContain('.abyss-documents');
    expect(selectors).not.toContain('.abyss-documents :root');
    const wrapperVariables = root.nodes.find(
      (node) =>
        node.type === 'rule' &&
        node.selector === '.abyss-documents' &&
        node.nodes.some(
          (child) => child.type === 'decl' && child.prop === '--viewer-container-height',
        ),
    );
    expect(wrapperVariables).toBeDefined();
    expect(() => assertNoRelativeUrls(output)).not.toThrow();
  });

  it('keeps the PDF.js viewer container absolute inside a bounded scrolling document host', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const declarations = (selector) => {
      const values = new Map();
      root.walkRules(selector, (rule) => {
        if (rule.selector !== selector) return;
        rule.walkDecls((declaration) => values.set(declaration.prop, declaration.value));
      });
      return values;
    };

    expect(Object.fromEntries(declarations('.abyss-documents'))).toMatchObject({
      position: 'relative',
      height: '100%',
      overflow: 'hidden',
    });
    expect(
      Object.fromEntries(declarations(".abyss-documents [data-region='document']")),
    ).toMatchObject({
      position: 'relative',
      overflow: 'hidden',
    });
    expect(Object.fromEntries(declarations('.abyss-documents .pdfViewerContainer'))).toMatchObject({
      position: 'absolute',
      inset: '0',
      overflow: 'auto',
    });
  });

  it('ships scoped settings, stored-width docking, safe-area mobile, and reduced motion', async () => {
    const output = await readFile('styles.css', 'utf8');
    const root = postcss.parse(output);
    const selectors = [];
    root.walkRules((rule) => selectors.push(rule.selector));

    expect(selectors).toContain('.abyss-documents-settings');
    expect(output).toContain('width: var(--abyss-reader-sidebar-width)');
    expect(output).toContain('env(safe-area-inset-bottom)');
    const reducedMotion = root.nodes.find(
      (node) =>
        node.type === 'atrule' &&
        node.name === 'media' &&
        node.params === '(prefers-reduced-motion: reduce)',
    );
    expect(reducedMotion?.toString()).toContain('scroll-behavior: auto');
    expect(reducedMotion?.toString()).toContain('transition: none');
    expect(() => assertScopedSelectors(output)).not.toThrow();
  });
});
