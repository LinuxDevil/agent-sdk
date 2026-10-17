/**
 * Mutable per-run state of an AgentExecutor.execute() call: where it
 * starts from (a rehydrated checkpoint, or a fresh conversation), how it
 * is checkpointed after each tool result, and how it becomes the final
 * ExecutionResult.
 */

import { GenerateResult, Message, ReasoningBlock, ToolCall, ToolDefinition } from '../providers';
import { AgentConfig } from '../types';
import { Checkpoint, CheckpointStatus, RUN_CONFIG_KEY } from './checkpoint';
import type { ApprovalKind } from './ApprovalGate';
import { checkAgentDrift, fingerprintOf, type AgentFingerprint } from './agentFingerprint';
import { runEventsOf } from './agentRun';
import { baseAgentOf } from './subagentRuntime';
import { CompactedLLMProviderError, ConfigurationError, SessionAwaitingApprovalError } from './errors';
import { inputMessages, insertToolResult, newSessionMessages, splitPendingTurn } from './transcript';
import type { CallUsage, RunUsage, StepUsage } from '../models/usage';
import { emptyRunUsage, mergeDelegatedUsage, recordStepUsage, restoreRunUsage } from './runUsage';
import type { ExecuteOptions, ExecutionFinishReason, ExecutionResult } from './AgentExecutor';
import type { ToolCallOutcome } from './toolCallExecution';
import type { UnrecordedToolCall } from './toolBatch';
import type { RunBudget } from './budget';
import { toolErrorResult } from './toolErrors';
import type { Principal } from '../auth/types';
import { readonlyPrincipal, resumedRunPrincipal } from './runPrincipal';
import { withHostedCalls } from './hostedToolCalls';
import { toolOutcomeMessage } from './toolResult';
import type { ParallelInputCheck } from './ioGuardrails';
import { REPLACES_CHECKPOINT, type RunLease, type RunLeaseOptions } from './runLease';

export interface AgentRunState {
  messages: Message[];
  toolCalls: ToolCall[];
  usage: RunUsage;
  /** One entry per model call. */
  stepUsage: StepUsage[];
  steps: number;
  businessState: unknown;
  finalText: string;
  finishReason: ExecutionFinishReason;
  /** The reasoning text of this run's steps so far. */
  reasoning?: string;
  /**
   * Set right before a compacted, model-actionable provider error
   * is pushed onto `messages` and the loop retries; cleared on any turn
   * that actually produces a result (text or tool calls). If the loop
   * exits because `maxSteps` was exhausted while this is still set, the
   * very last thing that happened was a provider failure, not a genuine
   * stop/tool-calls turn - see AgentExecutor.finishRun() for why
   * `execute()` still rejects in that case instead of returning a hollow
   * "successful" result whose `finishReason` would otherwise misleadingly
   * read as if the model actually gave up on its own.
   */
  lastSurfacedProviderError?: CompactedLLMProviderError;
  /**
   * Tool calls of the last model turn that have no result yet
   * (a run resumed after a crash, or after an approval mid-batch). They run
   * through the normal batch path before the model is called again.
   */
  pendingToolCalls: ToolCall[];
  /**
   * New input held back until `pendingToolCalls` all have results
   * (a user message must never sit between a tool-call turn and its
   * results). Persisted at the end of checkpoints and snapshots so it
   * survives a crash or another approval pause; splitPendingTurn() moves it
   * back behind the results on load.
   */
  queuedInput: Message[];
  /**
   * The reply a model call had streamed when the run's signal aborted it. The aborted result ends with
   * it as an assistant message marked `metadata.interrupted` (after the abort's checkpoint, so a resume never sees it).
   */
  interruptedText?: string;
  /** The run's `limits`, when it has any. */
  budget?: RunBudget;
  /** The checkpoint writes so far - each starts after the one before, so the newest state lands last. */
  saving?: Promise<void>;
  /** This run's agent, as written into its checkpoints and approval snapshots. */
  fingerprint?: AgentFingerprint;
  /** Set when an unfinished checkpoint is resumed: the fingerprint it was saved with, if any. */
  resumedFrom?: { fingerprint?: AgentFingerprint };
  /** Who the run acts for (frozen): an unfinished checkpoint's, else `ExecuteOptions.principal`. */
  principal?: Readonly<Principal>;
  /** The run's hook-context metadata: an unfinished checkpoint's fills in when `ExecuteOptions.metadata` is unset. */
  metadata?: Record<string, unknown>;
  /** The `runInParallel` input guardrails, until the first model call takes them. */
  inputCheck?: ParallelInputCheck;
  /** The agent running now (the target after a handoff): `result.agentName`. */
  agentName?: string;
  /** Handoffs this run made, checked against `maxHandoffs`. */
  handoffs?: number;
  /** The options and tools of the agent a handoff in the last step switched to, for the loop to take. */
  switched?: { options: ExecuteOptions; tools: ToolDefinition[] };
  /**
   * Messages of `messages` that only the model calls of this
   * run see - the structured-output repair and forced-answer prompts, and
   * the reply a repair rejected. They are left out of `result.messages` and
   * of the finished checkpoint (the session transcript).
   */
  requestOnly?: Set<Message>;
  /** The run lease the run holds on its checkpoint id, when the store has leases (see `runLease.ts`). */
  lease?: RunLease;
  /** What each sub-agent run still running has spent so far (not in `usage` until it ends); checkpointed. */
  delegatedInFlight?: Map<symbol, RunUsage>;
  /** Set once the run saved a checkpoint that ends or pauses it: a sub-agent still running then no longer writes it. */
  closed?: boolean;
}

/**
 * An internal option of a sub-agent run - called with what the run has
 * spent so far (its sub-agents still running included) after each model call
 * and tool result, so the lead can checkpoint it before the sub-agent ends.
 */
export const DELEGATED_PROGRESS = Symbol('lousho.delegatedProgress');

/** Options carrying {@link DELEGATED_PROGRESS}. */
export interface DelegatedProgressOptions {
  [DELEGATED_PROGRESS]?: (usage: RunUsage) => void;
}

/**
 * A checkpoint that ends or pauses the run closes it to its sub-agents
 * still running; an `'in-progress'` one of a sub-agent run tells its lead what
 * it has spent so far.
 */
function noteProgress(options: ExecuteOptions, state: AgentRunState, status: CheckpointStatus): void {
  if (status !== 'in-progress') state.closed = true;
  else (options as DelegatedProgressOptions)[DELEGATED_PROGRESS]?.(usageWithInFlight(state));
}

/** The checkpoint's `delegatedInFlight`, while the run is unfinished and has sub-agents running. */
function inFlightOf(state: AgentRunState, status: CheckpointStatus): Pick<Checkpoint, 'delegatedInFlight'> {
  if (status === 'finished' || !state.delegatedInFlight?.size) return {};
  return { delegatedInFlight: [...state.delegatedInFlight.values()].map((usage) => structuredClone(usage)) };
}

/** The run's usage plus what its sub-agents still running spent so far. */
function usageWithInFlight(state: AgentRunState): RunUsage {
  if (!state.delegatedInFlight?.size) return state.usage;
  const total = structuredClone(state.usage);
  for (const child of state.delegatedInFlight.values()) mergeDelegatedUsage(total, child);
  return total;
}

/** Marks `messages` (already in `state.messages`) as {@link AgentRunState.requestOnly}. */
export function markRequestOnly(state: AgentRunState, ...messages: Message[]): void {
  state.requestOnly ??= new Set();
  for (const message of messages) state.requestOnly.add(message);
}

/** `state.messages` without the {@link AgentRunState.requestOnly} ones: what the run keeps. */
function keptMessages(state: AgentRunState): Message[] {
  const requestOnly = state.requestOnly;
  return requestOnly?.size ? state.messages.filter((message) => !requestOnly.has(message)) : state.messages;
}

/**
 * Build messages from input
 */
function buildMessages(
  agent: AgentConfig,
  input: string | Message[],
  skipSystemPromptInjection = false
): Message[] {
  // Add system prompt, unless the caller has indicated `input` already
  // includes one (e.g. resume.ts rebuilding from an ExecutionSnapshot), or
  // `input` already starts with it - a `result.messages` fed back into
  // `send()`.
  // An empty message list would send a request with no user turn, which providers reject or answer from nothing.
  if (Array.isArray(input) && input.length === 0 && !skipSystemPromptInjection) {
    throw new ConfigurationError("The run's input is an empty message list. Pass a string or at least one message, e.g. send('Hello').", 'input');
  }
  const messages = inputMessages(input);
  const first = messages[0];
  const hasPrompt = first?.role === 'system' && first.content === agent.prompt;
  const system: Message[] =
    agent.prompt && !skipSystemPromptInjection && !hasPrompt ? [{ role: 'system', content: agent.prompt }] : [];
  return [...system, ...messages];
}

type InitialRunState = Pick<
  AgentRunState,
  'messages' | 'toolCalls' | 'usage' | 'stepUsage' | 'steps' | 'businessState'
>;

/**
 * Rehydrates run state from a checkpoint left by an earlier call:
 * an unfinished run resumes where it stopped (new input, if any, is
 * appended after it - see newSessionMessages()); a finished run continues
 * as a conversation, with a fresh step budget, usage and tool-call list.
 */
function stateFromCheckpoint(checkpoint: Checkpoint, options: ExecuteOptions): InitialRunState {
  // On a rehydrated run (e.g. a fresh process resuming after a
  // crash), the caller of this execute() call may have no way to know
  // what businessState a *previous* process attached - that's exactly
  // the "second store, hope it stays aligned" gap this field closes. So
  // when a checkpoint is loaded and this call's own `businessState`
  // option was left unset, fall back to the value already stored on the
  // checkpoint rather than silently dropping it. An explicit
  // `businessState` passed to *this* call always wins (e.g. a caller
  // deliberately updating it as part of the resumed run).
  const { businessState } = options;
  const finished = checkpoint.status === 'finished';
  const added = newSessionMessages(checkpoint.messages, options.input, finished);
  const seeded = collectToolCalls(checkpoint.messages);
  const ids = new Set(seeded.map((call) => call.id));
  return {
    messages: [...checkpoint.messages, ...added],
    // Checkpoints that predate toolCalls (or that dropped them) still hold
    // the calls inside their messages - the transcript is the source of truth.
    toolCalls: finished ? [] : [...seeded, ...(checkpoint.toolCalls as ToolCall[]).filter((call) => !ids.has(call.id))],
    // An unfinished run continues from the checkpointed totals (older
    // checkpoints: token counts only); a new turn of a finished one starts at zero.
    usage: finished ? emptyRunUsage() : resumedUsage(checkpoint),
    stepUsage: finished ? [] : [...(checkpoint.stepUsage ?? [])],
    steps: finished ? 0 : checkpoint.stepIndex,
    businessState: businessState === undefined ? checkpoint.businessState : businessState,
  };
}

/** An unfinished run's usage, plus what its sub-agents that were still running had spent. */
function resumedUsage(checkpoint: Checkpoint): RunUsage {
  const usage = restoreRunUsage(checkpoint.usage);
  for (const child of checkpoint.delegatedInFlight ?? []) mergeDelegatedUsage(usage, restoreRunUsage(child));
  return usage;
}

/**
 * Every tool call a transcript's assistant turns made, in order, deduped by
 * id. A run continued from a transcript (an approval resolve, a resumed
 * turn) still owns those calls - the result's `toolCalls` must not pretend
 * the run never made them.
 */
export function collectToolCalls(messages: readonly Message[]): ToolCall[] {
  const seen = new Set<string>();
  const calls: ToolCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      calls.push(call);
    }
  }
  return calls;
}

/** Builds messages from scratch (the no-checkpoint fallback path). */
function freshState(options: ExecuteOptions): InitialRunState {
  const { agent, input, skipSystemPromptInjection, initialSteps, businessState } = options;
  const messages = buildMessages(agent, input, skipSystemPromptInjection);
  return {
    messages,
    // A continued run's input transcript carries this run's earlier calls
    // (initialSteps/initialUsage mark the continuation: resumeAfterApproval,
    // continueHandoff). An ordinary new turn does not inherit its session
    // history's calls - they belong to earlier turns (result.toolCalls,
    // countToolErrors and limits.maxToolErrors are per-run).
    toolCalls: initialSteps !== undefined || options.initialUsage !== undefined ? collectToolCalls(messages) : [],
    usage: options.initialUsage ? restoreRunUsage(options.initialUsage) : emptyRunUsage(),
    stepUsage: [],
    steps: initialSteps ?? 0,
    businessState,
  };
}

/** The checkpoint the run continues from: its id's, unless it has none or `REPLACES_CHECKPOINT` (the input holds it already). */
async function checkpointToContinue(options: ExecuteOptions): Promise<Checkpoint | null> {
  const { sessionId, checkpointStore } = options;
  if (!sessionId || !checkpointStore || (options as RunLeaseOptions)[REPLACES_CHECKPOINT]) return null;
  return checkpointStore.load(sessionId);
}

/**
 * If a checkpoint exists for this sessionId, rehydrate state from it
 * instead of building messages from scratch. Either way, unanswered tool
 * calls of the last model turn become `pendingToolCalls`.
 * Throws SessionAwaitingApprovalError when the session is paused on an
 * approval.
 */
export async function loadRunState(options: ExecuteOptions): Promise<AgentRunState> {
  const { sessionId, checkpointStore } = options;
  const checkpoint = await checkpointToContinue(options);
  if (sessionId && checkpoint?.status === 'awaiting-approval') {
    throw new SessionAwaitingApprovalError(sessionId, checkpoint.approvalId, checkpoint.approvalKind);
  }

  const initial = checkpoint ? stateFromCheckpoint(checkpoint, options) : freshState(options);
  const turn = splitPendingTurn(initial.messages);
  settleStartedCalls(turn, checkpoint);
  // An unfinished run goes on as the caller it was saved with; a finished one starts a new run.
  const principal = readonlyPrincipal(
    sessionId && checkpoint && checkpoint.status !== 'finished' ? resumedRunPrincipal(checkpoint.principal, options.principal, sessionId) : options.principal
  );
  // An unfinished run's hooks keep seeing the metadata it was saved
  // with when this call did not pass its own; a finished run's next turn (or
  // a fresh run) uses exactly the call's.
  const metadata =
    sessionId && checkpoint && checkpoint.status !== 'finished'
      ? (options.metadata ?? checkpoint.metadata)
      : options.metadata;

  return {
    ...initial,
    messages: turn.messages,
    pendingToolCalls: turn.pendingToolCalls,
    queuedInput: turn.queuedInput,
    finalText: '',
    finishReason: 'stop',
    agentName: options.agent.name,
    // With checkpointing on, known before the first (synchronous) checkpoint write.
    ...(sessionId && checkpointStore && { fingerprint: await fingerprintOf(baseAgentOf(options.agent), options.toolRegistry, options.provider, options.hostedTools) }),
    ...(checkpoint && checkpoint.status !== 'finished' && { resumedFrom: { fingerprint: checkpoint.agentFingerprint } }),
    ...(principal && { principal }),
    ...(metadata !== undefined && { metadata }),
  };
}

/**
 * An approved call that had started when an unfinished run stopped (its checkpoint's
 * `startedToolCallIds`) and has no result is not run again: it gets an error
 * result saying it may or may not have taken effect (at-most-once for approved
 * calls, see docs/durable-execution.md), so a crash during an approved side
 * effect is neither repeated silently nor lost from the transcript.
 */
function settleStartedCalls(turn: ReturnType<typeof splitPendingTurn>, checkpoint: Checkpoint | null): void {
  const started = checkpoint?.status === 'finished' ? undefined : checkpoint?.startedToolCallIds;
  if (!started || started.length === 0) return;
  const ids = new Set(started);
  for (const call of turn.pendingToolCalls.filter((pending) => ids.has(pending.id))) {
    insertToolResult(turn.messages, {
      role: 'tool',
      content: JSON.stringify(
        toolErrorResult({
          toolName: call.function.name,
          error:
            `The approved call to '${call.function.name}' had started when the run stopped (a crash or restart), ` +
            'before its result was saved. It may or may not have taken effect, and it was not run again: check its effect before retrying it.',
          kind: 'interrupted',
        })
      ),
      name: call.function.name,
      toolCallId: call.id,
      toolName: call.function.name,
      isError: true,
    });
  }
  turn.pendingToolCalls = turn.pendingToolCalls.filter((pending) => !ids.has(pending.id));
}

/**
 * This run's agent fingerprint. Computed on first use, so a run that
 * is neither checkpointed, paused nor resumed takes no extra step to start.
 */
export async function ensureFingerprint(options: ExecuteOptions, state: AgentRunState): Promise<AgentFingerprint> {
  state.fingerprint ??= await fingerprintOf(baseAgentOf(options.agent), options.toolRegistry, options.provider, options.hostedTools);
  return state.fingerprint;
}

/**
 * When an unfinished checkpoint saved with an agent fingerprint is
 * resumed, compares it with this run's agent (`onAgentDrift`) before any model
 * call or tool runs: throws on a pending call whose tool is gone, or on drift
 * with `'error'`; with `'warn'` also reports an `agent.drift` event.
 */
export async function checkResumedAgent(options: ExecuteOptions, state: AgentRunState, tools: ToolDefinition[]): Promise<void> {
  const saved = state.resumedFrom?.fingerprint;
  if (!saved) return;
  const current = await ensureFingerprint(options, state);
  const have = new Set(tools.map((tool) => tool.function.name));
  const pending = state.pendingToolCalls.map((call) => call.function.name);
  const missingTools = [...new Set(pending.filter((name) => !have.has(name)))];
  const drift = checkAgentDrift({ saved, current, mode: options.onAgentDrift, missingTools });
  if (drift) runEventsOf(options)?.agentDrift(drift);
}

/** Accumulates one generate() call's usage into the run total and the per-step list. */
export function recordStep(state: AgentRunState, measured: CallUsage): StepUsage {
  recordStepUsage(state.usage, measured);
  const stepUsage: StepUsage = { step: state.steps, ...measured };
  state.stepUsage.push(stepUsage);
  return stepUsage;
}

/**
 * Persists the run's progress, when checkpointing is on: after each model
 * response, as tool results are recorded, and when the run
 * aborts, pauses (`'awaiting-approval'`) or finishes (`'finished'`).
 */
export async function saveStepCheckpoint(
  options: ExecuteOptions,
  state: AgentRunState,
  status: CheckpointStatus = 'in-progress',
  approval?: string | string[],
  approvalKind?: ApprovalKind
): Promise<void> {
  // A step paused on several calls records all their ids.
  const approvalIds = typeof approval === 'string' ? [approval] : approval;
  const approvalId = approvalIds?.[0];
  const { agent, sessionId, checkpointStore, inputQueue } = options;
  // A run that stops here takes no more queued input, and keeps none it did not apply.
  if (status !== 'in-progress') inputQueue?.close();
  noteProgress(options, state, status);
  if (!sessionId || !checkpointStore) {
    return;
  }

  const checkpoint: Checkpoint = {
    agentId: agent.id || '',
    sessionId,
    stepIndex: state.steps,
    // An unfinished run keeps its request-only prompts, so a resume sends what the model saw.
    messages: [...(status === 'finished' ? keptMessages(state) : state.messages), ...state.queuedInput, ...(inputQueue?.messages ?? [])],
    toolCalls: [...state.toolCalls],
    usage: structuredClone(state.usage),
    stepUsage: [...state.stepUsage],
    finishReason: state.finishReason,
    businessState: state.businessState,
    status,
    ...(approvalId !== undefined && { approvalId }),
    ...(approvalIds !== undefined && approvalIds.length > 1 && { approvalIds }),
    ...(approvalKind !== undefined && { approvalKind }),
    ...(state.fingerprint && { agentFingerprint: state.fingerprint }),
    ...(agent.metadata?.[RUN_CONFIG_KEY] !== undefined && { runConfig: agent.metadata[RUN_CONFIG_KEY] }),
    // So a crash resume acts for the same caller.
    ...(options.principal && { principal: options.principal }),
    // So a crash resume's hooks keep seeing the run's metadata.
    ...(options.metadata !== undefined && { metadata: options.metadata }),
    ...inFlightOf(state, status),
  };
  // Under the run's lease, a save is fenced: a run that lost it (it stalled past it) fails instead of overwriting the new holder's progress.
  const { lease } = state;
  const save = () => (lease?.id === sessionId ? lease.save(checkpoint) : checkpointStore.save(sessionId, checkpoint));
  const saved = state.saving ? state.saving.then(save) : save();
  state.saving = saved.catch(() => undefined);
  await saved;
}

/**
 * Records one settled tool call's result in the transcript, where the
 * model's call order puts it. Results may arrive out of order - a parallel
 * call is recorded as soon as it settles, so a
 * checkpoint holds every finished call and a crash never re-runs it - and
 * the transcript still keeps call order for the provider.
 */
export function pushToolResult(
  state: AgentRunState,
  toolCall: ToolCall,
  outcome: ToolCallOutcome,
  maxToolResultChars?: number
): void {
  // The message shape (the `{error}` payload, isError,
  // replacedByHook record) is toolOutcomeMessage()'s, shared with the
  // handoff settle path in handoffRun.ts.
  insertToolResult(state.messages, toolOutcomeMessage(toolCall, outcome, maxToolResultChars));
}

/**
 * Gives a tool call the run was aborted before reaching a `not-run`
 * tool error result, so the transcript stays well-formed (every assistant tool
 * call has a matching result) and a checkpointed run can be resumed without
 * the provider rejecting an unanswered tool call.
 */
function pushCancelledToolResult(state: AgentRunState, toolCall: ToolCall, reason: string): void {
  insertToolResult(state.messages, {
    role: 'tool',
    content: JSON.stringify(
      toolErrorResult({
        toolName: toolCall.function.name,
        error: `Tool call was cancelled before it ran because ${reason}`,
        kind: 'not-run',
      })
    ),
    name: toolCall.function.name,
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    isError: true,
  });
}

/**
 * Closes out a batch cut short by an abort - in call order, each
 * call that was not yet in the transcript gets its result if it finished,
 * or a cancelled result if it never started, was waiting on an approval,
 * or ended in a fatal error.
 */
export function pushAbortedBatchResults(
  state: AgentRunState,
  calls: UnrecordedToolCall[],
  reason = 'the run was aborted',
  maxToolResultChars?: number
): void {
  for (const { toolCall, outcome } of calls) {
    if (outcome && !outcome.requiresApproval && !outcome.signIn) {
      pushToolResult(state, toolCall, outcome, maxToolResultChars);
    } else {
      pushCancelledToolResult(state, toolCall, reason);
    }
  }
}

/** The ExecutionResult reflecting the run's current state. */
export function toExecutionResult(
  state: AgentRunState,
  text: string,
  finishReason: ExecutionFinishReason
): ExecutionResult {
  return {
    text,
    ...(state.reasoning && { reasoning: state.reasoning }),
    messages: finishReason === 'awaiting-approval' ? state.messages : keptMessages(state),
    toolCalls: state.toolCalls,
    usage: state.usage,
    stepUsage: state.stepUsage,
    finishReason,
    steps: state.steps,
    ...(state.agentName !== undefined && { agentName: state.agentName }),
    ...withToolErrors(state),
  };
}

/** Whether a tool message is the result of a call that never ran (`kind: 'not-run'`: an abort, a budget stop). */
function isNotRunResult(content: Message['content']): boolean {
  if (typeof content !== 'string') return false;
  try {
    return (JSON.parse(content) as { kind?: unknown } | null)?.kind === 'not-run';
  } catch {
    return false;
  }
}

/**
 * How many of the run's tool calls (`state.toolCalls`, a resumed run's
 * included) ended in an error result - thrown, invalid arguments, unknown
 * tool, denied, rejected, ... - but not a call that never ran (`'not-run'`).
 */
export function countToolErrors(state: Pick<AgentRunState, 'messages' | 'toolCalls'>): number {
  if (state.toolCalls.length === 0) return 0;
  const ids = new Set(state.toolCalls.map((call) => call.id));
  let failed = 0;
  for (const message of state.messages) {
    if (message.role === 'tool' && message.isError && message.toolCallId && ids.has(message.toolCallId) && !isNotRunResult(message.content)) failed++;
  }
  return failed;
}

function withToolErrors(state: AgentRunState): Pick<ExecutionResult, 'toolErrors'> {
  const toolErrors = countToolErrors(state);
  return toolErrors > 0 ? { toolErrors } : {};
}

/** Adds a step's reasoning text to the run's. */
export function noteReasoning(state: AgentRunState, reasoning: ReasoningBlock[] | undefined): void {
  const text = (reasoning ?? []).map((block) => block.text).join('');
  if (text) state.reasoning = state.reasoning ? `${state.reasoning}

${text}` : text;
}

/**
 * The assistant message of a tool-call turn. it keeps only the
 * reasoning blocks a provider needs back (signed or redacted Anthropic
 * thinking), so they survive the next step, a checkpoint and a resume.
 */
export function assistantTurn(result: GenerateResult): Message {
  const replayed = (result.reasoning ?? []).filter((block) => block.signature || block.redactedData);
  const turn: Message = { role: 'assistant', content: result.text || '', toolCalls: result.toolCalls, ...(replayed.length > 0 && { reasoning: replayed }) };
  // The provider's own calls are kept on the turn, never sent back as calls.
  return withHostedCalls(turn, result.hostedToolCalls);
}
