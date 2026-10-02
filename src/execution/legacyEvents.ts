/**
 * LOU-D41: the deprecated `ExecuteOptions.onEvent` listener, fed from the
 * run's {@link AgentEvent}s. The executor emits AgentEvents only; this maps
 * each one to the {@link ExecutionEvent}(s) the old listener expects. What
 * an AgentEvent cannot carry as JSON (the `Error` instance, the raw tool
 * result, `RunUsage`, the abort reason) comes with it as {@link LegacyDetail}.
 */

import type { ToolCall } from '../providers';
import type { RunUsage, StepUsage } from '../models/usage';
import type { AgentEvent, AgentEventOf } from './agentEvents';
import type { ExecutionEvent } from './AgentExecutor';

/** The in-process values behind an AgentEvent, for the ExecutionEvent derived from it. */
export interface LegacyDetail {
  error?: unknown;
  toolCall?: ToolCall;
  toolResult?: ExecutionEvent['toolResult'];
  stepUsage?: StepUsage;
  usage?: RunUsage;
  abortReason?: unknown;
}

let warned = false;

/** Warns once per process that `onEvent` is deprecated. */
export function warnLegacyOnEvent(): void {
  if (warned) return;
  warned = true;
  console.warn(
    '[@loushy/build-ai-agent] ExecuteOptions.onEvent (ExecutionEvent) is deprecated and will be removed: ' +
      'use onAgentEvent (AgentEvent), or createAgent({ onEvent }). See docs/streaming.md#listening-without-iterating.'
  );
}

/** The ExecutionEvents the deprecated `onEvent` gets for `event` (none for event types it never had). */
export function toExecutionEvents(event: AgentEvent, detail: LegacyDetail = {}): ExecutionEvent[] {
  const at = { timestamp: new Date(event.timestamp), ...(event.subagent && { subagent: event.subagent }) };
  switch (event.type) {
    case 'run.start':
      return [{ ...at, type: 'start', agentId: event.agentId, agentName: event.agentName }];
    case 'text.done':
      return [{ ...at, type: 'text-complete', text: event.text, ...(detail.stepUsage && { stepUsage: detail.stepUsage }) }];
    case 'tool.start':
      return [{ ...at, type: 'tool-call', toolCall: detail.toolCall ?? toolCallOf(event) }];
    case 'tool.done':
    case 'tool.error':
      return [{ ...at, type: 'tool-result', toolResult: detail.toolResult ?? toolResultOf(event) }];
    case 'error':
      return [{ ...at, type: 'error', error: (detail.error as Error | undefined) ?? Object.assign(new Error(event.error.message), { name: event.error.name }) }];
    case 'run.done':
      return finished(event, at, detail);
    default:
      return [];
  }
}

function toolCallOf({ toolCallId, toolName, args }: AgentEventOf<'tool.start'>): ToolCall {
  return { id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } };
}

function toolResultOf(event: AgentEventOf<'tool.done' | 'tool.error'>): NonNullable<ExecutionEvent['toolResult']> {
  const { toolCallId, toolName } = event;
  if (event.type === 'tool.error') return { toolCallId, toolName, result: { error: event.error.name }, error: event.error.message };
  return { toolCallId, toolName, result: event.result, ...(event.replacedByHook && { replacedByHook: event.replacedByHook }) };
}

/** `finish` (after `abort` for an aborted run); a failed run had its `error` already. */
function finished(event: AgentEventOf<'run.done'>, at: Pick<ExecutionEvent, 'timestamp' | 'subagent'>, detail: LegacyDetail): ExecutionEvent[] {
  const { finishReason } = event;
  if (finishReason === 'error') return [];
  const usage = detail.usage && { usage: detail.usage };
  const finish: ExecutionEvent = { ...at, type: 'finish', finishReason, ...usage };
  return finishReason === 'aborted' ? [{ ...at, type: 'abort', abortReason: detail.abortReason, ...usage }, finish] : [finish];
}
