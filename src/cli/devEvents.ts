/**
 * Events for `loushy dev` responses that are not a live `stream()` (LOU-D32):
 * `agent.approvals.resolve()` runs the continued turn to its end and returns
 * an `ExecutionResult`, so the dev server rebuilds the turn's events from it.
 */
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload, type AgentEventUsage } from '../execution/agentEvents';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { PendingApproval } from '../execution/ApprovalGate';
import { textOf } from '../providers/content';
import type { Message } from '../providers/llm';
import { newId } from '../utils/id';

/** `payloads` as one run's events: a shared `runId`, `seq` 0, 1, 2..., `timestamp` and `v` filled in. */
function runEvents(payloads: AgentEventPayload[]): AgentEvent[] {
  const runId = newId();
  return payloads.map(
    (payload, seq) => ({ ...payload, runId, seq, timestamp: new Date().toISOString(), v: AGENT_EVENT_SCHEMA_VERSION }) as AgentEvent
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `error` then `run.done`, for a request that failed while streaming. */
export function errorEvents(error: unknown): AgentEvent[] {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : 'Error';
  return runEvents([
    { type: 'error', error: { name, message } },
    { type: 'run.done', finishReason: 'error', text: '' },
  ]);
}

function toEventUsage(usage: ExecutionResult['usage']): AgentEventUsage {
  const { inputTokens, outputTokens, totalTokens, estimated, costUsd } = usage;
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    inputTokens,
    outputTokens,
    estimated,
    ...(costUsd !== undefined && { costUsd }),
  };
}

/** The events a transcript message stands for: a tool result, or an assistant message's tool calls and text. */
function messagePayloads(message: Message): AgentEventPayload[] {
  const text = textOf(message);
  if (message.role === 'tool') {
    const base = { toolCallId: message.toolCallId ?? '', toolName: message.toolName ?? '', durationMs: 0 };
    return [message.isError ? { type: 'tool.error', ...base, error: { name: 'Error', message: text } } : { type: 'tool.done', ...base, result: parseJson(text) }];
  }
  const calls: AgentEventPayload[] = (message.toolCalls ?? []).map((call) => ({
    type: 'tool.start',
    toolCallId: call.id,
    toolName: call.function.name,
    args: (parseJson(call.function.arguments) ?? {}) as Record<string, unknown>,
  }));
  return message.role === 'assistant' && text ? [...calls, { type: 'text.delta', text }, { type: 'text.done', text }] : calls;
}

/**
 * The events of a turn continued after `resolved` was decided: the decided
 * call's result and everything after it in `result.messages`, then
 * `approval.requested` for `pausedAgain` (when the turn paused again) and
 * `run.done`. Text arrives as one `text.delta`, not token by token.
 */
export function continuationEvents(result: ExecutionResult, resolved: PendingApproval, pausedAgain?: PendingApproval): AgentEvent[] {
  const decided = result.messages.findIndex((m) => m.role === 'tool' && m.toolCallId === resolved.toolCallId);
  const payloads: AgentEventPayload[] = [
    { type: 'run.start', agentName: resolved.agentId ?? 'agent' },
    ...(decided < 0 ? [] : result.messages.slice(decided).flatMap(messagePayloads)),
  ];
  if (pausedAgain) {
    const { id, toolCallId, toolName, args, kind, question } = pausedAgain;
    payloads.push({ type: 'approval.requested', approvalId: id, toolCallId, toolName, args, ...(kind && { kind }), ...(question && { question }) });
  }
  payloads.push({ type: 'run.done', finishReason: result.finishReason, text: result.text, usage: toEventUsage(result.usage) });
  return runEvents(payloads);
}
