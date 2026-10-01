/**
 * One `generateText()` call on `ai` v4 or `ai` v6/v7 (LOU-D26).
 *
 * aiSdkProvider builds its request in the `ai` v4 shape (CoreMessages,
 * `maxTokens`, ...). On v4 it is sent as it is; on v6/v7, detected by the
 * module exporting `stepCountIs`, it is mapped to the new call shape
 * (ModelMessages, `maxOutputTokens`, `stopWhen`, tools with `inputSchema`,
 * `output`). Both majors' results are normalized to our `GenerateResult`.
 * The module is a parameter, so tests can pass an aliased `ai` v7.
 */

import type { LanguageModel } from 'ai';
import type { GenerateOptions, GenerateResult, ProviderUsage, ToolCall, ToolDefinition } from './llm';

/** The parts of the `ai` module this layer calls; v4, v6 and v7 all fit. */
export interface AiSdkModule {
  generateText(options: never): PromiseLike<unknown>;
  jsonSchema(schema: never): unknown;
  /** Exported from `ai` v5 on, where it replaced `maxSteps`. */
  stepCountIs?: (count: number) => unknown;
}

/** A v4 CoreMessage, structurally (so this module type-checks against any `ai` major). */
interface V4Message {
  role: string;
  content: string | ReadonlyArray<object>;
}

/** The v4-shaped request aiSdkProvider builds (the fields mapped for v6/v7). */
export interface AiSdkCallSettings {
  model: LanguageModel;
  messages: V4Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  maxRetries: number;
  abortSignal?: AbortSignal;
}

/** Whether `ai` is v5 or later (the v6/v7 call shape). */
export function isModernAi(ai: AiSdkModule): boolean {
  // `in`, not a read: vitest's module mocks throw on reading a missing export.
  return 'stepCountIs' in ai;
}

/** A tool call as `ai` v4 (`args`) or v5+ (`input`) returns it. */
interface AiSdkToolCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  input?: unknown;
}

/** The subset of either major's `generateText()` result read here. */
interface AiSdkGenerateResult {
  text: string;
  finishReason: string;
  usage?: Record<string, unknown>;
  toolCalls?: AiSdkToolCall[];
  providerMetadata?: Record<string, unknown>;
}

/** Convert tool calls from 'ai' SDK format to our format. */
export function convertToolCalls(calls: AiSdkToolCall[]): ToolCall[] {
  return calls.map((tc) => ({
    id: tc.toolCallId,
    type: 'function' as const,
    function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? tc.args) },
  }));
}

const FINISH_REASONS = new Map<string, GenerateResult['finishReason']>([
  ['stop', 'stop'],
  ['length', 'length'],
  ['tool-calls', 'tool_calls'],
  ['content-filter', 'content_filter'],
]);

/** Map an 'ai' SDK finish reason to ours; anything unrecognised is 'error'. */
function mapFinishReason(reason: string): GenerateResult['finishReason'] {
  return FINISH_REASONS.get(reason) ?? 'error';
}

/** A finite, non-negative count, else `undefined`. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The first documented cache/reasoning token field a provider's metadata carries. */
function pickCount(metadata: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const provider of Object.values(metadata ?? {})) {
    const fields = provider as Record<string, unknown> | undefined;
    for (const key of keys) {
      const found = count(fields?.[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** `usage` plus the optional cache/reasoning counts that are known. */
function withDetails(usage: ProviderUsage, cachedInputTokens?: number, reasoningTokens?: number): ProviderUsage {
  return {
    ...usage,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * An `ai` v4 call's usage, or `undefined` when the backend reported none
 * (v4 yields `NaN` counts then; never zeros). Cache and reasoning tokens are
 * read from `providerMetadata` when the provider package documents them
 * (OpenAI `cachedPromptTokens`/`reasoningTokens`, Anthropic `cacheReadInputTokens`).
 */
export function toGenerateUsage(
  usage: Partial<ProviderUsage>,
  metadata: Record<string, unknown> | undefined
): ProviderUsage | undefined {
  const promptTokens = count(usage.promptTokens);
  const completionTokens = count(usage.completionTokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  return withDetails(
    { promptTokens, completionTokens, totalTokens: usage.totalTokens ?? promptTokens + completionTokens },
    pickCount(metadata, ['cachedPromptTokens', 'cacheReadInputTokens']),
    pickCount(metadata, ['reasoningTokens'])
  );
}

/** An `ai` v6/v7 `LanguageModelUsage` (v5's flat `cachedInputTokens`/`reasoningTokens` too). */
function modernUsage(usage: Record<string, unknown> | undefined): ProviderUsage | undefined {
  const inputTokens = count(usage?.inputTokens);
  const outputTokens = count(usage?.outputTokens);
  if (!usage || inputTokens === undefined || outputTokens === undefined) return undefined;
  const input = usage.inputTokenDetails as Record<string, unknown> | undefined;
  const output = usage.outputTokenDetails as Record<string, unknown> | undefined;
  return withDetails(
    { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: count(usage.totalTokens) ?? inputTokens + outputTokens },
    count(input?.cacheReadTokens) ?? count(usage.cachedInputTokens),
    count(output?.reasoningTokens) ?? count(usage.reasoningTokens)
  );
}

/** A v4 tool result as a v5+ `ToolResultOutput`. */
function toolOutput(result: unknown, isError: boolean | undefined) {
  if (typeof result === 'string') return { type: isError ? 'error-text' : 'text', value: result };
  return { type: isError ? 'error-json' : 'json', value: result ?? null };
}

/** A v4 content part in the v5+ shape: `args` -> `input`, `result` -> `output`, `mimeType` -> `mediaType`. */
function toModernPart(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type === 'tool-call') {
    const { args, ...rest } = part;
    return { ...rest, input: args };
  }
  if (part.type === 'tool-result') {
    const { result, isError, ...rest } = part;
    return { ...rest, output: toolOutput(result, isError as boolean | undefined) };
  }
  if ('mimeType' in part) {
    const { mimeType, ...rest } = part;
    return mimeType === undefined ? rest : { ...rest, mediaType: mimeType };
  }
  return part;
}

/** A v4 CoreMessage as a v5+ ModelMessage. */
function toModelMessage(message: V4Message) {
  if (typeof message.content === 'string') return message;
  return { ...message, content: message.content.map((part) => toModernPart(part as Record<string, unknown>)) };
}

/**
 * Our tool definitions as v5+ tools: `inputSchema` (a zod / Standard Schema
 * as it is, a JSON Schema wrapped with `jsonSchema()`) and no `execute`, so
 * the SDK returns the calls and AgentExecutor runs them.
 */
function toModernTools(ai: AiSdkModule, toolDefs: ToolDefinition[] | undefined) {
  if (!toolDefs?.length) return undefined;
  const tools: Record<string, { description: string; inputSchema: unknown }> = {};
  for (const { function: fn } of toolDefs) {
    const schema: Record<string, unknown> = fn.parameters ?? {};
    const raw = 'jsonSchema' in schema && 'validate' in schema ? schema.jsonSchema : schema;
    tools[fn.name] = { description: fn.description, inputSchema: '~standard' in schema ? schema : ai.jsonSchema(raw as never) };
  }
  return tools;
}

/**
 * LOU-V4 on v6/v7: JSON mode with the schema, leaving the prompt and the
 * reply text alone (AgentExecutor instructs the model and validates).
 */
function toModernOutput(format: GenerateOptions['responseFormat']) {
  if (format?.type !== 'json') return undefined;
  return {
    name: 'json',
    responseFormat: Promise.resolve({ type: 'json', ...(format.schema ? { schema: format.schema } : {}) }),
    parseCompleteOutput: async ({ text }: { text: string }) => text,
    parsePartialOutput: async ({ text }: { text: string }) => ({ partial: text }),
    createElementStreamTransform: () => undefined,
  };
}

/** `settings` (v4 shape) as an `ai` v6/v7 `generateText()` request. */
function toModernRequest(ai: AiSdkModule, settings: AiSdkCallSettings, options: GenerateOptions) {
  return {
    model: settings.model,
    messages: settings.messages.map(toModelMessage),
    // AgentExecutor sends the system prompt as a message; v7 rejects that by default.
    allowSystemInMessages: true,
    temperature: settings.temperature,
    maxOutputTokens: settings.maxTokens,
    topP: settings.topP,
    frequencyPenalty: settings.frequencyPenalty,
    presencePenalty: settings.presencePenalty,
    seed: settings.seed,
    tools: toModernTools(ai, options.tools),
    stopWhen: ai.stepCountIs?.(1), // Single step - tool execution happens in AgentExecutor
    maxRetries: settings.maxRetries,
    abortSignal: settings.abortSignal,
    output: toModernOutput(options.responseFormat),
  };
}

/** Call `generateText()` on `ai` (v4 or v6/v7) and normalize its result. */
export async function compatGenerateText(
  ai: AiSdkModule,
  settings: AiSdkCallSettings,
  options: GenerateOptions
): Promise<GenerateResult> {
  const modern = isModernAi(ai);
  const request = modern ? toModernRequest(ai, settings, options) : settings;
  const result = (await ai.generateText(request as never)) as AiSdkGenerateResult;
  return {
    text: result.text,
    finishReason: mapFinishReason(result.finishReason),
    usage: modern ? modernUsage(result.usage) : toGenerateUsage(result.usage ?? {}, result.providerMetadata),
    toolCalls: result.toolCalls && convertToolCalls(result.toolCalls),
    rawResponse: result,
  };
}
