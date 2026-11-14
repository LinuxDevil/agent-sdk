import { WORKSPACE_ROUTES, buildRoutePath, type JsonRouteName, type WorkspaceRouteName, type WorkspaceRouteTypes } from './wire';
import { RUN_EVENT_TYPES, apiErrorBodySchema, wireEnvelopeSchema, wireRunEventSchema } from './wireSchemas';
import type { ProblemView, Revision, WireRunEvent } from './wireTypes';

/** Request header a client sends on reconnect with the id of the last event it saw. */
export const LAST_EVENT_ID_HEADER = 'Last-Event-ID';

const MAX_FRAME_CHARS = 1024 * 1024;
const MAX_BACKOFF_MS = 5000;

/** What a client throws for a non-2xx answer, a malformed answer, a broken stream or a network failure; an aborted request surfaces as the platform's `AbortError` instead. */
export class WorkspaceApiError extends Error {
  /** The HTTP status of the answer, or 0 when the request never got one. */
  readonly status: number;
  /** The live revision a 409 reports. */
  readonly currentRevision?: Revision;
  /** The problems a rejected write reports. */
  readonly problems?: ProblemView[];
  /** Whether the same request may succeed if sent again: network failures and 5xx answers, but not contract failures or 4xx answers. */
  readonly retryable: boolean;

  constructor(message: string, status: number, extra: { currentRevision?: Revision; problems?: ProblemView[]; retryable?: boolean; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.currentRevision = extra.currentRevision;
    this.problems = extra.problems;
    this.retryable = extra.retryable ?? (status === 0 || status >= 500);
  }
}

const contractError = (message: string): WorkspaceApiError => new WorkspaceApiError(message, 502, { retryable: false });

/** The path parameters and body a call to route `Name` takes; a route without them leaves the key out. */
export type RouteInput<Name extends WorkspaceRouteName> = (keyof WorkspaceRouteTypes[Name]['params'] extends never
  ? {
      /** Left out: the route has no path parameters. */
      params?: undefined;
    }
  : {
      /** Values for the `:name` segments of the route path. */
      params: WorkspaceRouteTypes[Name]['params'];
    }) &
  ([WorkspaceRouteTypes[Name]['body']] extends [undefined]
    ? {
        /** Left out: the route takes no body. */
        body?: undefined;
      }
    : {
        /** The JSON request body. */
        body: WorkspaceRouteTypes[Name]['body'];
      });

/** What to stream: a run's events after the last one already seen. */
export interface RunEventsRequest {
  /** The workspace. */
  workspaceId: string;
  /** The run; events of any other run are dropped. */
  runId: string;
  /** The id of the last event already seen; the stream resumes after it. */
  lastEventId?: number;
  /** Stops the stream; the stream then ends with the platform's `AbortError`. */
  signal?: AbortSignal;
}

/** The one interface Forge and the Next.js app use to reach the workspace service. */
export interface ApiClient {
  /** Calls a route that answers with one JSON document and returns the checked answer. */
  call<Name extends JsonRouteName>(name: Name, input: RouteInput<Name>): Promise<WorkspaceRouteTypes[Name]['response']>;
  /** Streams a run's events in order, each once, until the run finishes; an event of a type this client does not know is skipped, while a known type with a bad shape throws a non-retryable {@link WorkspaceApiError}. */
  streamRunEvents(request: RunEventsRequest): AsyncIterable<WireRunEvent>;
}

/** Headers added to every request, or a function that returns them per request. */
export type HeadersSource = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

/** Options of {@link createFetchClient}. */
export interface FetchClientOptions {
  /** Service origin and prefix, such as `https://svc.example.com`. */
  baseUrl: string;
  /** The fetch to use; defaults to the global one. */
  fetch?: typeof fetch;
  /** Headers added to every request, such as the proxy's service token and signed user id. */
  headers?: HeadersSource;
  /** How many times a dropped stream is reopened with `Last-Event-ID`; default 3. */
  maxReconnects?: number;
  /** First reconnect delay in milliseconds, doubled per failed attempt up to 5 s; default 250. A `retry:` field from the server replaces it. */
  reconnectDelayMs?: number;
  /** Waits before a reconnect; defaults to a timer that ends early when the request's signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Writes one event as an SSE frame with its `id:`, `event:` and `data:` lines. */
export function formatRunEventFrame(event: WireRunEvent): string {
  return `id: ${event.id}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

function networkError(error: unknown): unknown {
  if (isAbort(error) || error instanceof WorkspaceApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkspaceApiError(`network failure: ${message}`, 0, { retryable: true, cause: error });
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    throw networkError(error);
  }
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await readChunk(reader);
      if (chunk.done) return;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        yield buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
      }
      if (buffer.length > MAX_FRAME_CHARS) throw contractError('the event stream sent a frame larger than 1 MB');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const fieldLines = (frame: string, field: string): string[] =>
  frame
    .split('\n')
    .filter((line) => line.startsWith(`${field}:`))
    .map((line) => line.slice(field.length + 1).replace(/^ /, ''));

function parseEvent(data: string): WireRunEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw contractError('the event stream sent a frame that is not JSON');
  }
  const parsed = wireRunEventSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const envelope = wireEnvelopeSchema.safeParse(json);
  if (envelope.success && !RUN_EVENT_TYPES.includes(envelope.data.event.type)) return undefined;
  throw contractError('the event stream sent an event that does not match the wire contract');
}

/** Reads SSE frames from a response body and yields each valid event; calls `onRetry` with a `retry:` field's milliseconds. An unknown event type is skipped and a known type with a bad shape throws a non-retryable {@link WorkspaceApiError}, as does a frame over 1 MB. */
export async function* readRunEvents(body: ReadableStream<Uint8Array>, onRetry?: (ms: number) => void): AsyncGenerator<WireRunEvent> {
  for await (const frame of frames(body)) {
    for (const hint of fieldLines(frame, 'retry')) if (/^\d+$/.test(hint)) onRetry?.(Number(hint));
    const data = fieldLines(frame, 'data');
    const event = data.length === 0 ? undefined : parseEvent(data.join('\n'));
    if (event !== undefined) yield event;
  }
}

async function failure(response: Response): Promise<WorkspaceApiError> {
  const parsed = apiErrorBodySchema.safeParse(await response.json().catch(() => undefined));
  const body = parsed.success ? parsed.data : undefined;
  return new WorkspaceApiError(body?.error ?? `request failed with status ${response.status}`, response.status, {
    currentRevision: body?.currentRevision,
    problems: body?.problems,
  });
}

async function headersFor(source: HeadersSource | undefined): Promise<Record<string, string>> {
  return typeof source === 'function' ? await source() : { ...source };
}

interface Sender {
  send(name: WorkspaceRouteName, input: { params?: object; body?: unknown }, extra?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
}

function sender(options: FetchClientOptions): Sender {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    async send(name, input, extra = {}) {
      const route = WORKSPACE_ROUTES[name];
      const hasBody = input.body !== undefined;
      const headers = { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(await headersFor(options.headers)), ...extra.headers };
      const init = { method: route.method, headers, body: hasBody ? JSON.stringify(input.body) : undefined, signal: extra.signal };
      const response = await fetchImpl(base + buildRoutePath(route.path, input.params ?? {}), init).catch((error: unknown) => {
        throw networkError(error);
      });
      if (!response.ok) throw await failure(response);
      return response;
    },
  };
}

async function callJson<Name extends JsonRouteName>(http: Sender, name: Name, input: RouteInput<Name>): Promise<WorkspaceRouteTypes[Name]['response']> {
  const response = await http.send(name, input);
  const parsed = WORKSPACE_ROUTES[name].response.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw contractError(`the answer to ${name} does not match the wire contract`);
  return parsed.data as WorkspaceRouteTypes[Name]['response'];
}

interface Cursor {
  lastId: number;
  finished: boolean;
  progressed: boolean;
  retryMs?: number;
}

async function* openStream(http: Sender, request: RunEventsRequest, cursor: Cursor): AsyncGenerator<WireRunEvent> {
  const headers = { accept: 'text/event-stream', ...(cursor.lastId >= 0 ? { [LAST_EVENT_ID_HEADER]: String(cursor.lastId) } : {}) };
  const response = await http.send('streamRunEvents', { params: { id: request.workspaceId, runId: request.runId } }, { headers, signal: request.signal });
  if (response.body === null) throw contractError('the event stream has no body');
  yield* readRunEvents(response.body, (ms) => {
    cursor.retryMs = ms;
  });
}

async function* unseen(http: Sender, request: RunEventsRequest, cursor: Cursor): AsyncGenerator<WireRunEvent> {
  for await (const wire of openStream(http, request, cursor)) {
    if (wire.runId !== request.runId || wire.id <= cursor.lastId) continue;
    cursor.lastId = wire.id;
    cursor.progressed = true;
    yield wire;
    if (wire.event.type === 'finished') {
      cursor.finished = true;
      return;
    }
  }
}

async function* attempt(http: Sender, request: RunEventsRequest, cursor: Cursor): AsyncGenerator<WireRunEvent, unknown> {
  try {
    yield* unseen(http, request, cursor);
    return undefined;
  } catch (error) {
    return error;
  }
}

const retryable = (error: unknown): boolean => error instanceof WorkspaceApiError && error.retryable;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

async function pause(request: RunEventsRequest, options: FetchClientOptions, cursor: Cursor, failures: number): Promise<void> {
  const delay = cursor.retryMs ?? Math.min((options.reconnectDelayMs ?? 250) * 2 ** failures, MAX_BACKOFF_MS);
  await (options.sleep ?? defaultSleep)(delay, request.signal);
  if (request.signal?.aborted === true) throw request.signal.reason ?? new DOMException('aborted', 'AbortError');
}

async function* streamEvents(http: Sender, request: RunEventsRequest, options: FetchClientOptions): AsyncGenerator<WireRunEvent> {
  const cursor: Cursor = { lastId: request.lastEventId ?? -1, finished: false, progressed: false };
  const maxReconnects = options.maxReconnects ?? 3;
  let failures = 0;
  for (;;) {
    cursor.progressed = false;
    const error = yield* attempt(http, request, cursor);
    if (cursor.finished) return;
    if (error !== undefined && !retryable(error)) throw error;
    if (cursor.progressed) failures = 0;
    if (failures >= maxReconnects) throw error ?? new WorkspaceApiError('the event stream ended before the run finished', 0, { retryable: true });
    await pause(request, options, cursor, failures);
    failures++;
  }
}

/** A client over {@link WORKSPACE_ROUTES} that uses `fetch`, checks every answer against its schema and reopens a dropped event stream after the last event it saw, waiting with a growing delay. Only network failures, 5xx answers and a stream that ends early are retried; contract failures and 4xx answers are not. */
export function createFetchClient(options: FetchClientOptions): ApiClient {
  const http = sender(options);
  return {
    call: (name, input) => callJson(http, name, input),
    streamRunEvents: (request) => streamEvents(http, request, options),
  };
}
