/**
 * N9c test helpers: one `node:http` server that is both an OAuth 2.1
 * authorization server (RFC 8414 metadata, RFC 7591 registration, a token
 * endpoint that checks PKCE, the client, the redirect URI and the resource
 * indicator, and refreshes) and an MCP protected resource (RFC 9728
 * metadata). `/mcp` accepts only the access tokens it issued and forwards to
 * our own `serveMcp` HTTP transport on a second port, protected with a bearer
 * token of its own. `/authorize` is never fetched: `authorize(url)` plays
 * the operator's consent and returns the callback's `code` and `state`.
 */
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../../../createAgent';
import { mockModel } from '../../../testing';
import { serveMcp } from '../server/serveMcp';

export interface FakeRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface IssuedCode {
  clientId: string;
  challenge: string;
  redirectUri: string;
  resource: string | null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export const PRE_REGISTERED = { clientId: 'pre-client', clientSecret: 'pre-secret-SECRET-xyz' };

/** Starts the fake. `close()` stops it and the `serveMcp` behind it. */
export async function fakeMcpOAuthServer(options: { accessTtlSec?: number } = {}) {
  const internalToken = 'internal-mcp-bearer';
  const mcp = await serveMcp({
    agent: createAgent({ prompt: 'p', provider: mockModel(['pong'], { onExhausted: 'repeat-last' }) }),
    name: 'support',
    transport: { type: 'http', port: 0, auth: { type: 'bearer', token: internalToken } },
    warn: () => undefined,
  });
  const clients = new Map<string, { redirectUris: string[]; secret?: string }>([
    [PRE_REGISTERED.clientId, { redirectUris: ['https://agent.example.com/oauth/callback'], secret: PRE_REGISTERED.clientSecret }],
  ]);
  const codes = new Map<string, IssuedCode>();
  const access = new Map<string, { expiresAt: number; revoked: boolean }>();
  const refresh = new Map<string, { clientId: string; revoked: boolean }>();
  const state = {
    requests: [] as FakeRequest[],
    /** Every secret this server handed out or was sent (access/refresh tokens, codes, verifiers). */
    secrets: new Set<string>(),
    registrations: 0,
    issued: 0,
  };
  let base = '';

  const tokenEndpoint = (form: URLSearchParams, res: http.ServerResponse) => {
    const clientId = form.get('client_id') ?? '';
    const client = clients.get(clientId);
    if (!client || (client.secret !== undefined && form.get('client_secret') !== client.secret)) return send(res, 401, { error: 'invalid_client' });
    const issue = () => {
      state.issued++;
      const accessToken = `mcp_at_SECRET_${state.issued}`;
      access.set(accessToken, { expiresAt: Date.now() + (options.accessTtlSec ?? 3600) * 1000, revoked: false });
      state.secrets.add(accessToken);
      return accessToken;
    };
    if (form.get('grant_type') === 'authorization_code') {
      const code = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      state.secrets.add(verifier);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!code || code.clientId !== clientId || code.challenge !== challenge || code.redirectUri !== form.get('redirect_uri') || code.resource !== form.get('resource')) {
        return send(res, 400, { error: 'invalid_grant' });
      }
      state.issued++;
      const refreshToken = `mcp_rt_SECRET_${state.issued}`;
      refresh.set(refreshToken, { clientId, revoked: false });
      state.secrets.add(refreshToken);
      return send(res, 200, { access_token: issue(), refresh_token: refreshToken, token_type: 'Bearer', expires_in: options.accessTtlSec ?? 3600 });
    }
    if (form.get('grant_type') === 'refresh_token') {
      const grant = refresh.get(form.get('refresh_token') ?? '');
      if (!grant || grant.revoked || grant.clientId !== clientId || form.get('resource') !== `${base}/mcp`) return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, { access_token: issue(), token_type: 'Bearer', expires_in: options.accessTtlSec ?? 3600 });
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  };

  const forward = async (req: http.IncomingMessage, body: string, res: http.ServerResponse) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const grant = access.get(bearer);
    if (!grant || grant.revoked || grant.expiresAt <= Date.now()) {
      return send(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    }
    const headers: Record<string, string> = { authorization: `Bearer ${internalToken}` };
    for (const name of ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const answer = await fetch(mcp.url ?? '', { method: req.method, headers, ...(req.method === 'POST' && { body }) });
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
    res.end(await answer.text());
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      state.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
      if (path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource') {
        return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (path === '/.well-known/oauth-authorization-server') {
        return send(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        });
      }
      if (path === '/register' && req.method === 'POST') {
        const metadata = JSON.parse(body) as { redirect_uris: string[] };
        state.registrations++;
        const clientId = `dyn-client-${state.registrations}`;
        clients.set(clientId, { redirectUris: metadata.redirect_uris });
        return send(res, 201, { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (path === '/token' && req.method === 'POST') return tokenEndpoint(new URLSearchParams(body), res);
      if (path === '/mcp') return forward(req, body, res);
      return send(res, 404, { error: 'not_found' });
    })().catch((error: unknown) => send(res, 500, { error: 'server_error', detail: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return Object.assign(state, {
    base,
    url: `${base}/mcp`,
    /** The operator consents: checks the authorization request and returns what the callback gets. */
    authorize(authorizationUrl: string): { code: string; state: string } {
      const url = new URL(authorizationUrl);
      const params = url.searchParams;
      const client = clients.get(params.get('client_id') ?? '');
      if (url.href.split('?')[0] !== `${base}/authorize`) throw new Error(`unexpected authorization endpoint ${url.origin}${url.pathname}`);
      if (!client || !client.redirectUris.includes(params.get('redirect_uri') ?? '')) throw new Error('unknown client or redirect_uri');
      if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) throw new Error('no PKCE');
      const code = `mcp_code_SECRET_${codes.size + state.issued + 1}`;
      codes.set(code, { clientId: params.get('client_id') ?? '', challenge: params.get('code_challenge') ?? '', redirectUri: params.get('redirect_uri') ?? '', resource: params.get('resource') });
      state.secrets.add(code);
      return { code, state: params.get('state') ?? '' };
    },
    /** Every access token expires now (the refresh tokens still work). */
    expireAll() {
      for (const grant of access.values()) grant.expiresAt = 0;
    },
    /** The grant is revoked: access and refresh tokens alike. */
    revokeAll() {
      for (const grant of access.values()) grant.revoked = true;
      for (const grant of refresh.values()) grant.revoked = true;
    },
    /** Requests to `path` (e.g. `/token`), as forms. */
    forms(path: string): URLSearchParams[] {
      return state.requests.filter((request) => request.path === path).map((request) => new URLSearchParams(request.body));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mcp.close();
    },
  });
}

export type FakeMcpOAuthServer = Awaited<ReturnType<typeof fakeMcpOAuthServer>>;
