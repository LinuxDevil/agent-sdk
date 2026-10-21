/**
 * Budgets: `limits` on a run, and on a session's turns, checked by
 * the executor before every model call (so after every tool batch), after
 * a model call that asks for tools, and - for `maxDurationMs` - by a timer
 * that aborts the run's signal.
 */

import type { Message } from '../providers';
import type { RunUsage } from '../models/usage';
import { ConfigurationError, SDKError } from './errors';
import { brandClass } from '../utils/brand';

/** Limits on a run (`createAgent({ limits })`, `ExecuteOptions.limits`) or on a session (`agent.session({ limits })`). */
export interface RunLimits {
  /** Prompt plus completion tokens, including delegated sub-agents. */
  maxTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** USD (`usage.costUsd`): the provider-reported cost, else the registry's estimate; not checked (a warning naming the model is logged once) while a model used has unknown pricing. */
  maxCostUsd?: number;
  /** Wall-clock time; an in-flight model or tool call is aborted when it runs out. */
  maxDurationMs?: number;
  /** Model steps: an alias of `maxSteps` (the stricter wins). */
  maxSteps?: number;
  /**
   * Tool calls of the run that ended in an error result (`result.toolErrors`): once this many have failed, the run
   * stops before its next model call. Off by default. Counted per run - on `agent.session({ limits })`, per turn.
   */
  maxToolErrors?: number;
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
    super(`The ${budget.scope} limit ${budget.limit} (${budget.max}) was reached: ${budget.value}.`, 'LOUSHO_BUDGET_EXCEEDED');
    this.name = 'BudgetExceededError';
  }
}
brandClass(BudgetExceededError, 'BudgetExceededError');

const SPENT_KEYS: Record<Exclude<BudgetLimit, 'maxToolErrors'>, keyof BudgetSpent> = {
  maxTokens: 'totalTokens',
  maxInputTokens: 'inputTokens',
  maxOutputTokens: 'outputTokens',
  maxCostUsd: 'costUsd',
  maxDurationMs: 'durationMs',
  maxSteps: 'steps',
};

const warnedUnknownCost = new Set<string>();

/** Warns (once per process and model) that `maxCostUsd` cannot be enforced because `model` has no known price. */
function warnUnknownCost(model: string): void {
  if (warnedUnknownCost.has(model)) return;
  warnedUnknownCost.add(model);
  console.warn(
    `[lousho] limits.maxCostUsd is set, but the price of model '${model}' is unknown (it is not in the price registry and the provider reported no cost), ` +
      `so the cost limit is NOT enforced for it. Register a price: registerModel({ id: '${model}', provider: '<provider>', contextWindow: 8192, inputCostPerMTok: 0, outputCostPerMTok: 0 }) ` +
      '(0 counts the model as free), or use a provider that reports cost (OpenRouter does). See https://lousho.com/models-and-cost#models-and-the-price-table'
  );
}

/** The models of `byModel` with no known cost, else `'unknown'` when none is recorded. */
function unpricedModels(byModel: RunUsage['byModel'] | undefined): string[] {
  const ids = Object.entries(byModel ?? {}).filter(([, m]) => m.costUsd === undefined).map(([id]) => id);
  return ids.length > 0 ? ids : ['unknown'];
}

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
  /** The first limit the run has reached; `afterModelCall` leaves out `maxSteps`. `toolErrors`: the run's failed tool calls so far. */
  check(usage: RunUsage, steps: number, afterModelCall?: boolean, toolErrors?: number): BudgetExceeded | undefined;
  mode(budget: BudgetExceeded): 'stop' | 'throw';
  dispose(): void;
}

/** The first spend limit of `max` that `total` reaches; `afterModelCall` leaves out `maxSteps`, `quietUnknownCost` the unknown-cost warning. */
function spendLimitReached(max: RunLimits, total: BudgetSpent, afterModelCall: boolean, quietUnknownCost: boolean, byModel?: RunUsage['byModel']): Omit<BudgetExceeded, 'scope'> | undefined {
  for (const [limit, key] of Object.entries(SPENT_KEYS) as Array<[Exclude<BudgetLimit, 'maxToolErrors'>, keyof BudgetSpent]>) {
    const value = total[key];
    const cap = max[limit];
    if (cap !== undefined && value === undefined && limit === 'maxCostUsd' && !quietUnknownCost) unpricedModels(byModel).forEach(warnUnknownCost);
    if (cap === undefined || value === undefined || (afterModelCall && limit === 'maxSteps')) continue;
    if (value >= cap) return { limit, value, max: cap };
  }
  return undefined;
}

/** Starts the run's budget; `undefined` without limits. */
/** `quietUnknownCost` (a scripted mock provider, which has no price) skips the unknown-cost warning. */
export function startBudget(limits?: RunLimits, session?: SessionBudget, signal?: AbortSignal, quietUnknownCost = false): RunBudget | undefined {
  const scopes = [
    ...(limits ? [{ scope: 'run' as const, limits, spent: NOTHING_SPENT }] : []),
    ...(session ? [{ scope: 'session' as const, ...session }] : []),
  ];
  if (scopes.length === 0) return undefined;
  const startedAt = Date.now();
  const check = (usage: Pick<RunUsage, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd'> & Partial<Pick<RunUsage, 'byModel'>>, steps: number, afterModelCall = false, toolErrors = 0) => {
    const now = runSpent(usage, steps, Date.now() - startedAt);
    for (const { scope, limits: max, spent } of scopes) {
      // Failed tool calls count per run, also under a session's limits.
      if (max.maxToolErrors !== undefined && toolErrors >= max.maxToolErrors) return { limit: 'maxToolErrors' as const, value: toolErrors, max: max.maxToolErrors, scope };
      const reached = spendLimitReached(max, addSpent(spent, now), afterModelCall, quietUnknownCost, usage.byModel);
      if (reached) return { ...reached, scope };
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

/**
 * A sub-agent run's view of its lead run's limits: called with what the sub-agent has spent so far, returns
 * the limit the lead reaches with it (the lead's own spend and its other sub-agents' still running included).
 */
export type LeadBudget = (childUsage: RunUsage) => BudgetExceeded | undefined;

/** An internal option of a sub-agent run: its {@link LeadBudget}, set by the lead's executor. */
export const LEAD_BUDGET = Symbol('lousho.leadBudget');

/** Options carrying {@link LEAD_BUDGET}. */
export interface LeadBudgetOptions {
  [LEAD_BUDGET]?: LeadBudget;
}

/**
 * A sub-agent's budget: its own limits, then its lead's. A lead limit stops the sub-agent (`'stop'`, never
 * `'throw'`: the lead decides how its own run ends) before its next model call or tools, so parallel sub-agents
 * share the lead's budget instead of each spending all of it. `signal` is the run's own when it has no limits.
 */
export function withLeadBudget(own: RunBudget | undefined, lead: LeadBudget | undefined, signal: AbortSignal | undefined): RunBudget | undefined {
  if (!lead) return own;
  const fromLead = new WeakSet<BudgetExceeded>();
  return {
    signal: own ? own.signal : signal,
    check: (usage, steps, afterModelCall, toolErrors) => {
      const reached = own?.check(usage, steps, afterModelCall, toolErrors);
      if (reached) return reached;
      const leadReached = lead(usage);
      if (leadReached) fromLead.add(leadReached);
      return leadReached;
    },
    mode: (budget) => (fromLead.has(budget) || !own ? 'stop' : own.mode(budget)),
    dispose: () => own?.dispose(),
  };
}

/** Throws `LOUSHO_CONFIG_INVALID` unless `maxSteps` is unset or a whole number >= 1. */
export function assertMaxSteps(value: unknown, caller: string): void {
  if (value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1)) return;
  throw new ConfigurationError(
    `${caller}: 'maxSteps' must be a whole number >= 1, got ${typeof value === 'string' ? `'${value}'` : String(value)}.`,
    'maxSteps'
  );
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
