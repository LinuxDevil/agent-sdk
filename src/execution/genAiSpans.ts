/**
 * Builds the span names, kinds and attributes for agent runs, model calls
 * and tool executions following the OpenTelemetry GenAI semantic
 * conventions, dual-emitting the SDK's older ad-hoc attribute
 * names. See `semconv.ts` for the spec URL, retrieval date and stability.
 *
 * Message and argument CONTENT is sensitive: the `gen_ai.*` content
 * attributes are only recorded when `captureContent` is true (or the
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` environment variable
 * is `true` and `captureContent` was not set). The deprecated content
 * attributes (`input`, `prompt`, `args`, `result`) are only recorded when
 * `redactContent` is explicitly false (they used to be on by
 * default, which put prompts and tool output on disk via `fileTraceExporter`).
 * Captured `gen_ai.*` content text goes through `redactContent` first: the
 * built-in secret scrubber, a custom function in its place, or nothing when
 * `redactContent` is `false`.
 */

import type { GenerateOptions, GenerateResult, LLMProvider, Message, ToolCall } from '../providers';
import { textOf } from '../providers/content';
import type { ToolRegistry } from '../tools';
import type { AgentConfig } from '../types';
import { ErrorAttr, GenAiAttr, GenAiOperation, LegacyAttr, SandboxAttr, SdkAttr, TOOL_TYPE_FUNCTION, CAPTURE_CONTENT_ENV } from './semconv';
import { sandboxDriverName } from '../sandbox/types';
import type { Span, SpanKind } from './tracing';
import { estimateCost } from '../models';
import { normalizeUsage } from '../models/usage';
import type { Usage } from '../models/usage';
import { REDACTED, scrubSecrets } from './scrubSecrets';

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
  /**
   * Omit the deprecated `input`/`prompt`/`args`/`result` attributes and scrub
   * secrets from captured content. Defaults to true: only an explicit `false`
   * records them and skips scrubbing. A function replaces the built-in
   * scrubber on captured content text.
   */
  redactContent?: boolean | ((text: string) => string);
}

/** Maps one piece of captured content text before it is encoded. */
type Redact = (text: string) => string;

const keepText: Redact = (text) => text;

/** A custom redactor that throws redacts that text whole: telemetry never fails a run. */
function safeRedactor(redact: Redact): Redact {
  return (text) => {
    try {
      return redact(text);
    } catch {
      return REDACTED;
    }
  };
}

/** The text mapping `redactContent` asks for on captured `gen_ai.*` content. */
export function contentRedactor(content: ContentOptions): Redact {
  const { redactContent } = content;
  if (redactContent === false) return keepText;
  return typeof redactContent === 'function' ? safeRedactor(redactContent) : scrubSecrets;
}

/**
 * JSON-encodes an arbitrary value (a tool's args or result) with `redact` on
 * every string. Redacting in the replacer keeps `JSON.stringify`'s own
 * semantics (`toJSON`, so a Date is its ISO string; its TypeError on a cycle);
 * `false` encodes exactly as before.
 */
function encodeContent(value: unknown, redact: Redact): string | undefined {
  if (redact === keepText) return JSON.stringify(value);
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? redact(item) : item));
}

/** Applies `redact` to every string inside parsed JSON (plain data: no toJSON, no cycles). */
function redactValue(value: unknown, redact: Redact): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, redact)]));
  }
  return value;
}

/** The deprecated content attributes are recorded only on an explicit opt-out of redaction. */
function keepLegacyContent(content: ContentOptions): boolean {
  return content.redactContent === false;
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

function textPart(content: string, redact: Redact) {
  return { type: 'text', content: redact(content) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolCallPart(call: ToolCall, redact: Redact) {
  return {
    type: 'tool_call',
    id: call.id,
    name: call.function.name,
    arguments: redactValue(parseJson(call.function.arguments), redact),
  };
}

function genAiMessage(message: Message, redact: Redact) {
  if (message.role === 'tool') {
    const response = redactValue(parseJson(textOf(message)), redact);
    return { role: 'tool', parts: [{ type: 'tool_call_response', id: message.toolCallId, response }] };
  }
  const text = textOf(message);
  const parts: unknown[] = text ? [textPart(text, redact)] : [];
  parts.push(...(message.toolCalls ?? []).map((call) => toolCallPart(call, redact)));
  return { role: message.role, parts };
}

/** Content attributes for a model call's request (JSON strings, per spec fallback for spans). */
function requestContent(messages: Message[], redact: Redact): Record<string, unknown> {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  return defined({
    [GenAiAttr.SYSTEM_INSTRUCTIONS]:
      system.length > 0 ? JSON.stringify(system.map((m) => textPart(textOf(m), redact))) : undefined,
    [GenAiAttr.INPUT_MESSAGES]: JSON.stringify(rest.map((m) => genAiMessage(m, redact))),
  });
}

/**
 * The run's input in the spec's message schema. A `Message[]` input maps
 * message-for-message; anything else becomes one user text part. Before this
 * a `Message[]` input was `JSON.stringify`'d into the text part's `content`,
 * so `gen_ai.input.messages` carried the messages double-JSON-encoded.
 */
function agentInputMessages(input: unknown, text: string, redact: Redact): unknown[] {
  if (Array.isArray(input)) return (input as Message[]).map((m) => genAiMessage(m, redact));
  return [{ role: 'user', parts: [textPart(text, redact)] }];
}

/** The name `createAgent()` gives an agent without a `name`. */
export const DEFAULT_AGENT_NAME = 'agent';

/** The execute option a sub-agent run carries, so its `invoke_agent` span says which sub-agent it is. */
export const SUBAGENT_SPAN = Symbol('lousho.subagentSpan');

/** What a sub-agent's `invoke_agent` span records about it. */
export interface SubagentSpanInfo {
  /** The name the lead knows it by (the `task` tool's `agent`). */
  name: string;
  depth: number;
  taskId?: string;
}

/** `invoke_agent {name}` span for one agent run. */
export function agentRunSpanInit(
  options: { agent: AgentConfig; provider?: LLMProvider; sessionId?: string; input: unknown; [SUBAGENT_SPAN]?: SubagentSpanInfo },
  content: ContentOptions & { captureContent: boolean }
): SpanInit {
  const { agent, provider, sessionId, input } = options;
  const subagent = options[SUBAGENT_SPAN];
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const inputMessages = content.captureContent ? agentInputMessages(input, text, contentRedactor(content)) : [];
  // An unnamed sub-agent is called by the key the lead knows it by.
  const name = subagent && agent.name === DEFAULT_AGENT_NAME ? subagent.name : agent.name;
  return {
    name: `${GenAiOperation.INVOKE_AGENT} ${name}`,
    kind: 'internal',
    attributes: defined({
      [GenAiAttr.OPERATION_NAME]: GenAiOperation.INVOKE_AGENT,
      [GenAiAttr.AGENT_NAME]: name,
      [SdkAttr.SUBAGENT_NAME]: subagent?.name,
      [SdkAttr.SUBAGENT_DEPTH]: subagent?.depth,
      [SdkAttr.TASK_ID]: subagent?.taskId,
      [GenAiAttr.AGENT_ID]: agent.id,
      [GenAiAttr.PROVIDER_NAME]: provider?.name,
      [GenAiAttr.REQUEST_MODEL]: agent.settings?.model || provider?.defaultModel || undefined,
      [GenAiAttr.CONVERSATION_ID]: sessionId,
      ...(!keepLegacyContent(content) ? {} : { [LegacyAttr.INPUT]: text }),
      [GenAiAttr.INPUT_MESSAGES]:
        content.captureContent && inputMessages.length > 0 ? JSON.stringify(inputMessages) : undefined,
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
      ...(!keepLegacyContent(content) ? {} : { [LegacyAttr.PROMPT]: JSON.stringify(request.messages) }),
      ...(content.captureContent ? requestContent(request.messages, contentRedactor(content)) : {}),
    }),
  };
}

/** The spec's `tool_call` finish reason is singular; ours is `tool_calls`. */
function genAiFinishReason(reason: GenerateResult['finishReason']): string {
  return reason === 'tool_calls' ? 'tool_call' : reason;
}

/** The fields of a provider's raw response that may name the model that answered. */
type RawResponseModel = { response?: { modelId?: unknown }; modelId?: unknown; model?: unknown };

/** The fields of a provider's raw response that may carry the response id (AI SDK `response.id`, OpenAI-style `id`). */
type RawResponseId = { response?: { id?: unknown }; id?: unknown };

function responseId(generated: GenerateResult): string | undefined {
  const raw = generated.rawResponse as RawResponseId | null | undefined;
  const id = raw?.response?.id ?? raw?.id;
  return typeof id === 'string' && id ? id : undefined;
}

function responseModel(generated: GenerateResult): string | undefined {
  const raw = generated.rawResponse as RawResponseModel | null | undefined;
  const model = raw?.response?.modelId ?? raw?.modelId ?? raw?.model;
  return typeof model === 'string' ? model : generated.servedBy?.model;
}

/**
 * Records usage, finish reason, response model (and output content) on a `chat` span.
 * Usage is the same normalized `Usage` the run totals use: pass the executor's
 * `measured` figures (which may be estimates), else what the provider reported.
 * `lousho.cost_usd` is the step's cost when the price table knows the model.
 */
export function recordLlmResult(
  span: Span,
  generated: GenerateResult,
  content: ContentOptions & { captureContent: boolean },
  measured?: { usage: Usage; estimated: boolean; costUsd?: number }
): void {
  const usage = measured?.usage ?? normalizeUsage(generated.usage);
  const model = span.attributes[GenAiAttr.REQUEST_MODEL];
  const costUsd =
    measured?.costUsd ?? (usage && typeof model === 'string' ? estimateCost(usage, model) : undefined);
  const redact = contentRedactor(content);
  const parts: unknown[] = generated.text ? [textPart(generated.text, redact)] : [];
  parts.push(...(generated.toolCalls ?? []).map((call) => toolCallPart(call, redact)));
  // Token counts and finish reason are never redacted.
  span.attributes = {
    ...span.attributes,
    ...defined({
      [GenAiAttr.RESPONSE_MODEL]: responseModel(generated),
      [GenAiAttr.RESPONSE_ID]: responseId(generated),
      [GenAiAttr.RESPONSE_FINISH_REASONS]: [genAiFinishReason(generated.finishReason)],
      [GenAiAttr.USAGE_INPUT_TOKENS]: usage?.inputTokens,
      [GenAiAttr.USAGE_OUTPUT_TOKENS]: usage?.outputTokens,
      [LegacyAttr.PROMPT_TOKENS]: usage?.inputTokens,
      [LegacyAttr.COMPLETION_TOKENS]: usage?.outputTokens,
      [LegacyAttr.TOTAL_TOKENS]: usage?.totalTokens,
      [SdkAttr.USAGE_ESTIMATED]: measured?.estimated ? true : undefined,
      [SdkAttr.COST_USD]: costUsd,
      [SdkAttr.USAGE_REASONING_TOKENS]: usage?.reasoningTokens,
      [SdkAttr.HOSTED_TOOL_CALLS]: generated.hostedToolCalls?.length ? generated.hostedToolCalls.map((call) => call.name) : undefined,
      [LegacyAttr.FINISH_REASON]: generated.finishReason,
      [GenAiAttr.OUTPUT_MESSAGES]: content.captureContent
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
  const desc = context.toolRegistry?.get(toolName);
  return {
    name: `${GenAiOperation.EXECUTE_TOOL} ${toolName}`,
    kind: 'internal',
    attributes: defined({
      [GenAiAttr.OPERATION_NAME]: GenAiOperation.EXECUTE_TOOL,
      [GenAiAttr.TOOL_NAME]: toolName,
      [GenAiAttr.TOOL_CALL_ID]: toolCall.id,
      [GenAiAttr.TOOL_DESCRIPTION]: desc?.tool?.description,
      [GenAiAttr.TOOL_TYPE]: TOOL_TYPE_FUNCTION,
      [GenAiAttr.AGENT_NAME]: context.agent.name,
      [GenAiAttr.CONVERSATION_ID]: context.sessionId,
      [LegacyAttr.TOOL_NAME]: toolName,
      // A `defineTool({ sandbox })` tool: which driver ran it (`'isolate'` by default).
      [SandboxAttr.DRIVER]: desc?.sandbox !== undefined ? sandboxDriverName(desc.sandbox.driver) : undefined,
    }),
  };
}

/** Records args/result (content), error and latency on an `execute_tool` span. */
export function recordToolOutcome(
  span: Span,
  outcome: { args: unknown; result: unknown; error?: string; sandboxError?: string; latencyMs: number },
  content: ContentOptions & { captureContent: boolean }
): void {
  const redact = contentRedactor(content);
  span.attributes = {
    ...span.attributes,
    ...defined({
      ...(!keepLegacyContent(content) ? {} : { [LegacyAttr.ARGS]: outcome.args, [LegacyAttr.RESULT]: outcome.result }),
      // The message, as on every other span's `error`; absent when the tool succeeded.
      [LegacyAttr.ERROR]: outcome.error === undefined ? undefined : redact(outcome.error),
      // The sandbox boundary's failure kind ('timeout' | 'oom' | 'driver'), absent for the tool's own errors.
      [SandboxAttr.ERROR]: outcome.sandboxError,
      [LegacyAttr.LATENCY_MS]: outcome.latencyMs,
      [ErrorAttr.TYPE]: outcome.error ? 'tool_error' : undefined,
      [GenAiAttr.TOOL_CALL_ARGUMENTS]: content.captureContent ? encodeContent(outcome.args, redact) : undefined,
      [GenAiAttr.TOOL_CALL_RESULT]:
        content.captureContent && !outcome.error ? encodeContent(outcome.result, redact) : undefined,
    }),
  };
  if (outcome.error) {
    span.status = { code: 'error', message: redact(outcome.error) };
  }
}
