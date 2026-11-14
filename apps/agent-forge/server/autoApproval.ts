/**
 * Studio's half of model-decided approvals (R01b): `studioAutoApprover`
 * turns the Settings > passes choices (`autoApprovalModel`, the
 * `auto_approval` kind switch) plus a stored provider key into the SDK's
 * `AutoApprover`, and `autoApprovalLogEntry` renders each
 * `AutoApprovalDecision` as the Logs-tab row RunManager emits.
 *
 * Every decided call also appends one `auto_approval` `PassRecord` to the
 * app's spend log - appended directly (fire-and-forget), never enqueued
 * on the PassRunner: the approver runs inside the run's tool step, so the
 * verdict must not wait on pass scheduling. Token usage and cost are
 * captured by spying on the provider's `generate` (the verdict itself
 * carries neither), keyed per call through AsyncLocalStorage so two
 * auto-approved calls in flight at once cannot swap usage.
 *
 * No usable provider key - or `passes.enabled.auto_approval === false` -
 * returns `undefined`, and spec `action: 'auto'` rules degrade to plain
 * `ask` pauses exactly like a host with no approver.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  estimateCost,
  modelAutoApprover,
  type AutoApprovalDecision,
  type AutoApprover,
  type GenerateOptions,
  type LLMProvider,
  type ProviderUsage,
} from '@linuxdevil/lousho';
import type { LogEntry } from '../shared/wireTypes';
import { resolveProviderForModel } from './buildAgent';
import type { PassRecord } from './passes/passRunner';
import type { SpendLog } from './passes/spendLog';
import type { SecretsStore } from './secretsStore';
import type { SettingsStore } from './settingsStore';

/** What {@link studioAutoApprover} needs: the Studio-global stores plus the agent the approver is built for. */
export interface StudioAutoApprovalDeps {
  settings: SettingsStore;
  secretsStore?: SecretsStore;
  spend: SpendLog;
  /** The workspace agent id the spend records are filed under. */
  agentId: string;
}

/** The per-call slot the provider spy fills with the reply's usage. */
interface UsageSlot {
  usage?: ProviderUsage;
}

/**
 * One ALS context per auto-approval call: the provider spy below stores
 * the `generate` reply's usage here, so concurrent approvals never read
 * each other's usage.
 */
const usageContext = new AsyncLocalStorage<UsageSlot>();

/**
 * `provider` with `generate` wrapped to record the reply's `usage` into
 * the ambient {@link UsageSlot}. Every other member passes through the
 * prototype chain, so the wrapper is a real `LLMProvider`.
 */
function usageSpyingProvider(provider: LLMProvider): LLMProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop !== 'generate') return Reflect.get(target, prop, receiver);
      return (options: GenerateOptions) => {
        const slot = usageContext.getStore();
        return target.generate(options).then((reply) => {
          if (slot !== undefined) slot.usage = reply.usage;
          return reply;
        });
      };
    },
  });
}

/** The `PassRecord` one decided call writes: `key` is the call's scope hash, `ms` the wall-clock check time. */
function spendRecord(deps: StudioAutoApprovalDeps, req: { callHash: string }, usage: ProviderUsage | undefined, model: string, outcome: 'completed' | 'failed', ms: number): PassRecord {
  const inputTokens = usage?.promptTokens ?? null;
  const outputTokens = usage?.completionTokens ?? null;
  return {
    kind: 'auto_approval',
    key: req.callHash,
    workspaceId: null,
    agentId: deps.agentId,
    model,
    outcome,
    usage: inputTokens === null || outputTokens === null ? null : { inputTokens, outputTokens },
    costUsd:
      usage === undefined
        ? null
        : (usage.costUsd ?? estimateCost({ inputTokens: usage.promptTokens, outputTokens: usage.completionTokens }, model) ?? null),
    ms,
    at: new Date().toISOString(),
  };
}

/** Appends the decision's spend line without ever blocking or failing the verdict. */
function recordSpend(deps: StudioAutoApprovalDeps, req: { callHash: string }, slot: UsageSlot, model: string, outcome: 'completed' | 'failed', ms: number): void {
  void deps.spend.append(spendRecord(deps, req, slot.usage, model, outcome, ms)).catch(() => undefined);
}

/**
 * The `AutoApprover` a Studio run's `action: 'auto'` rules score calls
 * with, or `undefined` when auto-approval is off (`passes.enabled.
 * auto_approval === false`) or no provider key resolves for
 * `passes.autoApprovalModel` (default `anthropic/claude-haiku-5-5`) - in
 * both cases the spec's auto rules behave as plain `ask`.
 */
export function studioAutoApprover(deps: StudioAutoApprovalDeps): AutoApprover | undefined {
  const passes = deps.settings.passes();
  if (passes.enabled.auto_approval === false) return undefined;
  const model = passes.autoApprovalModel;
  let provider: LLMProvider;
  try {
    provider = resolveProviderForModel(model, deps.secretsStore);
  } catch {
    return undefined;
  }
  const inner = modelAutoApprover({ provider: usageSpyingProvider(provider) });
  return async (req, signal) => {
    const slot: UsageSlot = {};
    const started = Date.now();
    try {
      const verdict = await usageContext.run(slot, () => inner(req, signal));
      recordSpend(deps, req, slot, model, 'completed', Date.now() - started);
      return verdict;
    } catch (error) {
      recordSpend(deps, req, slot, model, 'failed', Date.now() - started);
      throw error;
    }
  };
}

/** The human-readable why of an escalated decision: Studio's own words for the mechanical causes, the model's reason otherwise. */
function escalationReason(d: AutoApprovalDecision): string {
  if (d.cause === 'timeout') return 'The check took longer than 8 s.';
  if (d.cause === 'error') return 'The check failed.';
  if (d.cause === 'truncated') return 'Arguments too long to judge safely.';
  return d.reason;
}

/**
 * The Logs-tab row for one auto-approval decision (`phase: 'approval'`,
 * `level: 'info'`): `Approved automatically (safety 0.91): <reason>` when
 * the model let the call run, `Sent to you: <reason>` when it went to a
 * human. Safety prints with two decimals.
 */
export function autoApprovalLogEntry(agentId: string, d: AutoApprovalDecision): LogEntry {
  const message =
    d.outcome === 'approved'
      ? `Approved automatically (safety ${(d.safety ?? 0).toFixed(2)}): ${d.reason}`
      : `Sent to you: ${escalationReason(d)}`;
  return {
    id: randomUUID(),
    agentId,
    timestamp: new Date().toISOString(),
    level: 'info',
    phase: 'approval',
    toolName: d.toolName,
    message,
    detail: d,
  };
}
