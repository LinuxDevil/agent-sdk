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
import type { AgentSpecV2 } from 'lousho';
import { sortKeysDeep } from '../../shared/stableJson';

/** The canonical YAML a spec hashes as: `yaml.stringify` of the deep key-sorted spec. */
function canonicalSpecYaml(spec: AgentSpecV2): string {
  return stringifyYaml(sortKeysDeep(spec));
}

/** `'sha256:<64 hex>'` of the spec's canonical YAML - see the file header for what it marks. */
export function specHash(spec: AgentSpecV2): string {
  return `sha256:${createHash('sha256').update(canonicalSpecYaml(spec)).digest('hex')}`;
}
