/**
 * How eval results leave the vitest worker (LOU-D8).
 *
 * `loushy eval` sets `LOUSHY_EVAL_RESULTS` to a file path; every eval case
 * appends its `EvalResult` there as one JSON line. A file (rather than a
 * custom vitest reporter) is deliberate: it works with every vitest version
 * and worker pool, needs no module resolved from the user's project, and
 * `appendFileSync` of one short line is safe across parallel workers.
 * `LOUSHY_EVAL_TAGS` carries the `--tag` filter the other way.
 */
import * as fs from 'node:fs';
import type { EvalResult } from './evalResult';

/** Environment variable naming the JSON-lines file results are appended to. */
export const RESULTS_ENV = 'LOUSHY_EVAL_RESULTS';
/** Environment variable holding a comma-separated `--tag` filter. */
export const TAGS_ENV = 'LOUSHY_EVAL_TAGS';

/** Appends `result` to the results file when `loushy eval` asked for one. */
export function recordEvalResult(result: EvalResult): void {
  const file = process.env[RESULTS_ENV];
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify(result)}\n`);
}

/** True when no `--tag` filter is active or `tags` shares a tag with it. */
export function matchesTagFilter(tags: readonly string[]): boolean {
  const wanted = (process.env[TAGS_ENV] ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return wanted.length === 0 || tags.some((tag) => wanted.includes(tag));
}
