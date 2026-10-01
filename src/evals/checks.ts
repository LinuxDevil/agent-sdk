/**
 * Value checks for `t.check()` / `t.soft()` (LOU-D7).
 *
 * A check judges one value (a reply string, a judge score, a number) and
 * says why it failed. `includes`, `matches` and `equals` are yes/no;
 * `atLeast` and `atMost` compare a number against a threshold.
 */

/** Outcome of running a {@link Check}. */
export interface CheckOutcome {
  /** 0 or 1 for yes/no checks; the compared value for `atLeast`/`atMost`. */
  score: number;
  passed: boolean;
  /** Why the check failed; absent when it passed. */
  message?: string;
  threshold?: number;
}

/**
 * A reusable assertion over a value of type `T`.
 *
 * @example
 * ```ts
 * const mentionsPolicy: Check<string> = includes('30 days');
 * ```
 */
export interface Check<T> {
  evaluate(value: T): CheckOutcome;
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const shown = text.length > 160 ? `${text.slice(0, 157)}...` : text;
  return typeof value === 'string' ? JSON.stringify(shown) : shown;
}

function yesNo(passed: boolean, failure: string): CheckOutcome {
  return { score: passed ? 1 : 0, passed, threshold: 1, message: passed ? undefined : failure };
}

/**
 * Passes when the string contains `needle` (case-sensitive).
 *
 * @example
 * ```ts
 * t.check('mentions policy', t.reply, includes('30 days'));
 * ```
 */
export function includes(needle: string): Check<string> {
  return {
    evaluate: (value) =>
      yesNo(value.includes(needle), `expected ${preview(value)} to include ${JSON.stringify(needle)}`),
  };
}

/**
 * Passes when the string matches `pattern`.
 *
 * @example
 * ```ts
 * t.check('has an order id', t.reply, matches(/#\d+/));
 * ```
 */
export function matches(pattern: RegExp): Check<string> {
  return {
    evaluate: (value) => {
      // A fresh RegExp without the `g` flag keeps `test()` stateless across calls.
      const stateless = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      return yesNo(stateless.test(value), `expected ${preview(value)} to match ${pattern}`);
    },
  };
}

/**
 * Passes when the value equals `expected` (compared by JSON form).
 *
 * @example
 * ```ts
 * t.check('exact reply', t.reply, equals('Done.'));
 * ```
 */
export function equals<T>(expected: T): Check<T> {
  return {
    evaluate: (value) =>
      yesNo(
        JSON.stringify(value) === JSON.stringify(expected),
        `expected ${preview(value)} to equal ${preview(expected)}`
      ),
  };
}

/**
 * Passes when the number is at least `threshold`; the number is the score.
 *
 * @example
 * ```ts
 * t.soft('tone', await t.judge('Is the reply polite?'), atLeast(0.7));
 * ```
 */
export function atLeast(threshold: number): Check<number> {
  return {
    evaluate: (value) => {
      const passed = value >= threshold;
      const message = passed ? undefined : `score ${value} is below the threshold ${threshold}`;
      return { score: value, passed, threshold, message };
    },
  };
}

/**
 * Passes when the number is at most `limit`; the number is the score.
 *
 * @example
 * ```ts
 * t.check('latency', elapsedMs, atMost(2000));
 * ```
 */
export function atMost(limit: number): Check<number> {
  return {
    evaluate: (value) => {
      const passed = value <= limit;
      const message = passed ? undefined : `value ${value} is above the limit ${limit}`;
      return { score: value, passed, threshold: limit, message };
    },
  };
}
