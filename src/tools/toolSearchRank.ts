/**
 * N2: the default ranking of the `tool_search` tool - keyword overlap of the
 * query with each deferred tool's name and description. No dependency, no
 * index: deferred tool sets are tens to a few hundred tools.
 *
 * Eve MEM-F13: besides exact words it gives partial credit for word-family
 * matches (`create` / `created`, `send` / `sending`) and for a small
 * built-in table of common tool-verb and domain synonyms (`fetch` / `get`,
 * `share` / `stock` / `equity`), so a query that does not reuse a tool's exact
 * wording can still find it.
 */

/** A tool as `tool_search` ranks it. */
export interface SearchableTool {
  name: string;
  description: string;
}

/** Points for a query word found among a tool's name words, and among its description words. */
const NAME_HIT = 3;
const DESCRIPTION_HIT = 1;
/** Points for a related word (same word family or a synonym) in the name, and in the description. */
const NAME_RELATED = 2;
const DESCRIPTION_RELATED = 0.5;

/** English words too common to say anything about a tool. */
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'what', 'with']);

/**
 * A word without a plural ending, so singular and plural match: `tools` ->
 * `tool`, `currencies` -> `currency`, `statuses` -> `status`, `boxes` -> `box`,
 * `addresses` -> `address`. Words ending in `ss`, `us` or `is` (`status`,
 * `analysis`) are already singular.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith('uses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
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

/** Groups of words `tool_search` treats as related (singular forms). */
const SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['get', 'fetch', 'retrieve', 'read', 'load', 'obtain', 'lookup'],
  ['find', 'search', 'query', 'lookup', 'locate', 'discover'],
  ['create', 'add', 'new', 'make', 'insert', 'register'],
  ['update', 'edit', 'modify', 'change', 'patch', 'rename'],
  ['delete', 'remove', 'erase', 'destroy', 'drop', 'forget', 'purge'],
  ['list', 'enumerate', 'browse'],
  ['send', 'post', 'email', 'message', 'notify', 'mail'],
  ['run', 'execute', 'invoke', 'launch', 'start', 'trigger'],
  ['stop', 'cancel', 'abort', 'halt', 'kill', 'terminate'],
  ['stock', 'equity', 'share', 'ticker', 'security'],
  ['price', 'quote', 'value', 'cost', 'valuation'],
  ['buy', 'purchase', 'order'],
  ['user', 'account', 'person', 'member', 'profile', 'customer'],
  ['file', 'document', 'doc'],
  ['image', 'picture', 'photo'],
  ['schedule', 'calendar', 'appointment', 'meeting', 'event'],
  ['summary', 'summarize', 'digest'],
];

/** Each word of {@link SYNONYM_GROUPS} with the other words of its groups. */
const SYNONYMS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      const others = map.get(word) ?? new Set<string>();
      for (const other of group) if (other !== word) others.add(other);
      map.set(word, others);
    }
  }
  return map;
})();

/** How many leading characters `a` and `b` share. */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether two different words are related: synonyms, or one word family - the
 * shorter, at least 4 letters long, starts the longer (`send` / `sending`,
 * `create` / `created`). A shared start alone is not enough: `currency` and
 * `current` are not related.
 */
function related(a: string, b: string): boolean {
  if (SYNONYMS.get(a)?.has(b)) return true;
  const shorter = Math.min(a.length, b.length);
  return shorter >= 4 && commonPrefix(a, b) === shorter;
}

/** `'exact'` when `words` has `word`, `'related'` when it has a related word, else `undefined`. */
function match(word: string, words: ReadonlySet<string>): 'exact' | 'related' | undefined {
  if (words.has(word)) return 'exact';
  for (const other of words) if (related(word, other)) return 'related';
  return undefined;
}

/**
 * The names of `tools` that share a word with `query`, best first: each query
 * word found in a tool's name scores 3, in its description 1 (case-insensitive;
 * names split on `_`, `-`, `__` and camelCase; plurals folded). A related word
 * instead - a synonym from a small built-in table (`fetch` / `get`, `share` /
 * `stock`) or the same word family (`send` / `sending`) - scores 2 in the
 * name and 0.5 in the description. Ties are ordered by name; tools with no
 * matching word are left out.
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
    const score = wanted.reduce((sum, word) => {
      const inName = match(word, name);
      const inDescription = match(word, description);
      const namePoints = inName === 'exact' ? NAME_HIT : inName === 'related' ? NAME_RELATED : 0;
      const descriptionPoints = inDescription === 'exact' ? DESCRIPTION_HIT : inDescription === 'related' ? DESCRIPTION_RELATED : 0;
      return sum + namePoints + descriptionPoints;
    }, 0);
    return { name: tool.name, score };
  });
  return scored
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => tool.name);
}
