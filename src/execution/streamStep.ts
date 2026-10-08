/**
 * LOU-V2: obtains one model step through `provider.stream()` instead of
 * `provider.generate()`, reporting text chunks as they arrive and assembling
 * the same GenerateResult the rest of the AgentExecutor loop works with.
 */

import type { GenerateOptions, GenerateResult, HostedToolCall, LLMProvider, ReasoningBlock, StreamChunk, StreamResult, ToolCall } from '../providers';
import type { AgentEventPayload } from './agentEvents';
import { withProviderEvents } from '../providers/providerEvents';

const FINISH_REASONS: ReadonlySet<string> = new Set<GenerateResult['finishReason']>([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
]);

/**
 * A stream's finish reason as a GenerateResult one. Accepts both our
 * spelling and the 'ai' SDK's (`'tool-calls'`); anything else is `'error'`,
 * as in `generate()`.
 */
function toFinishReason(reason: string | undefined): GenerateResult['finishReason'] {
  const normalized = (reason ?? 'stop').replace(/-/g, '_');
  return FINISH_REASONS.has(normalized) ? (normalized as GenerateResult['finishReason']) : 'error';
}

/** Whether to stream this request: the provider has `stream()` and supports streaming its model. */
export function canStream(provider: LLMProvider, request: GenerateOptions): boolean {
  const candidate = provider as Partial<LLMProvider>;
  if (typeof candidate.stream !== 'function') return false;
  return typeof candidate.supportsStreaming !== 'function' || candidate.supportsStreaming.call(provider, request.model ?? '');
}

/** LOU-V13: the `reasoning.*` events of a step. */
type ReasoningEventPayload = Extract<AgentEventPayload, { type: 'reasoning.start' | 'reasoning.delta' | 'reasoning.done' }>;

/** Where a step reports what it streams. */
export interface StepSink {
  onTextDelta(text: string): void;
  onReasoning(event: ReasoningEventPayload): void;
  /** Called before the first text delta or tool call is applied (LOU-V10). */
  onOutput?: () => void;
  /** N1a: a provider-executed call started, and finished (with its result), as the chunks arrive. */
  onHostedToolCall?(call: HostedToolCall): void;
  onHostedToolResult?(call: HostedToolCall): void;
}

interface StreamedParts {
  text: string;
  toolCalls: ToolCall[];
  /** N1a: provider-executed calls by id, in call order, and the ids already reported finished. */
  hosted: Map<string, HostedToolCall>;
  hostedDone: Set<string>;
  finish?: StreamChunk;
  /** LOU-V13: finished reasoning blocks, the open block's text, and the text of the reasoning reported since `reasoning.start`. */
  reasoning: ReasoningBlock[];
  block: string;
  thought: string;
}

/** LOU-V13: closes the open block and, if reasoning was reported, ends it with `reasoning.done`. */
function closeReasoning(parts: StreamedParts, sink: StepSink, tokens?: number): void {
  if (parts.block) parts.reasoning.push({ text: parts.block });
  parts.block = '';
  if (parts.thought) sink.onReasoning({ type: 'reasoning.done', text: parts.thought, ...(tokens !== undefined && { tokens }) });
  parts.thought = '';
}

type ChunkHandler = (parts: StreamedParts, chunk: StreamChunk, sink: StepSink) => void;

const CHUNK_HANDLERS: Partial<Record<StreamChunk['type'], ChunkHandler>> = {
  'reasoning-delta': (parts, { textDelta = '' }, sink) => {
    if (!parts.thought) sink.onReasoning({ type: 'reasoning.start' });
    parts.block += textDelta;
    parts.thought += textDelta;
    sink.onReasoning({ type: 'reasoning.delta', text: textDelta });
  },
  'reasoning-end': (parts, { reasoning }) => {
    if (parts.block || reasoning?.signature || reasoning?.redactedData) parts.reasoning.push({ text: parts.block, ...reasoning });
    parts.block = '';
  },
  'text-delta': (parts, { textDelta }, sink) => {
    if (!textDelta) return;
    closeReasoning(parts, sink);
    parts.text += textDelta;
    sink.onOutput?.();
    sink.onTextDelta(textDelta);
  },
  'tool-call': (parts, { toolCall }, sink) => {
    if (!toolCall) return;
    closeReasoning(parts, sink);
    sink.onOutput?.();
    parts.toolCalls.push(toolCall);
  },
  'hosted-tool-call': (parts, { hostedToolCall }, sink) => {
    if (!hostedToolCall) return;
    closeReasoning(parts, sink);
    sink.onOutput?.();
    parts.hosted.set(hostedToolCall.id, hostedToolCall);
    sink.onHostedToolCall?.(hostedToolCall);
  },
  'hosted-tool-result': (parts, { hostedToolCall }, sink) => {
    if (!hostedToolCall) return;
    closeReasoning(parts, sink);
    sink.onOutput?.();
    parts.hosted.set(hostedToolCall.id, hostedToolCall);
    parts.hostedDone.add(hostedToolCall.id);
    sink.onHostedToolResult?.(hostedToolCall);
  },
  finish: (parts, chunk, sink) => {
    closeReasoning(parts, sink, chunk.usage?.reasoningTokens);
    parts.finish = chunk;
  },
  error: (_parts, chunk) => {
    throw chunk.error ?? new Error('The model stream reported an error without details');
  },
};

/** LOU-V13: a non-streamed step's reasoning, as one `reasoning.start` / `.delta` / `.done`. */
export function reportReasoning(generated: GenerateResult, sink: Pick<StepSink, 'onReasoning'>): void {
  const text = (generated.reasoning ?? []).map((block) => block.text).join('');
  if (!text) return;
  const tokens = generated.usage?.reasoningTokens;
  sink.onReasoning({ type: 'reasoning.start' });
  sink.onReasoning({ type: 'reasoning.delta', text });
  sink.onReasoning({ type: 'reasoning.done', text, ...(tokens !== undefined && { tokens }) });
}

/**
 * The stream's final-value promises we may not read must never surface as
 * unhandled rejections when the stream itself fails.
 */
function silenceFinalValues(streamed: StreamResult): void {
  for (const value of [streamed.text, streamed.usage, streamed.finishReason, streamed.toolCalls]) {
    Promise.resolve(value).catch(() => undefined);
  }
}

/**
 * Runs one model step through `provider.stream()`. Text comes from the
 * `text-delta` chunks; tool calls from `tool-call` chunks, else from the
 * stream's `toolCalls` promise (the 'ai' SDK adapters only report them
 * there); finish reason and usage from the `finish` chunk, else from the
 * stream's promises. The signal is checked between chunks. Reasoning
 * (LOU-V13) is reported as `reasoning.*` events, ended before the first text
 * or tool call (or a retry), and returned in blocks.
 */
export async function generateViaStream(provider: LLMProvider, request: GenerateOptions, sink: StepSink): Promise<GenerateResult> {
  const parts: StreamedParts = { text: '', toolCalls: [], hosted: new Map(), hostedDone: new Set(), reasoning: [], block: '', thought: '' };
  // C2: withRetry() retries a stream that failed after reasoning only. The
  // failed attempt's reasoning is ended (`reasoning.done`, before the
  // `provider.retry` event) and dropped; the step keeps the retry's.
  const retried = () => {
    closeReasoning(parts, sink);
    parts.reasoning = [];
  };
  const streamed = await provider.stream(withProviderEvents(request, { retry: retried, fallback: () => undefined }));
  silenceFinalValues(streamed);
  for await (const chunk of streamed.fullStream) {
    request.signal?.throwIfAborted();
    CHUNK_HANDLERS[chunk.type]?.(parts, chunk, sink);
  }
  request.signal?.throwIfAborted();
  closeReasoning(parts, sink);
  // N1a: a call whose result never came (the provider reported none) still ends with `tool.done`.
  for (const call of parts.hosted.values()) if (!parts.hostedDone.has(call.id)) sink.onHostedToolResult?.(call);
  const hostedToolCalls = [...parts.hosted.values()];

  const toolCalls = parts.toolCalls.length > 0 ? parts.toolCalls : ((await streamed.toolCalls) ?? []);
  return {
    text: parts.text,
    finishReason: toFinishReason(parts.finish?.finishReason ?? (await streamed.finishReason)),
    usage: parts.finish?.usage ?? (await streamed.usage),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(hostedToolCalls.length > 0 && { hostedToolCalls }),
    ...(parts.reasoning.length > 0 && { reasoning: parts.reasoning }),
    ...(streamed.servedBy && { servedBy: streamed.servedBy }),
  };
}
