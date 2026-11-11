/**
 * Stable node identity for the canvas graph: every node gets a deterministic
 * id derived from the spec item it renders (`tool:http`, `sub:research`,
 * `sub:research/tool:http`), with `#2`, `#3`… suffixes resolving collisions.
 * The canvas, telemetry (`lousho.node.id` spans) and the Author's diffs all
 * key on these ids, so the rules here are a contract, not an implementation
 * detail. Browser-safe: no `node:path`.
 */
import type {
  AgentNodeData,
  FlowNodeData,
  GraphNode,
  GuardrailNodeData,
  HandoffNodeData,
  HookNodeData,
  McpNodeData,
  MemoryNodeData,
  NodeKind,
  PermissionNodeData,
  SkillNodeData,
  SubagentNodeData,
  ToolNodeData,
  AbortNodeData,
  TriggerNodeData,
} from './types';
import { ROOT_AGENT_ID } from './types';
import type { SkillRef, ToolRef } from './specTypes';

/** `'new'` for an empty name, so a fresh item still gets a stable-looking id. */
function orNew(name: string | undefined): string {
  return name || 'new';
}

/**
 * The last path segment of `path`, without its extension and ignoring
 * trailing slashes: `tools/search.ts` → `search`, `skills/review/` → `review`.
 * Local because this runs in the browser (`node:path` is not available).
 */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const last = trimmed.slice(slash + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/** The name part of a tool node id: id ?? builtin ?? registry ?? hosted ?? file basename (no extension) ?? integration ?? 'openapi' ?? 'hub'; '' → 'new'. */
export function toolNodeName(ref: ToolRef): string {
  if (ref.id !== undefined) return orNew(ref.id);
  if ('builtin' in ref) return orNew(ref.builtin);
  if ('registry' in ref) return orNew(ref.registry);
  if ('hosted' in ref) return orNew(ref.hosted);
  if ('file' in ref) return orNew(basename(ref.file));
  if ('integration' in ref) return orNew(ref.integration);
  if ('openapi' in ref) return 'openapi';
  return 'hub';
}

/** inline.name ?? basename(dir) ?? registry; '' → 'new'. */
export function skillNodeName(ref: SkillRef): string {
  if ('inline' in ref) return orNew(ref.inline.name);
  if ('dir' in ref) return orNew(basename(ref.dir));
  return orNew(ref.registry);
}

/** `''` for the root agent, `'<ownerId>/'` for an inline subagent owner. */
export function childPrefix(ownerId: string): string {
  return ownerId === ROOT_AGENT_ID ? '' : `${ownerId}/`;
}

type BaseIdFn = (data: GraphNode['data'], prefix: string) => string;

/**
 * The base id of each kind, one small function per kind to keep the dispatch
 * flat. `prefix` is `childPrefix(ownerId)`: trigger, abort and flow are
 * root-only sections, so they deliberately ignore it.
 */
const BASE_ID: Record<NodeKind, BaseIdFn> = {
  agent: (data, prefix) => {
    const { subagentKey } = data as AgentNodeData;
    return subagentKey === undefined ? ROOT_AGENT_ID : `${prefix}sub:${subagentKey}`;
  },
  subagent: (data, prefix) => `${prefix}sub:${(data as SubagentNodeData).key}`,
  tool: (data, prefix) => `${prefix}tool:${toolNodeName((data as ToolNodeData).item)}`,
  mcp: (data, prefix) => `${prefix}mcp:${(data as McpNodeData).key}`,
  skill: (data, prefix) => `${prefix}skill:${skillNodeName((data as SkillNodeData).item)}`,
  memory: (data, prefix) => `${prefix}memory:${orNew((data as MemoryNodeData).item.name)}`,
  handoff: (data, prefix) => `${prefix}handoff:${orNew((data as HandoffNodeData).item.agent)}`,
  guardrail: (data, prefix) => `${prefix}guard:${(data as GuardrailNodeData).item.id}`,
  permission: (data, prefix) => `${prefix}perm:${(data as PermissionNodeData).item.id}`,
  hook: (data, prefix) => `${prefix}hook:${(data as HookNodeData).item.id}`,
  output: (_data, prefix) => `${prefix}output`,
  trigger: (data) => `trigger:${(data as TriggerNodeData).item.id}`,
  abort: (data) => `abort:${(data as AbortNodeData).item.id}`,
  flow: (data) => `flow:${(data as FlowNodeData).step.id}`,
  // A note's id part is its layout entry id, which only the caller (C02)
  // knows — `data` is just `{ text }`. Returns the `note:` stem; callers
  // append the layout note id.
  note: () => 'note:',
};

/** Base id (before dedupe) for a node of `kind` with `data`, owned by `ownerId`. */
export function baseNodeId(kind: NodeKind, data: GraphNode['data'], ownerId: string | null): string {
  const prefix = ownerId === null ? '' : childPrefix(ownerId);
  return BASE_ID[kind](data, prefix);
}

/** `base`, then `base#2`, `base#3`, … — first one not in `taken`. */
export function dedupeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}#${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Next free item id with a prefix: nextItemId('g', ['g1','g3']) → 'g2'. Used for guardrails g, permissions p, hooks h, triggers t, abort listeners a, flow steps s. */
export function nextItemId(prefix: 'g' | 'p' | 'h' | 't' | 'a' | 's', taken: Iterable<string>): string {
  const ids = new Set(taken);
  for (let n = 1; ; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!ids.has(candidate)) return candidate;
  }
}

/** `base`, then `base-2`, `base-3`, … — for record keys and names (mcp key, subagent key, memory name). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!names.has(candidate)) return candidate;
  }
}
