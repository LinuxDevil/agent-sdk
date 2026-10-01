/**
 * Accumulation of a run's usage (LOU-V5): per-call measurement (reported or
 * estimated), the running RunUsage, delegated-child roll-up, and
 * rehydration from a checkpoint.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { GenerateResult, Message } from '../providers';
import { estimateCost, estimateTokens } from '../models';
import { normalizeUsage } from '../models/usage';
import type { CallUsage, DelegatedUsage, RunUsage, Usage } from '../models/usage';

/** Model id that pre-LOU-V5 checkpoint tokens are attributed to. */
const UNKNOWN_MODEL = 'unknown';

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
  return { model, usage, estimated: !reported, costUsd: estimateCost(usage, model) };
}

type OptionalCount = 'cachedInputTokens' | 'reasoningTokens';

function addOptional(run: RunUsage, key: OptionalCount, add: number | undefined): void {
  if (add !== undefined) run[key] = (run[key] ?? 0) + add;
}

/** Recomputes per-model and total cost from the token counts, and the legacy aliases. */
function refreshDerived(run: RunUsage): void {
  let total: number | undefined = 0;
  for (const [model, entry] of Object.entries(run.byModel)) {
    entry.costUsd = estimateCost(entry, model);
    total = total === undefined || entry.costUsd === undefined ? undefined : total + entry.costUsd;
  }
  run.costUsd = total;
  run.promptTokens = run.inputTokens;
  run.completionTokens = run.outputTokens;
}

function addToModel(
  run: RunUsage,
  model: string,
  tokens: { inputTokens: number; outputTokens: number },
  calls: number
): void {
  const entry = (run.byModel[model] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
  entry.inputTokens += tokens.inputTokens;
  entry.outputTokens += tokens.outputTokens;
  entry.calls += calls;
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
  addOptional(run, 'reasoningTokens', usage.reasoningTokens);
  addToModel(run, step.model, usage, 1);
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
    costUsd:
      prior.costUsd === undefined || child.costUsd === undefined
        ? undefined
        : prior.costUsd + child.costUsd,
    modelCalls: prior.modelCalls + child.modelCalls,
    estimated: prior.estimated || child.estimated,
    runs: prior.runs + 1,
  };
}

/** Rolls a finished child agent run's total into the parent's (mutates the parent). */
export function mergeDelegatedUsage(run: RunUsage, child: RunUsage): void {
  run.inputTokens += child.inputTokens;
  run.outputTokens += child.outputTokens;
  run.totalTokens += child.totalTokens;
  run.modelCalls += child.modelCalls;
  run.estimated ||= child.estimated;
  addOptional(run, 'cachedInputTokens', child.cachedInputTokens);
  addOptional(run, 'reasoningTokens', child.reasoningTokens);
  for (const [model, entry] of Object.entries(child.byModel)) addToModel(run, model, entry, entry.calls);
  run.delegated = delegatedTotals(run.delegated, child);
  refreshDerived(run);
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
    if (saved.totalTokens > 0) addToModel(run, UNKNOWN_MODEL, run, 0);
  }
  refreshDerived(run);
  return run;
}

/**
 * Where a delegated child's finished usage is reported so the parent run can
 * add it to its totals. Set by AgentExecutor around each run.
 */
const delegatedUsageSink = new AsyncLocalStorage<(usage: RunUsage) => void>();

/** Runs `fn` with child usage reported to `run`'s totals. */
export function collectDelegatedUsage<T>(run: RunUsage, fn: () => Promise<T>): Promise<T> {
  return delegatedUsageSink.run((child) => mergeDelegatedUsage(run, child), fn);
}

/** Called by the delegate tool when a child run finishes. No-op outside an executor run. */
export function reportDelegatedUsage(child: RunUsage): void {
  delegatedUsageSink.getStore()?.(child);
}
