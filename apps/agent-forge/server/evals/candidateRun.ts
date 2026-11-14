/**
 * candidateRun: the default `runExample` of the eval gate - one dataset
 * example run against the candidate spec, built exactly the way RunManager
 * builds a run (D12's `buildRunnableAgent` over the workspace's stores),
 * minus the parts an eval must not touch:
 *
 * - No RunManager run: it would clobber the agent's live chat entry.
 * - No session id: the turn is non-session, so nothing checkpoints and no
 *   conversation state leaks between examples.
 * - Its own observe agent name (`<agentId>-evals`): gate runs report beside
 *   the agent's real runs, never mixed into them; the root span's id is
 *   taken as the example's `traceId` when the reporter emits one.
 * - Its own approval/checkpoint namespace (`<agentId>-evals`): a spec whose
 *   tools pause for approval leaves the pending record where the agent's
 *   own approvals UI never lists it.
 */
import type { AgentSpecV2, TraceExporter } from '@linuxdevil/lousho';
import type { Span } from '@linuxdevil/lousho/traces';
import { buildRunnableAgent, type StudioRunDeps } from '../buildAgentV2';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';
import { observeReporting } from '../observeReporting';
import { SpendLog } from '../passes/spendLog';
import { studioPaths } from '../workspace/studioPaths';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import type { CandidateRun } from './types';

/** One example run's wall-clock cap; the signal merge below and the runner's per-example timeout both use it. */
export const EVAL_EXAMPLE_TIMEOUT_MS = 60_000;

export interface CandidateRunnerDeps {
  agentId: string;
  baseDir: string;
  secretsStore: SecretsStore;
  settings: SettingsStore;
}

/** The run's deps, built once per gate run: the stores are path holders, cheap to share. */
function runDeps(deps: CandidateRunnerDeps): StudioRunDeps {
  return {
    baseDir: deps.baseDir,
    checkpointStore: new FileCheckpointStore(deps.baseDir),
    approvalStore: new FileApprovalStore(deps.baseDir),
    secretsStore: deps.secretsStore,
    settings: deps.settings,
    spend: new SpendLog(studioPaths().spend),
  };
}

/**
 * `inner` wrapped to note the first parentless span's id into `capture` -
 * the run's trace id (the SDK's trace id IS the root span's id; see
 * fileTraceExporter.ts). Every span still reaches the reporter.
 */
function tracingExporter(inner: TraceExporter, capture: { traceId?: string }): TraceExporter {
  return {
    onSpanStart: (span: Span) => {
      if (span.parentId === undefined && capture.traceId === undefined) capture.traceId = span.id;
      inner.onSpanStart(span);
    },
    onSpanEnd: (span: Span) => inner.onSpanEnd(span),
  };
}

/** The `CandidateRun.error` a settled run earns, if any. */
function settleError(finishReason: string, abortReason: { name: string; message: string } | undefined): string | undefined {
  if (finishReason === 'error') return "the provider reported finish reason 'error'";
  if (finishReason === 'aborted') {
    return abortReason === undefined ? 'Run aborted' : `Run aborted: ${abortReason.name} ${abortReason.message}`;
  }
  return undefined;
}

/**
 * `runEvalGates`' default `runExample`: builds the candidate spec through
 * `buildRunnableAgent` and streams one non-session turn on `signal` merged
 * with the {@link EVAL_EXAMPLE_TIMEOUT_MS} cap. Never rejects - a build or
 * run failure comes back as `CandidateRun.error` so the example counts as
 * a failed run (`Run failed: <error>`) instead of sinking the whole gate.
 */
export async function runCandidate(
  spec: AgentSpecV2,
  input: string,
  signal: AbortSignal,
  deps: CandidateRunnerDeps
): Promise<CandidateRun> {
  const reporting = observeReporting({ agentName: `${deps.agentId}-evals`, baseDir: deps.baseDir });
  const capture: { traceId?: string } = {};
  try {
    const built = await buildRunnableAgent(spec, `${deps.agentId}-evals`, runDeps(deps), {
      onEvent: () => {},
      exporter: tracingExporter(reporting.exporter(), capture),
      captureContent: reporting.captureContent(),
    });
    const merged = AbortSignal.any([signal, AbortSignal.timeout(EVAL_EXAMPLE_TIMEOUT_MS)]);
    const result = await built.agent.stream(input, { signal: merged }).result;
    const error = settleError(result.finishReason, result.abortReason);
    return {
      text: result.text,
      toolNames: result.toolCalls.map((call) => call.function.name),
      costUsd: result.usage.costUsd ?? null,
      steps: result.steps,
      ...(capture.traceId !== undefined && { traceId: capture.traceId }),
      ...(error !== undefined && { error }),
    };
  } catch (error) {
    return {
      text: '',
      toolNames: [],
      costUsd: null,
      steps: 0,
      ...(capture.traceId !== undefined && { traceId: capture.traceId }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
