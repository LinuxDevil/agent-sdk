/**
 * Scorers for defineEval() (LOU-G3/G4/G5)
 *
 * All scorer factories return a plain, synchronous `(result: ExecutionResult) => number`
 * function - the same shape defineEval()'s `score` field expects. None of
 * them throw on a non-match/mismatch; they simply return 0.
 */

import { ExecutionResult } from '../execution/AgentExecutor';

// ---------------------------------------------------------------------------
// LOU-G3: rule-based / exact-match scorer
// ---------------------------------------------------------------------------

/**
 * A matcher against the ExecutionResult's `.text` field: exact string
 * equality, a RegExp tested against the text, or a predicate function.
 */
export type Matcher = string | RegExp | ((text: string) => boolean);

/**
 * Returns a scorer that checks `result.text` against `matcher`:
 *  - string: exact equality
 *  - RegExp: `.test(text)`
 *  - function: called with `text`, its boolean return is used
 *
 * Never throws for a non-match - always resolves to 1 (match) or 0
 * (no match).
 */
export function exactMatch(matcher: Matcher): (result: ExecutionResult) => number {
  return (result: ExecutionResult): number => {
    const text = result.text ?? '';

    try {
      if (typeof matcher === 'string') {
        return text === matcher ? 1 : 0;
      }
      if (matcher instanceof RegExp) {
        return matcher.test(text) ? 1 : 0;
      }
      return matcher(text) ? 1 : 0;
    } catch {
      // A throwing predicate is treated as a non-match, not a scorer crash.
      return 0;
    }
  };
}
