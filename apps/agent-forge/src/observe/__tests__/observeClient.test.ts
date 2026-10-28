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
});
