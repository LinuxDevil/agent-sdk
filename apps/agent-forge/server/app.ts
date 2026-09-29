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
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import type { AgentSpec } from '@loushy/build-ai-agent';
import type { AgentStore } from '../src/persistence/AgentStore';
import { RunManager, AgentNotFoundError, AlreadyRunningError, NoActiveRunError } from './runRegistry';
import { isValidAgentId } from './types';

export interface CreateAppOptions {
  agentStore: AgentStore;
  runManager: RunManager;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
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

export function createApp({ agentStore, runManager }: CreateAppOptions): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.status(200).send('ok'));

  // Every `/agents/:id/**` route below eventually turns `:id` into a
  // filesystem path segment (agent spec YAML, checkpoint/approval files -
  // see fsAgentStore.ts/checkpointStore.ts/approvalStore.ts). Reject
  // anything that isn't a safe single-segment token here, once, rather than
  // trusting each store to sanitize it - closes off path traversal via a
  // percent-encoded `..%2F..%2F...` id, which Express happily hands to
  // `req.params.id` as a decoded string containing `/`/`..`.
  app.use('/agents/:id', (req, res, next) => {
    if (!isValidAgentId(paramId(req))) {
      res.status(400).json({ error: 'Invalid agent id' });
      return;
    }
    next();
  });

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
        if (error instanceof AlreadyRunningError) {
          res.status(409).json({ error: error.message });
          return;
        }
        if (error instanceof AgentNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
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
        if (error instanceof NoActiveRunError || error instanceof AgentNotFoundError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
