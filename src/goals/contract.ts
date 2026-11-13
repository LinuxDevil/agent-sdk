import { z } from 'zod';
import type { Check } from '../evals/checks';

/** When a goal loop stops even though the goal is not met. */
export interface GoalStop {
  /** Most iterations, 1 to 50 (A12). */
  maxIterations: number;
  /** Wall-clock cap for the whole loop, in milliseconds. */
  maxDurationMs?: number;
  /** Spend cap for the whole loop, in US dollars; required because goals loop (F5.3). */
  maxCostUsd: number;
  /** What a stall does: `stop` ends the loop as `stalled` (default), `continue` keeps going to the other limits. */
  onStall?: 'stop' | 'continue';
  /** How many iterations in a row without a better check score count as a stall (default 2). */
  stallAfter?: number;
}

/** One goal check: the id of a harness `evaluation.criteria` entry. */
export interface GoalCheckRef {
  /** The criterion id, from the page's effective harness. */
  criterion: string;
}

/** `goal.json` (`lousho.goal/1`): the goal, the criteria that say it is met, and the stop limits. Structure: never edited by improvement (R10). */
export interface GoalSpec {
  /** Schema id; always `lousho.goal/1`. */
  schema: 'lousho.goal/1';
  /** The goal, in words. */
  goal: string;
  /** The criteria that must all pass; at least one must have an executable `check` (R19). */
  checks: GoalCheckRef[];
  /** The stop limits. */
  stop: GoalStop;
}

const nonEmpty = z.string().min(1, 'must not be empty');

const goalStopObjectSchema = z
  .object({
    maxIterations: z.number().int().min(1, 'must be at least 1').max(50, 'must be at most 50 (A12)'),
    maxDurationMs: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive(),
    onStall: z.enum(['stop', 'continue']).optional(),
    stallAfter: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const goalObjectSchema = z
  .object({
    schema: z.literal('lousho.goal/1'),
    goal: nonEmpty,
    checks: z.array(z.object({ criterion: nonEmpty }).strict()).min(1, 'must name at least one criterion'),
    stop: goalStopObjectSchema,
  })
  .strict();

/** Zod schema for `goal.json` (`lousho.goal/1`); every object is strict. */
export const goalSchema: z.ZodType<GoalSpec> = goalObjectSchema;

/** A criterion as the goal contract needs it: its id and whether it has a check or only a rubric. */
export interface GoalCriterionInfo {
  /** Criterion id. */
  id: string;
  /** Path of the executable check, when it has one. */
  check?: string;
  /** Rubric text, when it has one. */
  rubric?: string;
}

/** One problem `goalProblems` found. */
export interface GoalProblem {
  /** `missing-criterion`: a check names an id no layer defines; `no-executable-check`: every named criterion is rubric-only. */
  kind: 'missing-criterion' | 'no-executable-check';
  /** Index in `checks` of the offending check, for `missing-criterion`. */
  index?: number;
  /** What is wrong, for people. */
  message: string;
}

function missingProblems(goal: Pick<GoalSpec, 'checks'>, known: ReadonlyMap<string, GoalCriterionInfo>): GoalProblem[] {
  return goal.checks.flatMap((check, index) =>
    known.has(check.criterion) ? [] : [{ kind: 'missing-criterion' as const, index, message: `check names criterion '${check.criterion}', which no layer defines` }]
  );
}

function executableProblem(goal: Pick<GoalSpec, 'checks'>, known: ReadonlyMap<string, GoalCriterionInfo>): GoalProblem[] {
  const named = goal.checks.map((check) => known.get(check.criterion)).filter((info): info is GoalCriterionInfo => info !== undefined);
  if (named.length === 0 || named.some((info) => typeof info.check === 'string' && info.check.length > 0)) return [];
  return [{ kind: 'no-executable-check', message: 'every criterion this goal names is rubric-only; name at least one criterion with an executable check (R19)' }];
}

/** The problems of a goal's checks against the page's effective criteria. */
export function goalProblems(goal: Pick<GoalSpec, 'checks'>, criteria: readonly GoalCriterionInfo[]): GoalProblem[] {
  const known = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  return [...missingProblems(goal, known), ...executableProblem(goal, known)];
}

/** One criterion's verdict on one iteration's output. */
export interface GoalCriterionResult {
  /** The criterion id. */
  criterion: string;
  /** Whether it passed; `undefined` when the criterion had no executable check (rubric-only never gates, A11). */
  passed?: boolean;
  /** Its score from 0 to 1, when it ran. */
  score?: number;
  /** Why it failed, when it did. */
  message?: string;
}

/** The verdict of a goal check on one iteration. */
export interface GoalCheckResult {
  /** True when every executable named criterion passed. */
  done: boolean;
  /** Mean score of the executable criteria, from 0 to 1; the loop's stall detection compares it. */
  score: number;
  /** One line: the failed criteria and their messages, or `all checks pass`. */
  reason: string;
  /** Each named criterion's verdict, in `checks` order. */
  results: GoalCriterionResult[];
}

/** Checks one iteration's output; it must not change anything. */
export type GoalCheck = (context: {
  /** The iteration, from 1. */
  iteration: number;
  /** The iteration's output: the lead's structured output, or its text. */
  output: unknown;
}) => Promise<GoalCheckResult>;

function runOne(criterion: string, check: Check<unknown> | undefined, output: unknown): GoalCriterionResult {
  if (check === undefined) return { criterion };
  try {
    const outcome = check.evaluate(output);
    return { criterion, passed: outcome.passed, score: outcome.score, ...(outcome.message !== undefined && { message: outcome.message }) };
  } catch (error) {
    return { criterion, passed: false, score: 0, message: error instanceof Error ? error.message : String(error) };
  }
}

function verdict(results: readonly GoalCriterionResult[]): GoalCheckResult {
  const ran = results.filter((result) => result.passed !== undefined);
  const failed = ran.filter((result) => result.passed === false);
  const score = ran.length === 0 ? 0 : ran.reduce((sum, result) => sum + (result.score ?? 0), 0) / ran.length;
  const reason = failed.length === 0 ? 'all checks pass' : failed.map((result) => `${result.criterion}: ${result.message ?? 'failed'}`).join('; ');
  return { done: ran.length > 0 && failed.length === 0, score, reason, results: [...results] };
}

/** Builds the `GoalCheck` that evaluates the goal's named criteria with the given executable checks, keyed by criterion id. */
export function goalCheck(goal: Pick<GoalSpec, 'checks'>, checks: Readonly<Record<string, Check<unknown>>>): GoalCheck {
  return async ({ output }) => verdict(goal.checks.map(({ criterion }) => runOne(criterion, checks[criterion], output)));
}
