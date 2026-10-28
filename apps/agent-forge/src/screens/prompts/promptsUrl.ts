/**
 * The Prompts screen's URL state.
 *
 * - `#/prompts` - the registry list.
 * - `#/prompts/:name` - one prompt, its latest version selected;
 *   `#/prompts/:name@<ref>` selects a version, `ref` being a version number
 *   or a label. The daemon's name rule (no `/`, `@` or whitespace) makes the
 *   first `@` the split point.
 * - `?diff=<a>,<b>` - the side-by-side diff between versions `a` and `b`.
 */
import type { ObservePromptVersion } from '../../observe/types';
import { toInt } from '../urlState';

/** `name@ref` from the decoded `:name` route param (`ref` absent = latest). */
export function parsePromptRoute(param: string): { name: string; ref: string | undefined } {
  const at = param.indexOf('@');
  if (at === -1) return { name: param, ref: undefined };
  return { name: param.slice(0, at), ref: param.slice(at + 1) || undefined };
}

/** The `?diff=a,b` version pair, or `undefined` when absent or malformed. */
export function parseDiff(query: URLSearchParams): [number, number] | undefined {
  const parts = (query.get('diff') ?? '').split(',');
  if (parts.length !== 2) return undefined;
  const a = toInt(parts[0]);
  const b = toInt(parts[1]);
  return a === undefined || b === undefined ? undefined : [a, b];
}

/** The hash path for a prompt, an optional version/label ref and an optional diff pair. */
export function promptPath(name: string, ref?: string | number, diff?: readonly [number, number]): string {
  const at = ref === undefined ? '' : `@${encodeURIComponent(String(ref))}`;
  return `/prompts/${encodeURIComponent(name)}${at}${diff ? `?diff=${diff[0]},${diff[1]}` : ''}`;
}

/** `#/traces` filtered to runs that used `name@version` (the daemon's `prompt` trace filter). */
export const promptRunsHref = (name: string, version: number): string => `#/traces?prompt=${encodeURIComponent(name)}@${version}`;

/** `#/playground` preloaded with `name@version` (read by the Playground screen). */
export const promptPlaygroundHref = (name: string, version: number): string =>
  `#/playground?prompt=${encodeURIComponent(name)}@${version}`;

/** The version `ref` names in a newest-first history: latest when absent, a version number, or a label. */
export function resolveRef(versions: readonly ObservePromptVersion[], ref: string | undefined): ObservePromptVersion | undefined {
  if (ref === undefined || ref === 'latest') return versions[0];
  const number = toInt(ref);
  if (number !== undefined) return versions.find((v) => v.version === number);
  return versions.find((v) => v.labels.includes(ref));
}
