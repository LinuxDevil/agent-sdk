/**
 * The HTTP server of the node-server and docker targets (LOU-I2, LOU-D14).
 *
 * Serves the `/chat` API shared with `lousho dev` (src/server/chatRoutes.ts)
 * over a `node:http` server (the routes are Fetch-native, src/server/fetchRoutes.ts,
 * and shared with the Worker target): `GET /health`, sessions, SSE streaming,
 * approvals and the legacy `POST /chat { message }`. When auth is configured (a bearer
 * token, or N10a's auth list from `@lousho/build-ai-agent/auth`), every route except
 * `/health` and the channels requires it.
 *
 * Node-only (the Worker target has its own runtime, runtime.worker.ts).
 */
import * as http from 'node:http';
import type { SimpleAgent } from '../createAgent';
import { relayFetch } from '../server/chatRoutes';
import { serveFetch } from '../server/fetchRoutes';
import { startSchedules, type StartSchedulesOptions } from '../schedules/startSchedules';
import type { DefinedSchedule } from '../schedules/defineSchedule';
import type { Channel } from '../channels/defineChannel';
import { mountChannels } from '../channels/mountChannels';
import { specToAgent } from '../spec/specToAgent';
import type { AgentSpec } from '../spec/schema';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { SDKError } from '../execution/errors';
import type { AuthFn } from '../auth/types';
import { apiToken } from '../auth/basic';

/** Environment variable holding the bearer token; wins over a token baked in at build time. */
const API_TOKEN_ENV = 'LOUSHO_API_TOKEN';
/** Environment variable choosing where sessions live: `memory` (default) or `sqlite:<path>`. */
const STORE_ENV = 'LOUSHO_STORE';

export interface DeployedServerOptions {
  /**
   * `{ token }` (the build options' `auth.token`): the bearer token when
   * `LOUSHO_API_TOKEN` is not set. Or (N10a) an auth entry or ordered list
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

/** The auth list of the server: the configured entries, then the env token; `undefined` when nothing is configured. */
function serverAuth(options: DeployedServerOptions): readonly AuthFn[] | undefined {
  const envToken = (options.env ?? process.env)[API_TOKEN_ENV] || undefined;
  const { auth } = options;
  if (auth === undefined || (typeof auth === 'object' && !Array.isArray(auth))) {
    const token = envToken ?? ((auth as { token?: string } | undefined)?.token || undefined);
    return token === undefined ? undefined : [apiToken(token)];
  }
  const entries: readonly AuthFn[] = Array.isArray(auth) ? auth : [auth as AuthFn];
  return envToken === undefined ? entries : [...entries, apiToken(envToken)];
}

/**
 * An (unlistening) http server for `agent`. `authenticated` tells whether
 * requests are checked (a token or an auth list), so the caller can warn when
 * it listens publicly without.
 */
export function createDeployedServer(agent: SimpleAgent, options: DeployedServerOptions = {}): { server: http.Server; authenticated: boolean } {
  const auth = serverAuth(options);
  const chat = { name: 'lousho server', agent: () => agent };
  // Channels authenticate themselves (their own verify), so they sit beside the bearer-protected chat routes.
  const channels = options.channels?.length ? mountChannels(agent, options.channels) : undefined;
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (await channels?.(req, res)) return;
    await relayFetch(req, res, (request) => serveFetch(request, chat, auth));
  };
  const server = http.createServer((req, res) => void handle(req, res).catch((error) => replyUnhandled(res, error)));
  if (options.schedules?.length) {
    let running: ReturnType<typeof startSchedules> | undefined;
    server.on('listening', () => (running = startSchedules(agent, options.schedules ?? [], options.scheduler)));
    server.on('close', () => running?.stop());
  }
  return { server, authenticated: auth !== undefined };
}
