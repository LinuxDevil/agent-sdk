/**
 * Agent id helpers for `POST /agents`: turning a display name into a
 * filesystem-safe slug and picking collision-free ids.
 *
 * Ids and names are different things - the id is the file name under
 * `.lousho/agents/`, the name is display text inside the spec. These
 * helpers only mint ids; they never write files themselves (they only
 * *look* at the repo, so they can run outside the agent lock).
 */
import * as fs from 'node:fs';
import type { AgentRepo } from './agentRepo';

/** Ids stay well under the 128-char agent-id cap so `-copy` suffixes still fit. */
const SLUG_MAX_LENGTH = 64;

/**
 * `text` as an agent id: lowercase, runs outside `[a-z0-9._-]` become
 * '-', leading/trailing punctuation trimmed, at most 64 chars, `''`
 * becomes `'agent'`. The result always passes `isValidAgentId` - leading
 * `'.'`/`'_'`/`'-'` and `'.'` runs are removed up front because ids must
 * start with a letter or digit and never contain `'..'`.
 */
export function slugAgentId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/[._-]+$/, '');
  return slug === '' ? 'agent' : slug;
}

/**
 * Whether `id` is unusable for a new agent: its spec file exists, or its
 * `<id>/` sidecar dir does - a deleted agent keeps its history
 * (`versions/`, `traces/`, ...) under that dir, so reusing the id would
 * merge the new agent into the old one's history.
 */
function agentIdTaken(repo: AgentRepo, id: string): boolean {
  return repo.exists(id) || fs.existsSync(repo.sidecarDir(id));
}

/**
 * `base`, else `base-2`, `base-3`, ... - the first id with no `<id>.yaml`
 * and no `<id>/` sidecar dir.
 */
export function uniqueAgentId(repo: AgentRepo, base: string): string {
  if (!agentIdTaken(repo, base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!agentIdTaken(repo, id)) return id;
  }
}

/** `<id>-copy`, else `<id>-copy-2`, `<id>-copy-3`, ... - the same availability rule as {@link uniqueAgentId}. */
export function copyAgentId(repo: AgentRepo, sourceId: string): string {
  const base = `${sourceId}-copy`;
  if (!agentIdTaken(repo, base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!agentIdTaken(repo, id)) return id;
  }
}
