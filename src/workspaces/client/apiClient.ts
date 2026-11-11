import { WORKSPACE_ROUTES, buildRoutePath, type JsonRouteName, type WorkspaceRouteName, type WorkspaceRouteTypes } from './wire';
import { apiErrorBodySchema, wireRunEventSchema } from './wireSchemas';
import type { ProblemView, Revision, WireRunEvent } from './wireTypes';

/** Request header a client sends on reconnect with the id of the last event it saw. */
export const LAST_EVENT_ID_HEADER = 'Last-Event-ID';

/** The error a client throws for a non-2xx answer, a malformed answer or a broken stream. */
export class WorkspaceApiError extends Error {
  /** The HTTP status of the answer. */
  readonly status: number;
  /** The live revision a 409 reports. */
  readonly currentRevision?: Revision;
  /** The problems a rejected write reports. */
  readonly problems?: ProblemView[];

  constructor(message: string, status: number, extra: { currentRevision?: Revision; problems?: ProblemView[] } = {}) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.currentRevision = extra.currentRevision;
    this.problems = extra.problems;
  }
}

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
  /** The run. */
  runId: string;
  /** The id of the last event already seen; the stream resumes after it. */
  lastEventId?: number;
  /** Stops the stream. */
  signal?: AbortSignal;
}

/** The one interface Forge and the Next.js app use to reach the workspace service. */
export interface ApiClient {
  /** Calls a route that answers with one JSON document and returns the checked answer. */
  call<Name extends JsonRouteName>(name: Name, input: RouteInput<Name>): Promise<WorkspaceRouteTypes[Name]['response']>;
  /** Streams a run's events in order, each once, until the run finishes. */
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
}

/** Writes one event as an SSE frame with its `id:`, `event:` and `data:` lines. */
export function formatRunEventFrame(event: WireRunEvent): string {
  return `id: ${event.id}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        yield buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const dataOf = (frame: string): string | undefined => {
  const lines = frame.split('\n').filter((line) => line.startsWith('data:'));
  return lines.length === 0 ? undefined : lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
};

function parseEvent(data: string): WireRunEvent {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new WorkspaceApiError('the event stream sent a frame that is not JSON', 502);
  }
  const parsed = wireRunEventSchema.safeParse(json);
  if (!parsed.success) throw new WorkspaceApiError('the event stream sent an event that does not match the wire contract', 502);
  return parsed.data;
}

/** Reads SSE frames from a response body and yields each valid event; a frame that fails the wire schema throws. */
export async function* readRunEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<WireRunEvent> {
  for await (const frame of frames(body)) {
    const data = dataOf(frame);
    if (data !== undefined) yield parseEvent(data);
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
      const response = await fetchImpl(base + buildRoutePath(route.path, input.params ?? {}), {
        method: route.method,
        headers,
        body: hasBody ? JSON.stringify(input.body) : undefined,
        signal: extra.signal,
      });
      if (!response.ok) throw await failure(response);
      return response;
    },
  };
}

async function callJson<Name extends JsonRouteName>(http: Sender, name: Name, input: RouteInput<Name>): Promise<WorkspaceRouteTypes[Name]['response']> {
  const response = await http.send(name, input);
  const parsed = WORKSPACE_ROUTES[name].response.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new WorkspaceApiError(`the answer to ${name} does not match the wire contract`, 502);
  return parsed.data as WorkspaceRouteTypes[Name]['response'];
}

async function* openStream(http: Sender, request: RunEventsRequest, lastId: number): AsyncGenerator<WireRunEvent> {
  const headers = { accept: 'text/event-stream', ...(lastId >= 0 ? { [LAST_EVENT_ID_HEADER]: String(lastId) } : {}) };
  const response = await http.send('streamRunEvents', { params: { id: request.workspaceId, runId: request.runId } }, { headers, signal: request.signal });
  if (response.body === null) throw new WorkspaceApiError('the event stream has no body', 502);
  yield* readRunEvents(response.body);
}

const retryable = (error: unknown, request: RunEventsRequest): boolean =>
  request.signal?.aborted !== true && !(error instanceof WorkspaceApiError && error.status >= 400 && error.status < 500);

interface Cursor {
  lastId: number;
  finished: boolean;
  progressed: boolean;
}

async function* unseen(http: Sender, request: RunEventsRequest, cursor: Cursor): AsyncGenerator<WireRunEvent> {
  for await (const wire of openStream(http, request, cursor.lastId)) {
    if (wire.id <= cursor.lastId) continue;
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

async function* streamEvents(http: Sender, request: RunEventsRequest, maxReconnects: number): AsyncGenerator<WireRunEvent> {
  const cursor: Cursor = { lastId: request.lastEventId ?? -1, finished: false, progressed: false };
  let failures = 0;
  for (;;) {
    cursor.progressed = false;
    const error = yield* attempt(http, request, cursor);
    if (cursor.finished) return;
    if (error !== undefined && !retryable(error, request)) throw error;
    if (request.signal?.aborted === true) return;
    if (cursor.progressed) failures = 0;
    if (failures++ >= maxReconnects) throw error ?? new WorkspaceApiError('the event stream ended before the run finished', 502);
  }
}

/** A client over {@link WORKSPACE_ROUTES} that uses `fetch`, checks every answer against its schema and reopens a dropped event stream after the last event it saw. */
export function createFetchClient(options: FetchClientOptions): ApiClient {
  const http = sender(options);
  const maxReconnects = options.maxReconnects ?? 3;
  return {
    call: (name, input) => callJson(http, name, input),
    streamRunEvents: (request) => streamEvents(http, request, maxReconnects),
  };
}
