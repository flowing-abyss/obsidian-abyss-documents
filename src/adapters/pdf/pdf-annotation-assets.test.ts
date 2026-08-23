import { describe, expect, it } from 'vitest';
import { replacePdfAnnotationImageSources } from './pdf-annotation-assets.js';

describe('PDF.js annotation image assets', () => {
  it('replaces packaged-relative annotation images and leaves unrelated images unchanged', () => {
    const root = createDiv();
    root.createEl('img', { attr: { src: 'annotation-comment.svg' } });
    root.createEl('img', { attr: { src: 'annotation-note.svg' } });
    root.createEl('img', { attr: { src: 'annotation-unknown.svg' } });
    root.createEl('img', { attr: { src: 'cover.svg' } });

    replacePdfAnnotationImageSources(root, {
      'annotation-comment.svg': 'data:image/svg+xml;base64,Y29tbWVudA==',
      'annotation-note.svg': 'data:image/svg+xml;base64,bm90ZQ==',
    });

    const sources: Array<string | null> = [];
    root
      .querySelectorAll<HTMLImageElement>('img')
      .forEach((image) => sources.push(image.getAttribute('src')));
    expect(sources).toEqual([
      'data:image/svg+xml;base64,Y29tbWVudA==',
      'data:image/svg+xml;base64,bm90ZQ==',
      'annotation-unknown.svg',
      'cover.svg',
    ]);
  });
});
