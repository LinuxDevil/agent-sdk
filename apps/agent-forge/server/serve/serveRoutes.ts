/**
 * Serve routes (X02a) - publish-then-serve: a Studio agent's PINNED
 * published version answers the SDK's whole `/chat` HTTP surface at
 * `/serve/<id>/*`, and Studio-token callers manage the switch under
 * `/agents/:id/serve*`.
 *
 * Two halves, mounted at different points in `createApp`:
 *
 * - `createServeSurface().router` mounts at `/serve` BEFORE
 *   `express.json()` - the bridge streams the raw request body into a
 *   Fetch `Request`, so the JSON parser must never see it (see
 *   fetchBridge.ts). The global access middleware already applied the
 *   host-only check; everything else - bearer token, allowed origins,
 *   preflight - is enforced here or by the SDK route handler.
 * - `registerRoutes` adds `GET/PUT /agents/:id/serve`,
 *   `GET /agents/:id/serve/token` and `POST /agents/:id/serve/rotate-token`
 *   with the other `/agents` routes (token-gated by `API_PREFIXES`, id
 *   validated by the shared `/agents/:id` middleware).
 *
 * The built agent's route handler is cached per workspace+agent+published
 * version and rebuilt when the publish pointer moves; rotating the token
 * drops the cached handler so the old bearer dies immediately.
 */
import path from 'node:path';
import { Router, type Express, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import {
  createRouteHandler,
  FileSessionStore,
  type AgentSpecV2,
  type SimpleAgent,
} from 'lousho';
import { fileTraceExporter } from 'lousho/traces';
import type { ServeAgentConfig, ServeStatus, ServeTokenReveal } from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { isValidAgentId } from '../types';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import type { SpendLog } from '../passes/spendLog';
import { buildRunnableAgent } from '../buildAgentV2';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';
import { agentTraceDir } from '../traceStore';
import { readPublishedSpec } from '../lifecycle/publish';
import { workspaceOf } from '../workspace/middleware';
import type { WorkspaceContext } from '../workspace/context';
import { ServeConfigInvalidError, type ServeConfigStore, type ServeAgentEntry } from './serveConfigStore';
import { sendFetchResponse, toFetchRequest } from './fetchBridge';

/** What the default agent builder needs beyond the workspace itself (all Studio-global stores). */
export interface ServeBuildServices {
  secretsStore: SecretsStore;
  settings: SettingsStore;
  spendLog: SpendLog;
}

/** Builds the `SimpleAgent` a published spec serves through; the test seam. */
export type ServeAgentBuilder = (
  spec: AgentSpecV2,
  agentId: string,
  workspace: WorkspaceContext,
  services: ServeBuildServices
) => Promise<SimpleAgent>;

export interface ServeDeps extends ServeBuildServices {
  config: ServeConfigStore;
  /** Test seam - defaults to `buildRunnableAgent` + a `FileSessionStore` under `.lousho/agents/<id>/serve-sessions`. */
  buildAgent?: ServeAgentBuilder;
}

interface CachedHandler {
  /** The `publishedVersion` this handler was built for; a moved pointer rebuilds. */
  version: number;
  handler: (request: Request) => Promise<Response>;
}

/** The default builder: `buildRunnableAgent` with durable serve sessions + file traces. Exported so tests can wrap it (count builds, spy on the spec). */
export const buildServeAgent: ServeAgentBuilder = async (spec, agentId, workspace, services) => {
  const { agent } = await buildRunnableAgent(
    spec,
    agentId,
    {
      baseDir: workspace.ref.root,
      checkpointStore: new FileCheckpointStore(workspace.ref.root),
      approvalStore: new FileApprovalStore(workspace.ref.root),
      secretsStore: services.secretsStore,
      settings: services.settings,
      spend: services.spendLog,
      sessions: new FileSessionStore(
        path.join(workspace.ref.root, '.lousho', 'agents', agentId, 'serve-sessions')
      ),
    },
    {
      onEvent: () => {},
      exporter: fileTraceExporter({ dir: agentTraceDir(workspace.ref.root, agentId) }),
    }
  );
  return agent;
};

/** `token` masked for `ServeStatus`: first 4 + '…' + last 4 (short tokens collapse to '…'). */
function maskToken(token: string): string {
  return token.length <= 8 ? '…' : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** `GET /agents/:id/serve`'s body from the stored entry + the publish pointer. */
async function statusOf(agentId: string, entry: ServeAgentEntry, workspace: WorkspaceContext): Promise<ServeStatus> {
  const published = await readPublishedSpec(agentId, { repo: workspace.repo, versions: workspace.versions });
  return {
    agentId,
    enabled: entry.enabled,
    allowedOrigins: entry.allowedOrigins,
    publishedVersion: published?.version ?? null,
    tokenMasked: maskToken(entry.token),
    baseUrl: `/serve/${agentId}`,
  };
}

/** CORS headers for an allowed `Origin`, or `undefined` when the origin isn't on the agent's list. */
function corsFor(origin: string | undefined, allowedOrigins: readonly string[]): Record<string, string> | undefined {
  if (origin === undefined) return undefined;
  if (!allowedOrigins.includes(origin.toLowerCase())) return undefined;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

/** The preflight answer for an allowed origin; the caller has already checked `Origin`. */
function preflightResponse(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Last-Event-ID',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}

/** The cached route handlers, keyed `<workspaceId>:<agentId>`; the publish version rides on each entry. */
function createHandlerCache() {
  const handlers = new Map<string, CachedHandler>();
  const key = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`;
  return {
    get: (workspaceId: string, agentId: string) => handlers.get(key(workspaceId, agentId)),
    set: (workspaceId: string, agentId: string, entry: CachedHandler) => handlers.set(key(workspaceId, agentId), entry),
    delete: (workspaceId: string, agentId: string) => handlers.delete(key(workspaceId, agentId)),
  };
}

export interface ServeSurface {
  /** Mount at `/serve` BEFORE `express.json()` - it streams raw bodies through the Fetch bridge. */
  router: Router;
  /** Register the `/agents/:id/serve*` management routes (after the `/agents/:id` id-validation middleware). */
  registerRoutes(app: Express): void;
}

/** Both halves of the serve surface over one config store and one handler cache. */
export function createServeSurface(deps: ServeDeps): ServeSurface {
  const cache = createHandlerCache();
  const builder = deps.buildAgent ?? buildServeAgent;
  const services: ServeBuildServices = {
    secretsStore: deps.secretsStore,
    settings: deps.settings,
    spendLog: deps.spendLog,
  };

  /** The SDK route handler for the agent's currently published version, rebuilding on a moved pointer. */
  async function handlerFor(
    published: { version: number; spec: AgentSpecV2 },
    agentId: string,
    token: string,
    allowedOrigins: readonly string[],
    workspace: WorkspaceContext
  ): Promise<CachedHandler['handler']> {
    const cached = cache.get(workspace.ref.id, agentId);
    if (cached !== undefined && cached.version === published.version) return cached.handler;
    const agent = await builder(published.spec, agentId, workspace, services);
    const { handler } = createRouteHandler(agent, {
      basePath: `/serve/${agentId}`,
      auth: token,
      allowedOrigins: [...allowedOrigins],
    });
    cache.set(workspace.ref.id, agentId, { version: published.version, handler });
    return handler;
  }

  const router = Router();
  router.use(
    '/:agentId',
    asyncRoute(async (req: ExpressRequest, res: ExpressResponse) => {
      const agentId = String(req.params.agentId);
      if (!isValidAgentId(agentId)) {
        sendError(res, 400, 'Invalid agent id', 'LOUSHO_AGENT_ID_INVALID');
        return;
      }
      const workspace = workspaceOf(req);
      const entry = await deps.config.get(agentId);
      if (!entry.enabled) {
        sendError(res, 404, 'Not served', 'LOUSHO_NOT_SERVED');
        return;
      }
      const published = await readPublishedSpec(agentId, { repo: workspace.repo, versions: workspace.versions });
      if (published === undefined) {
        sendError(res, 404, 'Not served', 'LOUSHO_NOT_SERVED');
        return;
      }
      const origin = req.headers.origin;
      const cors = corsFor(origin, entry.allowedOrigins);
      if (req.method === 'OPTIONS') {
        if (origin !== undefined && cors === undefined) {
          sendError(res, 403, 'Forbidden origin', 'LOUSHO_REQUEST_FORBIDDEN');
          return;
        }
        await sendFetchResponse(res, preflightResponse(origin ?? 'null'));
        return;
      }
      if (origin !== undefined && cors === undefined) {
        sendError(res, 403, 'Forbidden origin', 'LOUSHO_REQUEST_FORBIDDEN');
        return;
      }
      const handler = await handlerFor(published, agentId, entry.token, entry.allowedOrigins, workspace);
      const fetchResponse = await handler(toFetchRequest(req));
      // The SDK answers same-origin assumptions; a browser caller on an
      // allowed origin still needs CORS headers on the real response.
      if (cors !== undefined) {
        for (const [key, value] of Object.entries(cors)) fetchResponse.headers.set(key, value);
      }
      await sendFetchResponse(res, fetchResponse);
    })
  );
  // Anything under /serve that isn't /serve/<id>/... (bare /serve, /serve/)
  // is simply not served.
  router.use((_req, res) => sendError(res, 404, 'Not served', 'LOUSHO_NOT_SERVED'));

  return {
    router,
    registerRoutes(app) {
      app.get(
        '/agents/:id/serve',
        asyncRoute(async (req, res) => {
          const id = paramId(req);
          const entry = await deps.config.get(id);
          res.json(await statusOf(id, entry, workspaceOf(req)));
        })
      );
      app.put(
        '/agents/:id/serve',
        asyncRoute(async (req, res) => {
          const id = paramId(req);
          const body: unknown = req.body;
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            sendError(res, 400, 'Body must be a JSON object', 'LOUSHO_REQUEST_INVALID');
            return;
          }
          try {
            const entry = await deps.config.put(id, body as Partial<ServeAgentConfig>);
            res.json(await statusOf(id, entry, workspaceOf(req)));
          } catch (error) {
            if (error instanceof ServeConfigInvalidError) {
              sendError(res, 400, error.message, 'LOUSHO_REQUEST_INVALID');
              return;
            }
            throw error;
          }
        })
      );
      app.get(
        '/agents/:id/serve/token',
        asyncRoute(async (req, res) => {
          const entry = await deps.config.get(paramId(req));
          const reveal: ServeTokenReveal = { token: entry.token };
          res.json(reveal);
        })
      );
      app.post(
        '/agents/:id/serve/rotate-token',
        asyncRoute(async (req, res) => {
          const id = paramId(req);
          const token = await deps.config.rotateToken(id);
          // The cached handler still carries the OLD bearer - drop it so the
          // next request rebuilds with the new token.
          cache.delete(workspaceOf(req).ref.id, id);
          const reveal: ServeTokenReveal = { token };
          res.json(reveal);
        })
      );
    },
  };
}
