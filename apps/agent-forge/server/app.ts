/**
 * LOU-N runtime control server - HTTP API (N1).
 *
 * Routes:
 *   GET  /health                     -> 200 'ok'
 *   GET  /agents                     -> AgentStoreEntry[] (saved agent specs on disk)
 *   GET  /agents/:id                 -> AgentSpec | 404
 *   PUT  /agents/:id                 -> save an AgentSpec to disk (body: AgentSpec)
 *   POST /agents/:id/run             -> body: { spec?: AgentSpec, input: string }
 *   POST /agents/:id/stop            -> abort the in-flight run, if any
 *   GET  /agents/:id/status          -> AgentRunStatusPayload
 *   POST /agents/:id/approve         -> body: { approvalId, approved, note? }
 *   GET  /runs/:id/history           -> RunHistoryPayload (LOU-D45 time travel)
 *   POST /runs/:id/fork              -> body: ForkRunRequest; starts the fork, 202 ForkRunResponse
 *   GET  /runs/compare?a=&b=         -> RunComparisonPayload (compareTrajectories)
 *
 * `WS /agents/:id/stream` is wired separately in wsServer.ts (attached to
 * the same underlying http.Server, since `ws` needs the raw HTTP upgrade
 * event rather than an Express route).
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
import cors from 'cors';
import { ConfigurationError, SDKError, type AgentSpec, type ForkPatch } from '@loushy/build-ai-agent';
import { TriggerRegistry } from '@loushy/build-ai-agent/triggers';
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
import type { ForkRunRequest, ForkRunResponse, SettingsProfile } from '../shared/wireTypes';
import { DEPLOY_ADAPTERS, isDeployAdapter, runDeploy } from './deployRunner';

export interface CreateAppOptions {
  agentStore: AgentStore;
  runManager: RunManager;
  /** Directory `.loushy/**` lives under - same `baseDir` the server was started with. Required for R1/R2/R3's routes. */
  baseDir: string;
  /** R1: defaults to `new SecretsStore(baseDir)` when omitted. */
  secretsStore?: SecretsStore;
  /** R3: defaults to `new SettingsStore(baseDir)` when omitted. */
  settingsStore?: SettingsStore;
  /**
   * S1 (LOU-S): directory holding the pre-built Agent Forge client (the
   * output of `vite build`, normally `apps/agent-forge/dist`). When set and
   * it actually contains an `index.html`, this server serves it as static
   * files plus a SPA fallback, so `loushy studio --prod` can serve the whole
   * app - API and UI - from this one Express server/port instead of needing
   * a separate Vite dev server process. Omitted (or pointing at a directory
   * without a build) in dev mode, where the real Vite dev server (with HMR)
   * serves the UI instead and proxies `/agents/**` to this server - see
   * `src/cli/studio.ts`.
   */
  staticDir?: string;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
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

/**
 * Express 5's `req.params[name]` is typed `string | string[]` (a route
 * param can repeat, e.g. `/:id+`). None of this file's routes use repeating
 * params, so `:id` is always a single string in practice - this just
 * narrows the type for TS rather than changing any behavior.
 */
function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

/** Saved-agent CRUD: list, load, save. */
function registerAgentRoutes(app: Express, agentStore: AgentStore): void {
  app.get(
    '/agents',
    asyncRoute(async (_req, res) => {
      res.json(await agentStore.list());
    })
  );

  app.get(
    '/agents/:id',
    asyncRoute(async (req, res) => {
      const spec = await agentStore.load(paramId(req));
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
      const spec = req.body as AgentSpec;
      if (!spec || typeof spec !== 'object' || !spec.name || !spec.prompt || !spec.provider) {
        res.status(400).json({ error: 'Request body must be a valid AgentSpec' });
        return;
      }
      await agentStore.save(paramId(req), spec);
      res.status(204).end();
    })
  );
}

/** Run lifecycle: start, stop, status, and resolving a pending tool approval. */
function registerRunRoutes(app: Express, runManager: RunManager): void {
  app.post(
    '/agents/:id/run',
    asyncRoute(async (req, res) => {
      const { spec, input } = req.body as { spec?: AgentSpec; input?: string };
      if (typeof input !== 'string' || !input) {
        res.status(400).json({ error: "Request body must include a non-empty 'input' string" });
        return;
      }
      try {
        await runManager.run(paramId(req), input, spec);
        res.status(202).json(runManager.status(paramId(req)));
      } catch (error) {
        respondWithMappedError(res, error, [
          [AlreadyRunningError, 409],
          [AgentNotFoundError, 404],
        ]);
      }
    })
  );

  app.post('/agents/:id/stop', (req, res) => {
    runManager.stop(paramId(req));
    res.status(202).json(runManager.status(paramId(req)));
  });

  app.get('/agents/:id/status', (req, res) => {
    res.json(runManager.status(paramId(req)));
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
        await runManager.approve(paramId(req), approvalId, approved, note);
        res.status(202).json(runManager.status(paramId(req)));
      } catch (error) {
        respondWithMappedError(res, error, [
          [NoActiveRunError, 409],
          [AgentNotFoundError, 409],
        ]);
      }
    })
  );
}

/** LOU-D45: the `ForkPatch` fields a fork request may carry, each with its check. */
const FORK_PATCH_CHECKS = new Map<string, (value: unknown) => boolean>([
  ['toolResult', (v) => isObject(v) && typeof v.toolCallId === 'string' && 'result' in v],
  ['appendInput', (v) => typeof v === 'string' && v.trim() !== ''],
  ['businessState', () => true],
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** LOU-D45: a validated `POST /runs/:id/fork` body, or the 400 message. */
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

/** LOU-D45 time travel: a run's step history, forking it from a step, and comparing two runs. */
function registerTimeTravelRoutes(app: Express, runManager: RunManager): void {
  app.get(
    '/runs/compare',
    asyncRoute(async (req, res) => {
      const { a, b } = req.query;
      if (typeof a !== 'string' || typeof b !== 'string' || !isValidAgentId(a) || !isValidAgentId(b)) {
        res.status(400).json({ error: "Query must include valid run ids 'a' and 'b'" });
        return;
      }
      const comparison = await runManager.compare(a, b);
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
      const steps = await runManager.history(paramId(req));
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
        const runId = await runManager.fork(paramId(req), parsed.fromStep, parsed.patch);
        res.status(202).json({ runId, fromStep: parsed.fromStep, status: runManager.status(runId) } satisfies ForkRunResponse);
      } catch (error) {
        respondWithMappedError(res, error, [
          [AgentNotFoundError, 404],
          [ConfigurationError, 400],
          [SDKError, 404], // LOUSHY_CHECKPOINT_NOT_FOUND: no checkpoint at that step
        ]);
      }
    })
  );
}

/** P1/P3 chat transport and multi-session history. */
function registerChatRoutes(app: Express, runManager: RunManager, triggerRegistry: TriggerRegistry): void {
  // P1: chat transport. `POST /agents/:id/message` appends a user message
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
        const chatTrigger = triggerRegistry.get('chat') as ChatTriggerAdapter;
        await chatTrigger.trigger(paramId(req), message, spec);
        res.status(202).json(runManager.status(paramId(req)));
      } catch (error) {
        respondWithMappedError(res, error, [
          [AlreadyRunningError, 409],
          [ApprovalPendingError, 409],
          [AgentNotFoundError, 404],
        ]);
      }
    })
  );

  // P1: current live chat transcript (a REST snapshot mirroring the WS
  // stream's initial `{type:'chat'}` push, for a client that wants it
  // without opening a socket).
  app.get('/agents/:id/chat', (req, res) => {
    res.json(runManager.chatState(paramId(req)));
  });

  // P3: multi-session chat history - archives the current transcript and
  // starts a new, empty one.
  app.post('/agents/:id/chat/new', (req, res) => {
    res.json(runManager.newChat(paramId(req)));
  });

  app.get('/agents/:id/chats', (req, res) => {
    res.json(runManager.listChats(paramId(req)));
  });

  app.get('/agents/:id/chats/:sessionId', (req, res) => {
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    if (!isValidAgentId(sessionId)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const record = runManager.loadChatSession(paramId(req), sessionId);
    if (!record) {
      res.status(404).json({ error: `No chat session '${sessionId}' for agent '${paramId(req)}'` });
      return;
    }
    res.json(record);
  });
}

/** O3 step-debugger controls. */
function registerDebugRoutes(app: Express, runManager: RunManager): void {
  // O3: step-through debugger controls (Topbar's "Debug" button). See
  // debugController.ts for exactly what "breakpoint"/"paused" mean given
  // AgentExecutor's real control surface.
  app.get('/agents/:id/debug', (req, res) => {
    res.json(runManager.debugState(paramId(req)));
  });

  app.put(
    '/agents/:id/debug/breakpoints',
    (req, res) => {
      const { breakpoints } = req.body as { breakpoints?: unknown };
      if (!Array.isArray(breakpoints) || !breakpoints.every((b) => typeof b === 'string')) {
        res.status(400).json({ error: "Request body must include a 'breakpoints' string array" });
        return;
      }
      runManager.setBreakpoints(paramId(req), breakpoints);
      res.json(runManager.debugState(paramId(req)));
    }
  );

  app.post('/agents/:id/debug/continue', (req, res) => {
    runManager.continueRun(paramId(req));
    res.json(runManager.debugState(paramId(req)));
  });

  app.post('/agents/:id/debug/step', (req, res) => {
    runManager.stepRun(paramId(req));
    res.json(runManager.debugState(paramId(req)));
  });
}

function registerProviderKeyRoutes(app: Express, secrets: SecretsStore): void {
  // ---------------------------------------------------------------------
  // LOU-R1: provider key management. GET only ever returns masked status
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
  // LOU-R3: per-environment settings profiles.
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

function registerDeployRoutes(app: Express, agentStore: AgentStore, baseDir: string): void {
  // ---------------------------------------------------------------------
  // LOU-R2: deploy target picker + "Deploy this agent" action.
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
      const saved = await agentStore.load(paramId(req));
      if (!saved) {
        res.status(404).json({ error: `No saved agent '${paramId(req)}' to deploy - save it first` });
        return;
      }
      const result = await runDeploy(baseDir, paramId(req), adapter);
      res.status(result.exitCode === 0 ? 200 : 422).json(result);
    })
  );
}

function registerStaticClient(app: Express, staticDir: string | undefined): void {
  // S1: serve the pre-built client (production mode only - see `staticDir`'s
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
    app.get(/^(?!\/health|\/agents|\/runs).*/, (_req, res) => {
      res.sendFile(indexHtml);
    });
  }
}

export function createApp({
  agentStore,
  runManager,
  baseDir,
  secretsStore,
  settingsStore,
  staticDir,
}: CreateAppOptions): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const secrets = secretsStore ?? new SecretsStore(baseDir);
  const settings = settingsStore ?? new SettingsStore(baseDir);

  // LOU-T5: `POST /agents/:id/message` below is routed through a
  // TriggerRegistry-registered ChatTriggerAdapter rather than calling
  // `runManager.sendMessage()` directly - see chatTriggerAdapter.ts for why
  // this is a behavior-preserving wrapper, not a rewrite.
  const triggerRegistry = new TriggerRegistry();
  triggerRegistry.register('chat', new ChatTriggerAdapter(runManager));

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
      res.status(400).json({ error: 'Invalid agent id' });
      return;
    }
    next();
  });

  registerAgentRoutes(app, agentStore);
  registerRunRoutes(app, runManager);
  registerChatRoutes(app, runManager, triggerRegistry);
  registerDebugRoutes(app, runManager);
  registerTimeTravelRoutes(app, runManager);
  registerProviderKeyRoutes(app, secrets);
  registerProfileRoutes(app, settings);
  registerDeployRoutes(app, agentStore, baseDir);
  registerStaticClient(app, staticDir);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
