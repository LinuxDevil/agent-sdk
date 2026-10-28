import { describe, it, expect, vi } from 'vitest';
import { ObserveApiError, ObserveClient, ObserveDaemonDownError } from '../observeClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function clientWith(fetchFn: typeof fetch): ObserveClient {
  return new ObserveClient({ baseUrl: '/observe', fetchFn });
}

describe('ObserveClient', () => {
  it('builds the traces URL with filter params, skipping empty ones', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { traces: [], total: 0, limit: 50, offset: 0 }));
    const client = clientWith(fetchFn as typeof fetch);
    await client.listTraces({ agent_id: 'a1', status: 'error', limit: 25, offset: 50, project: '' });
    expect(fetchFn).toHaveBeenCalledWith('/observe/api/v1/traces?agent_id=a1&status=error&limit=25&offset=50', expect.anything());
  });

  it('passes the O12 window, search, model and sort params through', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { traces: [], total: 0, limit: 50, offset: 0 }));
    const client = clientWith(fetchFn as typeof fetch);
    await client.listTraces({ from: 1000, to: 2000, q: 'refund', min_duration_ms: 500, model: 'gpt-4o', sort: 'duration', order: 'asc' });
    expect(fetchFn).toHaveBeenCalledWith(
      '/observe/api/v1/traces?from=1000&to=2000&q=refund&min_duration_ms=500&model=gpt-4o&sort=duration&order=asc',
      expect.anything()
    );
  });

  it('lists sessions with their filter params and reads one session, undefined on 404', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes('/sessions/')
        ? jsonResponse(404, { error: 'No session', code: 'LOUSHO_REQUEST_INVALID' })
        : jsonResponse(200, { sessions: [], total: 0, limit: 50, offset: 0 })
    );
    const client = clientWith(fetchFn as unknown as typeof fetch);
    await client.listSessions({ agent_id: 'a1', status: 'active', from: 1, to: 2, limit: 50, offset: 0 });
    expect(fetchFn).toHaveBeenCalledWith('/observe/api/v1/sessions?agent_id=a1&status=active&from=1&to=2&limit=50&offset=0', expect.anything());
    expect(await client.session('s/1')).toBeUndefined();
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/sessions/s%2F1', expect.anything());
  });

  it('maps a proxy 502 and a network failure to ObserveDaemonDownError', async () => {
    const via502 = clientWith((async () => jsonResponse(502, { error: 'unreachable' })) as typeof fetch);
    await expect(via502.listTraces()).rejects.toBeInstanceOf(ObserveDaemonDownError);
    const viaRefused = clientWith((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(viaRefused.listTraces()).rejects.toBeInstanceOf(ObserveDaemonDownError);
  });

  it('maps a daemon {error, code} body to ObserveApiError with its message', async () => {
    const client = clientWith((async () => jsonResponse(400, { error: 'bad filter', code: 'LOUSHO_REQUEST_INVALID' })) as typeof fetch);
    await expect(client.listTraces()).rejects.toMatchObject({ name: 'ObserveApiError', status: 400, message: 'bad filter' });
    await expect(client.listTraces()).rejects.toBeInstanceOf(ObserveApiError);
  });

  it('health() answers the health body only for a real lousho-observe marker', async () => {
    const real = clientWith((async () => jsonResponse(200, { service: 'lousho-observe', ok: true, version: '1' })) as typeof fetch);
    expect(await real.health()).toMatchObject({ service: 'lousho-observe' });
    const squatter = clientWith((async () => jsonResponse(200, { service: 'something-else', ok: true })) as typeof fetch);
    expect(await squatter.health()).toBeUndefined();
    const down = clientWith((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect(await down.health()).toBeUndefined();
  });

  it('traceDetail returns undefined on the daemon\'s 404 instead of throwing', async () => {
    const client = clientWith((async () => jsonResponse(404, { error: "No trace 'x'.", code: 'LOUSHO_REQUEST_INVALID' })) as typeof fetch);
    expect(await client.traceDetail('x')).toBeUndefined();
  });

  it('sends the studio token only on the same-origin proxy base', async () => {
    window.sessionStorage.setItem('lousho-studio-token', 'tok-123');
    try {
      const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
        void init;
        return jsonResponse(200, { agents: [] });
      });
      const sameOrigin = new ObserveClient({ baseUrl: '/observe', fetchFn: fetchFn as typeof fetch });
      await sameOrigin.listAgents();
      const headers = new Headers((fetchFn.mock.calls[0][1] as RequestInit).headers);
      expect(headers.get('x-lousho-studio-token')).toBe('tok-123');

      const remote = new ObserveClient({ baseUrl: 'https://collector.example', fetchFn: fetchFn as typeof fetch });
      await remote.listAgents();
      const remoteHeaders = new Headers((fetchFn.mock.calls[1][1] as RequestInit).headers);
      expect(remoteHeaders.get('x-lousho-studio-token')).toBeNull();
    } finally {
      window.sessionStorage.removeItem('lousho-studio-token');
    }
  });

  it('postScore POSTs the JSON body to /api/v1/scores and returns the score id', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      void init;
      return jsonResponse(201, { score_id: 'sc1' });
    });
    const client = clientWith(fetchFn as typeof fetch);
    const body = { trace_id: 't1', obs_id: 'o1', name: 'feedback', value: 1, comment: 'nice' };
    expect(await client.postScore(body)).toEqual({ score_id: 'sc1' });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/observe/api/v1/scores');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('postScore keeps the error semantics: 404 is an ObserveApiError, 502 is daemon down', async () => {
    const notFound = clientWith((async () => jsonResponse(404, { error: "No trace 'x'." })) as typeof fetch);
    await expect(notFound.postScore({ trace_id: 'x', name: 'feedback', value: 0 })).rejects.toBeInstanceOf(ObserveApiError);
    const down = clientWith((async () => jsonResponse(502, {})) as typeof fetch);
    await expect(down.postScore({ trace_id: 'x', name: 'feedback', value: 0 })).rejects.toBeInstanceOf(ObserveDaemonDownError);
  });

  it('scorePassRates asks for the eval aggregate with the score filters', async () => {
    const evals = [{ name: 'support', count: 2, passed: 1, pass_rate: 0.5, avg_value: 0.5, last_ts: 1 }];
    const fetchFn = vi.fn(async () => jsonResponse(200, { evals }));
    const client = clientWith(fetchFn as typeof fetch);
    expect(await client.scorePassRates({ agent_id: 'a1', source: 'eval', since: 10, until: 20 })).toEqual(evals);
    expect(fetchFn).toHaveBeenCalledWith(
      '/observe/api/v1/scores?agent_id=a1&source=eval&since=10&until=20&aggregate=eval',
      expect.anything()
    );
  });

  it('passes the prompt trace filter through', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { traces: [], total: 0, limit: 50, offset: 0 }));
    await clientWith(fetchFn as typeof fetch).listTraces({ prompt: 'mira@2' });
    expect(fetchFn).toHaveBeenCalledWith('/observe/api/v1/traces?prompt=mira%402', expect.anything());
  });

  it('lists prompts and reads one prompt history, undefined on 404', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith('/prompts')
        ? jsonResponse(200, { prompts: [{ name: 'mira', version: 2, labels: ['prod'], versions: 2, uses: 3 }] })
        : jsonResponse(404, { error: "No prompt 'x'.", code: 'LOUSHO_REQUEST_INVALID' })
    );
    const client = clientWith(fetchFn as unknown as typeof fetch);
    expect((await client.listPrompts())[0]).toMatchObject({ name: 'mira', uses: 3 });
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/prompts', expect.anything());
    expect(await client.promptVersions('x y')).toBeUndefined();
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/prompts/x%20y', expect.anything());
  });

  it('movePromptLabel PUTs {version} as JSON with the studio token and returns the move', async () => {
    window.sessionStorage.setItem('lousho-studio-token', 'tok-123');
    try {
      const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
        void init;
        return jsonResponse(200, { name: 'mira', label: 'prod', version: 2, previous_version: 1 });
      });
      const moved = await clientWith(fetchFn as typeof fetch).movePromptLabel('mira', 'prod', 2);
      expect(moved).toEqual({ name: 'mira', label: 'prod', version: 2, previous_version: 1 });
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/observe/api/v1/prompts/mira/labels/prod');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(String(init.body))).toEqual({ version: 2 });
      const headers = new Headers(init.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-lousho-studio-token')).toBe('tok-123');
    } finally {
      window.sessionStorage.removeItem('lousho-studio-token');
    }
  });

  it('maps write failures like reads: 502 is daemon-down, other errors carry the daemon message', async () => {
    const down = clientWith((async () => jsonResponse(502, { error: 'unreachable' })) as typeof fetch);
    await expect(down.movePromptLabel('mira', 'prod', 2)).rejects.toBeInstanceOf(ObserveDaemonDownError);
    const missing = clientWith((async () => jsonResponse(404, { error: "No prompt 'mira@9'." })) as typeof fetch);
    await expect(missing.movePromptLabel('mira', 'prod', 9)).rejects.toMatchObject({ status: 404, message: "No prompt 'mira@9'." });
  });
  it('listHubEntries sends agent_id plus the optional namespace/scope/limit and returns the entries', async () => {
    const entry = { entry_id: 'e1', namespace: 'docs', agent_id: 'a1', key: 'k', value: '1', scope: 'fleet', created_at: 1, ttl: null, expires_at: null };
    const fetchFn = vi.fn(async () => jsonResponse(200, { entries: [entry] }));
    const client = clientWith(fetchFn as typeof fetch);
    expect(await client.listHubEntries({ agent_id: 'a1', namespace: 'docs', scope: 'fleet', limit: 1000 })).toEqual([entry]);
    expect(fetchFn).toHaveBeenCalledWith('/observe/api/v1/hub?agent_id=a1&namespace=docs&scope=fleet&limit=1000', expect.anything());
    await client.listHubEntries({ agent_id: 'a1' });
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/hub?agent_id=a1', expect.anything());
  });

  it('publishHubEntry POSTs the entry as JSON to /api/v1/hub', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      void init;
      return jsonResponse(200, { entry: undefined, created: false });
    });
    const body = { agent_id: 'a1', namespace: 'docs', key: 'k', value: { a: 1 }, scope: 'fleet' as const, ttl: 60_000 };
    expect(await clientWith(fetchFn as typeof fetch).publishHubEntry(body)).toMatchObject({ created: false });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/observe/api/v1/hub');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
  it('reads datasets: the paged list, one dataset with its examples page, undefined on 404', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes('/datasets/nope')
        ? jsonResponse(404, { error: "No dataset 'nope'.", code: 'LOUSHO_REQUEST_INVALID' })
        : jsonResponse(200, { datasets: [], total: 0, limit: 50, offset: 0 })
    );
    const client = clientWith(fetchFn as unknown as typeof fetch);
    await client.listDatasets({ limit: 50, offset: 100 });
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/datasets?limit=50&offset=100', expect.anything());
    await client.dataset('golden.v1', { limit: 50, offset: 0 });
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/datasets/golden.v1?limit=50&offset=0', expect.anything());
    expect(await client.dataset('nope')).toBeUndefined();
  });

  it('writes datasets: create and add-example POST JSON, delete-example sends a bodiless DELETE and takes the 204', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse(201, { dataset: {}, example: {} })
    );
    const client = clientWith(fetchFn as unknown as typeof fetch);
    await client.createDataset({ name: 'golden' });
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/datasets', expect.objectContaining({ method: 'POST', body: '{"name":"golden"}' }));
    await client.addExample('golden', { from_trace_id: 't1' });
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/observe/api/v1/datasets/golden/examples',
      expect.objectContaining({ method: 'POST', body: '{"from_trace_id":"t1"}' })
    );
    await expect(client.deleteExample('golden', 'e/1')).resolves.toBeUndefined();
    const [url, init] = fetchFn.mock.calls.at(-1)!;
    expect(url).toBe('/observe/api/v1/datasets/golden/examples/e%2F1');
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
  });
  it('reads queues: the paged list, one queue (undefined on 404), the next item (undefined on 204)', async () => {
    const queue = { queue_id: 'q 1', name: 'review', rubric: [], created_at: 1, counts: { pending: 1, done: 0, skipped: 0 } };
    const item = { item_id: 'i1', queue_id: 'q 1', trace_id: 't1', status: 'pending', reviewer: null, created_at: 1, done_at: null };
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/queues/nope')) return jsonResponse(404, { error: 'No queue.', code: 'LOUSHO_REQUEST_INVALID' });
      if (url.includes('/queues/empty/next')) return new Response(null, { status: 204 });
      if (url.endsWith('/next')) return jsonResponse(200, { item });
      if (url.includes('/queues/q%201')) return jsonResponse(200, { queue });
      return jsonResponse(200, { queues: [queue], total: 1, limit: 50, offset: 0 });
    });
    const client = clientWith(fetchFn as unknown as typeof fetch);
    await client.listQueues({ limit: 50, offset: 50 });
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/queues?limit=50&offset=50', expect.anything());
    expect(await client.queue('q 1')).toEqual(queue);
    expect(await client.queue('nope')).toBeUndefined();
    expect(await client.nextQueueItem('q 1')).toEqual(item);
    expect(fetchFn).toHaveBeenLastCalledWith('/observe/api/v1/queues/q%201/next', expect.anything());
    expect(await client.nextQueueItem('empty')).toBeUndefined();
  });

  it('writes queues: create, add items and complete POST JSON to their paths', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, { queue: { queue_id: 'q1' }, item: {}, score_ids: [] }));
    const client = clientWith(fetchFn as unknown as typeof fetch);
    await client.createQueue({ name: 'review', rubric: [{ name: 'helpful', min: 0, max: 5 }] });
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/observe/api/v1/queues',
      expect.objectContaining({ method: 'POST', body: '{"name":"review","rubric":[{"name":"helpful","min":0,"max":5}]}' })
    );
    const addFetch = vi.fn(async () => jsonResponse(201, { added: [], skipped_existing: ['t1'] }));
    expect(await clientWith(addFetch as unknown as typeof fetch).addQueueItems('q1', ['t1'])).toEqual({ added: [], skipped_existing: ['t1'] });
    await client.addQueueItems('q1', ['t1']);
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/observe/api/v1/queues/q1/items',
      expect.objectContaining({ method: 'POST', body: '{"trace_ids":["t1"]}' })
    );
    await client.completeQueueItem('q1', 'i/1', { scores: [], status: 'skipped' });
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/observe/api/v1/queues/q1/items/i%2F1/complete',
      expect.objectContaining({ method: 'POST', body: '{"scores":[],"status":"skipped"}' })
    );
  });
});
