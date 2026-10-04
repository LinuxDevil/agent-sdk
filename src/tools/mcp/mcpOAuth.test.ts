/**
 * N9c: OAuth for HTTP MCP servers against a local fake (authorization server
 * plus protected MCP resource, see `__fixtures__/fakeMcpOAuth.ts`): not signed
 * in is `needs-auth`, the operator's sign-in link carries PKCE, `state`,
 * `resource`, the registered client and the redirect URI, the callback stores
 * the token encrypted, an expired token is refreshed, a revoked one turns the
 * call into `LOUSHO_MCP_AUTH_REQUIRED`, a pre-registered client skips
 * registration, a token never follows a changed `url`, and no secret reaches
 * an error, a log line, `status()`, an event or a result.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import { memoryStore } from '../../storage/agentStore';
import { SqliteStore } from '../../storage/sqlite';
import { loadDatabaseSync } from '../../storage/sqlite/driver';
import { generateTokenKey } from '../../oauth/tokenCipher';
import { createRouteHandler } from '../../server/routeHandler';
import type { AgentEvent } from '../../execution/agentEvents';
import type { ExecutionResult } from '../../execution/AgentExecutor';
import type { Logger } from '../../execution/logger';
import type { OAuthTokenStore } from '../../oauth/types';
import type { McpHttpServerSpec } from '../../spec/schema';
import { connectMcp, type McpConnections } from './connect';
import { mcpFetch } from './mcpOAuth';
import { fakeMcpOAuthServer, PRE_REGISTERED, type FakeMcpOAuthServer } from './__fixtures__/fakeMcpOAuth';

const REDIRECT = 'https://agent.example.com/oauth/callback';
const CALL = { toolCalls: [{ name: 'linear__support', id: 'call_1', args: { message: 'ping' } }] };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fake(options?: Parameters<typeof fakeMcpOAuthServer>[0]): Promise<FakeMcpOAuthServer> {
  const server = await fakeMcpOAuthServer(options);
  cleanups.push(() => server.close());
  return server;
}

function entry(server: FakeMcpOAuthServer, oauth: Partial<NonNullable<McpHttpServerSpec['oauth']>> = {}, extra: Partial<McpHttpServerSpec> = {}): McpHttpServerSpec {
  return { url: server.url, approval: 'never', oauth: { redirectUri: REDIRECT, ...oauth }, ...extra };
}

async function connect(...args: Parameters<typeof connectMcp>): Promise<McpConnections> {
  const connections = await connectMcp(...args);
  cleanups.push(() => connections.close());
  return connections;
}

function captureLogger(lines: string[]): Logger {
  const log = (message: string, meta?: unknown) => {
    lines.push(`${message} ${JSON.stringify(meta ?? {})}`);
  };
  return { debug: log, info: log, warn: log, error: log };
}

function toolMessage(result: ExecutionResult): string {
  return String(result.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_1')?.content);
}

/** Signs the app in to `linear` the way an operator does: open the link, consent, the callback completes. */
async function signIn(agent: ReturnType<typeof createAgent>, server: FakeMcpOAuthServer): Promise<URL> {
  const url = new URL(await agent.oauth.mcpSignInUrl('linear'));
  const { code, state } = server.authorize(url.href);
  expect(await agent.oauth.complete({ state, code })).toEqual({ outcome: 'signed-in', provider: 'mcp-linear', displayName: 'linear' });
  return url;
}

function rawOAuthRows(file: string): string {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(file);
  try {
    return JSON.stringify([...db.prepare('SELECT * FROM oauth_tokens').all(), ...db.prepare('SELECT * FROM oauth_pending').all()]);
  } finally {
    db.close();
  }
}

describe('MCP servers with OAuth (N9c)', () => {
  it('not signed in: connect fails with LOUSHO_MCP_AUTH_REQUIRED and status needs-auth, without registering or starting a sign-in', async () => {
    const server = await fake();
    const tokens = memoryStore().tokens;
    const putPending = vi.spyOn(tokens, 'putPending');
    await expect(connectMcp({ linear: entry(server) }, { tokens })).rejects.toMatchObject({
      code: 'LOUSHO_MCP_AUTH_REQUIRED',
      message: expect.stringContaining("agent.oauth.mcpSignInUrl('linear')") as unknown,
    });

    const lines: string[] = [];
    const mcp = await connect({ linear: entry(server) }, { tokens, onError: 'skip', logger: captureLogger(lines) });
    expect(mcp.status()).toEqual({ linear: 'needs-auth' });
    expect(mcp.tools).toEqual({});
    expect(lines.join('\n')).toContain("skipping MCP server 'linear'");
    expect(server.registrations).toBe(0);
    expect(putPending).not.toHaveBeenCalled();
    expect(server.requests.some((request) => request.path === '/token')).toBe(false);
  });

  it('operator sign-in: the link has PKCE, state, resource, the registered client and redirect_uri; the callback stores the token encrypted; tools then work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-mcp-oauth-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'agent.db');
    const store = new SqliteStore(file, { tokenKey: generateTokenKey() });
    cleanups.push(() => store.connection.close());
    const server = await fake();
    const agent = createAgent({ provider: mockModel([CALL, { text: 'Done.' }]), mcpServers: { linear: entry(server) }, store });
    cleanups.push(() => agent.close());

    await expect(agent.ready()).rejects.toMatchObject({ code: 'LOUSHO_MCP_AUTH_REQUIRED' });

    const url = new URL(await agent.oauth.mcpSignInUrl('linear'));
    const params = url.searchParams;
    expect(`${url.origin}${url.pathname}`).toBe(`${server.base}/authorize`);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('resource')).toBe(server.url);
    expect(params.get('client_id')).toBe('dyn-client-1');
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(server.registrations).toBe(1);
    expect(JSON.parse(server.requests.find((request) => request.path === '/register')?.body ?? '{}')).toMatchObject({
      client_name: 'lousho',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

    const { code, state } = server.authorize(url.href);
    expect(await agent.oauth.complete({ state, code })).toEqual({ outcome: 'signed-in', provider: 'mcp-linear', displayName: 'linear' });
    // the state works once
    await expect(agent.oauth.complete({ state, code })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
    const [exchange] = server.forms('/token');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('resource')).toBe(server.url);

    const stored = await store.tokens.get('mcp-linear', { owner: 'app' });
    expect(stored?.accessToken).toBe('mcp_at_SECRET_2');
    const raw = rawOAuthRows(file);
    expect(raw).toContain('v1.');
    for (const secret of [stored?.accessToken ?? '?', stored?.refreshToken ?? '?', 'dyn-client-1']) expect(raw).not.toContain(secret);

    await agent.ready();
    const result = await agent.send('Ask support.');
    expect(result.finishReason).toBe('stop');
    expect(toolMessage(result)).toContain('pong');
    const mcpCalls = server.requests.filter((request) => request.path === '/mcp' && request.headers.authorization === 'Bearer mcp_at_SECRET_2');
    expect(mcpCalls.length).toBeGreaterThan(1);
  });

  it('N2: a deferLoading server that needs a sign-in fails the run like any server; once signed in, its tools load through tool_search', async () => {
    const server = await fake();
    const search = { toolCalls: [{ name: 'tool_search', id: 'call_search', args: { query: 'support' } }] };
    const model = mockModel([search, CALL, { text: 'Done.' }]);
    const agent = createAgent({ provider: model, mcpServers: { linear: entry(server, {}, { deferLoading: true }) }, store: memoryStore(), toolSearch: { thresholdPercent: 0 } });
    cleanups.push(() => agent.close());
    await expect(agent.send('Ask support.')).rejects.toMatchObject({ code: 'LOUSHO_MCP_AUTH_REQUIRED' });
    expect(model.calls).toHaveLength(0);

    await signIn(agent, server);
    const result = await agent.send('Ask support.');
    expect(model.calls[0].tools?.map((tool) => tool.function.name)).toEqual(['tool_search']);
    // Every deferred tool is loaded, so tool_search is no longer offered.
    expect(model.calls[1].tools?.map((tool) => tool.function.name)).toEqual(['linear__support']);
    expect(toolMessage(result)).toContain('pong');
  });

  it('the callback route finishes an MCP sign-in', async () => {
    const server = await fake();
    const agent = createAgent({ provider: mockModel([{ text: 'hi' }]), mcpServers: { linear: entry(server) }, store: memoryStore() });
    cleanups.push(() => agent.close());
    const { code, state } = server.authorize(await agent.oauth.mcpSignInUrl('linear'));
    const { handler } = createRouteHandler(agent, { basePath: '/api/agent' });
    const response = await handler(new Request(`https://agent.example.com/api/agent/oauth/callback?state=${state}&code=${code}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Signed in to linear.');
    await expect(agent.ready()).resolves.toBeUndefined();
  });

  it('an expired access token is refreshed without the operator; a revoked grant is a LOUSHO_MCP_AUTH_REQUIRED tool error and needs-auth', async () => {
    const server = await fake();
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel([CALL, { text: 'a' }, CALL, { text: 'b' }]), mcpServers: { linear: entry(server) }, store });
    cleanups.push(() => agent.close());
    await signIn(agent, server);
    const mcp = await connect({ linear: entry(server) }, { tokens: store.tokens });
    expect(mcp.status()).toEqual({ linear: 'connected' });

    server.expireAll();
    await expect(mcp.tools.linear__support.tool.execute!({ message: 'x' }, { toolCallId: 'c', messages: [] })).resolves.toMatchObject({ text: 'pong' });
    expect(server.forms('/token').map((form) => form.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    expect((await store.tokens.get('mcp-linear', { owner: 'app' }))?.accessToken).toBe('mcp_at_SECRET_3');
    expect(mcp.status()).toEqual({ linear: 'connected' });

    // the agent's own connection refreshes too
    expect(toolMessage(await agent.send('one'))).toContain('pong');

    server.revokeAll();
    await expect(mcp.tools.linear__support.tool.execute!({ message: 'x' }, { toolCallId: 'c', messages: [] })).rejects.toMatchObject({ code: 'LOUSHO_MCP_AUTH_REQUIRED' });
    expect(mcp.status()).toEqual({ linear: 'needs-auth' });
    expect(await store.tokens.get('mcp-linear', { owner: 'app' })).toBeUndefined();

    const refused = await agent.send('two');
    expect(refused.finishReason).toBe('stop');
    expect(toolMessage(refused)).toContain('LOUSHO_MCP_AUTH_REQUIRED');

    // signing in again is enough: the next call reconnects with the new token
    await signIn(agent, server);
    await expect(mcp.tools.linear__support.tool.execute!({ message: 'x' }, { toolCallId: 'c', messages: [] })).resolves.toMatchObject({ text: 'pong' });
    expect(mcp.status()).toEqual({ linear: 'connected' });
  });

  it('a pre-registered clientId skips registration and authenticates at the token endpoint', async () => {
    const server = await fake();
    const agent = createAgent({
      provider: mockModel([{ text: 'hi' }]),
      mcpServers: { linear: entry(server, { clientId: PRE_REGISTERED.clientId, clientSecret: PRE_REGISTERED.clientSecret, scopes: ['read'] }) },
      store: memoryStore(),
    });
    cleanups.push(() => agent.close());
    const url = await signIn(agent, server);
    expect(url.searchParams.get('client_id')).toBe(PRE_REGISTERED.clientId);
    expect(url.searchParams.get('scope')).toBe('read');
    expect(server.registrations).toBe(0);
    expect(server.forms('/token')[0].get('client_secret')).toBe(PRE_REGISTERED.clientSecret);
    await expect(agent.ready()).resolves.toBeUndefined();
  });

  it('a token is never sent to another url: after the entry changes, the server needs a new sign-in', async () => {
    const first = await fake();
    const second = await fake();
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel([{ text: 'hi' }]), mcpServers: { linear: entry(first) }, store });
    cleanups.push(() => agent.close());
    await signIn(agent, first);
    const token = (await store.tokens.get('mcp-linear', { owner: 'app' }))?.accessToken ?? '?';

    const moved = createAgent({ provider: mockModel([{ text: 'hi' }]), mcpServers: { linear: entry(second) }, store });
    cleanups.push(() => moved.close());
    await expect(moved.ready()).rejects.toMatchObject({ code: 'LOUSHO_MCP_AUTH_REQUIRED' });
    expect(JSON.stringify(second.requests)).not.toContain(token);
    expect(second.forms('/token')).toEqual([]);

    // a link made for the old url does not complete for the new one
    const stale = first.authorize(await agent.oauth.mcpSignInUrl('linear'));
    await expect(moved.oauth.complete(stale)).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
  });

  it('headers work alongside oauth, and go only to the MCP server origin', async () => {
    const server = await fake();
    const agent = createAgent({
      provider: mockModel([{ text: 'hi' }]),
      mcpServers: { linear: entry(server, {}, { headers: { 'X-Api-Key': 'k-123' } }) },
      store: memoryStore(),
    });
    cleanups.push(() => agent.close());
    await signIn(agent, server);
    await agent.ready();
    const mcpCalls = server.requests.filter((request) => request.path === '/mcp' && request.headers.authorization?.startsWith('Bearer mcp_at_'));
    expect(mcpCalls.length).toBeGreaterThan(0);
    expect(mcpCalls.every((request) => request.headers['x-api-key'] === 'k-123')).toBe(true);

    const seen: Headers[] = [];
    vi.stubGlobal('fetch', (_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response('{}'));
    });
    const doFetch = mcpFetch({ url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': 'k-123' } });
    await doFetch('https://mcp.example.com/mcp', { headers: { accept: 'application/json' } });
    await doFetch(new URL('https://auth.example.com/token'), { headers: { accept: 'application/json' } });
    expect(seen.map((headers) => headers.get('x-api-key'))).toEqual(['k-123', null]);
  });

  it('refuses oauth on plain http (except loopback), an Authorization header with oauth, and oauth without a token store', async () => {
    const http = { url: 'http://example.com/mcp', oauth: { redirectUri: REDIRECT } };
    expect(() => createAgent({ provider: mockModel([]), mcpServers: { x: http }, store: memoryStore() })).toThrow(/needs an https url/);
    await expect(connectMcp({ x: http }, { tokens: memoryStore().tokens })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    const withAuth = { url: 'https://example.com/mcp', headers: { authorization: 'Bearer x' }, oauth: { redirectUri: REDIRECT } };
    expect(() => createAgent({ provider: mockModel([]), mcpServers: { x: withAuth }, store: memoryStore() })).toThrow(/remove the Authorization header/);
    await expect(connectMcp({ x: { url: 'https://example.com/mcp', oauth: { redirectUri: REDIRECT } } })).rejects.toMatchObject({
      code: 'LOUSHO_OAUTH_STORE_MISSING',
    });
    const noStore = createAgent({ provider: mockModel([]), mcpServers: { x: { url: 'https://example.com/mcp', oauth: { redirectUri: REDIRECT } } } });
    await expect(noStore.oauth.mcpSignInUrl('x')).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STORE_MISSING' });
    await expect(noStore.oauth.mcpSignInUrl('nope')).rejects.toThrow(/no HTTP MCP server named 'nope'/);
    await expect(createAgent({ provider: mockModel([]) }).oauth.mcpSignInUrl('x')).rejects.toThrow(/no HTTP MCP server with `oauth`/);
    // loopback http is fine (the fake above is http://127.0.0.1)
    expect(() => createAgent({ mcpServers: { x: { url: 'http://localhost:3000/mcp', oauth: { redirectUri: REDIRECT } } }, provider: mockModel([]) })).not.toThrow();
  });

  it('no token, code, verifier or client secret in errors, log lines, status(), events or results', async () => {
    const server = await fake();
    const store = memoryStore();
    const events: AgentEvent[] = [];
    const lines: string[] = [];
    const consoleLines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '));
      });
    }
    const agent = createAgent({
      provider: mockModel([CALL, { text: 'a' }, CALL, { text: 'b' }, CALL, { text: 'c' }]),
      mcpServers: { linear: entry(server, { clientId: PRE_REGISTERED.clientId, clientSecret: PRE_REGISTERED.clientSecret }) },
      store,
      onEvent: (event) => events.push(event),
    });
    cleanups.push(() => agent.close());
    const errors: string[] = [];
    const record = (error: unknown) => {
      errors.push(error instanceof Error ? `${error.name} ${error.message} ${JSON.stringify(error)}` : String(error));
    };

    await agent.ready().catch(record);
    await signIn(agent, server);
    const results = [await agent.send('one')];
    server.expireAll();
    results.push(await agent.send('two'));
    const mcp = await connect({ linear: entry(server, { clientId: PRE_REGISTERED.clientId, clientSecret: PRE_REGISTERED.clientSecret }) }, {
      tokens: store.tokens,
      logger: captureLogger(lines),
    });
    const statuses = [JSON.stringify(mcp.status())];
    server.revokeAll();
    results.push(await agent.send('three'));
    // ai's Tool.execute returns PromiseLike (no .catch); wrap it in a real Promise.
    await Promise.resolve(mcp.tools.linear__support.tool.execute!({ message: 'x' }, { toolCallId: 'c', messages: [] })).catch(record);
    statuses.push(JSON.stringify(mcp.status()));
    await connectMcp({ linear: entry(server) }, { tokens: store.tokens }).catch(record);
    await connect({ linear: entry(server) }, { tokens: store.tokens, onError: 'skip', logger: captureLogger(lines) });
    // a refused exchange
    const bad = server.authorize(await agent.oauth.mcpSignInUrl('linear'));
    await agent.oauth.complete({ state: bad.state, code: `${bad.code}-wrong` }).catch(record);

    expect(errors.length).toBe(4);
    expect(errors.join('\n')).toContain('LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED');
    expect(errors.join('\n')).toContain("answered 'invalid_grant'");
    expect(statuses).toEqual(['{"linear":"connected"}', '{"linear":"needs-auth"}']);
    expect(toolMessage(results[2])).toContain('LOUSHO_MCP_AUTH_REQUIRED');

    const secrets = [...server.secrets, PRE_REGISTERED.clientSecret];
    expect(secrets.filter((secret) => secret.startsWith('mcp_at_')).length).toBeGreaterThanOrEqual(2); // signed in, then refreshed
    expect(toolMessage(results[1])).toContain('pong');
    expect(secrets.some((secret) => secret.startsWith('mcp_rt_'))).toBe(true);
    expect(secrets.some((secret) => secret.startsWith('mcp_code_'))).toBe(true);
    expect(secrets.some((secret) => /^[A-Za-z0-9._~-]{43,128}$/.test(secret))).toBe(true); // a PKCE verifier
    const outputs: Record<string, string> = {
      errors: errors.join('\n'),
      logs: lines.join('\n'),
      console: consoleLines.join('\n'),
      status: statuses.join('\n'),
      events: JSON.stringify(events),
      results: JSON.stringify(results),
    };
    for (const [where, text] of Object.entries(outputs)) {
      if (where !== 'console') expect(text.length, `${where} is empty, so the scan proves nothing`).toBeGreaterThan(2);
      for (const secret of secrets) expect(text, `a secret in ${where}`).not.toContain(secret);
    }
    expect(outputs.events).toContain('LOUSHO_MCP_AUTH_REQUIRED');
  });
});

describe('the token store contract the MCP provider relies on', () => {
  it('keeps the grant per server name, bound to its url', async () => {
    const server = await fake();
    const tokens: OAuthTokenStore = memoryStore().tokens;
    const agent = createAgent({ provider: mockModel([{ text: 'hi' }]), mcpServers: { linear: entry(server) }, store: { tokens } });
    cleanups.push(() => agent.close());
    await signIn(agent, server);
    expect(await tokens.getClient('mcp-linear')).toMatchObject({ serverUrl: server.url, client: { client_id: 'dyn-client-1' } });
    expect(await tokens.list({ provider: 'mcp-linear' })).toEqual([expect.objectContaining({ owner: { owner: 'app' }, hasRefreshToken: true })]);
  });
});
