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
}

/** What reads a response body as it passes. */
export interface ResponseWatch {
  /** Each JSON payload: the whole body of a JSON response, or one SSE `data:` line. A returned failure fails the response. */
  data?(text: string): UpstreamFailure | undefined;
  /** Each JSON payload before it goes on (and before `data`): a returned text replaces it. */
  rewrite?(text: string): string | undefined;
  /** Once, when the body was read to its end (`complete`) or failed or was cancelled. */
  end?(complete: boolean): void;
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

/**
 * `body` read through: each pull waits at most `idleMs` for the next chunk,
 * SSE `data:` lines (or, for a JSON body, the whole text) go to `watch.data`,
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
  let buffer = '';
  let ended = false;
  const end = (complete: boolean) => {
    if (ended) return;
    ended = true;
    watch?.end?.(complete);
  };
  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
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
  };
  /** The complete lines in `text` (after what is buffered): the first failure, and the text before it. */
  const scan = (text: string, last: boolean): { failure?: UpstreamFailure; before: string } => {
    buffer += text;
    const lines = buffer.split('\n');
    const rest = lines.pop() ?? '';
    buffer = last ? '' : rest;
    if (last && rest) lines.push(rest);
    let before = '';
    for (const line of lines) {
      const trimmed = line.trim();
      const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : '';
      const sent = payload && payload !== '[DONE]' ? (watch?.rewrite?.(payload) ?? payload) : payload;
      const failure = sent && sent !== '[DONE]' ? watch?.data?.(sent) : undefined;
      if (failure) return { failure, before };
      before += sent === payload ? `${line}\n` : `data: ${sent}\n`;
    }
    return { before };
  };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, failure: UpstreamFailure, before: string) => {
    if (before) controller.enqueue(encoder.encode(before));
    controller.error(
      new APICallError({
        message: failure.message,
        url,
        requestBodyValues: {},
        statusCode: failure.status,
        responseBody: failureBody(failure),
        isRetryable: isRetryableStatus(failure.status),
      })
    );
    end(false);
    reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Reads until something goes on (a pull that enqueues nothing would leave the reader waiting).
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await read();
        } catch (error) {
          end(false);
          reader.cancel(error).catch(() => undefined);
          controller.error(error);
          return;
        }
        if (result.done) {
          if (sse && watch?.data) {
            const { failure, before } = scan(decoder.decode(), true);
            if (failure) return fail(controller, failure, before);
            if (before) controller.enqueue(encoder.encode(before));
          }
          end(true);
          controller.close();
          return;
        }
        if (!sse || !watch?.data) {
          controller.enqueue(result.value);
          return;
        }
        // Complete lines only go on (re-encoded); a partial line waits for the rest of it.
        const { failure, before } = scan(decoder.decode(result.value, { stream: true }), false);
        if (failure) return fail(controller, failure, before);
        if (before) {
          controller.enqueue(encoder.encode(before));
          return;
        }
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
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    if (sse || !watching?.data) {
      const body = watchedBody(response.body, { idleMs, watch: watching, sse, url });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    // A JSON body: read whole (within the timeout), checked once, and handed on as text.
    const read = await new Response(watchedBody(response.body, { idleMs, sse: false, url })).text();
    const text = watching.rewrite?.(read) ?? read;
    const failure = watching.data(text);
    watching.end?.(true);
    if (failure) {
      return new Response(failureBody(failure), { status: failure.status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
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
    return { status: typeof error === 'string' ? 502 : errorStatus(error.code), message: `The provider reported an error mid-response: ${message}` };
  }
  if (payload.choices?.some((choice) => choice?.finish_reason === 'error')) {
    return {
      status: 502,
      message: "The provider ended the response with finish reason 'error' (an upstream failure after the response started); the text is incomplete.",
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
  const used = new Set<string>();
  const byIndex = new Map<string, { original: string; assigned: string }>();
  const unique = (id: string): string => {
    let assigned = id;
    for (let n = 2; used.has(assigned); n++) assigned = `${id}_${n}`;
    used.add(assigned);
    return assigned;
  };
  return (text) => {
    if (!text.includes('"tool_calls"')) return undefined;
    let payload: { choices?: Array<{ index?: unknown; message?: { tool_calls?: unknown }; delta?: { tool_calls?: unknown } }> };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      return undefined;
    }
    let changed = false;
    for (const choice of payload?.choices ?? []) {
      const delta = choice?.delta !== undefined;
      const calls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls;
      for (const call of Array.isArray(calls) ? (calls as ChatToolCall[]) : []) {
        if (typeof call?.id !== 'string' || call.id === '') continue;
        const key = delta && call.index !== undefined ? `${String(choice.index)}:${String(call.index)}` : undefined;
        const known = key === undefined ? undefined : byIndex.get(key);
        const assigned = known && known.original === call.id ? known.assigned : unique(call.id);
        if (key !== undefined) byIndex.set(key, { original: call.id, assigned });
        if (assigned !== call.id) {
          call.id = assigned;
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(payload) : undefined;
  };
}

/** The watch of one OpenAI-compatible chat completion response: unique tool-call ids and in-response failures. */
export function chatCompletionWatch(): ResponseWatch {
  return { rewrite: uniqueToolCallIds(), data: chatCompletionFailure };
}
