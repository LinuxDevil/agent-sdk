/**
 * `firstJsonObject` - the shared "first JSON object in a model's prose"
 * scan the judge ({@link ../judge.ts}) and the pass model
 * ({@link ./passModel.ts}) both need. Moved out of judge.ts for L06b so
 * the passes don't duplicate it.
 */

/** How many `{` (and, per `{`, how many `}`) the reply scan tries before it gives up on a long prose reply. */
const MAX_BRACES = 50;

/** A JSON object, or `undefined` when `slice` is not one. */
function objectOf(slice: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(slice);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Indexes of `char` in `text` from `from` on, at most {@link MAX_BRACES}. */
function indexesOf(text: string, char: string, from = 0): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(char, from); i !== -1 && found.length < MAX_BRACES; i = text.indexOf(char, i + 1)) found.push(i);
  return found;
}

/**
 * The first JSON object in `text`: from the earliest `{`, the shortest
 * `{...}` that parses (so braces inside strings or prose are tolerated).
 */
export function firstJsonObject(text: string): Record<string, unknown> | undefined {
  for (const start of indexesOf(text, '{')) {
    for (const end of indexesOf(text, '}', start)) {
      const object = objectOf(text.slice(start, end + 1));
      if (object !== undefined) return object;
    }
  }
  return undefined;
}
