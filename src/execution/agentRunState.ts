/**
 * Mutable per-run state of an AgentExecutor.execute() call: where it
 * starts from (a rehydrated checkpoint, or a fresh conversation), how it
 * is checkpointed after each tool result, and how it becomes the final
 * ExecutionResult.
 */

import { Message, ToolCall } from '../providers';
import { AgentConfig } from '../types';
import { Checkpoint, CheckpointStatus } from './checkpoint';
import { CompactedLLMProviderError, SessionAwaitingApprovalError } from './errors';
import { inputMessages, newSessionMessages, splitPendingTurn } from './transcript';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { ToolCallOutcome } from './toolCallExecution';
import type { UnrecordedToolCall } from './toolBatch';

type TokenUsage = ExecutionResult['usage'];

export interface AgentRunState {
  messages: Message[];
  toolCalls: ToolCall[];
  usage: TokenUsage;
  steps: number;
  businessState: unknown;
  finalText: string;
  finishReason: string;
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

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

type InitialRunState = Pick<
  AgentRunState,
  'messages' | 'toolCalls' | 'usage' | 'steps' | 'businessState'
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
    usage: finished ? { ...ZERO_USAGE } : { ...checkpoint.usage },
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
    usage: { ...ZERO_USAGE },
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
    throw new SessionAwaitingApprovalError(sessionId, checkpoint.approvalId);
  }

  const initial = checkpoint ? stateFromCheckpoint(checkpoint, options) : freshState(options);
  const turn = splitPendingTurn(initial.messages);

  return {
    ...initial,
    messages: turn.messages,
    pendingToolCalls: turn.pendingToolCalls,
    queuedInput: turn.queuedInput,
    finalText: '',
    finishReason: 'stop',
  };
}

/** Accumulates one generate() call's token usage into the run total. */
export function addUsage(total: TokenUsage, usage: TokenUsage): void {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  total.totalTokens += usage.totalTokens;
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
  approvalId?: string
): Promise<void> {
  const { agent, sessionId, checkpointStore } = options;
  if (!sessionId || !checkpointStore) {
    return;
  }

  const checkpoint: Checkpoint = {
    agentId: agent.id || '',
    sessionId,
    stepIndex: state.steps,
    messages: [...state.messages, ...state.queuedInput],
    toolCalls: [...state.toolCalls],
    usage: state.usage,
    finishReason: state.finishReason,
    businessState: state.businessState,
    status,
    ...(approvalId !== undefined && { approvalId }),
  };
  await checkpointStore.save(sessionId, checkpoint);
}

/** Appends one settled tool call's result to the transcript. */
export function pushToolResult(
  state: AgentRunState,
  toolCall: ToolCall,
  outcome: ToolCallOutcome
): void {
  // A failed tool carries its message as `{error}` (the same shape
  // resume.ts uses) - `result` is null then, so the model would otherwise
  // see a bare "null" and never learn the call failed. A failure that
  // already has a structured result (argument validation) keeps it, so the
  // model gets the per-issue detail.
  const failed = outcome.error !== undefined;
  const failurePayload = outcome.result ?? { error: outcome.error };
  state.messages.push({
    role: 'tool',
    content: JSON.stringify(failed ? failurePayload : outcome.result),
    name: toolCall.function.name,
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    ...(failed && { isError: true }),
  });
}

/**
 * LOU-V1: gives a tool call the run was aborted before reaching a `{error}`
 * tool result, so the transcript stays well-formed (every assistant tool
 * call has a matching result) and a checkpointed run can be resumed without
 * the provider rejecting an unanswered tool call.
 */
function pushCancelledToolResult(state: AgentRunState, toolCall: ToolCall): void {
  state.messages.push({
    role: 'tool',
    content: JSON.stringify({
      error: 'Tool call was cancelled before it ran because the run was aborted',
    }),
    name: toolCall.function.name,
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
  });
}

/**
 * LOU-V3: closes out a batch cut short by an abort - in call order, each
 * call that was not yet in the transcript gets its result if it finished,
 * or a cancelled result if it never started, was waiting on an approval,
 * or ended in a fatal error.
 */
export function pushAbortedBatchResults(state: AgentRunState, calls: UnrecordedToolCall[]): void {
  for (const { toolCall, outcome } of calls) {
    if (outcome && !outcome.requiresApproval) {
      pushToolResult(state, toolCall, outcome);
    } else {
      pushCancelledToolResult(state, toolCall);
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
    messages: state.messages,
    toolCalls: state.toolCalls,
    usage: state.usage,
    finishReason,
    steps: state.steps,
  };
}
