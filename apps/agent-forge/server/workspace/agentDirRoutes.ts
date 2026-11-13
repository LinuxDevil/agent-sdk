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
import type { CodeAgentSpecResponse } from '../../shared/wireTypes';
import { asyncRoute, sendError } from '../http/routeUtils';
import { workspaceOf } from './middleware';
import { agentConfigFile, findAgentDirs, resolveAgentDir } from './agentDirs';

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

export function registerAgentDirRoutes(app: Express): void {
  app.get(
    '/workspace/agent-dirs',
    asyncRoute(async (req, res) => {
      res.json(await findAgentDirs(workspaceOf(req).ref.root));
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
