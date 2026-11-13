/**
 * `/workspace/agent-dirs` routes (X06a): discover agent directories under
 * the request's workspace root and read a data-config directory back as an
 * `AgentSpecV2` for the read-only canvas (X06b).
 *
 * Both handlers scan `workspaceOf(req).ref.root` - the workspace seam -
 * so a `?ws=` request always sees its own folder. TRUST NOTE: for a code
 * config (`agent.ts`/`agent.js`) `agentDirToSpec` refuses with
 * LOUSHO_SPEC_UNSUPPORTED rather than importing the file, so this route
 * never executes workspace code - the same guarantee `lousho dev`'s spec
 * reader gives. Data configs are parsed, never imported.
 */
import { stat } from 'node:fs/promises';
import type { Express, Request, Response } from 'express';
import { agentDirToSpec, SDKError } from 'lousho';
import type { CodeAgentSpecResponse, WorkspaceScanResult } from '../../shared/wireTypes';
import { asyncRoute, sendError } from '../http/routeUtils';
import { workspaceOf } from './middleware';
import { agentConfigFile, resolveAgentDir } from './agentDirs';
import type { CodeAgentCache } from './codeAgentScan';
import type { WorkspaceRegistry } from './workspaceRegistry';

/** What the routes need beyond `app`: the shared scan cache and the registry (for the entry's stored `agentDirs`). */
export interface AgentDirRouteDeps {
  codeAgents: CodeAgentCache;
  registry: WorkspaceRegistry;
}

interface CacheEntry {
  mtimeMs: number;
  response: CodeAgentSpecResponse;
}

/**
 * Spec responses cached by workspace+path, invalidated on the config
 * file's mtime - the canvas reloads this route often and agent directories
 * are small, so 50 entries is plenty. Insertion-ordered Map = FIFO.
 */
const specCache = new Map<string, CacheEntry>();
const SPEC_CACHE_LIMIT = 50;

function cacheKey(root: string, rel: string): string {
  return `${root}\n${rel}`;
}

async function configMtime(absDir: string, configFile: string): Promise<number> {
  return (await stat(`${absDir}/${configFile}`)).mtimeMs;
}

function cacheGet(key: string, mtimeMs: number): CodeAgentSpecResponse | undefined {
  const hit = specCache.get(key);
  return hit !== undefined && hit.mtimeMs === mtimeMs ? hit.response : undefined;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (specCache.size >= SPEC_CACHE_LIMIT) {
    const oldest = specCache.keys().next().value;
    if (oldest !== undefined) specCache.delete(oldest);
  }
  specCache.set(key, entry);
}

/**
 * Whether `rel` is syntactically a traversal/absolute path - the 400 cases
 * of the contract. Well-formed misses (a plain nonexistent dir) are the
 * caller's 404 instead.
 */
function isEscapingPath(rel: string): boolean {
  return (
    rel.startsWith('/') ||
    rel.startsWith('\\\\') ||
    /^[a-zA-Z]:[\\/]/.test(rel) ||
    rel.split(/[\\/]/).some((s) => s === '..')
  );
}

/**
 * The request workspace's scan result, shared with `GET
 * /workspaces/:ws/scan` and `GET /agents?ws=all` (W08a): the cached
 * result when present, a fresh pattern scan otherwise. The registry
 * entry supplies the stored `agentDirs`; `ctx.ref` is the fallback (it
 * is the same object the registry handed the context builder).
 */
async function scanFor(
  req: Request,
  deps: AgentDirRouteDeps
): Promise<WorkspaceScanResult> {
  const ctx = workspaceOf(req);
  const entry = (await deps.registry.get(ctx.ref.id)) ?? { ...ctx.ref };
  return deps.codeAgents.get(entry.id) ?? deps.codeAgents.scan(entry);
}

export function registerAgentDirRoutes(app: Express, deps: AgentDirRouteDeps): void {
  app.get(
    '/workspace/agent-dirs',
    asyncRoute(async (req, res) => {
      res.json((await scanFor(req, deps)).agents);
    })
  );

  app.get(
    '/workspace/agent-dirs/spec',
    asyncRoute(async (req: Request, res: Response) => {
      const rel = req.query.path;
      const root = workspaceOf(req).ref.root;
      if (typeof rel !== 'string' || rel === '') {
        sendError(res, 400, 'path must be a directory inside the workspace', 'LOUSHO_REQUEST_INVALID');
        return;
      }
      if (isEscapingPath(rel)) {
        sendError(res, 400, 'path must be a directory inside the workspace', 'LOUSHO_REQUEST_INVALID');
        return;
      }
      // W08a: only directories the pattern scan listed are spec-readable -
      // the canvas and the list can never disagree about what exists.
      const scan = await scanFor(req, deps);
      const listed = rel.split('\\').join('/');
      if (!scan.agents.some((agent) => agent.path === listed)) {
        res.status(404).json({ error: `No agent directory at '${rel}'` });
        return;
      }
      const abs = await resolveAgentDir(root, rel);
      if (abs === undefined) {
        res.status(404).json({ error: `No agent directory at '${rel}'` });
        return;
      }
      const configFile = await agentConfigFile(abs);
      const mtimeMs = configFile === undefined ? 0 : await configMtime(abs, configFile);
      const key = cacheKey(root, rel);
      const cached = cacheGet(key, mtimeMs);
      if (cached !== undefined) {
        res.json(cached);
        return;
      }
      try {
        const { spec, dropped } = await agentDirToSpec(abs);
        const response: CodeAgentSpecResponse = {
          path: rel,
          spec,
          warnings: dropped.map((d) => `${d.field}: ${d.reason}`),
        };
        cacheSet(key, { mtimeMs, response });
        res.json(response);
      } catch (error) {
        if (error instanceof SDKError) {
          sendError(res, 422, error.message, error.code);
          return;
        }
        throw error;
      }
    })
  );
}
