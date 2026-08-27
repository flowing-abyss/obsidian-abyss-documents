interface AnnotationTagToken {
  readonly normalized: string;
  readonly display: string;
}

interface AnnotationTokens {
  readonly tags: readonly AnnotationTagToken[];
  readonly links: readonly string[];
}

export interface DecodedAnnotationComment {
  readonly source: string;
  readonly prose: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

export interface AnnotationCommentUpdate {
  readonly prose?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly links?: readonly string[] | undefined;
}

interface AnnotationCommentToken {
  readonly end: number;
  readonly kind: 'link' | 'tag' | 'wiki';
  readonly raw: string;
  readonly start: number;
  readonly value: string;
}

interface AnnotationCommentTokenGroup {
  readonly end: number;
  readonly start: number;
  readonly tokens: readonly AnnotationCommentToken[];
}

interface AnnotationTokenReplacement {
  readonly kind: EditableAnnotationTokenKind;
  readonly serialized: string;
  readonly start: number;
}

type EditableAnnotationTokenKind = 'link' | 'tag';

export function parseAnnotationTokens(value: string): AnnotationTokens {
  return Object.freeze({
    tags: Object.freeze(parseTags(value)),
    links: Object.freeze(parseLinks(value)),
  });
}

export function decodeAnnotationComment(source: string): DecodedAnnotationComment {
  const tokens = commentTokens(source);
  return Object.freeze({
    links: Object.freeze(tokens.filter((token) => token.kind === 'link').map(({ value }) => value)),
    prose: proseWithoutTokens(source, tokens),
    source,
    tags: Object.freeze(tokens.filter((token) => token.kind === 'tag').map(({ value }) => value)),
  });
}

export function updateAnnotationComment(source: string, update: AnnotationCommentUpdate): string {
  const decoded = decodeAnnotationComment(source);
  let next = source;
  if (update.tags !== undefined && !sameValues(update.tags, decoded.tags))
    next = replaceTokenClass(next, 'tag', update.tags);
  if (update.links !== undefined) {
    const currentLinks = decodeAnnotationComment(next).links;
    if (!sameValues(update.links, currentLinks))
      next = replaceTokenClass(next, 'link', update.links);
  }
  if (update.prose === undefined || update.prose === decoded.prose) return next;
  const tokens = commentTokens(next);
  const metadata = tokens.map(({ raw }) => raw);
  return joinCommentParts([update.prose, ...metadata]);
}

function parseTags(value: string): AnnotationTagToken[] {
  const tags: AnnotationTagToken[] = [];
  const seen = new Set<string>();
  const wikiSpans = linkTokens(value);
  for (const match of value.matchAll(/(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
    const display = match[2];
    if (display === undefined || display.length === 0) continue;
    const full = match[0];
    const start = match.index + full.length - display.length - 1;
    const end = start + display.length + 1;
    if (wikiSpans.some((span) => start < span.end && end > span.start)) continue;
    const normalized = normalize(display);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push({ display, normalized });
  }
  return tags;
}

function parseLinks(value: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('[[', cursor);
    if (open < 0) break;
    const close = value.indexOf(']]', open + 2);
    if (close < 0) break;
    cursor = close + 2;
    const body = value.slice(open + 2, close);
    if (body.includes('[') || body.includes('\n')) continue;
    const target = (body.split('|', 1)[0]?.split('#', 1)[0] ?? '').trim();
    const key = normalize(target);
    if (target.length === 0 || seen.has(key)) continue;
    seen.add(key);
    links.push(target);
  }
  return links;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function commentTokens(source: string): AnnotationCommentToken[] {
  const links = linkTokens(source);
  const tags: AnnotationCommentToken[] = [];
  for (const match of source.matchAll(/(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
    const display = match[2];
    if (display === undefined) continue;
    const full = match[0];
    const start = match.index + full.length - display.length - 1;
    const end = start + display.length + 1;
    if (links.some((link) => start < link.end && end > link.start)) continue;
    tags.push({ end, kind: 'tag', raw: source.slice(start, end), start, value: display });
  }
  return [...links, ...tags].sort((left, right) => left.start - right.start);
}

function linkTokens(source: string): AnnotationCommentToken[] {
  const tokens: AnnotationCommentToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('[[', cursor);
    if (start < 0) break;
    const close = source.indexOf(']]', start + 2);
    if (close < 0) break;
    const end = close + 2;
    cursor = end;
    const body = source.slice(start + 2, close);
    if (body.includes('[') || body.includes('\n')) continue;
    const value = (body.split('|', 1)[0]?.split('#', 1)[0] ?? '').trim();
    tokens.push({
      end,
      kind: value.length === 0 ? 'wiki' : 'link',
      raw: source.slice(start, end),
      start,
      value,
    });
  }
  return tokens;
}

function proseWithoutTokens(source: string, tokens: readonly AnnotationCommentToken[]): string {
  let cursor = 0;
  let prose = '';
  for (const [index, token] of tokens.entries()) {
    const gap = source.slice(cursor, token.start);
    const previous = tokens[index - 1];
    if (previous === undefined || /\S/u.test(gap)) prose += gap;
    cursor = token.end;
  }
  return prose + source.slice(cursor);
}

function replaceTokenClass(
  source: string,
  kind: EditableAnnotationTokenKind,
  values: readonly string[],
): string {
  const tokens = commentTokens(source);
  const serialized = serializeTokens(kind, values);
  const firstMatchingToken = tokens.find((token) => token.kind === kind);
  if (firstMatchingToken === undefined) return insertTokenClass(source, tokens, kind, serialized);
  const groups = tokenGroups(source, tokens);
  return replaceGroupedTokens(source, groups, {
    kind,
    serialized,
    start: firstMatchingToken.start,
  });
}

function replaceGroupedTokens(
  source: string,
  groups: readonly AnnotationCommentTokenGroup[],
  replacement: AnnotationTokenReplacement,
): string {
  let cursor = 0;
  let output = '';
  for (const group of groups) {
    output += source.slice(cursor, group.start);
    output += renderTokenGroup(source, group, replacement);
    cursor = group.end;
  }
  return output + source.slice(cursor);
}

function renderTokenGroup(
  source: string,
  group: AnnotationCommentTokenGroup,
  replacement: AnnotationTokenReplacement,
): string {
  if (!group.tokens.some((token) => token.kind === replacement.kind))
    return source.slice(group.start, group.end);
  return group.tokens
    .flatMap((token) => {
      if (token.kind !== replacement.kind) return [token.raw];
      if (token.start === replacement.start && replacement.serialized.length > 0)
        return [replacement.serialized];
      return [];
    })
    .join(' ');
}

function tokenGroups(
  source: string,
  tokens: readonly AnnotationCommentToken[],
): readonly AnnotationCommentTokenGroup[] {
  const groups: AnnotationCommentTokenGroup[] = [];
  for (const token of tokens) {
    const previous = groups[groups.length - 1];
    if (previous === undefined || source.slice(previous.end, token.start).trim().length > 0) {
      groups.push({ end: token.end, start: token.start, tokens: [token] });
      continue;
    }
    groups[groups.length - 1] = {
      end: token.end,
      start: previous.start,
      tokens: [...previous.tokens, token],
    };
  }
  return groups;
}

function insertTokenClass(
  source: string,
  tokens: readonly AnnotationCommentToken[],
  kind: EditableAnnotationTokenKind,
  serialized: string,
): string {
  if (serialized.length === 0) return source;
  if (kind === 'tag') {
    const firstLink = tokens.find((token) => token.kind === 'link');
    if (firstLink !== undefined) return insertAt(source, firstLink.start, serialized);
  } else {
    const lastTag = [...tokens].reverse().find((token) => token.kind === 'tag');
    if (lastTag !== undefined) return insertAt(source, lastTag.end, serialized);
  }
  return joinCommentParts([source, serialized]);
}

function insertAt(source: string, index: number, value: string): string {
  return joinCommentParts([source.slice(0, index), value, source.slice(index)]);
}

function serializeTokens(kind: EditableAnnotationTokenKind, values: readonly string[]): string {
  const rendered = values.flatMap((value) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (kind === 'tag') return [`#${trimmed.replace(/^#+/u, '')}`];
    const target =
      trimmed.startsWith('[[') && trimmed.endsWith(']]') ? trimmed.slice(2, -2) : trimmed;
    return target.length === 0 ? [] : [`[[${target}]]`];
  });
  return rendered.join(' ');
}

function joinCommentParts(parts: readonly string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .reduce((result, part) => {
      if (result.length === 0 || /\s$/u.test(result) || /^\s/u.test(part)) return result + part;
      return `${result} ${part}`;
    }, '');
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
