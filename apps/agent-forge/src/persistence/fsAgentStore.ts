import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadSpec, type AgentSpec } from '@lousho/build-ai-agent';
import type { AgentStore, AgentStoreEntry } from './AgentStore';

/**
 * Filesystem-backed `AgentStore`, saving/loading plain `AgentSpec` YAML
 * files under `<baseDir>/.lousho/agents/<id>.yaml`. Deliberately reuses the
 * core SDK's `loadSpec()` for reading (so files this store writes validate
 * and load exactly the way any other AgentSpec YAML file does) and the same
 * `yaml` package for writing - there is only one AgentSpec file format in
 * this repo, not a second bespoke one for the app.
 *
 * NOT wired into the Vite/browser app (`apps/agent-forge/src/App.tsx` uses
 * `LocalStorageAgentStore` instead) - a browser has no `node:fs` access.
 * This module is the interface point LOU-N's runtime control server is
 * expected to expose over HTTP/IPC: that server can import
 * `createFsAgentStore()` directly and serve it behind whatever transport it
 * adds, rather than reinventing filesystem persistence.
 *
 * TODO(LOU-N): wire this up behind the runtime control server so the
 * browser app can call it remotely instead of only using
 * `LocalStorageAgentStore`.
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
      return files.map((file) => {
        const id = file.replace(/\.ya?ml$/, '');
        const stat = fs.statSync(path.join(agentsDir, file));
        return { id, spec: loadSpec(path.join(agentsDir, file)), updatedAt: stat.mtime.toISOString() };
      });
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
