/**
 * LOU-V2: obtains one model step through `provider.stream()` instead of
 * `provider.generate()`, reporting text chunks as they arrive and assembling
 * the same GenerateResult the rest of the AgentExecutor loop works with.
 */

import type { GenerateOptions, GenerateResult, LLMProvider, StreamChunk, StreamResult, ToolCall } from '../providers';

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

interface StreamedParts {
  text: string;
  toolCalls: ToolCall[];
  finish?: StreamChunk;
}

/** Folds one chunk into the parts collected so far; throws on an `error` chunk. */
function applyChunk(parts: StreamedParts, chunk: StreamChunk, onTextDelta: (text: string) => void, onOutput?: () => void): void {
  if (chunk.type === 'text-delta' && chunk.textDelta) {
    parts.text += chunk.textDelta;
    onOutput?.();
    onTextDelta(chunk.textDelta);
  } else if (chunk.type === 'tool-call' && chunk.toolCall) {
    onOutput?.();
    parts.toolCalls.push(chunk.toolCall);
  } else if (chunk.type === 'finish') {
    parts.finish = chunk;
  } else if (chunk.type === 'error') {
    throw chunk.error ?? new Error('The model stream reported an error without details');
  }
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
 * stream's promises. The signal is checked between chunks. `onOutput` is
 * called before the first text delta or tool call is applied (LOU-V10).
 */
export async function generateViaStream(
  provider: LLMProvider,
  request: GenerateOptions,
  onTextDelta: (text: string) => void,
  onOutput?: () => void
): Promise<GenerateResult> {
  const streamed = await provider.stream(request);
  silenceFinalValues(streamed);
  const parts: StreamedParts = { text: '', toolCalls: [] };
  for await (const chunk of streamed.fullStream) {
    request.signal?.throwIfAborted();
    applyChunk(parts, chunk, onTextDelta, onOutput);
  }
  request.signal?.throwIfAborted();

  const toolCalls = parts.toolCalls.length > 0 ? parts.toolCalls : ((await streamed.toolCalls) ?? []);
  return {
    text: parts.text,
    finishReason: toFinishReason(parts.finish?.finishReason ?? (await streamed.finishReason)),
    usage: parts.finish?.usage ?? (await streamed.usage),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
