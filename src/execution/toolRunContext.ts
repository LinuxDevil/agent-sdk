/**
 * The one builder of the context a tool's `execute(args, ctx)` receives
 * (LOU-U15). Every path that runs a tool - the main loop, resume after an
 * approval, the sandbox route and FlowExecutor's tool-call node - goes
 * through {@link buildToolRunContext}, so the `ToolExecutionContext` the
 * type promises (`toolCallId`, `messages`, `abortSignal`) are always real.
 */

import { newId } from '../utils/id';
import type { Message } from '../providers';
import type { ToolExecutionContext } from '../types/tool';
import { bindToolCallScope, type ToolCallScope } from './subagentRuntime';

/**
 * @deprecated Use {@link ToolExecutionContext}, the one public execute-context
 * type. Kept as an alias of its fields (all optional, `messages` left out, as
 * before) so existing imports compile and 'ai' `tool()` execute options still
 * fit it.
 */
export type ToolRunContext = Partial<Omit<ToolExecutionContext, 'messages'>>;

/** What {@link buildToolRunContext} builds the context from. */
export interface ToolRunInput extends Pick<ToolRunContext, 'toolCallId' | 'sessionId' | 'onDelegatedUsage'> {
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
 * `ToolExecutionContext.messages` has (as in the 'ai' SDK).
 */
function transcriptBefore(messages: readonly Message[], toolCallId: string): readonly Message[] {
  const turn = messages.findIndex((m) => m.toolCalls?.some((call) => call.id === toolCallId));
  const before = turn < 0 ? messages : messages.slice(0, turn);
  return Object.freeze(before.filter((m) => m.role !== 'system').map((m) => Object.freeze({ ...m })));
}

/**
 * The context for one tool call: `{ toolCallId, messages, abortSignal }`
 * plus the optional `sessionId` and `onDelegatedUsage`. `toolCallId` falls back
 * to a generated id for callers with no model turn behind the call.
 */
export function buildToolRunContext(input: ToolRunInput): ToolExecutionContext {
  const toolCallId = input.toolCallId ?? newId('call');
  const ctx: ToolExecutionContext = {
    toolCallId,
    messages: transcriptBefore(input.messages ?? [], toolCallId),
    abortSignal: input.signal,
    onDelegatedUsage: input.onDelegatedUsage,
    ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
  };
  bindToolCallScope(ctx, input.scope);
  return ctx;
}
