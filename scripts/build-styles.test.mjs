import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { assertNoRelativeUrls, assertScopedSelectors, prefixPdfStyles } from './build-styles.mjs';

function mobileDeclarations(mobile, selector) {
  const values = new Map();
  mobile?.walkRules((rule) => {
    if (!rule.selectors.some((candidate) => candidate.replaceAll(/\s+/gu, ' ').trim() === selector))
      return;
    rule.walkDecls((declaration) => values.set(declaration.prop, declaration.value));
  });
  return Object.fromEntries(values);
}

function topLevelDeclarations(root, selector) {
  const values = new Map();
  for (const node of root.nodes) {
    if (node.type !== 'rule' || !node.selectors.includes(selector)) continue;
    node.walkDecls((declaration) => values.set(declaration.prop, declaration.value));
  }
  return Object.fromEntries(values);
}

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

  it('leaves PDF.js module-global editor metrics to lifecycle-managed runtime styles', async () => {
    const output = await readFile('styles.css', 'utf8');
    const root = postcss.parse(output);
    const declarations = topLevelDeclarations(root, ':root:has(.abyss-documents)');

    expect(declarations).toEqual({});
    expect(output).not.toContain(':root:has(.abyss-documents)');
    expect(() => assertScopedSelectors(output)).not.toThrow();
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

  it('lets search result buttons grow beyond the host button height to show their preview', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const declarations = new Map();
    root.walkRules('.abyss-documents .abyss-reader-search-result', (rule) => {
      if (rule.selector !== '.abyss-documents .abyss-reader-search-result') return;
      rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
    });

    expect(Object.fromEntries(declarations)).toMatchObject({
      height: 'auto',
      'white-space': 'normal',
    });
  });

  it('keeps PDF.js page geometry in content-box so canvas and text layers align', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const declarations = new Map();
    root.walkRules('.abyss-documents .pdfViewer .page', (rule) => {
      if (rule.selector !== '.abyss-documents .pdfViewer .page') return;
      rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
    });

    expect(Object.fromEntries(declarations)).toMatchObject({
      'box-sizing': 'content-box',
    });
  });

  it('provides 44px-equivalent touch targets in the responsive reader layout', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const touch = root.nodes.find(
      (node) =>
        node.type === 'atrule' && node.name === 'media' && node.params.includes('pointer: coarse'),
    );
    expect(
      mobileDeclarations(touch, '.abyss-documents .abyss-reader-toolbar-button'),
    ).toMatchObject({
      width: '2.75rem',
      'min-width': '2.75rem',
      'min-height': '2.75rem',
    });
    expect(mobileDeclarations(touch, '.abyss-documents .abyss-reader-sidebar-close')).toMatchObject(
      {
        width: '2.75rem',
        'min-width': '2.75rem',
        'min-height': '2.75rem',
      },
    );
    expect(mobileDeclarations(touch, '.abyss-documents .abyss-reader-search-input')).toMatchObject({
      'min-height': '2.75rem',
    });
    expect(
      mobileDeclarations(touch, '.abyss-documents .abyss-reader-outline-chevron'),
    ).toMatchObject({
      width: '18px',
      'min-width': '18px',
      height: '44px',
      'min-height': '44px',
    });
    expect(
      mobileDeclarations(
        touch,
        '.abyss-documents .abyss-reader-outline-chevron.is-interactive::after',
      ),
    ).toMatchObject({
      width: '44px',
      height: '44px',
      inset: '50% auto auto 50%',
      transform: 'translate(-50%, -50%)',
    });
    expect(
      mobileDeclarations(touch, '.abyss-documents .abyss-reader-outline-search'),
    ).toMatchObject({ 'min-height': '2.75rem' });
    expect(mobileDeclarations(touch, ".abyss-documents [data-action='retry']")).toMatchObject({
      'min-height': '2.75rem',
    });
  });

  it('keeps desktop outline rows and chevrons at native dense metrics', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    expect(
      topLevelDeclarations(root, '.abyss-documents .abyss-reader-outline-row-shell'),
    ).toMatchObject({ height: '27px' });
    expect(
      topLevelDeclarations(root, '.abyss-documents .abyss-reader-outline-chevron'),
    ).toMatchObject({
      width: '17px',
      'min-width': '17px',
      height: '27px',
      'min-height': '27px',
    });
    expect(
      topLevelDeclarations(root, '.abyss-documents .abyss-reader-outline-chevron .svg-icon'),
    ).toMatchObject({ width: 'var(--icon-xs)', height: 'var(--icon-xs)' });
  });

  it('stretches left-aligned annotation content instead of inheriting centered button layout', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const card = topLevelDeclarations(root, '.abyss-documents .abyss-annotation-card');
    const header = topLevelDeclarations(root, '.abyss-documents .abyss-annotation-card-header');
    const text = topLevelDeclarations(root, '.abyss-documents .abyss-annotation-card-text');

    expect(card).toMatchObject({
      'align-items': 'stretch',
      'justify-content': 'flex-start',
      'text-align': 'start',
    });
    expect(header).toMatchObject({ width: '100%' });
    expect(text).toMatchObject({ width: '100%' });
    expect(header).not.toHaveProperty('padding-inline-end');
    expect(await readFile('styles.css', 'utf8')).not.toContain('--abyss-annotation-action-width');
  });

  it('keeps direct navigation and one active split on a narrow reader leaf', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const narrow = root.nodes.find(
      (node) =>
        node.type === 'atrule' &&
        node.name === 'container' &&
        node.params === 'abyss-reader (inline-size <= 600px)',
    );
    const priority = root.nodes.find(
      (node) =>
        node.type === 'atrule' &&
        node.name === 'container' &&
        node.params === 'abyss-reader (inline-size <= 760px)',
    );
    const coarsePointer = root.nodes.find(
      (node) =>
        node.type === 'atrule' && node.name === 'media' && node.params.includes('pointer: coarse'),
    );

    expect(topLevelDeclarations(root, '.abyss-documents .abyss-reader-toolbar')).toMatchObject({
      'flex-wrap': 'nowrap',
      'overflow-x': 'hidden',
    });
    expect(topLevelDeclarations(root, '.abyss-documents')).toMatchObject({
      'container-name': 'abyss-reader',
      'container-type': 'inline-size',
    });
    expect(
      mobileDeclarations(priority, '.abyss-documents .abyss-reader-fit-control'),
    ).toMatchObject({ display: 'none' });
    expect(
      mobileDeclarations(priority, '.abyss-documents .abyss-reader-toolbar-zoom'),
    ).toMatchObject({ display: 'none' });
    expect(mobileDeclarations(narrow, ".abyss-documents [data-control='previous-page']")).toEqual(
      {},
    );
    expect(mobileDeclarations(narrow, ".abyss-documents [data-control='next-page']")).toEqual({});
    expect(mobileDeclarations(narrow, ".abyss-documents [data-control='page-field']")).toEqual({});
    expect(
      mobileDeclarations(
        narrow,
        ".abyss-documents .abyss-annotation-toolbar[data-annotation-mode='select'] > .abyss-reader-split-control:not(.abyss-reader-quick-control)",
      ),
    ).toMatchObject({ display: 'none' });
    expect(
      mobileDeclarations(
        narrow,
        ".abyss-documents .abyss-annotation-toolbar:not([data-annotation-mode='select']) > .abyss-reader-split-control:not(:has([data-annotation-tool][aria-pressed='true']))",
      ),
    ).toMatchObject({ display: 'none' });
    expect(
      mobileDeclarations(coarsePointer, '.abyss-documents .abyss-reader-toolbar-button'),
    ).toMatchObject({
      width: '2.75rem',
      'min-width': '2.75rem',
      'min-height': '2.75rem',
    });
    expect(
      mobileDeclarations(
        coarsePointer,
        '.abyss-documents .abyss-reader-split-control .abyss-reader-split-menu',
      ),
    ).toMatchObject({
      width: 'var(--abyss-reader-split-disclosure-width)',
      'min-width': 'var(--abyss-reader-split-disclosure-width)',
      'min-height': '2.75rem',
    });
    expect(
      mobileDeclarations(coarsePointer, '.abyss-documents .abyss-reader-toolbar'),
    ).toMatchObject({
      '--abyss-reader-split-disclosure-width': '24px',
      '--abyss-reader-split-main-width': '44px',
    });
    expect(
      mobileDeclarations(coarsePointer, '.abyss-documents .abyss-annotation-colors'),
    ).toMatchObject({
      'border-top': '0',
      'min-height': '44px',
      'padding-block': '0',
    });
    expect(
      mobileDeclarations(
        coarsePointer,
        ".abyss-documents .abyss-annotation-toolbar[data-annotation-mode='select'] > .abyss-reader-split-control:not(.abyss-reader-quick-control)",
      ),
    ).toMatchObject({ display: 'none' });
    expect(
      mobileDeclarations(coarsePointer, '.abyss-documents .abyss-reader-toolbar-zoom-button'),
    ).toEqual({});
  });

  it('keys the left sidebar overlay to reader width and gives direct zoom controls 44px targets', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const narrowReader = root.nodes.find(
      (node) =>
        node.type === 'atrule' &&
        node.name === 'container' &&
        node.params === 'abyss-reader (inline-size <= 600px)',
    );
    const viewportMobile = root.nodes.find(
      (node) =>
        node.type === 'atrule' && node.name === 'media' && node.params === '(width <= 600px)',
    );
    const touch = root.nodes.find(
      (node) =>
        node.type === 'atrule' && node.name === 'media' && node.params.includes('pointer: coarse'),
    );
    expect(
      mobileDeclarations(narrowReader, '.abyss-documents .abyss-reader-sidebar'),
    ).toMatchObject({
      position: 'absolute',
      'inset-inline-start': '0',
      width: 'min(var(--abyss-reader-sidebar-width), 90%)',
    });
    expect(mobileDeclarations(viewportMobile, '.abyss-documents .abyss-reader-sidebar')).toEqual(
      {},
    );
    expect(
      mobileDeclarations(touch, '.abyss-documents .abyss-reader-toolbar-button'),
    ).toMatchObject({
      width: '2.75rem',
      'min-width': '2.75rem',
      'min-height': '2.75rem',
    });
  });

  it('keeps focused text inputs visibly outlined for pointer and programmatic focus', async () => {
    const root = postcss.parse(await readFile('styles.css', 'utf8'));
    const selectors = [];
    root.walkRules((rule) => selectors.push(...rule.selectors));

    expect(selectors).toContain('.abyss-documents .abyss-reader-toolbar-page-field:focus');
    expect(selectors).toContain('.abyss-documents .abyss-reader-search-input:focus');
  });

  it('ships scoped settings, stored-width docking, safe-area mobile, and reduced motion', async () => {
    const output = await readFile('styles.css', 'utf8');
    const root = postcss.parse(output);
    const selectors = [];
    root.walkRules((rule) => selectors.push(rule.selector));

    expect(selectors).toContain('.abyss-documents-settings');
    expect(selectors).toContain('.abyss-documents .abyss-reader-sidebar.is-mobile');
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
