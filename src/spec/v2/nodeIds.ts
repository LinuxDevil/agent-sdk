/**
 * specNodeIds(): the PLAN §3.3 canvas node ids of one spec, by section.
 * The compiler (./nodeIdExporter.ts) maps spans with it; the canvas graph
 * and the Author's diffs use the same ids. Arrays are indexed like the
 * spec's arrays, and repeated bases are deduped `#2`, `#3` the way §3.3
 * prescribes for tools (applied to every list: two `{ dir: 'a/x' }` and
 * `{ dir: 'b/x' }` skills would otherwise collide). Browser-safe: types
 * only, no `node:*` imports.
 */
import type { SkillRef } from './skills';
import type { ToolRef } from './tools';
import type { AgentSpecV2 } from './types';

/** PLAN §3.3 node ids of one spec, by section. Arrays are indexed like the spec's arrays. */
export interface SpecNodeIds {
  /** 'tool:<id ?? builtin ?? registry ?? hosted ?? integration ?? file basename w/o ext ?? "openapi" ?? "hub">', dedupe '#2', '#3'. */
  tools: string[];
  /** server key → 'mcp:<key>'. */
  mcp: Record<string, string>;
  /** 'skill:<inline.name | dir basename | registry>'. */
  skills: string[];
  /** 'memory:<name>'. */
  memory: string[];
  /** name → 'sub:<name>'. */
  subagents: Record<string, string>;
  /** 'handoff:<agent>'. */
  handoffs: string[];
  /** 'guard:<id>'. */
  guardrails: string[];
  /** 'perm:<id>'. */
  permissions: string[];
  /** 'hook:<id>'. */
  hooks: string[];
  /** 'trigger:<id>'. */
  triggers: string[];
  /** 'abort:<id>'. */
  abortListeners: string[];
  /** step id → 'flow:<step id>' (every step of spec.flow.flow, depth-first). */
  flow: Record<string, string>;
}

/** `x#2`, `x#3`, ... for repeats of `x`, first occurrences unchanged. */
function dedupe(ids: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return ids.map((id) => {
    const seen = counts.get(id) ?? 0;
    counts.set(id, seen + 1);
    return seen === 0 ? id : `${id}#${seen + 1}`;
  });
}

/** `'a/b/c.d'` → `'c'` (forward-slash path, last extension dropped). */
function basenameNoExt(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.[^./]+$/, '');
}

/** `'a/b/c'` (or `'a/b/c/'`) → `'c'`. */
function basename(dir: string): string {
  return dir.split('/').filter((segment) => segment !== '').pop() ?? dir;
}

/** The `tool:<…>` base of one spec.tools entry (before dedupe). */
function toolBase(ref: ToolRef): string {
  if (ref.id !== undefined) return ref.id;
  if ('builtin' in ref) return ref.builtin;
  if ('registry' in ref) return ref.registry;
  if ('hosted' in ref) return ref.hosted;
  if ('integration' in ref) return ref.integration;
  if ('file' in ref) return basenameNoExt(ref.file);
  if ('openapi' in ref) return 'openapi';
  return 'hub';
}

/** The `skill:<…>` base of one spec.skills entry (before dedupe). */
function skillBase(ref: SkillRef): string {
  if ('inline' in ref) return ref.inline.name;
  if ('registry' in ref) return ref.registry;
  return basename(ref.dir);
}

/** `key → 'prefix:<key>'` for every own key of `map`. */
function prefixedRecord(map: Record<string, unknown> | undefined, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.keys(map ?? {}).map((key) => [key, `${prefix}:${key}`]));
}

/** `list → ['prefix:<item[key]>']` for each entry, deduped. */
function prefixedList<K extends string>(list: readonly { [P in K]?: unknown }[] | undefined, key: K, prefix: string): string[] {
  return dedupe((list ?? []).map((entry) => `${prefix}:${String(entry[key])}`));
}

/** Every step id of one flow node (an EditorStep) and its children, depth-first. */
function collectFlowIds(step: unknown, out: Record<string, string>): void {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return;
  const node = step as { id?: unknown; steps?: unknown; options?: unknown; step?: unknown };
  if (typeof node.id === 'string') out[node.id] = `flow:${node.id}`;
  if (Array.isArray(node.steps)) for (const child of node.steps) collectFlowIds(child, out);
  if (Array.isArray(node.options)) {
    for (const option of node.options) {
      if (typeof option === 'object' && option !== null) collectFlowIds((option as { step?: unknown }).step, out);
    }
  }
  collectFlowIds(node.step, out);
}

/** `step id → 'flow:<step id>'` for every step of `spec.flow.flow` (S21 lands the field; `never` until then). */
function flowNodeIds(spec: AgentSpecV2): Record<string, string> {
  const out: Record<string, string> = {};
  collectFlowIds((spec as { flow?: { flow?: unknown } }).flow?.flow, out);
  return out;
}

/** The PLAN §3.3 node ids of `spec`, each section keyed or indexed like the spec's own. */
export function specNodeIds(spec: AgentSpecV2): SpecNodeIds {
  return {
    tools: dedupe((spec.tools ?? []).map((ref) => `tool:${toolBase(ref)}`)),
    mcp: prefixedRecord(spec.mcpServers, 'mcp'),
    skills: dedupe((spec.skills ?? []).map((ref) => `skill:${skillBase(ref)}`)),
    memory: prefixedList(spec.memory, 'name', 'memory'),
    subagents: prefixedRecord(spec.subagents, 'sub'),
    handoffs: prefixedList(spec.handoffs, 'agent', 'handoff'),
    guardrails: prefixedList(spec.guardrails, 'id', 'guard'),
    permissions: prefixedList(spec.permissions, 'id', 'perm'),
    hooks: prefixedList(spec.hooks, 'id', 'hook'),
    triggers: prefixedList(spec.triggers, 'id', 'trigger'),
    // `never` in the merged types until R03; mapped the same way when it lands.
    abortListeners: prefixedList(spec.abortListeners as { id?: string }[] | undefined, 'id', 'abort'),
    flow: flowNodeIds(spec),
  };
}
