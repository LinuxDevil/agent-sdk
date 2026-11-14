/**
 * The `{{a.b.c}}` placeholder renderer trigger prompt templates and
 * chain/agent templates share (R08a; R07 reuses it). A placeholder reads
 * the value at that path in `scope`: strings insert as is, everything
 * else inserts its JSON form, an unknown path inserts ''. `{{{{` and
 * `}}}}` are literal braces. Pure and browser-safe.
 */

/** One `{{path}}` placeholder; `{{{{`/`}}}}` never match (they are literals). */
const PLACEHOLDER = /\{\{(?!\{)([^{}]*?)(?<!\})\}\}(?!\})/g;

// Sentinels for the literal-brace escapes, chosen outside any text a
// prompt template realistically holds; swapped back after the pass.
const OPEN_SENTINEL = '\u0000';
const CLOSE_SENTINEL = '\u0001';

/** `value` at `path` (`a.b.c`, `[0]` indexes into arrays), or `undefined`. */
function atPath(scope: Record<string, unknown>, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The inserted text for a resolved value: strings verbatim, others JSON, missing as ''. */
function renderValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Renders `template` against `scope`: every `{{a.b.c}}` becomes the value
 * at that path (unknown → ''), `{{{{`/`}}}}` collapse to literal `{{`/`}}`.
 */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  return template
    .replaceAll('{{{{', OPEN_SENTINEL)
    .replaceAll('}}}}', CLOSE_SENTINEL)
    .replace(PLACEHOLDER, (_match, path: string) => renderValue(atPath(scope, path.trim())))
    .replaceAll(OPEN_SENTINEL, '{{')
    .replaceAll(CLOSE_SENTINEL, '}}');
}
