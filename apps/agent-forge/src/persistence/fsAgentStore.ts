import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadSpec, type AgentSpec } from '@lousho/build-ai-agent';
import type { AgentStore, AgentStoreEntry } from './AgentStore';
import { isValidAgentId } from '../../shared/agentId';

/**
 * Filesystem-backed `AgentStore`, saving/loading plain `AgentSpec` YAML
 * files under `<baseDir>/.lousho/agents/<id>.yaml`. Deliberately reuses the
 * core SDK's `loadSpec()` for reading (so files this store writes validate
 * and load exactly the way any other AgentSpec YAML file does) and the same
 * `yaml` package for writing - there is only one AgentSpec file format in
 * this repo, not a second bespoke one for the app.
 *
 * The studio server (server/index.ts) serves this store over
 * `GET/PUT/DELETE /agents`, and the browser app reads it through
 * `HttpAgentStore` (Eve DUI-F2) - so the agent list is exactly
 * `.lousho/agents/` of the directory `lousho studio` was started in.
 */
/** Where `createFsAgentStore(baseDir)` reads/writes agent `id`'s spec - exposed (LOU-R2) so the runtime server's deploy route can hand `lousho build --agent=<path>` the exact file this store manages, without duplicating the `.lousho/agents/<id>.yaml` convention. */
export function agentSpecFilePath(baseDir: string, id: string): string {
  return path.join(baseDir, '.lousho', 'agents', `${id}.yaml`);
}

export function createFsAgentStore(baseDir: string): AgentStore {
  const agentsDir = path.join(baseDir, '.lousho', 'agents');

  function filePath(id: string): string {
    return agentSpecFilePath(baseDir, id);
  }

  function ensureDir(): void {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  return {
    async list(): Promise<AgentStoreEntry[]> {
      if (!fs.existsSync(agentsDir)) return [];
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
      const entries: AgentStoreEntry[] = [];
      for (const file of files) {
        const id = file.replace(/\.ya?ml$/, '');
        // Eve DUI-F2: the studio lists this directory now, so one hand-edited
        // file that no longer parses (or an id the API would reject) is
        // skipped instead of failing the whole list.
        if (!isValidAgentId(id)) continue;
        try {
          const stat = fs.statSync(path.join(agentsDir, file));
          entries.push({ id, spec: loadSpec(path.join(agentsDir, file)), updatedAt: stat.mtime.toISOString() });
        } catch (error) {
          console.warn(`[agent-forge] skipping unreadable agent spec '${file}': ${(error as Error).message}`);
        }
      }
      return entries.sort((a, b) => a.id.localeCompare(b.id));
    },

    async load(id: string): Promise<AgentSpec | undefined> {
      const file = filePath(id);
      if (!fs.existsSync(file)) return undefined;
      return loadSpec(file);
    },

    async save(id: string, spec: AgentSpec): Promise<void> {
      ensureDir();
      fs.writeFileSync(filePath(id), stringifyYaml(spec), 'utf8');
    },

    async remove(id: string): Promise<void> {
      const file = filePath(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
  };
}
