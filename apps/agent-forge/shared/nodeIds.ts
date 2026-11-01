/**
 * Stable item keys - the shared naming the SpecChange diff uses in
 * `field[key]` names (`tools[web-fetch]`) and the canvas graph uses in
 * node ids (`tool:<key>`, `skill:<key>`). Kept in `shared/` so both the
 * server diff and the browser graph pick the same name for the same ref;
 * the prefixes ('tool:', 'mcp:', ...) stay with the consumers.
 *
 * `shared/` ships in the browser bundle, so basenames are computed by hand
 * (`node:path` is not available here).
 */
import type { AgentSpecV2 } from 'lousho';

/** One `spec.tools` entry (the SDK's ToolRef union, derived here since it is not a public export). */
type ToolRef = NonNullable<AgentSpecV2['tools']>[number];

/** One `spec.skills` entry (the SDK's SkillRef union, derived here since it is not a public export). */
type SkillRef = NonNullable<AgentSpecV2['skills']>[number];

/** Last path segment, separators `/` or `\`, extension stripped ('a/b/tool.ts' -> 'tool'). */
function fileBasename(file: string): string {
  return file.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
}

/** Last path segment, separators `/` or `\`, kept whole ('skills/changelog' -> 'changelog'). */
function dirBasename(dir: string): string {
  return dir.split(/[\\/]/).pop()!;
}

/**
 * A tool ref's stable key: its explicit `id` when given, else the natural
 * name of its one kind key - builtin, registry or hosted name; file
 * basename without extension; integration name; the openapi spec URL; or
 * 'hub' for the Context Hub pair.
 */
export function toolKey(ref: ToolRef): string {
  if (ref.id !== undefined) return ref.id;
  if ('builtin' in ref) return ref.builtin;
  if ('registry' in ref) return ref.registry;
  if ('hosted' in ref) return ref.hosted;
  if ('file' in ref) return fileBasename(ref.file);
  if ('integration' in ref) return ref.integration;
  if ('openapi' in ref) return ref.openapi.url;
  return 'hub';
}

/** A skill ref's stable key: the inline skill's name, the dir's basename, or the registry name. */
export function skillKey(ref: SkillRef): string {
  if ('inline' in ref) return ref.inline.name;
  if ('dir' in ref) return dirBasename(ref.dir);
  return ref.registry;
}

/**
 * `items` paired with their `keyOf` keys, deduped in list order as 'x',
 * 'x#2', 'x#3' - two `{ builtin: 'http' }` refs diff as `tools[http]` and
 * `tools[http#2]` instead of colliding on one key.
 */
export function keyedItems<T>(items: readonly T[], keyOf: (item: T) => string): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: count === 1 ? base : `${base}#${count}`, item };
  });
}
