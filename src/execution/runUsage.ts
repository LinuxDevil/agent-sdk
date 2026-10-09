/**
 * Accumulation of a run's usage (LOU-V5): per-call measurement (reported or
 * estimated), the running RunUsage, delegated-child roll-up, and
 * rehydration from a checkpoint.
 */

import type { GenerateResult, Message } from '../providers';
import { estimateCost, estimateTokens } from '../models';
import { normalizeUsage } from '../models/usage';
import type { CallUsage, DelegatedUsage, RunUsage, Usage } from '../models/usage';
import type { AgentEventUsage } from './agentEvents';
import { addHostedCounts } from './hostedToolCalls';

/** Model id that pre-LOU-V5 checkpoint tokens are attributed to. */
const UNKNOWN_MODEL = 'unknown';

/** M10b: prefix of the `byModel` key a remote sub-agent's usage is filed under (`remote:<agent name>`). */
const REMOTE_MODEL_PREFIX = 'remote:';

/** The `byModel` key of remote sub-agent `name`'s usage. */
export function remoteModelKey(name: string): string {
  return `${REMOTE_MODEL_PREFIX}${name}`;
}

/** A remote entry keeps the cost the remote reported: there is no model id to price it by. */
const isRemoteKey = (model: string): boolean => model.startsWith(REMOTE_MODEL_PREFIX);

const addCost = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined || b === undefined ? undefined : a + b);

/** A fresh, empty run total. */
export function emptyRunUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    estimated: false,
    byModel: {},
    promptTokens: 0,
    completionTokens: 0,
  };
}

function estimatedUsage(model: string, messages: Message[], generated: GenerateResult): Usage {
  const calls = (generated.toolCalls ?? []).map((c) => `${c.function.name} ${c.function.arguments}`);
  const inputTokens = estimateTokens(messages, { model });
  const outputTokens = estimateTokens([generated.text, ...calls].join('\n'), { model });
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/**
 * What a call spent: the provider's reported usage, or - when it reported
 * none - an `estimateTokens` estimate of the request and reply (flagged).
 */
export function measureUsage(
  model: string,
  requestMessages: Message[],
  generated: GenerateResult
): CallUsage {
  const reported = normalizeUsage(generated.usage);
  const usage = reported ?? estimatedUsage(model, requestMessages, generated);
  // A cost the provider billed (OpenRouter's `usage.cost`) beats the registry's estimate.
  const billed = generated.usage?.costUsd;
  const costUsd = typeof billed === 'number' && Number.isFinite(billed) && billed >= 0 ? billed : estimateCost(usage, model);
  return { model, usage, estimated: !reported, costUsd };
}

type OptionalCount = 'cachedInputTokens' | 'cacheWriteTokens' | 'reasoningTokens';

function addOptional(run: RunUsage, key: OptionalCount, add: number | undefined): void {
  if (add !== undefined) run[key] = (run[key] ?? 0) + add;
}

/** Sums the per-model costs into the total, and sets the legacy aliases. */
function refreshDerived(run: RunUsage): void {
  let total: number | undefined = 0;
  for (const entry of Object.values(run.byModel)) total = addCost(total, entry.costUsd);
  run.costUsd = total;
  run.promptTokens = run.inputTokens;
  run.completionTokens = run.outputTokens;
}

function addToModel(
  run: RunUsage,
  model: string,
  tokens: { inputTokens: number; outputTokens: number; costUsd?: number },
  calls: number
): void {
  const existing = run.byModel[model];
  const entry = (run.byModel[model] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
  entry.inputTokens += tokens.inputTokens;
  entry.outputTokens += tokens.outputTokens;
  entry.calls += calls;
  entry.costUsd = existing ? addCost(existing.costUsd, tokens.costUsd) : tokens.costUsd;
}

/** Adds one model call to the run total (mutates). */
export function recordStepUsage(run: RunUsage, step: CallUsage): void {
  const { usage } = step;
  run.inputTokens += usage.inputTokens;
  run.outputTokens += usage.outputTokens;
  run.totalTokens += usage.totalTokens;
  run.modelCalls += 1;
  run.estimated ||= step.estimated;
  addOptional(run, 'cachedInputTokens', usage.cachedInputTokens);
  addOptional(run, 'cacheWriteTokens', usage.cacheWriteTokens);
  addOptional(run, 'reasoningTokens', usage.reasoningTokens);
  addToModel(run, step.model, { ...usage, costUsd: step.costUsd ?? estimateCost(usage, step.model) }, 1);
  refreshDerived(run);
}

function delegatedTotals(before: DelegatedUsage | undefined, child: RunUsage): DelegatedUsage {
  const prior = before ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0 as number | undefined,
    modelCalls: 0,
    estimated: false,
    runs: 0,
  };
  return {
    inputTokens: prior.inputTokens + child.inputTokens,
    outputTokens: prior.outputTokens + child.outputTokens,
    totalTokens: prior.totalTokens + child.totalTokens,
    costUsd: addCost(prior.costUsd, child.costUsd),
    modelCalls: prior.modelCalls + child.modelCalls,
    estimated: prior.estimated || child.estimated,
    runs: prior.runs + 1,
  };
}

/** The usage a run had spent when it threw, by the error it threw (Eve MA-F1). */
const failedRunUsage = new WeakMap<object, RunUsage>();

/**
 * Records on `error` what the run that threw it had spent, so a lead can still
 * count a failed sub-agent's tokens. The outermost run that rethrows the same
 * error records last (its usage includes its children's).
 */
export function attachRunUsage(error: unknown, usage: RunUsage): void {
  if (typeof error === 'object' && error !== null) failedRunUsage.set(error, structuredClone(usage));
}

/** What the run that threw `error` had spent, when {@link attachRunUsage} recorded it. */
export function runUsageOfError(error: unknown): RunUsage | undefined {
  return typeof error === 'object' && error !== null ? failedRunUsage.get(error) : undefined;
}

/** Rolls a finished child agent run's total into the parent's (mutates the parent). */
export function mergeDelegatedUsage(run: RunUsage, child: RunUsage): void {
  run.inputTokens += child.inputTokens;
  run.outputTokens += child.outputTokens;
  run.totalTokens += child.totalTokens;
  run.modelCalls += child.modelCalls;
  run.estimated ||= child.estimated;
  addOptional(run, 'cachedInputTokens', child.cachedInputTokens);
  addOptional(run, 'cacheWriteTokens', child.cacheWriteTokens);
  addOptional(run, 'reasoningTokens', child.reasoningTokens);
  for (const [model, entry] of Object.entries(child.byModel)) addToModel(run, model, entry, entry.calls);
  addHostedCounts(run, child.hostedToolCalls);
  run.delegated = delegatedTotals(run.delegated, child);
  refreshDerived(run);
}

/**
 * M10b: a remote sub-agent run's `run.done` usage as a {@link RunUsage}, to roll into the lead's totals. The remote
 * sends no per-model breakdown, so `byModel` has one entry under `modelKey` (see {@link remoteModelKey}) holding the
 * totals and the remote's own cost estimate (`undefined` when it sent none).
 */
export function fromEventUsage(usage: AgentEventUsage, modelKey: string): RunUsage {
  const { inputTokens, outputTokens, totalTokens, estimated, costUsd } = usage;
  const calls = usage.modelCalls ?? 1;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    modelCalls: calls,
    estimated,
    byModel: { [modelKey]: { inputTokens, outputTokens, calls, costUsd } },
    ...(usage.hostedToolCalls && { hostedToolCalls: { ...usage.hostedToolCalls } }),
    promptTokens: inputTokens,
    completionTokens: outputTokens,
  };
}

/** N1a: the per-tool hosted call counts of `now` after `before`; absent when none remain. */
function hostedSince(now: RunUsage['hostedToolCalls'], before: RunUsage['hostedToolCalls']): Pick<RunUsage, 'hostedToolCalls'> {
  const counts = Object.entries(now ?? {})
    .map(([name, count]) => [name, since(count ?? 0, before?.[name])] as const)
    .filter(([, count]) => count > 0);
  return counts.length > 0 ? { hostedToolCalls: Object.fromEntries(counts) } : {};
}

const since = (now: number, before: number | undefined): number => Math.max(0, now - (before ?? 0));

/**
 * M10b: what a run spent after `before`, given its cumulative usage `now` (a remote run resumed after an approval
 * reports its usage from its start, the turn before the pause included). Counts never go below zero.
 */
export function usageSince(now: RunUsage, before: RunUsage | undefined): RunUsage {
  if (!before) return now;
  const inputTokens = since(now.inputTokens, before.inputTokens);
  const outputTokens = since(now.outputTokens, before.outputTokens);
  const costUsd = now.costUsd === undefined || before.costUsd === undefined ? now.costUsd : Math.max(0, now.costUsd - before.costUsd);
  const byModel: RunUsage['byModel'] = {};
  for (const [model, entry] of Object.entries(now.byModel)) {
    const prior = before.byModel[model];
    const cost = entry.costUsd === undefined || prior?.costUsd === undefined ? entry.costUsd : Math.max(0, entry.costUsd - prior.costUsd);
    byModel[model] = { inputTokens: since(entry.inputTokens, prior?.inputTokens), outputTokens: since(entry.outputTokens, prior?.outputTokens), calls: since(entry.calls, prior?.calls), costUsd: cost };
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: since(now.totalTokens, before.totalTokens),
    costUsd,
    modelCalls: since(now.modelCalls, before.modelCalls),
    estimated: now.estimated,
    byModel,
    ...hostedSince(now.hostedToolCalls, before.hostedToolCalls),
    promptTokens: inputTokens,
    completionTokens: outputTokens,
  };
}

/** What a checkpoint stores of a run's usage: always the pre-LOU-V5 fields, plus the rest of RunUsage on newer ones. */
export type CheckpointUsage = Pick<RunUsage, 'promptTokens' | 'completionTokens' | 'totalTokens'> &
  Partial<RunUsage>;

/**
 * Rehydrates a checkpointed run total. Checkpoints written before LOU-V5
 * only carry token counts: those are kept (attributed to the `unknown`
 * model, so `costUsd` is `undefined` rather than a misleading partial sum).
 */
export function restoreRunUsage(saved: CheckpointUsage): RunUsage {
  const run = emptyRunUsage();
  if (saved.byModel && typeof saved.modelCalls === 'number') {
    Object.assign(run, structuredClone(saved));
  } else {
    run.inputTokens = saved.promptTokens;
    run.outputTokens = saved.completionTokens;
    run.totalTokens = saved.totalTokens;
    if (saved.totalTokens > 0) addToModel(run, UNKNOWN_MODEL, { ...run, costUsd: undefined }, 0);
  }
  // A saved entry keeps the cost it was billed at; one without is priced from the registry.
  for (const [model, entry] of Object.entries(run.byModel)) entry.costUsd ??= isRemoteKey(model) ? undefined : estimateCost(entry, model);
  refreshDerived(run);
  return run;
}
