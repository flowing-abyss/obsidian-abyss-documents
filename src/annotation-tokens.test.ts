import { describe, expect, it } from 'vitest';
import { decodeAnnotationComment, parseAnnotationTokens } from './annotation-tokens.js';

describe('annotation comment compatibility metadata', () => {
  it('keeps the raw comment authoritative and exposes frozen derived arrays only', () => {
    const source = '  Привет #First [[Ｆｏｏ|Shown]] [[Bar#Heading]]  ';
    const decoded = decodeAnnotationComment(source);

    expect(decoded).toEqual({
      links: ['Ｆｏｏ', 'Bar'],
      source,
      tags: ['First'],
    });
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.links)).toBe(true);
    expect(Object.isFrozen(decoded.tags)).toBe(true);
  });

  it('derives canonical comparisons without rewriting first-seen Unicode tokens', () => {
    expect(
      parseAnnotationTokens('#İdea #idea #I #ı #ＴＡＧ [[Ｆｏｏ#Section|Shown]] [[Foo]]'),
    ).toEqual({
      tags: [
        { display: 'İdea', normalized: 'i̇dea' },
        { display: 'idea', normalized: 'idea' },
        { display: 'I', normalized: 'i' },
        { display: 'ı', normalized: 'ı' },
        { display: 'ＴＡＧ', normalized: 'tag' },
      ],
      links: ['Ｆｏｏ'],
    });
  });

  it('does not derive tags from section-only wiki links', () => {
    expect(decodeAnnotationComment('Lead [[#Heading]] and [[#Other|Alias]] #Real tail')).toEqual({
      links: [],
      source: 'Lead [[#Heading]] and [[#Other|Alias]] #Real tail',
      tags: ['Real'],
    });
  });
});
