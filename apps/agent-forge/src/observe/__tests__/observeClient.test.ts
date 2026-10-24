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
});
