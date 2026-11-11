import { describe, expect, it } from 'vitest';
import { fixtureClient } from './__fixtures__/fixtureClient';
import fixtures from './__fixtures__/wire.fixtures.json';
import { WorkspaceApiError, createFetchClient, formatRunEventFrame, readRunEvents, type ApiClient } from './apiClient';
import type { WireRunEvent } from './wireTypes';

const events = fixtures.responses.streamRunEvents as WireRunEvent[];

const encoder = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const sse = (list: WireRunEvent[]): Response => new Response(streamOf(list.map(formatRunEventFrame)), { headers: { 'content-type': 'text/event-stream' } });

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function collect(source: AsyncIterable<WireRunEvent>): Promise<WireRunEvent[]> {
  const out: WireRunEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function headersOf(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function recorder(answer: (seen: Seen, call: number) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = {
      url: String(url),
      method: init?.method,
      headers: headersOf(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(entry);
    return answer(entry, seen.length - 1);
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

describe('SSE reader', () => {
  it('the SSE reader yields PageRunEvents in order and stops on finished', async () => {
    const after: WireRunEvent = { id: events.length, runId: events[0].runId, event: { type: 'progress', message: 'after the end' } };
    const http = recorder(() => sse([...events, after]));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch });
    const got = await collect(client.streamRunEvents({ workspaceId: 'marketing', runId: events[0].runId }));
    expect(got).toEqual(events);
    expect(got.at(-1)?.event.type).toBe('finished');
    expect(http.seen).toHaveLength(1);
    expect(http.seen[0].url).toBe(`https://svc.test/api/workspaces/marketing/runs/${events[0].runId}/events`);
    expect(http.seen[0].headers.accept).toBe('text/event-stream');
    expect(http.seen[0].headers['last-event-id']).toBeUndefined();
  });

  it('reads frames split at any byte, with comments and CRLF', async () => {
    const text = `: keep-alive\r\n\r\n${events.map(formatRunEventFrame).join('').replace(/\n/g, '\r\n')}`;
    const chunks = text.match(/[\s\S]{1,7}/g) ?? [];
    expect(await collect(readRunEvents(streamOf(chunks)))).toEqual(events);
  });

  it('rejects an event that does not match the wire schema', async () => {
    const bad = `id: 0\ndata: ${JSON.stringify({ id: 0, runId: 'r', event: { type: 'nope' } })}\n\n`;
    await expect(collect(readRunEvents(streamOf([bad])))).rejects.toBeInstanceOf(WorkspaceApiError);
    await expect(collect(readRunEvents(streamOf(['data: {not json\n\n'])))).rejects.toBeInstanceOf(WorkspaceApiError);
  });

  it('reconnects with Last-Event-ID and does not repeat a step', async () => {
    const http = recorder((seen, call) => {
      if (call === 0) return sse(events.slice(0, 3));
      expect(seen.headers['last-event-id']).toBe('2');
      return sse(events.slice(1));
    });
    const client = createFetchClient({ baseUrl: 'https://svc.test/', fetch: http.fetch });
    const got = await collect(client.streamRunEvents({ workspaceId: 'marketing', runId: 'run-0001' }));
    expect(got.map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(http.seen).toHaveLength(2);
  });

  it('resumes after a given lastEventId and gives up after maxReconnects', async () => {
    const resumed = recorder(() => sse(events.slice(3)));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: resumed.fetch });
    const tail = await collect(client.streamRunEvents({ workspaceId: 'marketing', runId: 'run-0001', lastEventId: 2 }));
    expect(tail.map((event) => event.id)).toEqual(events.slice(3).map((event) => event.id));
    expect(resumed.seen[0].headers['last-event-id']).toBe('2');

    const dropping = recorder(() => sse([]));
    const stuck = createFetchClient({ baseUrl: 'https://svc.test', fetch: dropping.fetch, maxReconnects: 2 });
    await expect(collect(stuck.streamRunEvents({ workspaceId: 'marketing', runId: 'run-0001' }))).rejects.toBeInstanceOf(WorkspaceApiError);
    expect(dropping.seen).toHaveLength(3);
  });

  it('does not retry a 4xx on the stream', async () => {
    const http = recorder(() => json({ error: 'no such run' }, 404));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch });
    await expect(collect(client.streamRunEvents({ workspaceId: 'marketing', runId: 'nope' }))).rejects.toMatchObject({ status: 404 });
    expect(http.seen).toHaveLength(1);
  });
});

describe('createFetchClient', () => {
  it('sends the method, path, body and headers of the route', async () => {
    const http = recorder(() => json({ revision: 'rev-2', problems: [] }));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch, headers: async () => ({ authorization: 'Bearer t', 'x-user': 'signed' }) });
    const result = await client.call('discardDraft', { params: { id: 'marketing', draftId: 'draft-0001' }, body: { expectedRevision: 'rev-1' } });
    expect(result).toEqual({ revision: 'rev-2', problems: [] });
    expect(http.seen[0]).toMatchObject({
      url: 'https://svc.test/api/workspaces/marketing/drafts/draft-0001',
      method: 'DELETE',
      body: { expectedRevision: 'rev-1' },
      headers: { authorization: 'Bearer t', 'x-user': 'signed', 'content-type': 'application/json' },
    });
  });

  it('a stale write throws with the current revision', async () => {
    const http = recorder(() => json({ error: 'stale', currentRevision: 'rev-9' }, 409));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch });
    const failed = client.call('applyDraft', { params: { id: 'marketing', draftId: 'd' }, body: { expectedRevision: 'rev-1' } });
    await expect(failed).rejects.toMatchObject({ name: 'WorkspaceApiError', status: 409, currentRevision: 'rev-9' });
  });

  it('does not trust an answer that breaks the wire contract', async () => {
    const http = recorder(() => json({ id: 'marketing' }));
    const client = createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch });
    await expect(client.call('getWorkspace', { params: { id: 'marketing' } })).rejects.toMatchObject({ status: 502 });
    const html = recorder(() => new Response('<html>', { status: 200 }));
    await expect(createFetchClient({ baseUrl: 'https://svc.test', fetch: html.fetch }).call('listWorkspaces', {})).rejects.toMatchObject({ status: 502 });
  });

  it('a failed answer without a JSON body still throws', async () => {
    const http = recorder(() => new Response('boom', { status: 500 }));
    await expect(createFetchClient({ baseUrl: 'https://svc.test', fetch: http.fetch }).call('listWorkspaces', {})).rejects.toMatchObject({ status: 500 });
  });
});

describe('fixtureClient', () => {
  const client: ApiClient = fixtureClient();

  it('answers every JSON route with the generated fixture', async () => {
    const workspaces = await client.call('listWorkspaces', {});
    expect(workspaces[0]?.id).toBe('marketing');
    const detail = await client.call('getWorkspace', { params: { id: 'marketing' } });
    expect(detail.pages.map((page) => page.id)).toEqual(detail.manifest.pages);
  });

  it('streams the fixture events after lastEventId', async () => {
    expect((await collect(client.streamRunEvents({ workspaceId: 'marketing', runId: 'run-0001' }))).length).toBe(events.length);
    const later = await collect(client.streamRunEvents({ workspaceId: 'marketing', runId: 'run-0001', lastEventId: 1 }));
    expect(later.map((event) => event.id)).toEqual(events.slice(2).map((event) => event.id));
  });
});
