/**
 * Runtime control server - HTTP API.
 *
 * Routes:
 *   GET  /health                     -> 200 'ok'
 *   GET  /agents                     -> AgentStoreEntry[] (saved agent specs on disk)
 *   GET  /agents/:id                 -> AgentSpec | 404
 *   PUT  /agents/:id                 -> save an AgentSpec to disk (body: AgentSpec)
 *   DELETE /agents/:id               -> remove the saved spec, 204
 *   GET/POST/DELETE /agents/:id/draft -> the pending ChangeDraft (routes/draftRoutes.ts)
 *   POST /agents/:id/draft/approve · /reject -> settle the pending draft
 *   GET  /workspace                  -> { baseDir, workspace } - the workspace Studio was launched in
 *   POST /agents/:id/run            -> body: { spec?: AgentSpec, input: string }
 *   POST /agents/:id/stop            -> abort the in-flight run, if any
 *   GET  /agents/:id/status          -> AgentRunStatusPayload
 *   POST /agents/:id/approve         -> body: { approvalId, approved, note? }
 *   GET  /agents/:id/traces?limit=N  -> { traces: TraceSummaryPayload[] } (newest first)
 *   GET  /agents/:id/traces/:traceId -> TraceDetailPayload | 404
 *   GET  /runs/:id/history           -> RunHistoryPayload
 *   POST /runs/:id/fork              -> body: ForkRunRequest; starts the fork, 202 ForkRunResponse
 *   GET  /runs/compare?a=&b=         -> RunComparisonPayload (compareTrajectories)
 *   GET  /observe/**                 -> proxied to the `lousho observe` daemon's read API (observeProxy.ts)
 *   POST /observe/api/v1/scores      -> proxied too (the proxy's write allowlist: human feedback scores)
 *   POST /observe/api/v1/evaluators/:id/test -> a judge rule's dry run here, a code rule forwarded (judge.ts)
 *   POST /playground/run             -> body: PlaygroundRunRequest; streams SSE PlaygroundEvents (playground.ts)
 *   GET  /catalog/models[?provider]  -> ModelCatalogEntry[] (available also counts Studio-stored keys)
 *   GET  /catalog/tools|guardrails|triggers -> the SDK catalogs (listBuiltinTools/listGuardrails/listTriggerTypes)
 *   GET  /catalog/skills|kits        -> the registry index's skill/kit items (routes/catalogRoutes.ts)
 *   POST/GET /assistant/sessions · GET/DELETE /assistant/sessions/:id
 *                                      -> Agent Author chat sessions, Studio-global (author/routes.ts)
 *
 * `WS /agents/:id/stream` is wired separately in wsServer.ts (attached to
 * the same underlying http.Server, since `ws` needs the raw HTTP upgrade
 * event rather than an Express route).
 *
 * Every route reads its workspace from workspaceOf(req) (header
 * x-lousho-workspace or ?ws=, else the launch folder).
 *
 * Built on Express (over Fastify): this SDK's only existing local server
 * (src/cli/dev.ts) is hand-rolled `node:http`, so there's no established
 * in-repo convention to match either way. Express is chosen for its
 * ubiquity (every contributor already knows its routing/middleware model)
 * and because `supertest` (the natural HTTP-layer test tool for this
 * ticket) is built and documented around it; Fastify's JSON-schema-first
 * validation wasn't worth the extra learning cost for ~6 small routes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { ConfigurationError, SDKError, type AgentSpec, type ForkPatch } from 'lousho';
import type { AgentStore } from '../src/persistence/AgentStore';
import {
  RunManager,
  AgentNotFoundError,
  AlreadyRunningError,
  NoActiveRunError,
  ApprovalPendingError,
} from './runRegistry';
import { ChatTriggerAdapter } from './chatTriggerAdapter';
import { isValidAgentId } from './types';
import { SecretsStore, isSecretProvider } from './secretsStore';
import { SettingsStore } from './settingsStore';
import type { ForkRunRequest, ForkRunResponse, SettingsProfile, WorkspaceInfo } from '../shared/wireTypes';
import { chatTriggersFor, singleWorkspace, type WorkspaceContext } from './workspace/context';
import { workspaceMiddleware, workspaceOf } from './workspace/middleware';
import { configureStudioHome } from './workspace/studioPaths';
import { workspaceRefFor } from './workspace/workspaceId';
import {
  DEFAULT_TRACE_LIMIT,
  MAX_TRACE_LIMIT,
  isValidTraceId,
  listAgentTraces,
  readAgentTrace,
  traceDirExists,
} from './traceStore';
import { DEPLOY_ADAPTERS, isDeployAdapter, runDeploy } from './deployRunner';
import { checkApiAccess, checkHostAndOrigin, type StudioAccessOptions } from './auth';
import { registerObserveProxy } from './observeProxy';
import { registerPlaygroundRoute, type PlaygroundOptions } from './playground';
import { registerJudgeTestRoute, type JudgeFn } from './judge';
import { asyncRoute, paramId, sendError } from './http/routeUtils';
import { AgentRepo, InvalidSpecError } from './storage/agentRepo';
import { DraftStore } from './storage/draftStore';
import { VersionStore } from './storage/versionStore';
import { registerDraftRoutes } from './routes/draftRoutes';
import { registerCatalogRoutes } from './routes/catalogRoutes';
import { AuthorSessionStore } from './author/sessionStore';
import { registerAuthorRoutes } from './author/routes';

interface CreateAppBaseOptions {
  /** The folder Studio was launched in - the default workspace's root, and nothing more: per-agent code reads `workspaceOf(req).ref.root`, never this field directly. */
  baseDir: string;
  /**
   * The Studio home directory every Studio-global file lives under
   * (settings, secrets, Author sessions, … - see workspace/studioPaths.ts).
   * Defaults to `<baseDir>/.lousho` today, which keeps every file exactly
   * where it was; a later change moves the default to `~/.lousho/studio`.
   */
  studioHome?: string;
  /** Defaults to `new SecretsStore(studioPaths())` when omitted. */
  secretsStore?: SecretsStore;
  /** Defaults to `new SettingsStore(studioPaths())` when omitted. */
  settingsStore?: SettingsStore;
  /** Defaults to `new AuthorSessionStore(studioPaths().sessions)` when omitted. */
  sessions?: AuthorSessionStore;
  /**
   * Directory holding the pre-built Agent Forge client (the
   * output of `vite build`, normally `apps/agent-forge/dist`). When set and
   * it actually contains an `index.html`, this server serves it as static
   * files plus a SPA fallback, so `lousho studio --prod` can serve the whole
   * app - API and UI - from this one Express server/port instead of needing
   * a separate Vite dev server process. Omitted (or pointing at a directory
   * without a build) in dev mode, where the real Vite dev server (with HMR)
   * serves the UI instead and proxies `/agents/**` to this server - see
   * `src/cli/studio.ts`.
   */
  staticDir?: string;
  /**
   * The per-launch token (and extra allowed hosts) every API
   * request must present - see auth.ts. `startStudioServer()` always passes
   * one; omitting it (in-process tests only) skips the token check, while
   * the Host/Origin check still applies.
   */
  access?: StudioAccessOptions;
  /** Observe reporter overrides for `POST /playground/run` (tests); see playground.ts. */
  playgroundObserve?: PlaygroundOptions['observe'];
  /** The judge `POST /observe/api/v1/evaluators/:id/test` runs for a judge rule (tests); default the real model call (judge.ts). */
  judge?: JudgeFn;
}

/**
 * How `createApp` learns the workspace it serves: either an already-built
 * `WorkspaceContext` (startStudioServer's real one, or a test's stub) or
 * the legacy `{agentStore, runManager}` pair existing tests pass, which
 * `createApp` wraps in a context for the launch folder.
 */
type CreateAppWorkspaceOptions =
  | { workspace: WorkspaceContext; agentStore?: never; runManager?: never }
  | { workspace?: undefined; agentStore: AgentStore; runManager: RunManager };

/**
 * `createApp`'s options: the launch folder and Studio-global services,
 * plus exactly one way of describing the workspace it serves (a built
 * `WorkspaceContext`, or the legacy `{agentStore, runManager}` pair).
 */
export type CreateAppOptions = CreateAppBaseOptions & CreateAppWorkspaceOptions;

/** Path prefixes of the API (everything except `/health` and the static client). */
const API_PREFIXES = ['/agents', '/runs', '/settings', '/workspace', '/observe', '/playground', '/catalog', '/assistant'];

/** The only methods served without the token, and only off the API (`/health`, the static client). */
const PUBLIC_METHODS = new Set(['GET', 'HEAD']);

/**
 * `pathname` as the token gate compares it: percent-decoded to a fixed point,
 * runs of `/` or `\` collapsed to one `/`, lower-cased - a superset of every
 * spelling Express could route to an API handler (`/PLAYGROUND/run`,
 * `//playground/run`, `/%70layground/run`, `/observe%2Fapi/...`).
 * `undefined` when it doesn't decode cleanly (the gate then treats it as API).
 */
function gatePath(pathname: string): string | undefined {
  let current = pathname;
  for (let round = 0; round < 4; round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return undefined;
    }
    if (decoded === current) return current.replace(/[\\/]+/g, '/').toLowerCase();
    current = decoded;
  }
  return undefined;
}

function isApiPath(pathname: string): boolean {
  const normalised = gatePath(pathname);
  if (normalised === undefined) return true;
  return API_PREFIXES.some((prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`));
}

/**
 * Deny by default: every request needs the token except a GET/HEAD off the
 * API (`/health`, static files, the SPA fallback). `req.path` is the pathname
 * Express routes on (an absolute-form request line's included).
 */
function needsToken(req: Request): boolean {
  return !PUBLIC_METHODS.has(req.method) || isApiPath(req.path);
}

type ErrorClass = new (...args: never[]) => Error;

/**
 * Replies with the HTTP status mapped to `error`'s class (first match wins)
 * and `{ error: message }`; an error matching none of `mappings` is rethrown
 * so asyncRoute() hands it to the 500 handler.
 */
function respondWithMappedError(res: Response, error: unknown, mappings: [ErrorClass, number][]): void {
  const match = mappings.find(([errorClass]) => error instanceof errorClass);
  if (!match) throw error;
  res.status(match[1]).json({ error: (error as Error).message });
}

/** Saved-agent CRUD: list, load, save - all on the request's workspace (`workspaceOf(req).agentStore`). */
function registerAgentRoutes(app: Express): void {
  app.get(
    '/agents',
    asyncRoute(async (req, res) => {
      res.json(await workspaceOf(req).agentStore.list());
    })
  );

  app.get(
    '/agents/:id',
    asyncRoute(async (req, res) => {
      const spec = await workspaceOf(req).agentStore.load(paramId(req));
      if (!spec) {
        res.status(404).json({ error: `No saved agent '${paramId(req)}'` });
        return;
      }
      res.json(spec);
    })
  );

  app.put(
    '/agents/:id',
    asyncRoute(async (req, res) => {
      // The facade's save() takes the agent lock itself around the
      // read-modify-write - wrapping here too would re-enter it.
      const spec = req.body as AgentSpec;
      if (!spec || typeof spec !== 'object' || !spec.name || !spec.prompt || !spec.provider) {
        res.status(400).json({ error: 'Request body must be a valid AgentSpec' });
        return;
      }
      try {
        await workspaceOf(req).agentStore.save(paramId(req), spec);
      } catch (error) {
        if (error instanceof InvalidSpecError) {
          sendError(res, 400, error.message, error.code, { issues: error.issues });
          return;
        }
        throw error;
      }
      res.status(204).end();
    })
  );

  app.delete(
    '/agents/:id',
    asyncRoute(async (req, res) => {
      await workspaceOf(req).agentStore.remove(paramId(req));
      res.status(204).end();
    })
  );
}

/**
 * The workspace the studio serves - the client keys its draft
 * cache by `baseDir`, so unsaved edits never leak into another project's
 * studio, and reads `workspace` to address this workspace by id.
 */
function registerWorkspaceRoute(app: Express): void {
  app.get('/workspace', (req, res) => {
    const ws = workspaceOf(req);
    res.json({ baseDir: ws.ref.root, workspace: ws.ref } satisfies WorkspaceInfo);
  });
}

/** Run lifecycle: start, stop, status, and resolving a pending tool approval (all on `workspaceOf(req).runs`). */
function registerRunRoutes(app: Express): void {
  app.post(
    '/agents/:id/run',
    asyncRoute(async (req, res) => {
      const { spec, input } = req.body as { spec?: AgentSpec; input?: string };
      if (typeof input !== 'string' || !input) {
        res.status(400).json({ error: "Request body must include a non-empty 'input' string" });
        return;
      }
      try {
        const runs = workspaceOf(req).runs;
        await runs.run(paramId(req), input, spec);
        res.status(202).json(runs.status(paramId(req)));
      } catch (error) {
        respondWithMappedError(res, error, [
          [AlreadyRunningError, 409],
          [AgentNotFoundError, 404],
          // E.g. LOUSHO_PROVIDER_MISSING_API_KEY - the run never started.
          [ConfigurationError, 422],
        ]);
      }
    })
  );

  app.post('/agents/:id/stop', (req, res) => {
    const runs = workspaceOf(req).runs;
    runs.stop(paramId(req));
    res.status(202).json(runs.status(paramId(req)));
  });

  app.get('/agents/:id/status', (req, res) => {
    res.json(workspaceOf(req).runs.status(paramId(req)));
  });

  app.post(
    '/agents/:id/approve',
    asyncRoute(async (req, res) => {
      const { approvalId, approved, note } = req.body as {
        approvalId?: string;
        approved?: boolean;
        note?: string;
      };
      if (typeof approvalId !== 'string' || typeof approved !== 'boolean') {
        res
          .status(400)
          .json({ error: "Request body must include 'approvalId' (string) and 'approved' (boolean)" });
        return;
      }
      try {
        const runs = workspaceOf(req).runs;
        await runs.approve(paramId(req), approvalId, approved, note);
        res.status(202).json(runs.status(paramId(req)));
      } catch (error) {
        respondWithMappedError(res, error, [
          [NoActiveRunError, 409],
          [AgentNotFoundError, 409],
        ]);
      }
    })
  );
}

/** The `ForkPatch` fields a fork request may carry, each with its check. */
const FORK_PATCH_CHECKS = new Map<string, (value: unknown) => boolean>([
  ['toolResult', (v) => isObject(v) && typeof v.toolCallId === 'string' && 'result' in v],
  ['appendInput', (v) => typeof v === 'string' && v.trim() !== ''],
  ['businessState', () => true],
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A validated `POST /runs/:id/fork` body, or the 400 message. */
function parseForkRequest(body: Partial<ForkRunRequest> | undefined): { fromStep: number; patch: ForkPatch } | string {
  const { fromStep, patch = {} } = body ?? {};
  if (!Number.isInteger(fromStep) || (fromStep as number) < 0) return "'fromStep' must be a non-negative integer";
  if (!isObject(patch)) return "'patch' must be an object";
  const invalid = Object.entries(patch).find(([key, value]) => !FORK_PATCH_CHECKS.get(key)?.(value));
  if (invalid) {
    return `'patch.${invalid[0]}' is invalid: 'patch' takes toolResult { toolCallId: string, result }, appendInput (a non-empty string) and businessState`;
  }
  return { fromStep: fromStep as number, patch };
}

/** `true` when the workspace knows the agent id - a saved spec, or a traces dir from a run whose spec was never saved. */
async function knownAgent(ws: WorkspaceContext, id: string): Promise<boolean> {
  return traceDirExists(ws.ref.root, id) || (await ws.agentStore.load(id)) !== undefined;
}

/** The persisted traces of an agent's runs (files under `.lousho/agents/<id>/traces`, the ones `lousho traces` reads). */
function registerTraceRoutes(app: Express): void {
  app.get(
    '/agents/:id/traces',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_TRACE_LIMIT) : DEFAULT_TRACE_LIMIT;
      if (!(await knownAgent(ws, paramId(req)))) {
        res.status(404).json({ error: `No saved agent '${paramId(req)}'` });
        return;
      }
      res.json({ traces: await listAgentTraces(ws.ref.root, paramId(req), limit) });
    })
  );

  app.get(
    '/agents/:id/traces/:traceId',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const traceId = Array.isArray(req.params.traceId) ? req.params.traceId[0] : req.params.traceId;
      if (!isValidTraceId(traceId)) {
        res.status(400).json({ error: 'Invalid trace id' });
        return;
      }
      if (!(await knownAgent(ws, paramId(req)))) {
        res.status(404).json({ error: `No saved agent '${paramId(req)}'` });
        return;
      }
      let spans;
      try {
        spans = await readAgentTrace(ws.ref.root, paramId(req), traceId);
      } catch (error) {
        if (error instanceof SDKError) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }
      if (spans.length === 0) {
        res.status(404).json({ error: `No trace '${traceId}' for agent '${paramId(req)}'` });
        return;
      }
      res.json({ traceId, spans });
    })
  );
}

/** Time travel: a run's step history, forking it from a step, and comparing two runs. */
function registerTimeTravelRoutes(app: Express): void {
  app.get(
    '/runs/compare',
    asyncRoute(async (req, res) => {
      const { a, b } = req.query;
      if (typeof a !== 'string' || typeof b !== 'string' || !isValidAgentId(a) || !isValidAgentId(b)) {
        res.status(400).json({ error: "Query must include valid run ids 'a' and 'b'" });
        return;
      }
      const comparison = await workspaceOf(req).runs.compare(a, b);
      if (!comparison) {
        res.status(404).json({ error: `No checkpoint for run '${a}' or '${b}'` });
        return;
      }
      res.json(comparison);
    })
  );

  app.get(
    '/runs/:id/history',
    asyncRoute(async (req, res) => {
      const steps = await workspaceOf(req).runs.history(paramId(req));
      if (!steps) {
        res.status(404).json({ error: `No checkpoint history for run '${paramId(req)}'` });
        return;
      }
      res.json({ runId: paramId(req), steps });
    })
  );

  app.post(
    '/runs/:id/fork',
    asyncRoute(async (req, res) => {
      const parsed = parseForkRequest(req.body as Partial<ForkRunRequest> | undefined);
      if (typeof parsed === 'string') {
        res.status(400).json({ error: parsed });
        return;
      }
      try {
        const runs = workspaceOf(req).runs;
        const runId = await runs.fork(paramId(req), parsed.fromStep, parsed.patch);
        res.status(202).json({ runId, fromStep: parsed.fromStep, status: runs.status(runId) } satisfies ForkRunResponse);
      } catch (error) {
        respondWithMappedError(res, error, [
          [AgentNotFoundError, 404],
          [ConfigurationError, 400],
          [SDKError, 404], // LOUSHO_CHECKPOINT_NOT_FOUND: no checkpoint at that step
        ]);
      }
    })
  );
}

/** Chat transport and multi-session history. */
function registerChatRoutes(app: Express): void {
  // Chat transport. `POST /agents/:id/message` appends a user message
  // and either continues the agent's existing conversation or starts a
  // fresh one (see RunManager.sendMessage()'s doc comment for the exact
  // continuation semantics); replies stream back over the existing
  // `WS /agents/:id/stream` channel as `{type:'chat', ...}` events, not a
  // separate response body here.
  app.post(
    '/agents/:id/message',
    asyncRoute(async (req, res) => {
      const { message, spec } = req.body as { message?: string; spec?: AgentSpec };
      if (typeof message !== 'string' || !message) {
        res.status(400).json({ error: "Request body must include a non-empty 'message' string" });
        return;
      }
      try {
        const ws = workspaceOf(req);
        const chatTrigger = ws.chatTriggers.get('chat') as ChatTriggerAdapter;
        await chatTrigger.trigger(paramId(req), message, spec);
        res.status(202).json(ws.runs.status(paramId(req)));
      } catch (error) {
        respondWithMappedError(res, error, [
          [AlreadyRunningError, 409],
          [ApprovalPendingError, 409],
          [AgentNotFoundError, 404],
          [ConfigurationError, 422],
        ]);
      }
    })
  );

  // Current live chat transcript (a REST snapshot mirroring the WS
  // stream's initial `{type:'chat'}` push, for a client that wants it
  // without opening a socket).
  app.get('/agents/:id/chat', (req, res) => {
    res.json(workspaceOf(req).runs.chatState(paramId(req)));
  });

  // Multi-session chat history - archives the current transcript and
  // starts a new, empty one.
  app.post('/agents/:id/chat/new', (req, res) => {
    res.json(workspaceOf(req).runs.newChat(paramId(req)));
  });

  app.get('/agents/:id/chats', (req, res) => {
    res.json(workspaceOf(req).runs.listChats(paramId(req)));
  });

  app.get('/agents/:id/chats/:sessionId', (req, res) => {
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    if (!isValidAgentId(sessionId)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const record = workspaceOf(req).runs.loadChatSession(paramId(req), sessionId);
    if (!record) {
      res.status(404).json({ error: `No chat session '${sessionId}' for agent '${paramId(req)}'` });
      return;
    }
    res.json(record);
  });
}

/** Step-debugger controls. */
function registerDebugRoutes(app: Express): void {
  // Step-through debugger controls (Topbar's "Debug" button). See
  // debugController.ts for exactly what "breakpoint"/"paused" mean given
  // AgentExecutor's real control surface.
  app.get('/agents/:id/debug', (req, res) => {
    res.json(workspaceOf(req).runs.debugState(paramId(req)));
  });

  app.put(
    '/agents/:id/debug/breakpoints',
    (req, res) => {
      const { breakpoints } = req.body as { breakpoints?: unknown };
      if (!Array.isArray(breakpoints) || !breakpoints.every((b) => typeof b === 'string')) {
        res.status(400).json({ error: "Request body must include a 'breakpoints' string array" });
        return;
      }
      const runs = workspaceOf(req).runs;
      runs.setBreakpoints(paramId(req), breakpoints);
      res.json(runs.debugState(paramId(req)));
    }
  );

  app.post('/agents/:id/debug/continue', (req, res) => {
    const runs = workspaceOf(req).runs;
    runs.continueRun(paramId(req));
    res.json(runs.debugState(paramId(req)));
  });

  app.post('/agents/:id/debug/step', (req, res) => {
    const runs = workspaceOf(req).runs;
    runs.stepRun(paramId(req));
    res.json(runs.debugState(paramId(req)));
  });
}

function registerProviderKeyRoutes(app: Express, secrets: SecretsStore): void {
  // ---------------------------------------------------------------------
  // Provider key management. GET only ever returns masked status
  // (never a real key - see secretsStore.ts's `list()`/`ProviderKeyStatus`).
  // ---------------------------------------------------------------------
  app.get('/settings/providers', (_req, res) => {
    res.json(secrets.list());
  });

  app.put(
    '/settings/providers/:provider',
    (req, res) => {
      const provider = req.params.provider;
      if (!isSecretProvider(provider)) {
        res.status(400).json({ error: `Unknown provider '${provider}'. Known: ${['openai', 'anthropic'].join(', ')}` });
        return;
      }
      const { apiKey } = req.body as { apiKey?: string };
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        res.status(400).json({ error: "Request body must include a non-empty 'apiKey' string" });
        return;
      }
      try {
        secrets.setKey(provider, apiKey);
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      // Never echo the key back - only the masked status, mirroring list().
      res.status(200).json(secrets.list().find((p) => p.provider === provider));
    }
  );

  app.delete('/settings/providers/:provider', (req, res) => {
    const provider = req.params.provider;
    if (!isSecretProvider(provider)) {
      res.status(400).json({ error: `Unknown provider '${provider}'` });
      return;
    }
    secrets.removeKey(provider);
    res.status(204).end();
  });
}

function registerProfileRoutes(app: Express, settings: SettingsStore): void {
  // ---------------------------------------------------------------------
  // Per-environment settings profiles.
  // ---------------------------------------------------------------------
  app.get('/settings/profiles', (_req, res) => {
    res.json(settings.list());
  });

  app.put('/settings/profiles/:profileId', (req, res) => {
    const profileId = req.params.profileId;
    const body = req.body as Partial<SettingsProfile>;
    if (
      typeof body.name !== 'string' ||
      typeof body.providerType !== 'string' ||
      typeof body.deployAdapter !== 'string' ||
      typeof body.otelEnabled !== 'boolean' ||
      typeof body.hookTimeoutMs !== 'number' ||
      body.hookTimeoutMs <= 0
    ) {
      res.status(400).json({
        error:
          "Request body must include 'name' (string), 'providerType' (string), 'deployAdapter' (string), 'otelEnabled' (boolean) and a positive 'hookTimeoutMs' (number)",
      });
      return;
    }
    const profile: SettingsProfile = {
      id: profileId,
      name: body.name,
      providerType: body.providerType,
      providerKeyRef: body.providerKeyRef,
      deployAdapter: body.deployAdapter,
      otelEnabled: body.otelEnabled,
      hookTimeoutMs: body.hookTimeoutMs,
      sandboxBackend: 'noop',
    };
    res.json(settings.upsertProfile(profile));
  });

  app.delete('/settings/profiles/:profileId', (req, res) => {
    try {
      res.json(settings.removeProfile(req.params.profileId));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/settings/profiles/:profileId/activate', (req, res) => {
    try {
      res.json(settings.setActive(req.params.profileId));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
}

function registerDeployRoutes(app: Express): void {
  // ---------------------------------------------------------------------
  // Deploy target picker + "Deploy this agent" action.
  // ---------------------------------------------------------------------
  app.get('/settings/deploy-adapters', (_req, res) => {
    res.json(DEPLOY_ADAPTERS);
  });

  app.post(
    '/agents/:id/deploy',
    asyncRoute(async (req, res) => {
      const { adapter } = req.body as { adapter?: string };
      if (typeof adapter !== 'string' || !isDeployAdapter(adapter)) {
        res.status(400).json({ error: `'adapter' must be one of: ${DEPLOY_ADAPTERS.join(', ')}` });
        return;
      }
      const ws = workspaceOf(req);
      const saved = await ws.agentStore.load(paramId(req));
      if (!saved) {
        res.status(404).json({ error: `No saved agent '${paramId(req)}' to deploy - save it first` });
        return;
      }
      const result = await runDeploy(ws.ref.root, paramId(req), adapter);
      res.status(result.exitCode === 0 ? 200 : 422).json(result);
    })
  );
}

function registerStaticClient(app: Express, staticDir: string | undefined): void {
  // Serve the pre-built client (production mode only - see `staticDir`'s
  // doc comment above). Registered after every API route above so a real
  // `/agents/**`/`/health` request is always handled by its own route first;
  // this only ever runs for requests those routes didn't match.
  const indexHtml = staticDir ? path.join(staticDir, 'index.html') : undefined;
  if (staticDir && indexHtml && fs.existsSync(indexHtml)) {
    app.use(express.static(staticDir));
    // SPA fallback: any remaining GET that isn't `/health` or `/agents/**`
    // (both already handled above) is a client-side route (React Router-less
    // `App.tsx` view state, but still refresh-safe) - serve `index.html` and
    // let the client app take over, the same as `vite preview`/most SPA
    // hosts do.
    app.get(/^(?!\/health|\/agents|\/runs|\/observe|\/playground|\/catalog|\/assistant).*/, (_req, res) => {
      res.sendFile(indexHtml);
    });
  }
}

/**
 * The context the `workspaceMiddleware` serves when the caller passed the
 * legacy `{agentStore, runManager}` form instead of a ready-built
 * `workspace`: the launch folder's ref around those two stores.
 */
function defaultWorkspaceContext(options: CreateAppOptions): WorkspaceContext {
  if (options.workspace) return options.workspace;
  const repo = new AgentRepo(options.baseDir);
  return {
    ref: workspaceRefFor(options.baseDir),
    repo,
    agentStore: options.agentStore,
    versions: new VersionStore(repo),
    drafts: new DraftStore(repo),
    runs: options.runManager,
    chatTriggers: chatTriggersFor(options.runManager),
  };
}

export function createApp(options: CreateAppOptions): Express {
  const { baseDir, staticDir, access, playgroundObserve, judge } = options;
  // The Studio home is process-wide and configured once, here, before any
  // request is served; request handlers never call studioPaths() - the
  // stores below close over the paths resolved now.
  const paths = configureStudioHome(options.studioHome ?? path.join(baseDir, '.lousho'));
  const secrets = options.secretsStore ?? new SecretsStore(paths);
  const settings = options.settingsStore ?? new SettingsStore(paths);
  const sessions = options.sessions ?? new AuthorSessionStore(paths.sessions);
  const workspace = defaultWorkspaceContext(options);

  const app = express();
  // Express 5 matches routes case-insensitively by default, so `/PLAYGROUND/run`
  // used to reach its handler past a case-sensitive gate. Set before the first
  // `app.use` (the router reads it when it is created).
  app.set('case sensitive routing', true);
  // No CORS middleware - the client is same-origin (served by
  // this server, or proxied by Vite in dev). Every request must name a
  // loopback Host and carry no foreign Origin; everything except a GET/HEAD of
  // `/health` or the static client also needs the token (see needsToken()).
  app.use((req, res, next) => {
    const decision = access
      ? needsToken(req)
        ? checkApiAccess(req, access)
        : checkHostAndOrigin(req, access)
      : checkHostAndOrigin(req, { token: '' });
    if (!decision.ok) {
      res.status(decision.status).json({ error: decision.error });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  // Resolve every request's workspace before the first route so handlers
  // read their per-workspace stores from workspaceOf(req), never a
  // closed-over singleton. Studio serves exactly one workspace today -
  // the launch folder - so this changes nothing user-visible.
  app.use(workspaceMiddleware(singleWorkspace(workspace)));

  app.get('/health', (_req, res) => res.status(200).send('ok'));

  // Every `/agents/:id/**` route below eventually turns `:id` into a
  // filesystem path segment (agent spec YAML, checkpoint/approval files -
  // see fsAgentStore.ts/checkpointStore.ts/approvalStore.ts). Reject
  // anything that isn't a safe single-segment token here, once, rather than
  // trusting each store to sanitize it - closes off path traversal via a
  // percent-encoded `..%2F..%2F...` id, which Express happily hands to
  // `req.params.id` as a decoded string containing `/`/`..`.
  app.use(['/agents/:id', '/runs/:id'], (req, res, next) => {
    if (!isValidAgentId(paramId(req))) {
      sendError(res, 400, 'Invalid agent id', 'LOUSHO_AGENT_ID_INVALID');
      return;
    }
    next();
  });

  registerAgentRoutes(app);
  // Draft routes: get/create/withdraw/approve/reject the per-agent pending
  // ChangeDraft (server/routes/draftRoutes.ts - stores come from
  // workspaceOf(req), the workspace seam).
  registerDraftRoutes(app);
  registerWorkspaceRoute(app);
  registerRunRoutes(app);
  registerChatRoutes(app);
  registerDebugRoutes(app);
  registerTimeTravelRoutes(app);
  registerTraceRoutes(app);
  registerProviderKeyRoutes(app, secrets);
  registerProfileRoutes(app, settings);
  registerDeployRoutes(app);
  registerPlaygroundRoute(app, { secretsStore: secrets, baseDir, ...(playgroundObserve ? { observe: playgroundObserve } : {}) });
  // The SDK catalogs + registry index the pickers and the Author read
  // (routes/catalogRoutes.ts) - a Studio-global route family, mounted on
  // every workspace's app like the settings routes are.
  registerCatalogRoutes(app, { secretsStore: secrets });
  // Agent Author chat sessions (Studio-global files under
  // studioPaths().sessions; each session records which workspace it edits).
  registerAuthorRoutes(app, { sessions });
  // The observe panels' read path: `/observe/**` -> the `lousho observe`
  // daemon (see observeProxy.ts), plus its small write allowlist (feedback
  // scores; bodies come from the express.json above) - before the SPA
  // fallback so a proxied GET never gets index.html.
  // Test-on-trace for judge rules runs here (the daemon has no provider keys); before the proxy.
  registerJudgeTestRoute(app, { secretsStore: secrets, ...(judge ? { judge } : {}) });
  registerObserveProxy(app);
  registerStaticClient(app, staticDir);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
