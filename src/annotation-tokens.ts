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
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

interface AnnotationTokenSpan {
  readonly end: number;
  readonly start: number;
}

export function parseAnnotationTokens(value: string): AnnotationTokens {
  return Object.freeze({
    tags: Object.freeze(parseTags(value)),
    links: Object.freeze(parseLinks(value)),
  });
}

export function decodeAnnotationComment(source: string): DecodedAnnotationComment {
  const tokens = parseAnnotationTokens(source);
  return Object.freeze({
    links: tokens.links,
    source,
    tags: Object.freeze(tokens.tags.map(({ display }) => display)),
  });
}

function parseTags(value: string): AnnotationTagToken[] {
  const tags: AnnotationTagToken[] = [];
  const seen = new Set<string>();
  const wikiSpans = linkSpans(value);
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

function linkSpans(source: string): AnnotationTokenSpan[] {
  const spans: AnnotationTokenSpan[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('[[', cursor);
    if (start < 0) break;
    const close = source.indexOf(']]', start + 2);
    if (close < 0) break;
    const end = close + 2;
    cursor = end;
    const body = source.slice(start + 2, close);
    if (!body.includes('[') && !body.includes('\n')) spans.push({ end, start });
  }
  return spans;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}
