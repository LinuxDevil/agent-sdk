/**
 * One `generateText()` (LOU-D26) or `streamText()` (LOU-D27) call on `ai` v4
 * or `ai` v6/v7.
 *
 * aiSdkProvider builds its request in the `ai` v4 shape (CoreMessages,
 * `maxTokens`, ...). On v4 it is sent as it is; on v6/v7, detected by the
 * module exporting `stepCountIs`, it is mapped to the new call shape
 * (ModelMessages, `maxOutputTokens`, `stopWhen`, tools with `inputSchema`,
 * `output`). Both majors' results are normalized to our `GenerateResult`, and
 * both majors' `fullStream` parts to our `StreamChunk`s.
 * The module is a parameter, so tests can pass an aliased `ai` v7.
 */

import type { LanguageModel } from 'ai';
import type {
  GenerateOptions,
  GenerateResult,
  HostedToolCall,
  ProviderUsage,
  ReasoningBlock,
  StreamChunk,
  StreamResult,
  ToolCall,
  ToolDefinition,
} from './llm';
import type { AiMajor } from './providerSpec';

/** The parts of the `ai` module this layer calls; v4, v6 and v7 all fit. */
export interface AiSdkModule {
  generateText(options: never): PromiseLike<unknown>;
  streamText(options: never): unknown;
  jsonSchema(schema: never): unknown;
  /** Exported from `ai` v5 on, where it replaced `maxSteps`. */
  stepCountIs?: (count: number) => unknown;
}

/** A v4 CoreMessage, structurally (so this module type-checks against any `ai` major). */
export interface AiSdkMessage {
  role: string;
  content: string | ReadonlyArray<object>;
}

/** The v4-shaped request aiSdkProvider builds (the fields mapped for v6/v7). */
export interface AiSdkCallSettings {
  model: LanguageModel;
  messages: AiSdkMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  /** `GenerateOptions.stop`, sent as the SDK's `stopSequences` (both majors). */
  stopSequences?: string[];
  /** The SDK's `toolChoice` (set only for a call with tools). */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
  maxRetries: number;
  abortSignal?: AbortSignal;
  /** LOU-V13: the reasoning options (`ai` 4.3 and 6/7 take the same field). */
  providerOptions?: Record<string, unknown>;
  /** N1a: the hosted tools' AI SDK tool objects by name (`ai` 6/7 only), merged into `tools` as they are. */
  hostedTools?: Record<string, unknown>;
}

/** Whether `ai` is v5 or later (the v6/v7 call shape). */
export function isModernAi(ai: AiSdkModule): boolean {
  // `in`, not a read: vitest's module mocks throw on reading a missing export.
  return 'stepCountIs' in ai;
}

/**
 * The installed `ai` major (LOU-D28d), from its exports: `stepCountIs` from
 * v5 on, and `registerTelemetry` from v7 on (v6 calls it `registerTelemetryIntegration`).
 */
export function aiMajorOf(ai: AiSdkModule): AiMajor {
  if (!isModernAi(ai)) return 4;
  return 'registerTelemetry' in ai ? 7 : 6;
}

/** A tool call as `ai` v4 (`args`) or v5+ (`input`) returns it. */
interface AiSdkToolCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  input?: unknown;
  /** v5+: the provider ran the call (a hosted tool, N1a); it is never ours to run. */
  providerExecuted?: boolean;
}

/** A v5+ content part (`generateText()` result `content`) or `fullStream` part, as far as hosted calls read it. */
interface AiSdkContentPart extends Partial<AiSdkToolCall> {
  type: string;
  /** `tool-result`: the output; `tool-error` (and a stream `error` part): the error. */
  output?: unknown;
  error?: unknown;
  /** `source`: v5+ `sourceType: 'url'` with `url` and `title`. */
  sourceType?: string;
  url?: string;
  title?: string;
}

/** The subset of either major's `generateText()` result read here. */
interface AiSdkGenerateResult {
  text: string;
  finishReason: string;
  usage?: Record<string, unknown>;
  toolCalls?: AiSdkToolCall[];
  /** v5+: the step's parts in order (N1a reads the provider-executed calls, their results and sources). */
  content?: AiSdkContentPart[];
  providerMetadata?: Record<string, unknown>;
  /** v4: `reasoningDetails`; v6/v7: `reasoning` parts. */
  reasoningDetails?: Array<{ type: string; text?: string; signature?: string; data?: string }>;
  reasoning?: unknown;
}

/** Convert tool calls from 'ai' SDK format to our format; a provider-executed call (N1a) is left out. */
function convertToolCalls(calls: AiSdkToolCall[]): ToolCall[] {
  return calls.filter((tc) => !tc.providerExecuted).map((tc) => ({
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
function toGenerateUsage(
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

/** LOU-V13: a v4 reasoning part as v5+ carries it, Anthropic's signature or redacted data in `providerOptions`. */
function modernReasoning({ text = '', signature, data }: Record<string, unknown>): Record<string, unknown> {
  const anthropic = data !== undefined ? { redactedData: data } : signature !== undefined ? { signature } : undefined;
  return { type: 'reasoning', text, ...(anthropic && { providerOptions: { anthropic } }) };
}

/** v4 part types whose v5+ shape differs by more than `mimeType` -> `mediaType`. */
const MODERN_PARTS: Record<string, (part: Record<string, unknown>) => Record<string, unknown>> = {
  'tool-call': ({ args, ...rest }) => ({ ...rest, input: args }),
  'tool-result': ({ result, isError, ...rest }) => ({ ...rest, output: toolOutput(result, isError as boolean | undefined) }),
  // `ai` 5+ deprecates `image` parts (a warning per image): a `file` part with an image media type.
  image: ({ image, mimeType }) => ({ type: 'file', data: image, mediaType: mimeType ?? 'image/*' }),
  reasoning: modernReasoning,
  'redacted-reasoning': modernReasoning,
};

/** A v4 content part in the v5+ shape (see MODERN_PARTS); elsewhere `mimeType` -> `mediaType`. */
function toModernPart(part: Record<string, unknown>): Record<string, unknown> {
  const modern = MODERN_PARTS[part.type as string];
  if (modern) return modern(part);
  if ('mimeType' in part) {
    const { mimeType, ...rest } = part;
    return mimeType === undefined ? rest : { ...rest, mediaType: mimeType };
  }
  return part;
}

/** A v4 CoreMessage as a v5+ ModelMessage. */
function toModelMessage(message: AiSdkMessage) {
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
    const schema = fn.parameters ?? {};
    const raw = 'jsonSchema' in schema && 'validate' in schema ? schema.jsonSchema : schema;
    tools[fn.name] = { description: fn.description, inputSchema: '~standard' in schema ? schema : ai.jsonSchema(raw as never) };
  }
  return tools;
}

/** N1a: the function tools plus the hosted tools' provider tool objects, passed exactly as the provider package made them. */
function modernToolSet(ai: AiSdkModule, toolDefs: ToolDefinition[] | undefined, hostedTools: Record<string, unknown> | undefined) {
  const tools = toModernTools(ai, toolDefs);
  if (!hostedTools || Object.keys(hostedTools).length === 0) return tools;
  return { ...tools, ...hostedTools };
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
    stopSequences: settings.stopSequences,
    toolChoice: settings.toolChoice,
    tools: modernToolSet(ai, options.tools, settings.hostedTools),
    stopWhen: ai.stepCountIs?.(1), // Single step - tool execution happens in AgentExecutor
    providerOptions: settings.providerOptions,
    maxRetries: settings.maxRetries,
    abortSignal: settings.abortSignal,
    output: toModernOutput(options.responseFormat),
  };
}

/** Either major's usage as ours; `undefined` when the backend reported none. */
function usageOf(
  modern: boolean,
  usage: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined
): ProviderUsage | undefined {
  return modern ? modernUsage(usage) : toGenerateUsage(usage ?? {}, metadata);
}

/** LOU-V13: Anthropic's signature or redacted data, from a v6/v7 part's `providerMetadata`. */
function blockData(metadata: unknown): Omit<ReasoningBlock, 'text'> {
  const anthropic = (metadata as { anthropic?: { signature?: unknown; redactedData?: unknown } } | undefined)?.anthropic;
  return {
    ...(typeof anthropic?.signature === 'string' && { signature: anthropic.signature }),
    ...(typeof anthropic?.redactedData === 'string' && { redactedData: anthropic.redactedData }),
  };
}

/** LOU-V13: either major's reasoning as blocks (v4 `reasoningDetails`; v6/v7 `reasoning` parts). */
function reasoningOf(result: AiSdkGenerateResult, modern: boolean): ReasoningBlock[] {
  if (!modern) {
    return (result.reasoningDetails ?? []).map((d) =>
      d.type === 'redacted' ? { text: '', redactedData: d.data ?? '' } : { text: d.text ?? '', ...(d.signature && { signature: d.signature }) }
    );
  }
  const parts = Array.isArray(result.reasoning) ? (result.reasoning as Array<{ type: string; text?: string; providerMetadata?: unknown }>) : [];
  return parts.filter((p) => p.type === 'reasoning').map((p) => ({ text: p.text ?? '', ...blockData(p.providerMetadata) }));
}

/** N1a: a provider-executed `tool-call` part as our hosted call (no result yet). */
function hostedCallOf(part: AiSdkContentPart): HostedToolCall {
  return { id: part.toolCallId ?? '', name: part.toolName ?? '', args: part.input ?? part.args ?? {} };
}

/** N1a: a provider-executed `tool-result` / `tool-error` part's result, set on `call`. */
function settleHostedCall(call: HostedToolCall, part: AiSdkContentPart): void {
  if (part.type === 'tool-error') {
    call.result = part.error instanceof Error ? part.error.message : part.error;
    call.isError = true;
  } else {
    call.result = part.output;
  }
}

/** N1a: adds a url `source` part to `call`'s sources (other source types are not kept). */
function addSource(call: HostedToolCall | undefined, part: AiSdkContentPart): void {
  if (!call || typeof part.url !== 'string' || (part.sourceType !== undefined && part.sourceType !== 'url')) return;
  (call.sources ??= []).push({ url: part.url, ...(typeof part.title === 'string' && part.title !== '' && { title: part.title }) });
}

/** N1a: a `tool-result` / `tool-error` part of a provider-executed call. */
function isHostedResult(part: AiSdkContentPart): boolean {
  return (part.type === 'tool-result' || part.type === 'tool-error') && part.providerExecuted === true;
}

/**
 * N1a: the provider-executed calls of a v5+ result's ordered `content`, with
 * their results; a `source` part attaches to the call it follows (the last
 * hosted call before it). Sources before any hosted call are not kept.
 */
function hostedCallsOf(content: AiSdkContentPart[] | undefined): HostedToolCall[] {
  const calls = new Map<string, HostedToolCall>();
  let last: HostedToolCall | undefined;
  for (const part of content ?? []) {
    if (part.type === 'tool-call' && part.providerExecuted) {
      last = hostedCallOf(part);
      calls.set(last.id, last);
    } else if (isHostedResult(part)) {
      last = calls.get(part.toolCallId ?? '') ?? hostedCallOf(part);
      calls.set(last.id, last);
      settleHostedCall(last, part);
    } else if (part.type === 'source') {
      addSource(last, part);
    }
  }
  return [...calls.values()];
}

/** `settings` without the hosted tools, for `ai` v4 (which cannot send them). */
function v4Settings(settings: AiSdkCallSettings): Omit<AiSdkCallSettings, 'hostedTools'> {
  const { hostedTools: _hosted, ...rest } = settings;
  return rest;
}

/** Call `generateText()` on `ai` (v4 or v6/v7) and normalize its result. */
export async function compatGenerateText(
  ai: AiSdkModule,
  settings: AiSdkCallSettings,
  options: GenerateOptions
): Promise<GenerateResult> {
  const modern = isModernAi(ai);
  const request = modern ? toModernRequest(ai, settings, options) : v4Settings(settings);
  const result = (await ai.generateText(request as never)) as AiSdkGenerateResult;
  const reasoning = reasoningOf(result, modern);
  const hostedToolCalls = modern ? hostedCallsOf(result.content) : [];
  return {
    text: result.text,
    finishReason: mapFinishReason(result.finishReason),
    usage: usageOf(modern, result.usage, result.providerMetadata),
    toolCalls: result.toolCalls && convertToolCalls(result.toolCalls),
    ...(hostedToolCalls.length > 0 && { hostedToolCalls }),
    ...(reasoning.length > 0 && { reasoning }),
    rawResponse: result,
  };
}

/** A `fullStream` part of either major: the fields read here. */
interface AiSdkStreamPart extends AiSdkContentPart {
  type: string;
  /** `text-delta`: v6/v7 `text`, v4 `textDelta`. */
  text?: string;
  textDelta?: string;
  /** `tool-input-start` / `-delta` (v6/v7). */
  id?: string;
  delta?: string;
  finishReason?: string;
  /** v4 `reasoning-signature` / `redacted-reasoning` (LOU-V13). */
  signature?: string;
  data?: string;
  /** `finish`: v4 `usage` (and `providerMetadata`), v6/v7 `totalUsage`. */
  usage?: Record<string, unknown>;
  totalUsage?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

/** The subset of either major's `streamText()` result read here (v6/v7 `usage` is the total). */
interface AiSdkStreamResult {
  fullStream?: AsyncIterable<AiSdkStreamPart>;
  textStream: AsyncIterable<string>;
  text: PromiseLike<string> | string;
  usage: PromiseLike<Record<string, unknown> | undefined> | Record<string, unknown>;
  providerMetadata?: PromiseLike<Record<string, unknown> | undefined>;
  finishReason: PromiseLike<string> | string;
  toolCalls: PromiseLike<AiSdkToolCall[]> | AiSdkToolCall[];
}

/** What reading one stream keeps: the major, the signal, and tool inputs streamed so far by call id. */
interface ChunkState {
  modern: boolean;
  signal?: AbortSignal;
  inputs: Map<string, { toolName: string; input: string }>;
  /** LOU-V13: the open v6/v7 reasoning block's `providerMetadata` (Anthropic sends the signature on a delta). */
  reasoningMetadata?: unknown;
  /** N1a: provider-executed calls by id, the last one seen, and a settled one whose result chunk waits for the sources after it. */
  hosted: Map<string, HostedToolCall>;
  lastHosted?: HostedToolCall;
  settledHosted?: HostedToolCall;
}

/** LOU-V13: a reasoning text delta (v4 `reasoning`, v6/v7 `reasoning-delta`), noting a v6/v7 block's metadata. */
function reasoningDelta(part: AiSdkStreamPart, state: ChunkState): StreamChunk[] {
  state.reasoningMetadata = part.providerMetadata ?? state.reasoningMetadata;
  const textDelta = part.text ?? part.textDelta;
  return textDelta ? [{ type: 'reasoning-delta', textDelta }] : [];
}

/** LOU-V13: the end of a reasoning block, with its signature or redacted data. */
function reasoningEnd(reasoning: Omit<ReasoningBlock, 'text'>): StreamChunk[] {
  return [{ type: 'reasoning-end', reasoning }];
}

/**
 * The finish chunk, after a tool call for each input streamed with
 * `tool-input-start`/`-delta`/`-end` that no `tool-call` followed (when one
 * does, v6/v7 emits that whole call after the input, and it is used instead).
 */
function finishChunks(part: AiSdkStreamPart, { modern, inputs }: ChunkState): StreamChunk[] {
  const chunks: StreamChunk[] = [...inputs].map(([id, { toolName, input }]) => ({
    type: 'tool-call',
    toolCall: { id, type: 'function', function: { name: toolName, arguments: input || '{}' } },
  }));
  const usage = usageOf(modern, modern ? part.totalUsage : part.usage, part.providerMetadata);
  chunks.push({ type: 'finish', finishReason: part.finishReason, ...(usage ? { usage } : {}) });
  return chunks;
}

/**
 * N1a: a provider-executed call's result. Its `hosted-tool-result` chunk is
 * held (see toChunks) until a part other than a `source` arrives, so the
 * sources that follow the result travel with it. Other results (v4's
 * placeholder `execute`) carry nothing.
 */
function hostedResult(part: AiSdkStreamPart, state: ChunkState): StreamChunk[] {
  if (!isHostedResult(part)) return [];
  const call = state.hosted.get(part.toolCallId ?? '') ?? hostedCallOf(part);
  state.hosted.set(call.id, call);
  settleHostedCall(call, part);
  state.lastHosted = call;
  state.settledHosted = call;
  return [];
}

/** N1a: the held `hosted-tool-result` chunk, if any. */
function flushHosted(state: ChunkState): StreamChunk[] {
  const call = state.settledHosted;
  state.settledHosted = undefined;
  return call ? [{ type: 'hosted-tool-result', hostedToolCall: call }] : [];
}

/**
 * The chunks each `fullStream` part type becomes, on either major. An `error`
 * part rejects the stream with its error, an `abort` part with the signal's
 * reason. Reasoning (LOU-V13) becomes `reasoning-delta` / `reasoning-end`
 * chunks. N1a: a provider-executed call and its result become
 * `hosted-tool-call` / `hosted-tool-result` chunks (never a `tool-call`), and
 * url `source` parts attach to the hosted call they follow. Unlisted parts
 * are dropped: steps, files, `raw` and v4's results of the placeholder
 * `execute` carry nothing a chunk reports.
 */
const PART_CHUNKS = new Map<string, (part: AiSdkStreamPart, state: ChunkState) => StreamChunk[]>([
  ['text-delta', (part) => {
    const textDelta = part.text ?? part.textDelta;
    return textDelta ? [{ type: 'text-delta', textDelta }] : [];
  }],
  ['reasoning', reasoningDelta],
  ['reasoning-start', reasoningDelta],
  ['reasoning-delta', reasoningDelta],
  ['reasoning-end', (part, state) => {
    const metadata = part.providerMetadata ?? state.reasoningMetadata;
    state.reasoningMetadata = undefined;
    return reasoningEnd(blockData(metadata));
  }],
  ['reasoning-signature', (part) => reasoningEnd({ signature: part.signature })],
  ['redacted-reasoning', (part) => reasoningEnd({ redactedData: part.data })],
  ['tool-input-start', (part, { inputs }) => {
    // N1a: a provider-executed call's input is never completed into a call of ours by finishChunks().
    if (!part.providerExecuted) inputs.set(part.id ?? '', { toolName: part.toolName ?? '', input: '' });
    return [];
  }],
  ['tool-input-delta', (part, { inputs }) => {
    const pending = inputs.get(part.id ?? '');
    if (pending) pending.input += part.delta ?? '';
    return [];
  }],
  ['tool-call', (part, state) => {
    state.inputs.delete(part.toolCallId ?? '');
    if (!part.providerExecuted) return [{ type: 'tool-call', toolCall: convertToolCalls([part as AiSdkToolCall])[0] }];
    const hostedToolCall = hostedCallOf(part);
    state.hosted.set(hostedToolCall.id, hostedToolCall);
    state.lastHosted = hostedToolCall;
    return [{ type: 'hosted-tool-call', hostedToolCall }];
  }],
  ['tool-result', hostedResult],
  ['tool-error', hostedResult],
  ['source', (part, state) => {
    addSource(state.settledHosted ?? state.lastHosted, part);
    return [];
  }],
  ['finish', finishChunks],
  ['error', (part) => {
    throw part.error ?? new Error('The model stream reported an error without details');
  }],
  ['abort', (_part, { signal }) => {
    throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }],
]);

/** Either major's `fullStream` as our chunks (see PART_CHUNKS). */
async function* toChunks(result: AiSdkStreamResult, modern: boolean, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  const state: ChunkState = { modern, signal, inputs: new Map(), hosted: new Map() };
  for await (const part of result.fullStream ?? []) {
    if (part.type !== 'source') yield* flushHosted(state);
    yield* PART_CHUNKS.get(part.type)?.(part, state) ?? [];
  }
  yield* flushHosted(state);
}

/** The final usage of either major's stream. */
async function finalUsage(result: AiSdkStreamResult, modern: boolean): Promise<ProviderUsage | undefined> {
  return usageOf(modern, await result.usage, await result.providerMetadata);
}

/** A v4 result without `fullStream` (as this repo's v4 test doubles script it): its text deltas, then the finish. */
async function* textStreamChunks(result: AiSdkStreamResult): AsyncGenerator<StreamChunk> {
  for await (const textDelta of result.textStream) yield { type: 'text-delta', textDelta };
  yield { type: 'finish', finishReason: await result.finishReason, usage: await finalUsage(result, false) };
}

async function* textDeltas(chunks: AsyncIterable<StreamChunk>): AsyncGenerator<string> {
  for await (const chunk of chunks) if (chunk.type === 'text-delta' && chunk.textDelta) yield chunk.textDelta;
}

/**
 * Call `streamText()` on `ai` (v4 or v6/v7), with the request mapped as
 * `compatGenerateText()` maps it, and normalize its stream and final values.
 * `textStream` and `fullStream` each read their own copy of the SDK stream.
 */
export async function streamCompat(
  ai: AiSdkModule,
  settings: AiSdkCallSettings,
  options: GenerateOptions
): Promise<StreamResult> {
  const modern = isModernAi(ai);
  const request = modern ? toModernRequest(ai, settings, options) : v4Settings(settings);
  // Errors reject the stream (toChunks); the SDK's default onError would also log them.
  const result = (await ai.streamText({ ...request, onError: () => undefined } as never)) as AiSdkStreamResult;
  const chunks = () => ('fullStream' in result ? toChunks(result, modern, settings.abortSignal) : textStreamChunks(result));
  return {
    textStream: textDeltas(chunks()),
    fullStream: chunks(),
    text: handled(Promise.resolve(result.text)),
    usage: handled(finalUsage(result, modern)),
    finishReason: handled(Promise.resolve(result.finishReason)),
    toolCalls: handled(Promise.resolve(result.toolCalls).then(convertToolCalls)),
  };
}

/** `promise`, marked handled: a final value nobody reads must not become an unhandled rejection when the stream fails. */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}
