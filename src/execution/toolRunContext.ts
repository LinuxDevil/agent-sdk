/**
 * The one builder of the context a tool's `execute(args, ctx)` receives
 * (LOU-U15). Every path that runs a tool - the main loop, resume after an
 * approval, the sandbox route and FlowExecutor's tool-call node - goes
 * through {@link buildToolRunContext}, so the `ToolExecutionOptions` the
 * type promises (`toolCallId`, `messages`, `abortSignal`) are always real.
 */

import { newId } from '../utils/id';
import type { ToolExecutionOptions } from 'ai';
import type { Message } from '../providers';
import type { RunUsage } from '../models/usage';
import { bindToolCallScope, type ToolCallScope } from './subagentRuntime';

/** Extra context the executor hands a tool next to the 'ai' SDK's own execute options (LOU-V5). */
export interface ToolRunContext {
  /** Called by the delegate tool with a finished child run's usage, so the parent run adds it to its totals. */
  onDelegatedUsage?: (usage: RunUsage) => void;
  /**
   * LOU-U9: the model's id for this tool call - unchanged when a call that
   * was running when the process died is re-run on resume, so tools can use
   * it as an idempotency key.
   */
  toolCallId?: string;
}

/** What {@link buildToolRunContext} builds the context from. */
export interface ToolRunInput extends ToolRunContext {
  /** The run's transcript. The tool gets the part before the model turn that made this call. */
  messages?: readonly Message[];
  /** The run's cancellation signal; the tool gets it as `abortSignal`. */
  signal?: AbortSignal;
  /** LOU-Y1: lets a delegate/`task` tool's sub-agent inherit from this run. */
  scope?: ToolCallScope;
}

/**
 * A read-only copy of what the model had seen when it made `toolCallId`'s
 * call: the transcript without the system prompt and without the assistant
 * turn that made the call (or anything after it) - the same meaning
 * `ToolExecutionOptions.messages` has in the 'ai' SDK.
 */
function transcriptBefore(messages: readonly Message[], toolCallId: string): readonly Message[] {
  const turn = messages.findIndex((m) => m.toolCalls?.some((call) => call.id === toolCallId));
  const before = turn < 0 ? messages : messages.slice(0, turn);
  return Object.freeze(before.filter((m) => m.role !== 'system').map((m) => Object.freeze({ ...m })));
}

/**
 * The context for one tool call: `{ toolCallId, messages, abortSignal }`
 * plus the SDK's own {@link ToolRunContext} fields. `toolCallId` falls back
 * to a generated id for callers with no model turn behind the call.
 */
export function buildToolRunContext(input: ToolRunInput): ToolExecutionOptions & ToolRunContext {
  const toolCallId = input.toolCallId ?? newId('call');
  const ctx = {
    toolCallId,
    messages: transcriptBefore(input.messages ?? [], toolCallId),
    abortSignal: input.signal,
    onDelegatedUsage: input.onDelegatedUsage,
  } as unknown as ToolExecutionOptions & ToolRunContext;
  bindToolCallScope(ctx, input.scope);
  return ctx;
}
