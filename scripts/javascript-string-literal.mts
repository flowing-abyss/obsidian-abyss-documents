/** Encodes a string as JavaScript data, including script and Unicode line boundaries. */
export function serializeJavaScriptString(value: string): string {
  return JSON.stringify(value).replace(
    /[<>\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
