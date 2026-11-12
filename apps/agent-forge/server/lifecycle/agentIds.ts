/**
 * Import id helpers (L08a): turning a spec's display name into the agent
 * id an import would write, and picking collision-free `new`/`copy` ids.
 *
 * The `exists` predicate is injected (sync or async) so the helpers stay
 * storage-agnostic - `import.ts` passes the workspace repo's
 * spec-file-or-sidecar-dir rule. `resolveNextCopyId` is shared with L10's
 * duplicate flow; keep it here.
 */
import { isValidAgentId } from '../../shared/agentId';
import { slugAgentId } from '../storage/agentIds';

/** How many suffixes each resolver tries before giving up (`-2` … `-1000`, or `-copy-2` … `-copy-1000`). */
const MAX_SUFFIX = 1000;

/**
 * `name` as an agent id: lowercase, runs outside `[a-z0-9._-]` become
 * `-`, edge punctuation trimmed, cut to 64 chars; `''` or anything that
 * still fails {@link isValidAgentId} becomes `'agent'`. Delegates to the
 * create route's {@link slugAgentId} so both mint ids by one rule.
 */
export function slugifyAgentId(name: string): string {
  const slug = slugAgentId(name);
  return isValidAgentId(slug) ? slug : 'agent';
}

/**
 * `base`, then `base-2`, `base-3`, … `base-1000` - the first id `exists`
 * answers false for. Throws when every candidate is taken.
 */
export async function resolveFreshId(base: string, exists: (id: string) => boolean | Promise<boolean>): Promise<string> {
  if (!(await exists(base))) return base;
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const id = `${base}-${n}`;
    if (!(await exists(id))) return id;
  }
  throw new Error(`Every import id for '${base}' is taken.`);
}

/**
 * `${base}-copy`, then `${base}-copy-2`, … `${base}-copy-1000` - the
 * first id `exists` answers false for. Throws when every candidate is
 * taken.
 */
export async function resolveNextCopyId(
  base: string,
  exists: (id: string) => boolean | Promise<boolean>
): Promise<string> {
  const first = `${base}-copy`;
  if (!(await exists(first))) return first;
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const id = `${base}-copy-${n}`;
    if (!(await exists(id))) return id;
  }
  throw new Error(`Every copy id for '${base}' is taken.`);
}
