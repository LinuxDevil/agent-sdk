/**
 * Rejects option keys an API does not know, so a misspelled key from
 * JavaScript, YAML or an `as any` cast fails loudly instead of being ignored
 * (a mistyped `needsApproval` would otherwise run the tool without approval).
 */
import { closestMatch } from './closestMatch';

/**
 * The first key of `options` that is not in `known`, with what is wrong with
 * it ("is not a known option (did you mean 'needsApproval'?)"), or undefined
 * when every key is known. `aliases` maps names other SDKs use to ours (the
 * suggestion may be a path such as `modelSettings.maxTokens`); other unknown
 * keys get the closest known key, if one is a plausible typo. A key whose
 * value is undefined is skipped, since it sets nothing.
 */
export function unknownOptionKey(
  options: object,
  known: Readonly<Record<string, true>>,
  aliases: Readonly<Record<string, string>> = {}
): { key: string; problem: string } | undefined {
  const knownKeys = Object.keys(known);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || Object.hasOwn(known, key)) continue;
    const suggestion = Object.hasOwn(aliases, key) ? aliases[key] : closestMatch(key, knownKeys);
    return { key, problem: `'${key}' is not a known option${suggestion ? ` (did you mean '${suggestion}'?)` : ''}` };
  }
  return undefined;
}
