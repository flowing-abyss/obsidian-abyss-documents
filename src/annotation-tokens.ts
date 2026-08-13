interface AnnotationTagToken {
  readonly normalized: string;
  readonly display: string;
}

interface AnnotationTokens {
  readonly tags: readonly AnnotationTagToken[];
  readonly links: readonly string[];
}

export function parseAnnotationTokens(value: string): AnnotationTokens {
  return Object.freeze({
    tags: Object.freeze(parseTags(value)),
    links: Object.freeze(parseLinks(value)),
  });
}

function parseTags(value: string): AnnotationTagToken[] {
  const tags: AnnotationTagToken[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(/(^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
    const display = match[2];
    if (display === undefined || display.length === 0) continue;
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
