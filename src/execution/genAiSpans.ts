/**
 * Builds the span names, kinds and attributes for agent runs, model calls
 * and tool executions following the OpenTelemetry GenAI semantic
 * conventions (LOU-D9), dual-emitting the SDK's older ad-hoc attribute
 * names. See `semconv.ts` for the spec URL, retrieval date and stability.
 *
 * Message and argument CONTENT is sensitive: the `gen_ai.*` content
 * attributes are only recorded when `captureContent` is true (or the
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` environment variable
 * is `true` and `captureContent` was not set). The deprecated content
 * attributes (`input`, `prompt`, `args`, `result`) keep their previous
 * behavior: recorded unless `redactContent` is true.
 */

import type { GenerateOptions, GenerateResult, LLMProvider, Message, ToolCall } from '../providers';
import type { ToolRegistry } from '../tools';
import type { AgentConfig } from '../types';
import { ErrorAttr, GenAiAttr, GenAiOperation, LegacyAttr, SdkAttr, TOOL_TYPE_FUNCTION, CAPTURE_CONTENT_ENV } from './semconv';
import type { Span, SpanKind } from './tracing';
import { estimateCost } from '../models';
import { normalizeUsage } from '../models/usage';
import type { Usage } from '../models/usage';

/** Name, kind and starting attributes for a span about to be opened. */
interface SpanInit {
  name: string;
  kind: SpanKind;
  attributes: Record<string, unknown>;
}

/** Content-privacy switches shared by every traced entry point. */
interface ContentOptions {
  /**
   * Record message and tool-argument content on the `gen_ai.*` attributes
   * (`gen_ai.input.messages`, `gen_ai.output.messages`,
   * `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`,
   * `gen_ai.tool.call.result`). Off by default because content is sensitive
   * and large; when omitted it falls back to the
   * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` environment
   * variable.
   *
   * @example
   * await AgentExecutor.execute({ agent, input, provider, exporter, captureContent: true });
   */
  captureContent?: boolean;
  /** Omit the deprecated `prompt`/`args`/`result` attributes (default false). */
  redactContent?: boolean;
}

/** Resolves `captureContent`, falling back to the OTel content env var. */
export function resolveCaptureContent(captureContent: boolean | undefined): boolean {
  if (captureContent !== undefined) {
    return captureContent;
  }
  return typeof process !== 'undefined' && process.env?.[CAPTURE_CONTENT_ENV]?.toLowerCase() === 'true';
}

/** Drops `undefined` values so attribute maps contain only what is known. */
export function defined(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined));
}

function textPart(content: string) {
  return { type: 'text', content };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolCallPart(call: ToolCall) {
  return {
    type: 'tool_call',
    id: call.id,
    name: call.function.name,
    arguments: parseJson(call.function.arguments),
  };
}

function genAiMessage(message: Message) {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: message.toolCallId, response: parseJson(message.content) }],
    };
  }
  const parts: unknown[] = message.content ? [textPart(message.content)] : [];
  parts.push(...(message.toolCalls ?? []).map(toolCallPart));
  return { role: message.role, parts };
}

/** Content attributes for a model call's request (JSON strings, per spec fallback for spans). */
function requestContent(messages: Message[]): Record<string, unknown> {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  return defined({
    [GenAiAttr.SYSTEM_INSTRUCTIONS]:
      system.length > 0 ? JSON.stringify(system.map((m) => textPart(m.content))) : undefined,
    [GenAiAttr.INPUT_MESSAGES]: JSON.stringify(rest.map(genAiMessage)),
  });
}

/** `invoke_agent {name}` span for one agent run. */
export function agentRunSpanInit(
  options: { agent: AgentConfig; provider?: LLMProvider; sessionId?: string; input: unknown },
  captureContent: boolean
): SpanInit {
  const { agent, provider, sessionId, input } = options;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return {
    name: `${GenAiOperation.INVOKE_AGENT} ${agent.name}`,
    kind: 'internal',
    attributes: defined({
      [GenAiAttr.OPERATION_NAME]: GenAiOperation.INVOKE_AGENT,
      [GenAiAttr.AGENT_NAME]: agent.name,
      [GenAiAttr.AGENT_ID]: agent.id,
      [GenAiAttr.PROVIDER_NAME]: provider?.name,
      [GenAiAttr.CONVERSATION_ID]: sessionId,
      [LegacyAttr.INPUT]: text,
      [GenAiAttr.INPUT_MESSAGES]: captureContent
        ? JSON.stringify([{ role: 'user', parts: [textPart(text)] }])
        : undefined,
    }),
  };
}

/** `chat {model}` span (CLIENT) for one provider.generate() call. */
export function llmSpanInit(
  provider: LLMProvider,
  request: GenerateOptions,
  content: ContentOptions & { captureContent: boolean }
): SpanInit {
  return {
    name: request.model ? `${GenAiOperation.CHAT} ${request.model}` : GenAiOperation.CHAT,
    kind: 'client',
    attributes: defined({
      [GenAiAttr.OPERATION_NAME]: GenAiOperation.CHAT,
      [GenAiAttr.PROVIDER_NAME]: provider.name,
      [GenAiAttr.REQUEST_MODEL]: request.model,
      [GenAiAttr.REQUEST_TEMPERATURE]: request.temperature,
      [GenAiAttr.REQUEST_MAX_TOKENS]: request.maxTokens,
      [LegacyAttr.MODEL]: request.model,
      ...(content.redactContent ? {} : { [LegacyAttr.PROMPT]: JSON.stringify(request.messages) }),
      ...(content.captureContent ? requestContent(request.messages) : {}),
    }),
  };
}

/** The spec's `tool_call` finish reason is singular; ours is `tool_calls`. */
function genAiFinishReason(reason: GenerateResult['finishReason']): string {
  return reason === 'tool_calls' ? 'tool_call' : reason;
}

function responseModel(generated: GenerateResult): string | undefined {
  const raw = generated.rawResponse;
  const model = raw?.response?.modelId ?? raw?.modelId ?? raw?.model;
  return typeof model === 'string' ? model : undefined;
}

/**
 * Records usage, finish reason, response model (and output content) on a `chat` span.
 * Usage is the same normalized `Usage` the run totals use: pass the executor's
 * `measured` figures (which may be estimates), else what the provider reported.
 * `loushy.cost_usd` is the step's cost when the price table knows the model.
 */
export function recordLlmResult(
  span: Span,
  generated: GenerateResult,
  captureContent: boolean,
  measured?: { usage: Usage; estimated: boolean; costUsd?: number }
): void {
  const usage = measured?.usage ?? normalizeUsage(generated.usage);
  const model = span.attributes[GenAiAttr.REQUEST_MODEL];
  const costUsd =
    measured?.costUsd ?? (usage && typeof model === 'string' ? estimateCost(usage, model) : undefined);
  const parts: unknown[] = generated.text ? [textPart(generated.text)] : [];
  parts.push(...(generated.toolCalls ?? []).map(toolCallPart));
  // Token counts and finish reason are never redacted.
  span.attributes = {
    ...span.attributes,
    ...defined({
      [GenAiAttr.RESPONSE_MODEL]: responseModel(generated),
      [GenAiAttr.RESPONSE_FINISH_REASONS]: [genAiFinishReason(generated.finishReason)],
      [GenAiAttr.USAGE_INPUT_TOKENS]: usage?.inputTokens,
      [GenAiAttr.USAGE_OUTPUT_TOKENS]: usage?.outputTokens,
      [LegacyAttr.PROMPT_TOKENS]: usage?.inputTokens,
      [LegacyAttr.COMPLETION_TOKENS]: usage?.outputTokens,
      [LegacyAttr.TOTAL_TOKENS]: usage?.totalTokens,
      [SdkAttr.USAGE_ESTIMATED]: measured?.estimated ? true : undefined,
      [SdkAttr.COST_USD]: costUsd,
      [LegacyAttr.FINISH_REASON]: generated.finishReason,
      [GenAiAttr.OUTPUT_MESSAGES]: captureContent
        ? JSON.stringify([{ role: 'assistant', parts }])
        : undefined,
    }),
  };
}

/** `execute_tool {name}` span for one tool execution. */
export function toolSpanInit(
  toolCall: { id?: string; name: string },
  context: { agent: AgentConfig; toolRegistry?: ToolRegistry; sessionId?: string }
): SpanInit {
  const toolName = toolCall.name;
  return {
    name: `${GenAiOperation.EXECUTE_TOOL} ${toolName}`,
    kind: 'internal',
    attributes: defined({
      [GenAiAttr.OPERATION_NAME]: GenAiOperation.EXECUTE_TOOL,
      [GenAiAttr.TOOL_NAME]: toolName,
      [GenAiAttr.TOOL_CALL_ID]: toolCall.id,
      [GenAiAttr.TOOL_DESCRIPTION]: context.toolRegistry?.get(toolName)?.tool?.description,
      [GenAiAttr.TOOL_TYPE]: TOOL_TYPE_FUNCTION,
      [GenAiAttr.AGENT_NAME]: context.agent.name,
      [GenAiAttr.CONVERSATION_ID]: context.sessionId,
      [LegacyAttr.TOOL_NAME]: toolName,
    }),
  };
}

/** Records args/result (content), error and latency on an `execute_tool` span. */
export function recordToolOutcome(
  span: Span,
  outcome: { args: unknown; result: unknown; error?: string; latencyMs: number },
  content: ContentOptions & { captureContent: boolean }
): void {
  span.attributes = {
    ...span.attributes,
    ...defined({
      ...(content.redactContent ? {} : { [LegacyAttr.ARGS]: outcome.args, [LegacyAttr.RESULT]: outcome.result }),
      [LegacyAttr.ERROR]: !!outcome.error,
      [LegacyAttr.LATENCY_MS]: outcome.latencyMs,
      [ErrorAttr.TYPE]: outcome.error ? 'tool_error' : undefined,
      [GenAiAttr.TOOL_CALL_ARGUMENTS]: content.captureContent ? JSON.stringify(outcome.args) : undefined,
      [GenAiAttr.TOOL_CALL_RESULT]:
        content.captureContent && !outcome.error ? JSON.stringify(outcome.result) : undefined,
    }),
  };
  if (outcome.error) {
    span.status = { code: 'error', message: outcome.error };
  }
}
