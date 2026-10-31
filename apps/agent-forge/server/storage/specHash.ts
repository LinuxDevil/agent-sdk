/**
 * The content hash of an AgentSpec v2, recorded in
 * `.lousho/agents/<id>/working.json` after every Studio write so a later
 * reader can tell that write apart from an external hand edit (the file's
 * hash matches `working.json` only when Studio wrote it).
 *
 * The hash input is the spec serialized as YAML with object keys sorted at
 * every depth: two specs that differ only in key order hash identically.
 * Arrays keep their order - order is meaningful there.
 */
import { createHash } from 'node:crypto';
import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpecV2 } from '@lousho/build-ai-agent';

/**
 * `value` with every object's keys sorted, recursively. Arrays keep their
 * order (their element objects are still key-sorted); scalars pass through.
 * Shared with `mergeLegacySave`, which uses it for deep-equality on spec
 * areas.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** The canonical YAML a spec hashes as: `yaml.stringify` of the deep key-sorted spec. */
function canonicalSpecYaml(spec: AgentSpecV2): string {
  return stringifyYaml(sortKeysDeep(spec));
}

/** `'sha256:<64 hex>'` of the spec's canonical YAML - see the file header for what it marks. */
export function specHash(spec: AgentSpecV2): string {
  return `sha256:${createHash('sha256').update(canonicalSpecYaml(spec)).digest('hex')}`;
}
