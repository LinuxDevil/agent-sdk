/**
 * OpenTelemetry GenAI semantic-convention names (LOU-D9).
 *
 * Every span name, attribute key and well-known value this SDK emits lives
 * here so nothing is stringly-typed across files.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/ - the GenAI
 * conventions have moved to
 * https://github.com/open-telemetry/semantic-conventions-genai
 * (docs/gen-ai/gen-ai-spans.md and docs/gen-ai/gen-ai-agent-spans.md,
 * schema model/gen-ai/*.json). Retrieved 2026-10-01 (main as of
 * 2026-09-30, semconv v1.44.0 for the shared `error.*` attributes).
 *
 * STABILITY: the GenAI conventions are `Development` (not stable) as of
 * that date. Attribute names have changed between versions before (for
 * example `gen_ai.system` became `gen_ai.provider.name`), so they may change
 * again. Pin the SDK version if you build dashboards on them.
 */

/** `gen_ai.operation.name` well-known values this SDK emits. */
export const GenAiOperation = {
  /** Model call (inference span). */
  CHAT: 'chat',
  /** One agent run. */
  INVOKE_AGENT: 'invoke_agent',
  /** One tool execution. */
  EXECUTE_TOOL: 'execute_tool',
  /** One flow run (`FlowExecutor.execute`). */
  INVOKE_WORKFLOW: 'invoke_workflow',
} as const;

/** OpenTelemetry GenAI attribute keys (all `Development` stability). */
export const GenAiAttr = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  AGENT_ID: 'gen_ai.agent.id',
  AGENT_NAME: 'gen_ai.agent.name',
  WORKFLOW_NAME: 'gen_ai.workflow.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_DESCRIPTION: 'gen_ai.tool.description',
  TOOL_TYPE: 'gen_ai.tool.type',
  /** Opt-in content (see `captureContent`). */
  SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
  TOOL_CALL_RESULT: 'gen_ai.tool.call.result',
  /** Metric attribute: `input` or `output` (see {@link TokenType}). */
  TOKEN_TYPE: 'gen_ai.token.type',
} as const;

/** `gen_ai.token.type` values of the `gen_ai.client.token.usage` metric. */
export const TokenType = { INPUT: 'input', OUTPUT: 'output' } as const;

/**
 * OpenTelemetry GenAI client metrics (LOU-D48). Spec: gen-ai-metrics.md of
 * semantic-conventions v1.40 (the newer semantic-conventions-genai repo
 * replaces the token histogram with per-type counters, which are not
 * emitted here). Both are `Development` stability; the bucket boundaries are
 * the spec's recommendations.
 */
export const GenAiMetric = {
  /** Histogram, unit `{token}`, one record per token type per model call. */
  TOKEN_USAGE: 'gen_ai.client.token.usage',
  /** Histogram, unit `s`, one record per model call and per tool call. */
  OPERATION_DURATION: 'gen_ai.client.operation.duration',
} as const;

export const TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];
export const OPERATION_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

/** `error.type` (stable in semconv) and its `_OTHER` fallback. */
export const ErrorAttr = {
  TYPE: 'error.type',
  /** Fallback value when the thrown value is not an `Error`. */
  OTHER: '_OTHER',
} as const;

/** `gen_ai.tool.type` value for tools executed by this SDK's host process. */
export const TOOL_TYPE_FUNCTION = 'function';

/** Attributes specific to this SDK (not part of the GenAI semantic conventions). */
export const SdkAttr = {
  /** `true` on a span whose token counts are (partly) estimates because the provider reported none (LOU-V5). */
  USAGE_ESTIMATED: 'lousho.usage.estimated',
  /**
   * Estimated USD (LOU-D48): per step on a `chat` span; cumulative on the
   * parent spans (`invoke_agent`, and a delegating `execute_tool`). Absent
   * when the price table does not know a contributing model.
   */
  COST_USD: 'lousho.cost_usd',
  /** Reasoning (thinking) tokens of a `chat` span's call, when the provider reports them (LOU-V13). */
  USAGE_REASONING_TOKENS: 'lousho.usage.reasoning_tokens',
  /**
   * N1a: on a `chat` span, the names of the hosted tools the provider ran
   * inside that call (e.g. `['web_search']`). They get no `execute_tool`
   * span: the SDK did not run them.
   */
  HOSTED_TOOL_CALLS: 'lousho.hosted_tool_calls',
} as const;

/**
 * The attribute names this SDK emitted before LOU-D9. They are still emitted
 * alongside the GenAI ones (dual-emit) and are DEPRECATED.
 */
export const LegacyAttr = {
  INPUT: 'input',
  MODEL: 'model',
  PROMPT: 'prompt',
  PROMPT_TOKENS: 'promptTokens',
  COMPLETION_TOKENS: 'completionTokens',
  TOTAL_TOKENS: 'totalTokens',
  FINISH_REASON: 'finishReason',
  TOOL_NAME: 'toolName',
  ARGS: 'args',
  RESULT: 'result',
  ERROR: 'error',
  LATENCY_MS: 'latencyMs',
} as const;

/** Attributes for flow spans (no GenAI convention exists for flow nodes). */
export const FlowAttr = {
  CODE: 'lousho.flow.code',
  NODE_ID: 'lousho.flow.node.id',
  NODE_TYPE: 'lousho.flow.node.type',
  OUTCOME: 'lousho.flow.outcome',
} as const;

/** Span-name prefix for a flow node span (`flow.node sequence`, ...). */
export const FLOW_NODE_SPAN_NAME = 'flow.node';

/** Environment variable that turns content capture on when `captureContent` is not set. */
export const CAPTURE_CONTENT_ENV = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
