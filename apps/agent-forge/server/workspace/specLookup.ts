/**
 * The shared "load this agent's spec or answer 404" lookup the per-agent
 * POST routes repeat: `workspaceOf(req)` picks the workspace, `paramId`
 * the id, `repo.readSpec` the spec. `notFoundMessage` formats the 404
 * body per route. Returns `undefined` once the 404 is sent so the caller
 * can early-return.
 */
import type { Request, Response } from 'express';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { paramId, sendError } from '../http/routeUtils';
import { workspaceOf } from './middleware';
import type { WorkspaceContext } from './context';

export async function readSpecOr404(
  req: Request,
  res: Response,
  notFoundMessage: (id: string) => string
): Promise<{ ws: WorkspaceContext; id: string; spec: AgentSpecV2 } | undefined> {
  const ws = workspaceOf(req);
  const id = paramId(req);
  const spec = await ws.repo.readSpec(id);
  if (spec === undefined) {
    sendError(res, 404, notFoundMessage(id), 'LOUSHO_AGENT_NOT_FOUND');
    return undefined;
  }
  return { ws, id, spec };
}
