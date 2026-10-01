/**
 * Mutable per-run state of an AgentExecutor.execute() call: where it
 * starts from (a rehydrated checkpoint, or a fresh conversation), how it
 * is checkpointed after each tool result, and how it becomes the final
 * ExecutionResult.
 */

import { Message, ToolCall } from '../providers';
import { AgentConfig } from '../types';
import { Checkpoint } from './checkpoint';
import { CompactedLLMProviderError } from './errors';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';

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
}

/**
 * Build messages from input
 */
function buildMessages(
  agent: AgentConfig,
  input: string | Message[],
  skipSystemPromptInjection = false
): Message[] {
  const messages: Message[] = [];

  // Add system prompt, unless the caller has indicated `input` already
  // includes one (e.g. resume.ts rebuilding from an ExecutionSnapshot).
  if (agent.prompt && !skipSystemPromptInjection) {
    messages.push({
      role: 'system',
      content: agent.prompt,
    });
  }

  // Add input messages
  if (typeof input === 'string') {
    messages.push({
      role: 'user',
      content: input,
    });
  } else {
    messages.push(...input);
  }

  return messages;
}

type InitialRunState = Pick<
  AgentRunState,
  'messages' | 'toolCalls' | 'usage' | 'steps' | 'businessState'
>;

/** Rehydrates run state from a checkpoint left by an earlier process. */
function stateFromCheckpoint(checkpoint: Checkpoint, businessState: unknown): InitialRunState {
  // LOU-T1: on a rehydrated run (e.g. a fresh process resuming after a
  // crash), the caller of this execute() call may have no way to know
  // what businessState a *previous* process attached - that's exactly
  // the "second store, hope it stays aligned" gap this field closes. So
  // when a checkpoint is loaded and this call's own `businessState`
  // option was left unset, fall back to the value already stored on the
  // checkpoint rather than silently dropping it. An explicit
  // `businessState` passed to *this* call always wins (e.g. a caller
  // deliberately updating it as part of the resumed run).
  return {
    messages: [...checkpoint.messages],
    toolCalls: [...(checkpoint.toolCalls as ToolCall[])],
    usage: { ...checkpoint.usage },
    steps: checkpoint.stepIndex,
    businessState: businessState === undefined ? checkpoint.businessState : businessState,
  };
}

/** Builds messages from scratch (the no-checkpoint fallback path). */
function freshState(options: ExecuteOptions): InitialRunState {
  const { agent, input, skipSystemPromptInjection, initialSteps, businessState } = options;
  return {
    messages: buildMessages(agent, input, skipSystemPromptInjection),
    toolCalls: [],
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    steps: initialSteps ?? 0,
    businessState,
  };
}

/**
 * If a checkpoint exists for this sessionId, rehydrate state from it
 * instead of building messages from scratch.
 */
export async function loadRunState(options: ExecuteOptions): Promise<AgentRunState> {
  const { sessionId, checkpointStore } = options;
  let checkpoint: Checkpoint | null = null;
  if (sessionId && checkpointStore) {
    checkpoint = await checkpointStore.load(sessionId);
  }

  const initial = checkpoint
    ? stateFromCheckpoint(checkpoint, options.businessState)
    : freshState(options);

  return { ...initial, finalText: '', finishReason: 'stop' };
}

/** Accumulates one generate() call's token usage into the run total. */
export function addUsage(total: TokenUsage, usage: TokenUsage): void {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  total.totalTokens += usage.totalTokens;
}

/** Persists the run's progress after a tool result, when checkpointing is on. */
export async function saveStepCheckpoint(
  options: ExecuteOptions,
  state: AgentRunState
): Promise<void> {
  const { agent, sessionId, checkpointStore } = options;
  if (!sessionId || !checkpointStore) {
    return;
  }

  const checkpoint: Checkpoint = {
    agentId: agent.id || '',
    sessionId,
    stepIndex: state.steps,
    messages: [...state.messages],
    toolCalls: [...state.toolCalls],
    usage: state.usage,
    finishReason: state.finishReason,
    businessState: state.businessState,
  };
  await checkpointStore.save(sessionId, checkpoint);
}

/**
 * LOU-V1: gives each tool call the run was aborted before reaching a
 * `{error}` tool result, so the transcript stays well-formed (every
 * assistant tool call has a matching result) and a checkpointed run can be
 * resumed without the provider rejecting an unanswered tool call.
 */
export function pushCancelledToolResults(state: AgentRunState, toolCalls: ToolCall[]): void {
  for (const toolCall of toolCalls) {
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
