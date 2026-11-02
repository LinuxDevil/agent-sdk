/**
 * AgentHost: the seam between `RunManager` and whatever executes an
 * `AgentSpecV2`. RunManager never calls `buildRunnableAgent`,
 * `agent.stream()` or `approvals.streamResolve()` itself - it starts runs,
 * steers, aborts and resolves approvals through this interface, so a
 * second implementation (`BridgeAgentHost`, running the project's own
 * installed SDK over `lousho bridge`) plugs in without RunManager changing
 * again. Studio's own SDK backs `InProcessAgentHost`
 * (inProcessAgentHost.ts); flow specs (`spec.flow`) never reach a host -
 * RunManager keeps those on its in-process FlowExecutor path.
 *
 * Event model: `start()` hands the host an `onEvent`; every `AgentEvent`,
 * every span start/end and the terminal `settled` (or `failed`) of that
 * run - including continuations after `resolveApproval()`/`answerQuestion()`
 * - arrive through it, in order. `steer.joined` reports how a `steer()`
 * call's input landed.
 */
import type {
  AgentEvent,
  AgentHook,
  AgentInput,
  AgentSpecV2,
  ExecutionResult,
  PendingApproval,
  Span,
} from 'lousho';
import type { CatalogGuardrail, CatalogModel, CatalogTool, CatalogTriggerType } from '../../shared/wireTypes';

export interface AgentHost {
  readonly kind: 'in-process' | 'bridge';
  /** `VERSION` of the SDK the runs execute under (Studio's own, or the workspace's over the bridge). */
  readonly sdkVersion: string;
  /** Compiles the spec and starts a run or chat turn; rejects (before any event) when the spec cannot be built. */
  start(input: HostRunInput): Promise<HostRun>;
  /**
   * Steers a live run. Returns the SDK's steer id and whether the input
   * applied immediately, queued, or was refused (`false`); the `joined`
   * half arrives later as a `steer.joined` HostEvent.
   */
  steer(runId: string, message: string): Promise<HostSteerResult>;
  /**
   * Live run → aborts it (a `settled` event with `finishReason: 'aborted'`
   * follows). Paused → discards the pending approval(s), no event. Unknown
   * run → no-op.
   */
  abort(runId: string, reason?: string): Promise<void>;
  /** Resumes a run paused on `approvalId`; its events and the next `settled` go to the same `onEvent`. */
  resolveApproval(runId: string, approvalId: string, decision: { approved: boolean; note?: string }): Promise<void>;
  /** Answers a question a run paused on (`ask_question` tool); same continuation semantics as `resolveApproval`. */
  answerQuestion(runId: string, questionId: string, answer: string): Promise<void>;
  /** The tools/models/guardrails/triggers catalog of the SDK this host runs. */
  catalog(): Promise<HostCatalog>;
  /** Aborts every live run and releases the host. */
  dispose(): Promise<void>;
}

export interface HostRunInput {
  agentId: string;
  spec: AgentSpecV2;
  /** The durable-run id (`send({ sessionId })`) the run checkpoints under - RunManager uses the agent id (a fork's id for a forked run). */
  sessionId: string;
  /** A string for a run; prior messages (no 'system' entries) plus the new user message for a chat turn; `[]` to continue a forked checkpoint. */
  input: AgentInput;
  captureContent?: boolean;
  /** Every event of every segment of this run, including continuations after approvals. */
  onEvent: (event: HostEvent) => void;
  /** In-process only (the debugger's `agentHooks()`); a bridge host ignores it. */
  extraHooks?: readonly AgentHook[];
}

export interface HostRun {
  runId: string;
  /** `<provider>/<model>` the run actually uses, for the status payload's `provider` field. */
  modelLabel: string;
}

export interface HostSteerResult {
  id: string;
  applied: 'immediate' | 'queued' | false;
}

export interface HostErrorInfo {
  message: string;
  code?: string;
  name?: string;
}

/** The `ExecutionResult` fields Studio reads, plus the pending-approval record of an `awaiting-approval` settle. */
export type HostRunResult = Pick<
  ExecutionResult,
  'finishReason' | 'text' | 'messages' | 'usage' | 'steps' | 'approvalId' | 'approvalIds' | 'abortReason'
> & {
  object?: unknown;
  pendingApproval?: PendingApproval;
};

export type HostEvent =
  | { type: 'agent'; event: AgentEvent }
  | { type: 'span'; phase: 'start' | 'end'; span: Span }
  | { type: 'steer.joined'; steerId: string; joined: boolean }
  | { type: 'settled'; result: HostRunResult }
  | { type: 'failed'; error: HostErrorInfo };

export interface HostCatalog {
  tools: CatalogTool[];
  models: CatalogModel[];
  guardrails: CatalogGuardrail[];
  triggers: CatalogTriggerType[];
}

/**
 * `steer`/`resolveApproval`/`answerQuestion` on a run that is not live
 * (steer) or not paused on that id. RunManager maps it to the same 409 a
 * `NoActiveRunError` produces.
 */
export class HostRunNotActiveError extends Error {}
