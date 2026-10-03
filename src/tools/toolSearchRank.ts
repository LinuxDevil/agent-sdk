/**
 * N2: the default ranking of the `tool_search` tool - keyword overlap of the
 * query with each deferred tool's name and description. No dependency, no
 * index: deferred tool sets are tens to a few hundred tools.
 */

/** A tool as `tool_search` ranks it. */
export interface SearchableTool {
  name: string;
  description: string;
}

/** Points for a query word found among a tool's name words, and among its description words. */
const NAME_HIT = 3;
const DESCRIPTION_HIT = 1;

/** English words too common to say anything about a tool. */
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'what', 'with']);

/** A word without a plural ending (`tools` -> `tool`, `currencies` -> `currency`), so singular and plural match. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * The words of `text` as `tool_search` compares them: lowercase, split on
 * anything but letters and digits (`_`, `-`, `__`, spaces) and on camelCase,
 * without plural endings and common English words.
 */
export function searchWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !STOP_WORDS.has(word))
    .map(stem);
}

/**
 * The names of `tools` that share a word with `query`, best first: each query
 * word found in a tool's name scores 3, in its description 1 (case-insensitive;
 * names split on `_`, `-`, `__` and camelCase). Ties are ordered by name; tools
 * with no shared word are left out.
 *
 * @example
 * ```ts
 * rankToolsByKeywords('currency conversion', [{ name: 'convert_currency', description: 'Convert money' }]); // ['convert_currency']
 * ```
 */
export function rankToolsByKeywords(query: string, tools: ReadonlyArray<SearchableTool>): string[] {
  const wanted = [...new Set(searchWords(query))];
  if (wanted.length === 0) return [];
  const scored = tools.map((tool) => {
    const name = new Set(searchWords(tool.name));
    const description = new Set(searchWords(tool.description));
    const score = wanted.reduce((sum, word) => sum + (name.has(word) ? NAME_HIT : 0) + (description.has(word) ? DESCRIPTION_HIT : 0), 0);
    return { name: tool.name, score };
  });
  return scored
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => tool.name);
}
