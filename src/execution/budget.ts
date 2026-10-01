/**
 * Budgets (LOU-V6): `limits` on a run, and on a session's turns, checked by
 * the executor before every model call (so after every tool batch), after
 * a model call that asks for tools, and - for `maxDurationMs` - by a timer
 * that aborts the run's signal.
 */

import type { Message } from '../providers';
import type { RunUsage } from '../models/usage';
import { SDKError } from './errors';

/** Limits on a run (`createAgent({ limits })`, `ExecuteOptions.limits`) or on a session (`agent.session({ limits })`). */
export interface RunLimits {
  /** Prompt plus completion tokens, including delegated sub-agents. */
  maxTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Estimated USD (`usage.costUsd`); not checked while a model used has unknown pricing. */
  maxCostUsd?: number;
  /** Wall-clock time; an in-flight model or tool call is aborted when it runs out. */
  maxDurationMs?: number;
  /** Model steps: an alias of `maxSteps` (the stricter wins). */
  maxSteps?: number;
  /** `'stop'` (default): resolve with `finishReason: 'budget-exceeded'`. `'throw'`: reject with `BudgetExceededError`. */
  onExceeded?: 'stop' | 'throw';
}

/** The name of a limit. */
export type BudgetLimit = Exclude<keyof RunLimits, 'onExceeded'>;

/** The limit that stopped a run: `result.budget` and the `budget.exceeded` event. */
export interface BudgetExceeded {
  limit: BudgetLimit;
  /** What was spent when it tripped (for a session limit: by the whole session). */
  value: number;
  max: number;
  /** `'session'` for an `agent.session({ limits })` limit. */
  scope: 'run' | 'session';
}

/** What a session's turns spent, kept on its transcript's last message (`metadata.sessionUsage`). */
export interface BudgetSpent {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  steps: number;
  durationMs: number;
}

/** A session's limits and what its earlier turns spent; set by `agent.session({ limits })`. */
export interface SessionBudget {
  limits: RunLimits;
  spent: BudgetSpent;
}

/** Thrown when a limit trips under `onExceeded: 'throw'`; `budget` says which. */
export class BudgetExceededError extends SDKError {
  constructor(readonly budget: BudgetExceeded) {
    super(`The ${budget.scope} limit ${budget.limit} (${budget.max}) was reached: ${budget.value}.`, 'LOUSHY_BUDGET_EXCEEDED');
    this.name = 'BudgetExceededError';
  }
}

const SPENT_KEYS: Record<BudgetLimit, keyof BudgetSpent> = {
  maxTokens: 'totalTokens',
  maxInputTokens: 'inputTokens',
  maxOutputTokens: 'outputTokens',
  maxCostUsd: 'costUsd',
  maxDurationMs: 'durationMs',
  maxSteps: 'steps',
};

const NOTHING_SPENT: BudgetSpent = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, steps: 0, durationMs: 0 };

/** `a + b`, field by field (`costUsd` is unknown when either is). */
export function addSpent(a: BudgetSpent, b: BudgetSpent): BudgetSpent {
  const costUsd = a.costUsd === undefined || b.costUsd === undefined ? undefined : a.costUsd + b.costUsd;
  const sum = (key: Exclude<keyof BudgetSpent, 'costUsd'>) => a[key] + b[key];
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), costUsd, steps: sum('steps'), durationMs: sum('durationMs') };
}

/** A run's spend as {@link BudgetSpent}. */
export function runSpent(usage: Pick<RunUsage, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd'>, steps: number, durationMs: number): BudgetSpent {
  const { inputTokens, outputTokens, totalTokens, costUsd } = usage;
  return { inputTokens, outputTokens, totalTokens, costUsd, steps, durationMs };
}

/** What a session spent: the newest `metadata.sessionUsage` of its transcript. */
export function sessionSpent(messages: readonly Message[]): BudgetSpent {
  for (let i = messages.length - 1; i >= 0; i--) {
    const spent = messages[i].metadata?.sessionUsage;
    if (spent) return spent as BudgetSpent;
  }
  return NOTHING_SPENT;
}

/** A run's budget: its limits (and a session's) and the `maxDurationMs` timer. */
export interface RunBudget {
  /** The run's signal, aborted with a `BudgetExceededError` when `maxDurationMs` runs out. */
  readonly signal: AbortSignal | undefined;
  /** The first limit the run has reached; `afterModelCall` leaves out `maxSteps`. */
  check(usage: RunUsage, steps: number, afterModelCall?: boolean): BudgetExceeded | undefined;
  mode(budget: BudgetExceeded): 'stop' | 'throw';
  dispose(): void;
}

/** Starts the run's budget; `undefined` without limits. */
export function startBudget(limits?: RunLimits, session?: SessionBudget, signal?: AbortSignal): RunBudget | undefined {
  const scopes = [
    ...(limits ? [{ scope: 'run' as const, limits, spent: NOTHING_SPENT }] : []),
    ...(session ? [{ scope: 'session' as const, ...session }] : []),
  ];
  if (scopes.length === 0) return undefined;
  const startedAt = Date.now();
  const check = (usage: Pick<RunUsage, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd'>, steps: number, afterModelCall = false) => {
    const now = runSpent(usage, steps, Date.now() - startedAt);
    for (const { scope, limits: max, spent } of scopes) {
      const total = addSpent(spent, now);
      for (const [limit, key] of Object.entries(SPENT_KEYS) as Array<[BudgetLimit, keyof BudgetSpent]>) {
        const value = total[key];
        const cap = max[limit];
        if (cap === undefined || value === undefined || (afterModelCall && limit === 'maxSteps')) continue;
        if (value >= cap) return { limit, value, max: cap, scope };
      }
    }
    return undefined;
  };

  // The `maxDurationMs` that runs out first aborts the run's signal.
  const [first] = scopes
    .filter((s) => s.limits.maxDurationMs !== undefined)
    .map((s) => ({ ...s, max: s.limits.maxDurationMs ?? 0, left: (s.limits.maxDurationMs ?? 0) - s.spent.durationMs }))
    .sort((a, b) => a.left - b.left);
  const controller = new AbortController();
  const timer = first && setTimeout(() => {
    const value = Math.max(first.max, first.spent.durationMs + Date.now() - startedAt);
    controller.abort(new BudgetExceededError({ limit: 'maxDurationMs', value, max: first.max, scope: first.scope }));
  }, Math.max(0, first.left));

  return {
    signal: !timer ? signal : signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    check,
    mode: (budget) => (budget.scope === 'run' ? limits : session?.limits)?.onExceeded ?? 'stop',
    dispose: () => clearTimeout(timer),
  };
}

/** The run's step limit: `maxSteps`, or 10 - unless `limits.maxSteps` is set alone, which then is the limit. */
export function maxStepsOf({ maxSteps, limits }: { maxSteps?: number; limits?: RunLimits }): number {
  if (maxSteps !== undefined) return maxSteps;
  return limits?.maxSteps === undefined ? 10 : Infinity;
}

/** The limit whose `maxDurationMs` timer aborted `signal`, if that is why it is aborted. */
export function budgetOfAbort(signal: AbortSignal | undefined): BudgetExceeded | undefined {
  return signal?.aborted && signal.reason instanceof BudgetExceededError ? signal.reason.budget : undefined;
}
