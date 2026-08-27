import { describe, expect, it } from 'vitest';
import {
  decodeAnnotationComment,
  parseAnnotationTokens,
  updateAnnotationComment,
} from './annotation-tokens.js';

describe('annotation comment token codec', () => {
  it('round-trips prose and replaces only the edited metadata token class', () => {
    const source = 'Lead #First, then [[Ｆｏｏ|Shown]] and #Second; tail [[Bar#Heading]].';
    const decoded = decodeAnnotationComment(source);

    expect(decoded).toEqual({
      links: ['Ｆｏｏ', 'Bar'],
      prose: 'Lead , then  and ; tail .',
      source,
      tags: ['First', 'Second'],
    });
    expect(updateAnnotationComment(source, decoded)).toBe(source);

    const tagsEdited = updateAnnotationComment(source, { tags: ['Renamed', 'Second'] });
    expect(tagsEdited).toBe(
      'Lead #Renamed #Second, then [[Ｆｏｏ|Shown]] and ; tail [[Bar#Heading]].',
    );

    const linksEdited = updateAnnotationComment(tagsEdited, { links: ['Concept'] });
    expect(linksEdited).toBe('Lead #Renamed #Second, then [[Concept]] and ; tail .');
    expect(
      updateAnnotationComment(linksEdited, { links: ['Concept'], tags: ['Renamed', 'Second'] }),
    ).toBe(linksEdited);
    expect(decodeAnnotationComment(linksEdited).prose).toBe(decoded.prose);
  });

  it('keeps adjacent tag and link slots stable through repeated remove and add cycles', () => {
    let value = 'Prose #One [[Alpha]]';
    for (let cycle = 0; cycle < 3; cycle += 1) {
      value = updateAnnotationComment(value, { tags: [] });
      expect(value).toBe('Prose [[Alpha]]');
      value = updateAnnotationComment(value, { tags: ['Two'] });
      expect(value).toBe('Prose #Two [[Alpha]]');
      value = updateAnnotationComment(value, { links: [] });
      expect(value).toBe('Prose #Two');
      value = updateAnnotationComment(value, { links: ['Beta'] });
      expect(value).toBe('Prose #Two [[Beta]]');
      value = updateAnnotationComment(value, { links: ['Alpha'], tags: ['One'] });
      expect(value).toBe('Prose #One [[Alpha]]');
    }
    expect(decodeAnnotationComment(value).prose).toBe('Prose ');
  });

  it('excludes section-only wiki spans from tags and preserves them through tag edits', () => {
    const source = 'Lead [[#Heading]] and [[#Other|Alias]] #Real tail';

    expect(parseAnnotationTokens(source)).toEqual({
      links: [],
      tags: [{ display: 'Real', normalized: 'real' }],
    });
    expect(decodeAnnotationComment(source)).toEqual({
      links: [],
      prose: 'Lead  and  tail',
      source,
      tags: ['Real'],
    });
    expect(updateAnnotationComment(source, { tags: ['Changed'] })).toBe(
      'Lead [[#Heading]] and [[#Other|Alias]] #Changed tail',
    );
  });
});
