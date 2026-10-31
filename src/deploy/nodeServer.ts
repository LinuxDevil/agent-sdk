/**
 * The HTTP server of the node-server and docker targets.
 *
 * Serves the `/chat` API shared with `lousho dev` (src/server/chatRoutes.ts)
 * over a `node:http` server (the routes are Fetch-native, src/server/fetchRoutes.ts,
 * and shared with the Worker target): `GET /health`, sessions, SSE streaming,
 * approvals and the legacy `POST /chat { message }`, plus `GET /ready`
 * (readiness: 200 while serving, 503 once `shutdown()` has begun; `/health` stays
 * the liveness probe). When auth is configured (a bearer
 * token, or an auth list from `lousho/auth`), every route except
 * `/health` and `/ready` requires it, including a channel route, unless that channel
 * authenticates its own requests (it has a `verify`: a signed platform channel,
 * a webhook with a secret, an `httpChannel({ verify })`).
 * Once it listens it finishes the runs a crash left interrupted
 * (`agent.recover()`), unless `LOUSHO_RECOVER_ON_START=0`.
 *
 * Node-only (the Worker target has its own runtime, runtime.worker.ts).
 */
import * as http from 'node:http';
import type { SimpleAgent } from '../createAgent';
import type { RunRecovery } from '../agentRecover';
import { incomingHeaders, relayFetch } from '../server/chatRoutes';
import { serveFetch, type ChatRoutesAccess, type ChatRoutesContext, type ServeAuth } from '../server/fetchRoutes';
import { startSchedules, type StartSchedulesOptions } from '../schedules/startSchedules';
import type { DefinedSchedule } from '../schedules/defineSchedule';
import type { Channel } from '../channels/defineChannel';
import { continueChannelSignIn, mountChannels } from '../channels/mountChannels';
import { specToAgent } from '../spec/specToAgent';
import type { AgentSpec } from '../spec/schema';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { SDKError } from '../execution/errors';
import type { AuthFn } from '../auth/types';
import { apiToken } from '../auth/basic';
import { requestGuardFromEnv } from '../server/requestGuard';
import { routeAuth } from '../auth/routeAuth';

/** Environment variable holding the bearer token; wins over a token baked in at build time. */
const API_TOKEN_ENV = 'LOUSHO_API_TOKEN';
/** Environment variable choosing where sessions live: `memory` (default) or `sqlite:<path>`. */
const STORE_ENV = 'LOUSHO_STORE';
/** Environment variable that turns off crash recovery at start-up when `0` or `false`. */
const RECOVER_ENV = 'LOUSHO_RECOVER_ON_START';
/** Environment variable that, when `1` or `true`, lets the server listen on a public interface with no auth. */
const ALLOW_PUBLIC_ENV = 'LOUSHO_ALLOW_PUBLIC';

/** Whether `host` only takes connections from this machine: `localhost`, `::1` or an address in 127.0.0.0/8. */
function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name);
}

/**
 * The built server's start-up check, before it listens on `host`. With no
 * route auth (`authenticated` false: no `LOUSHO_API_TOKEN`, no build token,
 * no `auth.ts`) on a non-loopback host, it throws `LOUSHO_SERVER_UNPROTECTED`,
 * unless `LOUSHO_ALLOW_PUBLIC=1` in `env` serves the open agent on purpose:
 * then it returns the warning to log. `undefined` when there is nothing to say.
 */
export function checkServerExposure(host: string, authenticated: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (authenticated || isLoopbackHost(host)) return undefined;
  const allowPublic = env[ALLOW_PUBLIC_ENV]?.trim().toLowerCase();
  if (allowPublic === '1' || allowPublic === 'true') {
    return `[lousho server] warning: no ${API_TOKEN_ENV} set, so anyone who can reach ${host} can use this agent.`;
  }
  throw new SDKError(
    `refusing to listen on ${host} with no auth: anyone who can reach it could use this agent. ` +
      `Set ${API_TOKEN_ENV}, add an auth.ts to the agent directory, bind to 127.0.0.1 (HOST / --host), ` +
      `or set ${ALLOW_PUBLIC_ENV}=1 to serve an open agent on purpose.`,
    'LOUSHO_SERVER_UNPROTECTED'
  );
}

/**
 * `authorizeSession`, `authorizeApproval` and `exposeErrors` work as on
 * `createRouteHandler()` (docs/auth.md); so do `onDisconnect` and
 * `waitUntil`, and `allowedOrigins`, `requireJsonBody` and `allowedHosts`
 * (when unset, read from `LOUSHO_ALLOWED_ORIGINS`, `LOUSHO_REQUIRE_JSON_BODY`
 * and `LOUSHO_ALLOWED_HOSTS` in `env`).
 */
export interface DeployedServerOptions extends ChatRoutesAccess {
  /**
   * `{ token }` (the build options' `auth.token`): the bearer token when
   * `LOUSHO_API_TOKEN` is not set. Or an auth entry or ordered list
   * (`jwt()`, `oidc()`, `basic()`, ...; an agent directory's `auth.ts`):
   * `apiToken(LOUSHO_API_TOKEN)` is appended to it when that variable is set.
   */
  auth?: { token?: string } | AuthFn | readonly AuthFn[];
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Schedules of the served agent directory (`resolveAgentDir()`'s `schedules`): started when the server listens, stopped when it closes. */
  schedules?: readonly DefinedSchedule[];
  /** Overrides for the scheduler (clock, timers, error sink); mainly for tests. */
  scheduler?: StartSchedulesOptions;
  /** Channels of the served agent directory (`resolveAgentDir()`'s `channels`): mounted under `/channels` next to the chat routes. */
  channels?: readonly Channel[];
  /**
   * Crash recovery: once the server listens, `agent.recover()` resumes the
   * runs a crash left `in-progress` in the store (runs paused on an approval
   * are left alone), and keeps sweeping every `intervalMs` (default 30 s) until
   * the server shuts down. On by default; `false`, or `LOUSHO_RECOVER_ON_START=0`
   * in `env`, turns it off. `intervalMs` is mainly for tests.
   */
  recovery?: false | { intervalMs?: number };
}

/** The store `LOUSHO_STORE` names: `memory` (the default, lost on restart) or `sqlite:<path>` (Node >= 22). */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): AgentStore {
  const value = env[STORE_ENV]?.trim() || 'memory';
  if (value === 'memory') return memoryStore();
  if (value.startsWith('sqlite:') && value.length > 'sqlite:'.length) return new SqliteStore(value.slice('sqlite:'.length));
  throw new SDKError(`${STORE_ENV} must be 'memory' or 'sqlite:<path>' (got '${value}')`, 'LOUSHO_DEPLOY_FAILED');
}

/** Builds the spec's agent over the store from the environment and connects its MCP servers. */
export async function createDeployedAgent(spec: AgentSpec, env: NodeJS.ProcessEnv = process.env): Promise<SimpleAgent> {
  const agent = specToAgent(spec, { store: storeFromEnv(env) });
  await agent.ready();
  return agent;
}

/** Answers 500 for a request that failed outside the routes' own error handling. */
function replyUnhandled(res: http.ServerResponse, error: unknown): void {
  console.error('[lousho server] unhandled request error:', error);
  if (!res.headersSent) res.writeHead(500);
  res.end();
}

/** The auth of the server: the token alone, or the configured entries then the env token; `undefined` when nothing is configured. */
function serverAuth(options: DeployedServerOptions): ServeAuth | undefined {
  const envToken = (options.env ?? process.env)[API_TOKEN_ENV] || undefined;
  const { auth } = options;
  if (auth === undefined || (typeof auth === 'object' && !Array.isArray(auth))) {
    return envToken ?? ((auth as { token?: string } | undefined)?.token || undefined);
  }
  const entries: readonly AuthFn[] = Array.isArray(auth) ? auth : [auth as AuthFn];
  return envToken === undefined ? entries : [...entries, apiToken(envToken)];
}

/** `values` without its `undefined` entries. */
function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/**
 * How a channel route of the deployed server is guarded: `self-verified` (the
 * channel has its own `verify`: a platform signature, a webhook secret, ...),
 * `server-auth` (no `verify`, so the server's auth - `LOUSHO_API_TOKEN`, the
 * build's token or the agent directory's `auth.ts` - guards it, as it guards
 * `/chat`), or `open` (no `verify` and no server auth: anyone can call it).
 */
export type ChannelRouteAuth = 'self-verified' | 'server-auth' | 'open';

/** The channel routes' guards, in channel order. */
function channelRoutesOf(channels: readonly Channel[], authenticated: boolean): { name: string; auth: ChannelRouteAuth }[] {
  return channels.map((channel) => ({ name: channel.name, auth: channel.verify ? 'self-verified' : authenticated ? 'server-auth' : 'open' }));
}

/** Whether `req` is a `POST /channels/<name>[/...]` for one of `names`. */
function guardedChannelRoute(req: http.IncomingMessage, names: ReadonlySet<string>): boolean {
  if (req.method !== 'POST') return false;
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  return pathname.startsWith('/channels/') && names.has(pathname.slice('/channels/'.length).split('/')[0]);
}

/**
 * Runs the server's auth on the headers of `req` (its body is left unread for
 * the channel) and writes the 401 / 403 / 500 when it refuses; `true` when the
 * request may go on.
 */
async function channelRequestAllowed(req: http.IncomingMessage, res: http.ServerResponse, auth: ServeAuth): Promise<boolean> {
  const headers = incomingHeaders(req);
  const request = new Request(new URL(req.url ?? '/', 'http://localhost'), { method: req.method, headers });
  const outcome = await routeAuth(request, typeof auth === 'string' ? apiToken(auth) : auth);
  if (outcome.ok) return true;
  const responseHeaders: Record<string, string> = {};
  outcome.response.headers.forEach((value, name) => (responseHeaders[name] = value));
  res.writeHead(outcome.response.status, responseHeaders);
  res.end(await outcome.response.text());
  return false;
}

/** Whether crash recovery runs at start-up: not with `recovery: false` or `LOUSHO_RECOVER_ON_START=0` / `false`. */
function recoveryEnabled(options: DeployedServerOptions): boolean {
  const value = (options.env ?? process.env)[RECOVER_ENV]?.trim().toLowerCase();
  return options.recovery !== false && value !== '0' && value !== 'false';
}

/** Codes of `agent.pending()` / `agent.recover()` for a store that keeps no listable checkpoints: nothing to recover. */
const NOT_RECOVERABLE = new Set(['LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE', 'LOUSHO_CONFIG_INVALID']);

/**
 * Starts `agent.recover()` (stopped by `signal`), after logging how many
 * interrupted runs it found. Never throws: a store that cannot list its
 * checkpoints (none, or a custom one without `list()`) has nothing to
 * recover, and any other failure is logged without stopping the server.
 */
async function startRunRecovery(agent: SimpleAgent, signal: AbortSignal, intervalMs: number | undefined): Promise<RunRecovery | undefined> {
  try {
    const interrupted = (await agent.pending()).filter((run) => run.status === 'in-progress' && run.lastError?.retryable !== false);
    if (signal.aborted) return undefined;
    if (interrupted.length > 0) console.log(`lousho server: resuming ${interrupted.length} interrupted run(s)`);
    return agent.recover({
      signal,
      ...(intervalMs !== undefined && { intervalMs }),
      onRecovered: (run) => console.log(`lousho server: recovered interrupted run '${run.sessionId}'`),
      onError: (error, run) => console.error(`[lousho server] recovery${run ? ` of run '${run.sessionId}'` : ''} failed:`, error),
    });
  } catch (error) {
    if (!NOT_RECOVERABLE.has((error as { code?: string } | null)?.code ?? '')) console.error('[lousho server] recovery failed to start:', error);
    return undefined;
  }
}

/** Default bound of {@link DeployedServer.shutdown}'s wait for in-flight turns; `LOUSHO_SHUTDOWN_TIMEOUT_MS` overrides it in the generated server. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** What {@link createDeployedServer} returns. */
export interface DeployedServer {
  server: http.Server;
  /** Whether requests are checked (a token or an auth list), so the caller can warn when it listens publicly without. */
  authenticated: boolean;
  /** Each channel route and how it is guarded (see {@link ChannelRouteAuth}), for the start-up report. */
  channelRoutes: { name: string; auth: ChannelRouteAuth }[];
  /**
   * A graceful stop, for SIGTERM. Stops accepting connections
   * (`server.close()`), stops the schedules (no new fires) and crash recovery
   * (its resumes in flight are aborted; their checkpoints stay for the next
   * start), then waits for
   * what is in flight - requests and their turns (a channel turn, a stream),
   * turns that outlived a disconnected client, and schedule fires - for at
   * most `timeoutMs` (default 10 s), and finally closes the connections left.
   * It does not close the agent: call `agent.close()` after it.
   */
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * An (unlistening) http server for `agent`. `authenticated` tells whether
 * requests are checked (a token or an auth list), so the caller can warn when
 * it listens publicly without; `shutdown()` drains it.
 */
export function createDeployedServer(agent: SimpleAgent, options: DeployedServerOptions = {}): DeployedServer {
  const auth = serverAuth(options);
  const channels = options.channels?.length ? mountChannels(agent, options.channels) : undefined;
  // A channel with its own verify authenticates its callers (a platform's signature: they cannot send our token);
  // one without it sits behind the server's auth, like the chat routes.
  const channelRoutes = channelRoutesOf(options.channels ?? [], auth !== undefined);
  const guarded = new Set(channelRoutes.filter((route) => route.auth === 'server-auth').map((route) => route.name));
  // Requests being handled, and turns that outlived their client, for shutdown() to wait for.
  const inFlight = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    const settled = work.then(
      () => undefined,
      () => undefined
    );
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
  };
  // A channel turn paused on a sign-in continues on its surface once the callback stored the token.
  const { authorizeSession, authorizeApproval, exposeErrors, onDisconnect, waitUntil } = options;
  // LOUSHO_ALLOWED_ORIGINS, LOUSHO_ALLOWED_HOSTS and LOUSHO_REQUIRE_JSON_BODY, where the options leave them unset.
  const guard = { ...requestGuardFromEnv(options.env ?? process.env), ...definedOnly({ allowedOrigins: options.allowedOrigins, allowedHosts: options.allowedHosts, requireJsonBody: options.requireJsonBody }) };
  const { allowedOrigins, requireJsonBody, allowedHosts } = guard;
  const chat: ChatRoutesContext = {
    name: 'lousho server',
    agent: () => agent,
    afterSignIn: (result) => continueChannelSignIn(channels, result),
    allowedOrigins,
    requireJsonBody,
    allowedHosts,
    authorizeSession,
    authorizeApproval,
    exposeErrors,
    onDisconnect,
    waitUntil: (promise) => {
      track(promise);
      waitUntil?.(promise);
    },
  };
  // Readiness: flips once shutdown() begins, so a keep-alive probe sees it before the sockets close.
  let draining = false;
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method === 'GET' && new URL(req.url ?? '/', 'http://localhost').pathname === '/ready') {
      res.writeHead(draining ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: draining ? 'draining' : 'ready' }));
      return;
    }
    if (auth !== undefined && guardedChannelRoute(req, guarded) && !(await channelRequestAllowed(req, res, auth))) return;
    if (await channels?.(req, res)) return;
    await relayFetch(req, res, (request) => serveFetch(request, chat, auth));
  };
  const server = http.createServer((req, res) => track(handle(req, res).catch((error) => replyUnhandled(res, error))));
  let running: ReturnType<typeof startSchedules> | undefined;
  let schedulesStopped: Promise<void> | undefined;
  const stopSchedules = (): Promise<void> => (schedulesStopped ??= running?.stop() ?? Promise.resolve());
  if (options.schedules?.length) {
    server.on('listening', () => (running = startSchedules(agent, options.schedules ?? [], options.scheduler)));
    server.on('close', () => void stopSchedules());
  }
  // Crash recovery: the runs a crash left in-progress are resumed once the server listens.
  const recoveryAbort = new AbortController();
  let recovering: Promise<RunRecovery | undefined> | undefined;
  const stopRecovery = async (): Promise<void> => {
    recoveryAbort.abort();
    await (await recovering)?.done;
  };
  if (recoveryEnabled(options)) {
    const intervalMs = options.recovery === false ? undefined : options.recovery?.intervalMs;
    server.on('listening', () => (recovering ??= startRunRecovery(agent, recoveryAbort.signal, intervalMs)));
    server.on('close', () => void stopRecovery());
  }
  const shutdown = async ({ timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> => {
    draining = true;
    if (server.listening) server.close();
    server.closeIdleConnections();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((done) => (timer = setTimeout(() => done('timeout'), timeoutMs)));
    const drained = (async () => {
      await stopSchedules();
      await stopRecovery();
      // A request can start a detached turn while it ends: wait until nothing is left.
      while (inFlight.size > 0) await Promise.all(inFlight);
    })();
    const outcome = await Promise.race([drained, timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      console.warn(`[lousho server] shutdown: ${inFlight.size} request(s) or turn(s) still running after ${timeoutMs} ms; closing their connections.`);
    }
    server.closeAllConnections();
  };
  return { server, authenticated: auth !== undefined, channelRoutes, shutdown };
}
