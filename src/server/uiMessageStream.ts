/**
 * LOU-P1: render a Lousho run with the Vercel AI SDK's UI hooks (`useChat`).
 * `toUIMessageStream()` maps a run's typed events (docs/streaming.md) to the
 * AI SDK's "UI message stream" chunks, `toUIMessageStreamResponse()` frames
 * them as the protocol's Server-Sent Events, and `fromUIMessages()` turns the
 * `UIMessage[]` `useChat` posts back into an `AgentInput`. See docs/ai-sdk-ui.md.
 *
 * The chunk types are our own structural copies: this module imports nothing
 * from `ai` (the SDK's peer may be v4, which has no UI message stream) and
 * nothing from `node:*`, so it runs on Workers.
 */
import type { AgentEvent } from '../execution/agentEvents';
import type { AgentInput } from '../providers/content';
import type { ContentPart, Message } from '../providers/llm';

/** The AI SDK's finish reasons, as the `finish` chunk carries them. */
export type UIFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

/** Payload of the `data-lousho-approval` part: a tool call waiting for a decision, or an `ask_question` waiting for an answer. */
export interface LoushoApprovalData {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** `'question'` for an `ask_question` pause; absent for a tool approval. */
  kind?: string;
  /** The question's text and options, when `kind` is `'question'`. */
  question?: unknown;
}

/** `messageMetadata` of the `finish` chunk. */
export interface LoushoFinishMetadata {
  runId: string;
  /** The run's own finish reason (`'awaiting-approval'`, `'max-steps'`, ...). */
  loushoFinishReason: string;
  /** Tokens and, when known, USD cost of the run (`AgentEventUsage`). */
  usage?: unknown;
}

/** The subset of the AI SDK's `UIMessageChunk` this adapter emits. */
export type LoushoUIMessageChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  | { type: 'text-start' | 'text-end'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-start' | 'reasoning-end'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'data-lousho-approval'; id: string; data: LoushoApprovalData }
  | { type: 'error'; errorText: string }
  | { type: 'finish'; finishReason: UIFinishReason; messageMetadata: LoushoFinishMetadata };

const FINISH_REASONS: Record<string, UIFinishReason> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content-filter',
  tool_calls: 'tool-calls',
  'tool-calls': 'tool-calls',
  error: 'error',
};

interface MapState {
  /** Id of the open text part, if any. */
  openText: string | null;
  textCount: number;
  /** LOU-V13: id of the reasoning part opened last. */
  reasoning: string;
}

function closeText(state: MapState): LoushoUIMessageChunk[] {
  const id = state.openText;
  state.openText = null;
  return id === null ? [] : [{ type: 'text-end', id }];
}

function textDelta(state: MapState, delta: string): LoushoUIMessageChunk[] {
  const opened: LoushoUIMessageChunk[] = [];
  if (state.openText === null) {
    state.openText = `text-${++state.textCount}`;
    opened.push({ type: 'text-start', id: state.openText });
  }
  return [...opened, { type: 'text-delta', id: state.openText, delta }];
}

/** LOU-V13: a `reasoning-delta`, or the `reasoning-end` of the part the last `reasoning.start` opened. */
function reasoningChunk(event: Extract<AgentEvent, { type: 'reasoning.delta' | 'reasoning.done' }>, state: MapState): LoushoUIMessageChunk {
  if (event.type === 'reasoning.done') return { type: 'reasoning-end', id: state.reasoning };
  return { type: 'reasoning-delta', id: state.reasoning, delta: event.text };
}

/** The chunks one event produces. Sub-agent events and events with no UI counterpart produce none. */
function chunksFor(event: AgentEvent, state: MapState): LoushoUIMessageChunk[] {
  if (event.subagent) return [];
  switch (event.type) {
    case 'run.start':
      return [{ type: 'start', messageId: event.runId }];
    case 'step.start':
      return [{ type: 'start-step' }];
    case 'text.delta':
      return textDelta(state, event.text);
    case 'text.done':
      return closeText(state);
    // LOU-V13: one reasoning part per `reasoning.start` ... `reasoning.done`.
    case 'reasoning.start':
      state.reasoning = `reasoning-${event.seq}`;
      return [{ type: 'reasoning-start', id: state.reasoning }];
    case 'reasoning.delta':
    case 'reasoning.done':
      return [reasoningChunk(event, state)];
    case 'tool.start':
      return [
        ...closeText(state),
        { type: 'tool-input-start', toolCallId: event.toolCallId, toolName: event.toolName },
        { type: 'tool-input-available', toolCallId: event.toolCallId, toolName: event.toolName, input: event.args },
      ];
    case 'tool.done':
      return [{ type: 'tool-output-available', toolCallId: event.toolCallId, output: event.result }];
    case 'tool.error':
      return [{ type: 'tool-output-error', toolCallId: event.toolCallId, errorText: event.error.message }];
    case 'approval.requested':
      return [
        {
          type: 'data-lousho-approval',
          id: event.approvalId,
          data: {
            approvalId: event.approvalId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args,
            ...(event.kind && { kind: event.kind }),
            ...(event.question && { question: event.question }),
          },
        },
      ];
    case 'step.done':
      return [...closeText(state), { type: 'finish-step' }];
    case 'error':
      return [{ type: 'error', errorText: event.error.message }];
    case 'run.done':
      return [
        ...closeText(state),
        {
          type: 'finish',
          finishReason: FINISH_REASONS[event.finishReason] ?? 'other',
          messageMetadata: { runId: event.runId, loushoFinishReason: event.finishReason, ...(event.usage && { usage: event.usage }) },
        },
      ];
    default:
      return [];
  }
}

/**
 * The run's events as AI SDK UI message chunks, in order: `start`, then per
 * step `start-step`, text parts, tool parts and `finish-step`, and finally
 * `finish` (whose `messageMetadata` carries the run id, the run's own finish
 * reason and its usage). Cancelling the stream aborts the run.
 *
 * @example
 * ```ts
 * const chunks = toUIMessageStream(agent.stream('Hello'));
 * ```
 */
export function toUIMessageStream(run: AsyncIterable<AgentEvent>): ReadableStream<LoushoUIMessageChunk> {
  const iterator = run[Symbol.asyncIterator]();
  const state: MapState = { openText: null, textCount: 0, reasoning: '' };
  const pending: LoushoUIMessageChunk[] = [];
  return new ReadableStream<LoushoUIMessageChunk>({
    async pull(controller) {
      try {
        while (pending.length === 0) {
          const next = await iterator.next();
          if (next.done) return controller.close();
          pending.push(...chunksFor(next.value, state));
        }
        controller.enqueue(pending.shift() as LoushoUIMessageChunk);
      } catch (error) {
        controller.enqueue({ type: 'error', errorText: error instanceof Error ? error.message : String(error) });
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * A `Response` carrying the run as the UI message stream protocol (SSE, one
 * JSON chunk per `data:` line, `data: [DONE]` at the end, header
 * `x-vercel-ai-ui-message-stream: v1`): return it from a route handler.
 *
 * @example
 * ```ts
 * export async function POST(request: Request) {
 *   const { messages } = await request.json();
 *   return toUIMessageStreamResponse(agent.stream(fromUIMessages(messages)));
 * }
 * ```
 */
export function toUIMessageStreamResponse(run: AsyncIterable<AgentEvent>, init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const frames = toUIMessageStream(run).pipeThrough(
    new TransformStream<LoushoUIMessageChunk, Uint8Array>({
      transform: (chunk, controller) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)),
      flush: (controller) => controller.enqueue(encoder.encode('data: [DONE]\n\n')),
    })
  );
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  headers.set('x-vercel-ai-ui-message-stream', 'v1');
  headers.set('x-accel-buffering', 'no');
  return new Response(frames, { ...init, headers });
}

/** A part of the AI SDK's `UIMessage`, structurally (unknown part types are ignored). */
export interface UIMessagePartLike {
  type: string;
  text?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
}

/** The `UIMessage` `useChat` posts, structurally. */
export interface UIMessageLike {
  role: 'system' | 'user' | 'assistant';
  parts: UIMessagePartLike[];
}

function toContentPart(part: UIMessagePartLike): ContentPart | undefined {
  if (part.type === 'text' && part.text) return { type: 'text', text: part.text };
  if (part.type !== 'file' || !part.url) return undefined;
  if (part.mediaType?.startsWith('image/')) return { type: 'image', image: part.url, mimeType: part.mediaType };
  return { type: 'file', data: part.url, mimeType: part.mediaType ?? 'application/octet-stream', ...(part.filename && { filename: part.filename }) };
}

function toContent(parts: UIMessagePartLike[]): string | ContentPart[] {
  const content = parts.flatMap((part) => toContentPart(part) ?? []);
  return content.length === 1 && content[0].type === 'text' ? content[0].text : content;
}

/**
 * The `UIMessage[]` `useChat` posts as an `AgentInput`: text parts become text,
 * `image/*` file parts images and other file parts files (the part's `url`, a
 * `data:` URL or an `http(s)` URL, is the data); tool, reasoning, data and any
 * other parts are ignored, and messages left empty are dropped. With
 * `lastUserOnly` (use it when the run has a `sessionId`, whose transcript
 * already holds the earlier turns) only the last user message is returned, as
 * the new input.
 */
export function fromUIMessages(messages: readonly UIMessageLike[], options: { lastUserOnly?: boolean } = {}): AgentInput {
  const converted: Message[] = messages
    .map((message): Message => ({ role: message.role, content: toContent(message.parts ?? []) }))
    .filter((message) => message.content.length > 0);
  if (!options.lastUserOnly) return converted;
  const last = [...converted].reverse().find((message) => message.role === 'user');
  return last ? last.content : '';
}
