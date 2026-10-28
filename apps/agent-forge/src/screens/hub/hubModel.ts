/**
 * Pure pieces of the Context Hub screen: its URL state, the namespace list
 * derived from entry rows (the daemon has no namespace endpoint), value
 * parsing for display and editing, and TTL text.
 *
 * URL shapes: `#/hub` (namespaces) and `#/hub/:namespace` (its entries), both
 * taking `?agent=<agent_id>` (the "Viewing as" identity; absent = the first
 * agent by name) and `?scope=private|fleet` (absent = both). Defaults are
 * never written.
 */
import type { ObserveAgentRow, ObserveHubEntry, ObserveHubScope } from '../../observe/types';

/** The daemon's max `limit`; a page this full may be cut short. */
export const HUB_LIMIT = 1000;

/** The parsed hub query; absent fields are the defaults. */
export interface HubUrlState {
  agent?: string;
  scope?: ObserveHubScope;
}

/** Read `agent` and `scope` from the hub query; an unknown scope is dropped. */
export function parseHubQuery(query: URLSearchParams): HubUrlState {
  const state: HubUrlState = {};
  const agent = query.get('agent');
  const scope = query.get('scope');
  if (agent) state.agent = agent;
  if (scope === 'private' || scope === 'fleet') state.scope = scope;
  return state;
}

/** The hash path for the namespace list (no namespace) or one namespace, with the non-default query. */
export function hubPath(namespace: string | undefined, state: HubUrlState): string {
  const params = new URLSearchParams();
  if (state.agent) params.set('agent', state.agent);
  if (state.scope) params.set('scope', state.scope);
  const qs = params.toString();
  return `/hub${namespace === undefined ? '' : `/${encodeURIComponent(namespace)}`}${qs ? `?${qs}` : ''}`;
}

/** The display name of an agent: its registered name, else a short id. */
export const agentLabel = (a: ObserveAgentRow): string => a.name ?? a.agent_id.slice(0, 8);

/** Agents sorted by display name, the "Viewing as" option order (the first is the default viewer). */
export const sortAgents = (agents: readonly ObserveAgentRow[]): ObserveAgentRow[] =>
  [...agents].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)) || a.agent_id.localeCompare(b.agent_id));

/** One row of the namespace list. */
export interface HubNamespaceRow {
  namespace: string;
  entries: number;
  fleet: number;
  private: number;
  /** Newest `created_at` (last publish) in the namespace. */
  updated: number;
}

/** Group entry rows by namespace, sorted by name. */
export function groupNamespaces(entries: readonly ObserveHubEntry[]): HubNamespaceRow[] {
  const groups = new Map<string, HubNamespaceRow>();
  for (const e of entries) {
    const row = groups.get(e.namespace) ?? { namespace: e.namespace, entries: 0, fleet: 0, private: 0, updated: 0 };
    row.entries += 1;
    if (e.scope === 'fleet') row.fleet += 1;
    else row.private += 1;
    row.updated = Math.max(row.updated, e.created_at);
    groups.set(e.namespace, row);
  }
  return [...groups.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/** A stored value: parsed JSON when it parses, else the raw string. */
export type HubValue = { json: true; parsed: unknown } | { json: false; text: string };

export function parseValue(value: string | null): HubValue {
  if (value === null) return { json: true, parsed: null };
  try {
    return { json: true, parsed: JSON.parse(value) as unknown };
  } catch {
    return { json: false, text: value };
  }
}

/** The editor's starting text: pretty JSON for a JSON value, else the string as stored. */
export function editableText(value: string | null): string {
  const parsed = parseValue(value);
  return parsed.json ? JSON.stringify(parsed.parsed, null, 2) : parsed.text;
}

/**
 * The value to publish from edited text: JSON when it parses; otherwise the
 * text itself for an entry that was a plain string, and invalid for an entry
 * that held JSON (it stays JSON).
 */
export function parseEditedValue(text: string, wasJson: boolean): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return wasJson ? { ok: false } : { ok: true, value: text };
  }
}

/** One line of the stored value for the table, whitespace collapsed. */
export const valuePreview = (value: string | null): string => (value === null ? 'null' : value.replace(/\s+/g, ' ').trim().slice(0, 300));

const UNITS: [string, number][] = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1],
];

/** A span in its two largest non-zero units, to the second: `1h 30m`, `45s`, `2d 1h`. */
export function fmtSpan(ms: number): string {
  let rest = Math.max(0, Math.round(ms / 1000));
  const parts: string[] = [];
  for (const [unit, size] of UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 || parts.length > 0) parts.push(`${n}${unit}`);
    if (parts.length === 2) break;
  }
  const shown = parts.filter((p, i) => i === 0 || !p.startsWith('0'));
  return shown.length > 0 ? shown.join(' ') : '0s';
}

/** The TTL cell: `never`, or the lifetime and the time left. */
export function ttlText(entry: ObserveHubEntry, now: number): string {
  if (entry.ttl === null || entry.expires_at === null) return 'never';
  return `${fmtSpan(entry.ttl)} - expires in ${fmtSpan(entry.expires_at - now)}`;
}
