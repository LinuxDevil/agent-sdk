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
import { CompactedLLMProviderError, SessionAwaitingApprovalError } from './errors';
import { inputMessages, insertToolResult, newSessionMessages, splitPendingTurn } from './transcript';
import type { CallUsage, RunUsage, StepUsage } from '../models/usage';
import { emptyRunUsage, recordStepUsage, restoreRunUsage } from './runUsage';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { ToolCallOutcome } from './toolCallExecution';
import type { UnrecordedToolCall } from './toolBatch';
import type { RunBudget } from './budget';
import { toolErrorResult } from './toolErrors';
import type { Principal } from '../auth/types';
import { readonlyPrincipal, resumedRunPrincipal } from './runPrincipal';
import { withHostedCalls } from './hostedToolCalls';
import { toolOutcomeMessage } from './toolResult';
import type { ParallelInputCheck } from './ioGuardrails';

export interface AgentRunState {
  messages: Message[];
  toolCalls: ToolCall[];
  usage: RunUsage;
  /** One entry per model call (LOU-V5). */
  stepUsage: StepUsage[];
  steps: number;
  businessState: unknown;
  finalText: string;
  finishReason: string;
  /** LOU-V13: the reasoning text of this run's steps so far. */
  reasoning?: string;
  /**
   * LOU-T4: set right before a compacted, model-actionable provider error
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
   * LOU-U7/U9: tool calls of the last model turn that have no result yet
   * (a run resumed after a crash, or after an approval mid-batch). They run
   * through the normal batch path before the model is called again.
   */
  pendingToolCalls: ToolCall[];
  /**
   * LOU-U8: new input held back until `pendingToolCalls` all have results
   * (a user message must never sit between a tool-call turn and its
   * results). Persisted at the end of checkpoints and snapshots so it
   * survives a crash or another approval pause; splitPendingTurn() moves it
   * back behind the results on load.
   */
  queuedInput: Message[];
  /** LOU-V6: the run's `limits`, when it has any. */
  budget?: RunBudget;
  /** LOU-V9: the checkpoint writes so far - each starts after the one before, so the newest state lands last. */
  saving?: Promise<void>;
  /** LOU-W9.2: this run's agent, as written into its checkpoints and approval snapshots. */
  fingerprint?: AgentFingerprint;
  /** LOU-W9.2: set when an unfinished checkpoint is resumed: the fingerprint it was saved with, if any. */
  resumedFrom?: { fingerprint?: AgentFingerprint };
  /** N10b: who the run acts for (frozen): an unfinished checkpoint's, else `ExecuteOptions.principal`. */
  principal?: Readonly<Principal>;
  /** LOU-R16: the run's hook-context metadata: an unfinished checkpoint's fills in when `ExecuteOptions.metadata` is unset. */
  metadata?: Record<string, unknown>;
  /** N5b: the `runInParallel` input guardrails, until the first model call takes them. */
  inputCheck?: ParallelInputCheck;
  /** N6: the agent running now (the target after a handoff): `result.agentName`. */
  agentName?: string;
  /** N6: handoffs this run made, checked against `maxHandoffs`. */
  handoffs?: number;
  /** N6: the options and tools of the agent a handoff in the last step switched to, for the loop to take. */
  switched?: { options: ExecuteOptions; tools: ToolDefinition[] };
  /**
   * Eve CORE-F3: messages of `messages` that only the model calls of this
   * run see - the structured-output repair and forced-answer prompts, and
   * the reply a repair rejected. They are left out of `result.messages` and
   * of the finished checkpoint (the session transcript).
   */
  requestOnly?: Set<Message>;
}

/** Eve CORE-F3: marks `messages` (already in `state.messages`) as {@link AgentRunState.requestOnly}. */
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
  // includes one (e.g. resume.ts rebuilding from an ExecutionSnapshot).
  const system: Message[] =
    agent.prompt && !skipSystemPromptInjection ? [{ role: 'system', content: agent.prompt }] : [];
  return [...system, ...inputMessages(input)];
}

type InitialRunState = Pick<
  AgentRunState,
  'messages' | 'toolCalls' | 'usage' | 'stepUsage' | 'steps' | 'businessState'
>;

/**
 * Rehydrates run state from a checkpoint left by an earlier call (LOU-U8):
 * an unfinished run resumes where it stopped (new input, if any, is
 * appended after it - see newSessionMessages()); a finished run continues
 * as a conversation, with a fresh step budget, usage and tool-call list.
 */
function stateFromCheckpoint(checkpoint: Checkpoint, options: ExecuteOptions): InitialRunState {
  // LOU-T1: on a rehydrated run (e.g. a fresh process resuming after a
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
  return {
    messages: [...checkpoint.messages, ...added],
    toolCalls: finished ? [] : [...(checkpoint.toolCalls as ToolCall[])],
    // LOU-V5: an unfinished run continues from the checkpointed totals (older
    // checkpoints: token counts only); a new turn of a finished one starts at zero.
    usage: finished ? emptyRunUsage() : restoreRunUsage(checkpoint.usage),
    stepUsage: finished ? [] : [...(checkpoint.stepUsage ?? [])],
    steps: finished ? 0 : checkpoint.stepIndex,
    businessState: businessState === undefined ? checkpoint.businessState : businessState,
  };
}

/** Builds messages from scratch (the no-checkpoint fallback path). */
function freshState(options: ExecuteOptions): InitialRunState {
  const { agent, input, skipSystemPromptInjection, initialSteps, businessState } = options;
  return {
    messages: buildMessages(agent, input, skipSystemPromptInjection),
    toolCalls: [],
    usage: options.initialUsage ? restoreRunUsage(options.initialUsage) : emptyRunUsage(),
    stepUsage: [],
    steps: initialSteps ?? 0,
    businessState,
  };
}

/**
 * If a checkpoint exists for this sessionId, rehydrate state from it
 * instead of building messages from scratch. Either way, unanswered tool
 * calls of the last model turn become `pendingToolCalls` (LOU-U7/U9).
 * Throws SessionAwaitingApprovalError when the session is paused on an
 * approval (LOU-U8).
 */
export async function loadRunState(options: ExecuteOptions): Promise<AgentRunState> {
  const { sessionId, checkpointStore } = options;
  let checkpoint: Checkpoint | null = null;
  if (sessionId && checkpointStore) {
    checkpoint = await checkpointStore.load(sessionId);
  }
  if (sessionId && checkpoint?.status === 'awaiting-approval') {
    throw new SessionAwaitingApprovalError(sessionId, checkpoint.approvalId, checkpoint.approvalKind);
  }

  const initial = checkpoint ? stateFromCheckpoint(checkpoint, options) : freshState(options);
  const turn = splitPendingTurn(initial.messages);
  // N10b: an unfinished run goes on as the caller it was saved with; a finished one starts a new run.
  const principal = readonlyPrincipal(
    sessionId && checkpoint && checkpoint.status !== 'finished' ? resumedRunPrincipal(checkpoint.principal, options.principal, sessionId) : options.principal
  );
  // LOU-R16: an unfinished run's hooks keep seeing the metadata it was saved
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
    // LOU-W9.2: with checkpointing on, known before the first (synchronous) checkpoint write.
    ...(sessionId && checkpointStore && { fingerprint: await fingerprintOf(baseAgentOf(options.agent), options.toolRegistry, options.provider, options.hostedTools) }),
    ...(checkpoint && checkpoint.status !== 'finished' && { resumedFrom: { fingerprint: checkpoint.agentFingerprint } }),
    ...(principal && { principal }),
    ...(metadata !== undefined && { metadata }),
  };
}

/**
 * This run's agent fingerprint (LOU-W9.2). Computed on first use, so a run that
 * is neither checkpointed, paused nor resumed takes no extra step to start.
 */
export async function ensureFingerprint(options: ExecuteOptions, state: AgentRunState): Promise<AgentFingerprint> {
  state.fingerprint ??= await fingerprintOf(baseAgentOf(options.agent), options.toolRegistry, options.provider, options.hostedTools);
  return state.fingerprint;
}

/**
 * LOU-W9.2: when an unfinished checkpoint saved with an agent fingerprint is
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
 * response (LOU-U9), as tool results are recorded, and when the run
 * aborts, pauses (`'awaiting-approval'`) or finishes (`'finished'`).
 */
export async function saveStepCheckpoint(
  options: ExecuteOptions,
  state: AgentRunState,
  status: CheckpointStatus = 'in-progress',
  approvalId?: string,
  approvalKind?: ApprovalKind
): Promise<void> {
  const { agent, sessionId, checkpointStore, inputQueue } = options;
  // LOU-V9: a run that stops here takes no more queued input, and keeps none it did not apply.
  if (status !== 'in-progress') inputQueue?.close();
  if (!sessionId || !checkpointStore) {
    return;
  }

  const checkpoint: Checkpoint = {
    agentId: agent.id || '',
    sessionId,
    stepIndex: state.steps,
    // Eve CORE-F3: an unfinished run keeps its request-only prompts, so a resume sends what the model saw.
    messages: [...(status === 'finished' ? keptMessages(state) : state.messages), ...state.queuedInput, ...(inputQueue?.messages ?? [])],
    toolCalls: [...state.toolCalls],
    usage: structuredClone(state.usage),
    stepUsage: [...state.stepUsage],
    finishReason: state.finishReason,
    businessState: state.businessState,
    status,
    ...(approvalId !== undefined && { approvalId }),
    ...(approvalKind !== undefined && { approvalKind }),
    ...(state.fingerprint && { agentFingerprint: state.fingerprint }),
    ...(agent.metadata?.[RUN_CONFIG_KEY] !== undefined && { runConfig: agent.metadata[RUN_CONFIG_KEY] }),
    // N10b: so a crash resume acts for the same caller.
    ...(options.principal && { principal: options.principal }),
    // LOU-R16: so a crash resume's hooks keep seeing the run's metadata.
    ...(options.metadata !== undefined && { metadata: options.metadata }),
  };
  const save = () => checkpointStore.save(sessionId, checkpoint);
  const saved = state.saving ? state.saving.then(save) : save();
  state.saving = saved.catch(() => undefined);
  await saved;
}

/**
 * Records one settled tool call's result in the transcript, where the
 * model's call order puts it. Results may arrive out of order - a parallel
 * call is recorded as soon as it settles (audit log-incident F9), so a
 * checkpoint holds every finished call and a crash never re-runs it - and
 * the transcript still keeps call order for the provider.
 */
export function pushToolResult(
  state: AgentRunState,
  toolCall: ToolCall,
  outcome: ToolCallOutcome
): void {
  // The message shape (the `{error}` payload, isError, LOU-X3's
  // replacedByHook record) is toolOutcomeMessage()'s, shared with the
  // handoff settle path in handoffRun.ts.
  insertToolResult(state.messages, toolOutcomeMessage(toolCall, outcome));
}

/**
 * LOU-V1: gives a tool call the run was aborted before reaching a `not-run`
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
 * LOU-V3: closes out a batch cut short by an abort - in call order, each
 * call that was not yet in the transcript gets its result if it finished,
 * or a cancelled result if it never started, was waiting on an approval,
 * or ended in a fatal error.
 */
export function pushAbortedBatchResults(
  state: AgentRunState,
  calls: UnrecordedToolCall[],
  reason = 'the run was aborted'
): void {
  for (const { toolCall, outcome } of calls) {
    if (outcome && !outcome.requiresApproval && !outcome.signIn) {
      pushToolResult(state, toolCall, outcome);
    } else {
      pushCancelledToolResult(state, toolCall, reason);
    }
  }
}

/** The ExecutionResult reflecting the run's current state. */
export function toExecutionResult(
  state: AgentRunState,
  text: string,
  finishReason: string
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
  };
}

/** LOU-V13: adds a step's reasoning text to the run's. */
export function noteReasoning(state: AgentRunState, reasoning: ReasoningBlock[] | undefined): void {
  const text = (reasoning ?? []).map((block) => block.text).join('');
  if (text) state.reasoning = state.reasoning ? `${state.reasoning}

${text}` : text;
}

/**
 * The assistant message of a tool-call turn. LOU-V13: it keeps only the
 * reasoning blocks a provider needs back (signed or redacted Anthropic
 * thinking), so they survive the next step, a checkpoint and a resume.
 */
export function assistantTurn(result: GenerateResult): Message {
  const replayed = (result.reasoning ?? []).filter((block) => block.signature || block.redactedData);
  const turn: Message = { role: 'assistant', content: result.text || '', toolCalls: result.toolCalls, ...(replayed.length > 0 && { reasoning: replayed }) };
  // N1a: the provider's own calls are kept on the turn, never sent back as calls.
  return withHostedCalls(turn, result.hostedToolCalls);
}
