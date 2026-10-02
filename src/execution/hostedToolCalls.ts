/**
 * N1a: what the run loop does with hosted tool calls - the calls a provider
 * ran inside a model request (`webSearch()` and the like). The SDK never
 * executes them: no permission rule, guardrail, approval, hook or
 * `onToolCall` sees them. They are reported (events with
 * `executedBy: 'provider'`), kept on the step's assistant message
 * (`metadata.hostedToolCalls`) and counted in usage.
 */

import type { GenerateResult, HostedToolCall, LLMProvider, Message } from '../providers';
import type { RunUsage } from '../models/usage';
import { assertHostedToolNames, hostedToolUnsupported, type HostedTool } from '../tools/hosted';
import type { AgentConfig } from '../types';

/** Longest hosted result kept in the transcript and in events, in characters of JSON. */
export const HOSTED_RESULT_LIMIT = 20_000;

/** `value` as it survives a JSON round trip (`undefined` -> `null`; unserializable -> its string form). */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) ?? null;
  } catch {
    return String(value);
  }
}

/** A hosted result, JSON-safe; over {@link HOSTED_RESULT_LIMIT} characters of JSON it becomes the cut JSON text with a marker. */
export function cappedHostedResult(value: unknown): unknown {
  const safe = jsonSafe(value);
  const json = JSON.stringify(safe);
  if (json.length <= HOSTED_RESULT_LIMIT) return safe;
  return `${json.slice(0, HOSTED_RESULT_LIMIT)}... [truncated ${json.length - HOSTED_RESULT_LIMIT} characters]`;
}

/** A hosted call as kept in `metadata.hostedToolCalls`: JSON-safe, the result capped. */
function hostedCallRecord(call: HostedToolCall): HostedToolCall {
  return {
    id: call.id,
    name: call.name,
    args: jsonSafe(call.args),
    ...(call.result !== undefined && { result: cappedHostedResult(call.result) }),
    ...(call.isError && { isError: true }),
    ...(call.sources?.length && { sources: call.sources.map(({ url, title }) => ({ url, ...(title !== undefined && { title }) })) }),
  };
}

/** `message` with the step's hosted calls in `metadata.hostedToolCalls` (unchanged when there are none). */
export function withHostedCalls(message: Message, calls: readonly HostedToolCall[] | undefined): Message {
  if (!calls?.length) return message;
  return { ...message, metadata: { ...message.metadata, hostedToolCalls: calls.map(hostedCallRecord) } };
}

/**
 * A step whose only calls the provider ran is a final reply: the provider may
 * still report `tool_calls`, which would make the loop ask the model again
 * with nothing new.
 */
export function settleHostedFinish(result: GenerateResult): GenerateResult {
  if (result.finishReason !== 'tool_calls' || !result.hostedToolCalls?.length || result.toolCalls?.length) return result;
  return { ...result, finishReason: 'stop' };
}

/** Adds the step's hosted calls to `usage.hostedToolCalls`, per tool name (mutates). */
export function countHostedCalls(usage: RunUsage, calls: readonly HostedToolCall[] | undefined): void {
  if (!calls?.length) return;
  const counts = (usage.hostedToolCalls ??= {});
  for (const { name } of calls) counts[name] = (counts[name] ?? 0) + 1;
}

/** Adds `add`'s per-tool counts to `into` (mutates), creating it when needed. */
export function addHostedCounts(into: RunUsage, add: RunUsage['hostedToolCalls']): void {
  for (const [name, count] of Object.entries(add ?? {})) {
    if (!count) continue;
    const counts = (into.hostedToolCalls ??= {});
    counts[name] = (counts[name] ?? 0) + count;
  }
}

/**
 * Before a run with hosted tools: no hosted tool shares a name with another
 * or with a local tool, and the provider can send each one
 * (`LLMProvider.supportsHostedTool`; absent means none).
 */
export function assertHostedToolsSupported(hostedTools: readonly HostedTool[] | undefined, agent: AgentConfig, provider: LLMProvider): void {
  if (!hostedTools?.length) return;
  assertHostedToolNames(hostedTools, Object.keys(agent.tools ?? {}));
  for (const tool of hostedTools) {
    if (typeof provider.supportsHostedTool !== 'function') {
      throw hostedToolUnsupported(provider.name, tool, 'the provider does not implement supportsHostedTool()');
    }
    if (!provider.supportsHostedTool(tool.type)) {
      throw hostedToolUnsupported(provider.name, tool, `the provider reports no support for ${tool.type === 'custom' ? 'hostedTool() pass-through' : tool.type} here`);
    }
  }
}
