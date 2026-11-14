/**
 * The `AgentRecord` assembler shared by the agent routes and the import
 * routes: spec + meta + layout + latest version + publish state for one
 * id, `undefined` when the agent has no spec file. `requirements` is NOT
 * included - the `GET /agents/:id` route computes it per request.
 */
import type { AgentRecord } from '../shared/wireTypes';
import { publishStateOf, readPublishedSpec } from './lifecycle/publish';
import { specHash } from './storage/specHash';
import type { WorkspaceContext } from './workspace/context';

/** One agent's `AgentRecord`; `undefined` when it has no spec file. */
export async function readAgentRecord(ws: WorkspaceContext, id: string): Promise<AgentRecord | undefined> {
  const spec = await ws.repo.readSpec(id);
  if (spec === undefined) return undefined;
  const [meta, layout, latest, published] = await Promise.all([
    ws.repo.readMeta(id),
    ws.repo.readLayout(id),
    ws.versions.latest(id),
    readPublishedSpec(id, { repo: ws.repo, versions: ws.versions }),
  ]);
  // The pinned version's item carries the specHash/createdAt publishStateOf
  // needs; readPublishedSpec already proved the record exists.
  const publishedItem = published === undefined ? undefined : await ws.versions.get(id, published.version);
  return {
    id,
    spec,
    meta,
    layout,
    updatedAt: ws.repo.updatedAt(id),
    latestVersion: latest?.version ?? null,
    publishState: publishStateOf(meta, specHash(spec), publishedItem),
  };
}
