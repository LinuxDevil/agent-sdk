/**
 * Eject route (A08b): `POST /agents/:id/eject` writes the agent's
 * agent-directory form (`specToAgentDir`) to `agents/<id>/` under the
 * request's workspace root - the Code tab's exit from the read-only canvas
 * to hand-written code (PLAN §16 decision 1).
 *
 * The workspace seam applies: `workspaceOf(req)` names the root, so a
 * `?ws=` request ejects into its own folder. Writes go through
 * `writeFileAtomic` inside `withAgentLock(id)` like every other spec write.
 * Generated paths are re-validated before touching disk: anything absolute
 * or containing `..` is a 400, and the resolved target must stay inside the
 * eject directory (checked with `path.relative`, not string prefixes).
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { specToAgentDir } from '@linuxdevil/lousho/spec';
import type { EjectResult } from '../shared/wireTypes';
import { asyncRoute, sendError } from './http/routeUtils';
import { withAgentLock, writeFileAtomic } from './storage/atomic';
import { readSpecOr404 } from './workspace/specLookup';

/** The eject body: `{ overwrite?: boolean }`, default false; anything else reads as false. */
function wantsOverwrite(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { overwrite?: unknown }).overwrite === true;
}

/**
 * Whether a generated path could escape the eject directory: absolute
 * (POSIX or Windows), a `..` segment, or a NUL byte. `specToAgentDir`
 * never emits these today; the check is the contract's safety rail.
 */
function isUnsafeRelPath(rel: string): boolean {
  return (
    rel === '' ||
    rel.includes(String.fromCharCode(0)) ||
    path.isAbsolute(rel) ||
    /^[a-zA-Z]:[\\/]/.test(rel) ||
    rel.split(/[\\/]/).some((seg) => seg === '..')
  );
}

/** Every file under `dir`, paths relative to it with '/' separators; [] when `dir` is absent. */
async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = async (cur: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/** The `{ overwrite }` parse plus the spec read; undefined means a response was already sent. */
async function loadEjectInput(req: Request, res: Response) {
  const input = await readSpecOr404(req, res, (id) => `Agent ${id} not found.`);
  if (input === undefined) return undefined;
  const { ws, id, spec } = input;
  let generated;
  try {
    generated = specToAgentDir(spec);
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error), 'LOUSHO_EJECT_INVALID');
    return undefined;
  }
  if (generated.files.some((f) => isUnsafeRelPath(f.path))) {
    sendError(res, 400, 'The agent directory generated a path outside the target folder.', 'LOUSHO_EJECT_INVALID');
    return undefined;
  }
  return { ws, id, files: generated.files };
}

export function registerEjectRoutes(app: Express): void {
  app.post(
    '/agents/:id/eject',
    asyncRoute(async (req: Request, res: Response) => {
      const input = await loadEjectInput(req, res);
      if (input === undefined) return;
      const { ws, id, files } = input;
      const dirRel = `agents/${id}`;
      const dirAbs = path.join(ws.ref.root, 'agents', id);
      const overwrite = wantsOverwrite(req.body);

      const existing = await listFiles(dirAbs);
      if (existing.length > 0 && !overwrite) {
        sendError(res, 409, `${dirRel}/ already exists.`, 'LOUSHO_EJECT_EXISTS', { files: existing });
        return;
      }

      const dirResolved = path.resolve(dirAbs);
      await withAgentLock(id, async () => {
        for (const file of files) {
          const target = path.resolve(dirResolved, file.path);
          // Belt to the generation check's braces: a resolved target must
          // stay inside the eject directory.
          const rel = path.relative(dirResolved, target);
          if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Refusing to write outside ${dirRel}: ${file.path}`);
          }
          await writeFileAtomic(target, file.content);
        }
      });

      const result: EjectResult = { dir: dirRel, files: files.map((f) => f.path) };
      res.json(result);
    })
  );
}
