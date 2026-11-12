/**
 * Duplicate an agent (L10): `POST /agents { from: { copyOf } }` writes a
 * new agent under `resolveNextCopyId` (`<id>-copy`, `<id>-copy-2`, …) with
 * a `structuredClone` of the source spec renamed `'<name> copy'` (or the
 * body's `name`), the source's labels and canvas layout - sticky notes get
 * fresh ids so the two layouts never share one - `enabled: false` meta
 * with `createdFrom: { kind: 'copy', ref }`, `publishedVersion: null` and
 * `failureStreak: 0`, and exactly one `create` version. Versions, drafts,
 * suggestions, traces, chats, approvals and checkpoints are NOT copied -
 * the new id has no sidecar dir until this write.
 */
import { randomUUID } from 'node:crypto';
import type { AgentSpecV2 } from 'lousho';

import { isValidAgentId } from '../../shared/agentId';
import type { AgentMeta, AgentRecord, CanvasLayout } from '../../shared/wireTypes';
import { readAgentRecord } from '../agentRecord';
import { defaultMeta } from '../storage/agentRepo';
import { agentIdTaken } from '../storage/agentIds';
import { withAgentLock } from '../storage/atomic';
import type { WorkspaceContext } from '../workspace/context';
import { resolveNextCopyId } from './agentIds';

/**
 * The layout with every sticky note re-idded: note ids are only unique
 * within one `layout.json`, but a copy should not share ids with its
 * source - a later merge or note operation must never confuse the two.
 */
function withFreshNoteIds(layout: CanvasLayout): CanvasLayout {
  if (layout.notes.length === 0) return layout;
  return {
    ...layout,
    notes: layout.notes.map((note) => ({ ...note, id: `n${randomUUID()}` })),
  };
}

/**
 * The copy `POST /agents` writes, or `undefined` when `copyOf` is not a
 * valid id or names no saved agent (the route answers 404). Everything
 * lands inside `withAgentLock(newId)` like every other create.
 */
export async function copyAgent(
  ws: WorkspaceContext,
  copyOf: string,
  name: string | undefined
): Promise<AgentRecord | undefined> {
  if (!isValidAgentId(copyOf)) return undefined;
  const source = await ws.repo.readSpec(copyOf);
  if (source === undefined) return undefined;

  const spec: AgentSpecV2 = structuredClone(source);
  spec.name = name ?? `${source.name.slice(0, 59)} copy`;
  const meta: AgentMeta = {
    ...defaultMeta(new Date().toISOString()),
    enabled: false,
    labels: (await ws.repo.readMeta(copyOf)).labels,
    createdFrom: { kind: 'copy', ref: copyOf },
  };
  const layout = withFreshNoteIds(await ws.repo.readLayout(copyOf));
  const id = await resolveNextCopyId(copyOf, (candidate) => agentIdTaken(ws.repo, candidate));

  await withAgentLock(id, async () => {
    await ws.repo.writeSpec(id, spec);
    await ws.repo.writeMeta(id, meta);
    await ws.repo.writeLayout(id, layout);
    await ws.versions.capture(id, { kind: 'create', source: 'copy' });
  });
  const record = await readAgentRecord(ws, id);
  if (record === undefined) throw new Error(`Agent '${id}' vanished right after copying`);
  return record;
}
