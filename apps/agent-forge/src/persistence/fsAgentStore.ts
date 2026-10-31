import type { AgentSpec } from 'lousho';
import type { AgentStore, AgentStoreEntry } from './AgentStore';
import { AgentRepo } from '../../server/storage/agentRepo';
import { mergeLegacySave, toLegacySpec } from '../../server/storage/legacySpec';
import { withAgentLock } from '../../server/storage/atomic';
import { VersionStore } from '../../server/storage/versionStore';

/**
 * Filesystem-backed `AgentStore` - a v1 facade over `AgentRepo`, which owns
 * `<baseDir>/.lousho/agents/<id>.yaml` as an AgentSpec v2 working copy plus
 * the `meta.json` / `layout.json` / `working.json` sidecars.
 *
 * Every caller of this interface (the routes, RunManager, deploy) still
 * speaks AgentSpec v1, so reads project the stored spec down
 * (`toLegacySpec`) and saves merge the v1 body onto the stored v2 spec
 * (`mergeLegacySave`) - the file on disk is v2 while nothing user-visible
 * changes. The `save` read-modify-write runs inside `withAgentLock(id)`;
 * `AgentRepo` itself stays lock-free.
 *
 * The studio server (server/index.ts) serves this store over
 * `GET/PUT/DELETE /agents`, and the browser app reads it through
 * `HttpAgentStore` - so the agent list is exactly
 * `.lousho/agents/` of the directory `lousho studio` was started in.
 */
/**
 * The `AgentStore` over `baseDir`'s `.lousho/agents`. `repo` is the
 * `AgentRepo` for the same workspace root - the workspace context passes
 * its own so every per-workspace store shares one repo; it defaults to a
 * fresh `AgentRepo(baseDir)` for callers that only want the store.
 */
export function createFsAgentStore(baseDir: string, repo: AgentRepo = new AgentRepo(baseDir)): AgentStore {
  const versions = new VersionStore(repo);
  return {
    async list(): Promise<AgentStoreEntry[]> {
      const entries: AgentStoreEntry[] = [];
      for (const id of repo.listIds()) {
        // The studio lists this directory now, so one hand-edited
        // file that no longer parses is skipped instead of failing the
        // whole list (repo.listIds already filtered invalid ids).
        try {
          const spec = await repo.readSpec(id);
          if (spec === undefined) continue;
          entries.push({ id, spec: toLegacySpec(spec), updatedAt: repo.updatedAt(id) });
        } catch (error) {
          console.warn(`[agent-forge] skipping unreadable agent spec '${id}': ${(error as Error).message}`);
        }
      }
      return entries;
    },

    async load(id: string): Promise<AgentSpec | undefined> {
      const spec = await repo.readSpec(id);
      return spec === undefined ? undefined : toLegacySpec(spec);
    },

    async save(id: string, spec: AgentSpec): Promise<void> {
      // One lock around the whole read-modify-write: read the stored v2
      // spec, merge the v1 save onto it (preserving the v2-only keys the
      // v1 body cannot express), validate and write atomically.
      await withAgentLock(id, async () => {
        // If the yaml on disk was edited outside Studio since our last
        // write, preserve that content as a baseline version before we
        // overwrite it. Autosave still writes no version of its own.
        await versions.reconcileExternalEdit(id);
        await repo.writeSpec(id, mergeLegacySave(await repo.readSpec(id), spec));
      });
    },

    async remove(id: string): Promise<void> {
      await repo.remove(id);
    },
  };
}
