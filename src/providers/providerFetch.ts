/**
 * The `fetch` the built-in providers' model calls go through: the configured
 * (or global) `fetch`, bounded by the provider's `timeout`, with each
 * successful response body read as it passes so OpenAI-compatible failures
 * reported inside a 200 response (`finish_reason: "error"`, an `error` object
 * in a stream chunk) fail the call instead of ending it as a success.
 */

import { APICallError } from 'ai';

/** The default `timeout` of the built-in providers: the longest wait for a response to start, and between two of its chunks. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** A failure found in a successful response: the HTTP status it stands for and its message. */
export interface UpstreamFailure {
  status: number;
  message: string;
  /** The payload that reported it, kept as the error's `responseBody` for a failure mid-stream. */
  body?: string;
}

/** What reads a response body as it passes. */
export interface ResponseWatch {
  /** Each JSON payload: the whole body of a JSON response, or one SSE `data:` line. A returned failure fails the response. */
  data?(text: string): UpstreamFailure | undefined;
  /** Each JSON payload before it goes on (and before `data`): a returned text replaces it. */
  rewrite?(text: string): string | undefined;
  /** Once, when the body was read to its end (`complete`) or failed or was cancelled. */
  end?(complete: boolean): void;
  /** A JSON body answering a streaming request (a server that ignores `stream: true`): the event stream it stands for, if it can tell. */
  asStream?(text: string): string | undefined;
}

export interface ProviderFetchOptions {
  /** The `fetch` each request goes to, read per request (so tests can stub `globalThis.fetch` late). */
  send: () => typeof globalThis.fetch;
  /** The longest wait, in ms, for the response headers and between two body chunks; unset, 0 or `Infinity`: none. */
  timeoutMs?: number;
  /** The watch for one request's successful response, if any. */
  watch?: () => ResponseWatch | undefined;
}

function timeoutError(ms: number): Error {
  return new DOMException(`The model request timed out: no response for ${ms} ms (the provider's \`timeout\`)`, 'TimeoutError');
}

/** `ms` as a usable timer length, else `undefined` (no timeout). */
function timerMs(ms: number | undefined): number | undefined {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** The failure as the OpenAI-style error body every `@ai-sdk/*` OpenAI-compatible parser reads. */
function failureBody(failure: UpstreamFailure): string {
  return JSON.stringify({ error: { message: failure.message, type: 'upstream_error', param: null, code: null } });
}

/** `reader.read()`, rejected with a `TimeoutError` when the next chunk takes longer than `idleMs`. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number | undefined): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleMs === undefined) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(idleMs)), idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
  }
}

/** One SSE line as it goes on: rewritten by the watch when it is a `data:` payload, and the failure it reports. */
function watchLine(line: string, watch: ResponseWatch): { sent: string; failure?: UpstreamFailure } {
  const trimmed = line.trim();
  const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : '';
  if (!payload || payload === '[DONE]') return { sent: `${line}\n` };
  const rewritten = watch.rewrite?.(payload) ?? payload;
  const sent = rewritten === payload ? `${line}\n` : `data: ${rewritten}\n`;
  return { sent, failure: watch.data?.(rewritten) };
}

/** Splits an event stream into lines for its watch, keeping a partial line until the rest of it arrives. */
class LineScanner {
  private buffer = '';
  constructor(private readonly watch: ResponseWatch) {}

  /** The complete lines in `text` (after what is buffered): the first failure, and the text before it. */
  scan(text: string, last: boolean): { failure?: UpstreamFailure; before: string } {
    const lines = (this.buffer + text).split('\n');
    const rest = lines.pop() ?? '';
    this.buffer = last ? '' : rest;
    if (last && rest) lines.push(rest);
    let before = '';
    for (const line of lines) {
      const { sent, failure } = watchLine(line, this.watch);
      if (failure) return { failure, before };
      before += sent;
    }
    return { before };
  }
}

/** The retryable `APICallError` an in-response failure fails the stream with. */
function failureError(failure: UpstreamFailure, url: string): APICallError {
  return new APICallError({
    message: failure.message,
    url,
    requestBodyValues: {},
    statusCode: failure.status,
    responseBody: failure.body ?? failureBody(failure),
    isRetryable: isRetryableStatus(failure.status),
  });
}

/**
 * `body` read through: each pull waits at most `idleMs` for the next chunk,
 * SSE `data:` lines go to the watch (complete lines only go on, re-encoded),
 * and a failure it returns errors the stream with a retryable `APICallError`
 * after the lines before it.
 */
function watchedBody(
  body: ReadableStream<Uint8Array>,
  { idleMs, watch, sse, url }: { idleMs?: number; watch?: ResponseWatch; sse: boolean; url: string }
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const scanner = sse && watch?.data ? new LineScanner(watch) : undefined;
  let ended = false;
  const end = (complete: boolean) => {
    if (!ended) watch?.end?.(complete);
    ended = true;
  };
  /** Passes on what `text` completes; true when something went on or the stream ended. */
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, text: string, last: boolean): boolean => {
    const { failure, before } = (scanner as LineScanner).scan(text, last);
    if (before) controller.enqueue(encoder.encode(before));
    if (!failure) return before !== '';
    controller.error(failureError(failure, url));
    end(false);
    reader.cancel().catch(() => undefined);
    return true;
  };
  /** One read: true when something went on (a pull that enqueues nothing would leave the reader waiting). */
  const step = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<boolean> => {
    const result = await readWithin(reader, idleMs);
    if (result.done) {
      if (!scanner || !emit(controller, decoder.decode(), true) || !ended) {
        end(true);
        controller.close();
      }
      return true;
    }
    if (!scanner) {
      controller.enqueue(result.value);
      return true;
    }
    return emit(controller, decoder.decode(result.value, { stream: true }), false);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!(await step(controller)));
      } catch (error) {
        end(false);
        reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      end(false);
      return reader.cancel(reason);
    },
  });
}

/** `promise`, rejected with a `TimeoutError` (and `controller` aborted) when it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number | undefined, controller: AbortController): Promise<T> {
  if (ms === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A `fetch` for a provider's model calls (see the module doc). A non-OK
 * response is passed on as it is; an OK JSON response whose watch reports a
 * failure becomes an error response with that status, and an OK
 * event stream errors at the failing line.
 */
export function providerFetch({ send, timeoutMs, watch }: ProviderFetchOptions): typeof globalThis.fetch {
  const idleMs = timerMs(timeoutMs);
  return async (input, init) => {
    const controller = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const response = await within(send()(input, { ...init, signal }), idleMs, controller);
    const watching = response.ok ? watch?.() : undefined;
    if (!response.body || (!watching && idleMs === undefined)) return response;
    return watchedResponse(response, response.body, { idleMs, watching, url: requestUrl(input), streaming: isStreamingRequest(init) });
  };
}

/** Whether a request body asks for an event stream (`"stream": true`, as every OpenAI-compatible API spells it). */
function isStreamingRequest(init: RequestInit | undefined): boolean {
  return typeof init?.body === 'string' && /"stream"\s*:\s*true/.test(init.body);
}

/** The URL a `fetch` input names. */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** `response` with its body read through its watch and the idle timeout (see providerFetch). */
async function watchedResponse(
  response: Response,
  body: ReadableStream<Uint8Array>,
  { idleMs, watching, url, streaming }: { idleMs?: number; watching?: ResponseWatch; url: string; streaming: boolean }
): Promise<Response> {
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const replays = !sse && streaming && watching?.asStream !== undefined;
  if (sse || !(watching?.data || replays)) return new Response(watchedBody(body, { idleMs, watch: watching, sse, url }), init);
  // A JSON body: read whole (within the timeout), checked once, and handed on as text.
  const read = await new Response(watchedBody(body, { idleMs, sse: false, url })).text();
  // A whole JSON reply to a streaming request would parse as an empty stream: replay it as the stream it stands for.
  const events = replays ? watching?.asStream?.(read) : undefined;
  if (events !== undefined) {
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/event-stream');
    const replayed = new Response(events).body as ReadableStream<Uint8Array>;
    return new Response(watchedBody(replayed, { watch: watching, sse: true, url }), { ...init, headers });
  }
  const text = watching?.rewrite?.(read) ?? read;
  const failure = watching?.data?.(text);
  watching?.end?.(true);
  if (failure) return new Response(failureBody(failure), { status: failure.status, headers: { 'content-type': 'application/json' } });
  return new Response(text, init);
}

/** One choice of an OpenAI-compatible chat completion or chunk, as far as read here. */
interface ChatPayload {
  type?: unknown;
  error?: { message?: unknown; code?: unknown } | string | null;
  choices?: Array<{ finish_reason?: unknown }>;
}

/** A provider's own status for an in-response `error` (OpenRouter sends `code: 502`), else 502. */
function errorStatus(code: unknown): number {
  const status = typeof code === 'number' ? code : typeof code === 'string' ? Number(code) : NaN;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

/**
 * The failure an OpenAI-compatible chat completion (or stream chunk) reports
 * inside a 200 response, if any: an `error` object (OpenRouter's mid-stream
 * error chunk) or a choice that ended with `finish_reason: "error"` (an
 * upstream failure after the response started; what was written is cut off).
 * Responses API events (which carry a `type`) are left to the AI SDK.
 */
export function chatCompletionFailure(text: string): UpstreamFailure | undefined {
  // Cheap filter: nearly every payload has neither.
  if (!text.includes('"error"')) return undefined;
  let payload: ChatPayload;
  try {
    payload = JSON.parse(text) as ChatPayload;
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null || payload.type !== undefined) return undefined;
  const { error } = payload;
  if (error && (typeof error === 'string' || typeof error === 'object')) {
    const message = typeof error === 'string' ? error : typeof error.message === 'string' ? error.message : JSON.stringify(error);
    return {
      status: typeof error === 'string' ? 502 : errorStatus(error.code),
      message: `The provider reported an error mid-response: ${message}`,
      body: text,
    };
  }
  if (payload.choices?.some((choice) => choice?.finish_reason === 'error')) {
    return {
      status: 502,
      message: "The provider ended the response with finish reason 'error' (an upstream failure after the response started); the text is incomplete.",
      body: text,
    };
  }
  return undefined;
}

/** One tool call of a chat completion message or stream delta, as far as read here. */
interface ChatToolCall {
  index?: unknown;
  id?: unknown;
}

/**
 * A rewrite for one chat completion response that gives every tool call its
 * own id. Some OpenAI-compatible servers (and Gemini behind proxies) send two
 * calls with the same id, and `ai` 6/7 then keep the first call's arguments
 * for both; a repeated id gets a `_2`, `_3`, ... suffix. A stream that repeats
 * a call's id on each of its deltas keeps the id it was given first.
 */
export function uniqueToolCallIds(): (text: string) => string | undefined {
  const ids = new ToolCallIds();
  return (text) => {
    if (!text.includes('"tool_calls"')) return undefined;
    let payload: ToolCallPayload;
    try {
      payload = JSON.parse(text) as ToolCallPayload;
    } catch {
      return undefined;
    }
    let changed = false;
    for (const choice of payload?.choices ?? []) changed = ids.assign(choice) || changed;
    return changed ? JSON.stringify(payload) : undefined;
  };
}

/** A chat completion (or chunk) as far as its tool calls are read. */
interface ToolCallPayload {
  choices?: Array<{ index?: unknown; message?: { tool_calls?: unknown }; delta?: { tool_calls?: unknown } }>;
}

/** The tool-call ids of one response: each one used, and a stream call's id by its `index` (or its slot in the delta's `tool_calls` when `index` is omitted). */
class ToolCallIds {
  private readonly used = new Set<string>();
  private readonly byIndex = new Map<string, { original: string; assigned: string }>();

  /** Gives each call of `choice` its own id; true when one changed. */
  assign(choice: NonNullable<ToolCallPayload['choices']>[number]): boolean {
    const calls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls;
    let changed = false;
    const list = Array.isArray(calls) ? (calls as ChatToolCall[]) : [];
    for (const [position, call] of list.entries()) {
      if (typeof call?.id !== 'string' || call.id === '') continue;
      // A stream call is keyed by its choice and its `index`; a delta that omits
      // `index` still repeats the call at the same slot of its tool_calls, so
      // the array position stands in for it.
      const key = choice.delta !== undefined ? `${String(choice.index)}:${String(call.index ?? position)}` : undefined;
      const assigned = this.idFor(call.id, key);
      if (assigned !== call.id) {
        call.id = assigned;
        changed = true;
      }
    }
    return changed;
  }

  /** `id`, or a suffixed one when an earlier call had it; a stream call (`key`) keeps the one it was given first. */
  private idFor(id: string, key: string | undefined): string {
    const known = key === undefined ? undefined : this.byIndex.get(key);
    if (known && known.original === id) return known.assigned;
    let assigned = id;
    for (let n = 2; this.used.has(assigned); n++) assigned = `${id}_${n}`;
    this.used.add(assigned);
    if (key !== undefined) this.byIndex.set(key, { original: id, assigned });
    return assigned;
  }
}

/** A chat completion as far as {@link chatCompletionAsStream} reads it. */
interface ChatCompletion {
  object?: unknown;
  usage?: unknown;
  choices?: Array<{ index?: unknown; finish_reason?: unknown; message?: Record<string, unknown> & { tool_calls?: unknown } }>;
}

/**
 * A whole chat completion (choices with a `message`) as the event stream
 * of chunks that carries the same message, finish reason and usage; any
 * other body is `undefined`. For servers that answer `stream: true` with JSON.
 */
export function chatCompletionAsStream(text: string): string | undefined {
  let completion: ChatCompletion;
  try {
    completion = JSON.parse(text) as ChatCompletion;
  } catch {
    return undefined;
  }
  if (completion?.object !== 'chat.completion' && completion?.object !== undefined) return undefined;
  const { choices, usage, object: _object, ...meta } = completion ?? {};
  if (!Array.isArray(choices) || choices.length === 0 || !choices.every((choice) => typeof choice?.message === 'object' && choice.message !== null)) return undefined;
  const chunk = (rest: Record<string, unknown>) => `data: ${JSON.stringify({ ...meta, object: 'chat.completion.chunk', ...rest })}\n\n`;
  let events = '';
  for (const [n, choice] of choices.entries()) {
    const index = choice.index ?? n;
    const { tool_calls: calls, ...message } = choice.message ?? {};
    const toolCalls = Array.isArray(calls) ? (calls as Array<Record<string, unknown>>).map((call, i) => ({ index: i, ...call })) : undefined;
    events += chunk({ choices: [{ index, delta: { ...message, ...(toolCalls && { tool_calls: toolCalls }) }, finish_reason: null }] });
    events += chunk({ choices: [{ index, delta: {}, finish_reason: choice.finish_reason ?? null }] });
  }
  if (usage !== undefined) events += chunk({ choices: [], usage });
  return `${events}data: [DONE]\n\n`;
}

/** The watch of one OpenAI-compatible chat completion response: unique tool-call ids, in-response failures, and a JSON reply to a stream request. */
export function chatCompletionWatch(): ResponseWatch {
  return { rewrite: uniqueToolCallIds(), data: chatCompletionFailure, asStream: chatCompletionAsStream };
}
