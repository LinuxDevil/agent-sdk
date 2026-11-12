/**
 * The `AgentRecord` assembler shared by the agent routes and the import
 * routes: spec + meta + layout + latest version for one id, `undefined`
 * when the agent has no spec file. `requirements` is NOT included - the
 * `GET /agents/:id` route computes it per request.
 */
import type { AgentRecord } from '../shared/wireTypes';
import type { WorkspaceContext } from './workspace/context';

/** One agent's `AgentRecord`; `undefined` when it has no spec file. */
export async function readAgentRecord(ws: WorkspaceContext, id: string): Promise<AgentRecord | undefined> {
  const spec = await ws.repo.readSpec(id);
  if (spec === undefined) return undefined;
  const [meta, layout, latest] = await Promise.all([ws.repo.readMeta(id), ws.repo.readLayout(id), ws.versions.latest(id)]);
  return { id, spec, meta, layout, updatedAt: ws.repo.updatedAt(id), latestVersion: latest?.version ?? null };
}
