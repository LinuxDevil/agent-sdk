/**
 * The `#/agents` list's URL state and pure helpers (A02): the search text,
 * the label set and the on/off filter live in the hash query (`q`, `label`,
 * `enabled`), synced with `useQueryState` so edits replace the history entry
 * and Back leaves the screen. `filterAgents`/`labelOptions` are the pure
 * halves the screen and its tests share.
 */
import { useCallback } from 'react';
import type { AgentListItem } from '../../../shared/wireTypes';
import { navigate, parseHash } from '../../router/router';
import { useQueryState } from '../../router/useRoute';

/** The list's filter state: search text, selected labels and the on/off facet. */
export interface AgentListFilter {
  q: string;
  labels: string[];
  enabled: 'on' | 'off' | undefined;
}

/** `enabled` accepts only the two facet values; anything else (or nothing) is no filter. */
function parseEnabled(raw: string | null): AgentListFilter['enabled'] {
  return raw === 'on' || raw === 'off' ? raw : undefined;
}

/** `label` is comma-separated and lowercase; empty pieces drop out. */
function parseLabels(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(',')
    .map((label) => label.trim().toLowerCase())
    .filter((label) => label !== '');
}

/**
 * Reads the list filter out of the hash query: `q` is the raw search text,
 * `label` a comma-separated lowercase set, `enabled` `'on'`/`'off'`.
 */
export function parseAgentListQuery(query: URLSearchParams): AgentListFilter {
  return {
    q: query.get('q') ?? '',
    labels: query.getAll('label').flatMap((value) => parseLabels(value)),
    enabled: parseEnabled(query.get('enabled')),
  };
}

const parseQ = (raw: string | null): string => raw ?? '';
const formatQ = (q: string): string | null => (q === '' ? null : q);
const formatLabels = (labels: string[]): string | null => (labels.length === 0 ? null : labels.join(','));
const formatEnabled = (enabled: AgentListFilter['enabled']): string | null => enabled ?? null;

/**
 * The filter as URL state: one `useQueryState` per key (`q`, `label`,
 * `enabled`). The setter writes all three keys in a single `replace`
 * navigation - three separate writes could each read a stale hash and
 * resurrect a key another write just cleared.
 */
export function useAgentListFilter(): [AgentListFilter, (next: AgentListFilter) => void] {
  const [q] = useQueryState('q', parseQ, formatQ);
  const [labels] = useQueryState('label', parseLabels, formatLabels);
  const [enabled] = useQueryState('enabled', parseEnabled, formatEnabled);
  const set = useCallback((next: AgentListFilter) => {
    const { path, query } = parseHash(window.location.hash);
    const params = new URLSearchParams(query);
    const write = (key: string, value: string | null) => {
      if (value === null) params.delete(key);
      else params.set(key, value);
    };
    write('q', formatQ(next.q));
    write('label', formatLabels(next.labels));
    write('enabled', formatEnabled(next.enabled));
    const qs = params.toString();
    navigate(qs === '' ? path : `${path}?${qs}`, { replace: true });
  }, []);
  return [{ q, labels, enabled }, set];
}

/**
 * The items the current filter keeps, sorted for the grid: `q` is a
 * case-insensitive substring over name, id, description and model; every
 * selected label must be on the item (compared lowercase); `enabled` matches
 * `meta.enabled`. Order is name (case-insensitive), then id.
 */
export function filterAgents(items: AgentListItem[], filter: AgentListFilter): AgentListItem[] {
  const q = filter.q.trim().toLowerCase();
  const labels = filter.labels.map((label) => label.toLowerCase());
  return items
    .filter((item) => {
      if (q !== '') {
        const haystack = `${item.name}\n${item.id}\n${item.description}\n${item.model}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (labels.length > 0) {
        const own = item.labels.map((label) => label.toLowerCase());
        if (!labels.every((label) => own.includes(label))) return false;
      }
      if (filter.enabled === 'on' && !item.enabled) return false;
      if (filter.enabled === 'off' && item.enabled) return false;
      return true;
    })
    .sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)
    );
}

/**
 * The Labels facet's options: every label across `items`, lowercased,
 * deduplicated, sorted, with the number of agents carrying it.
 */
export function labelOptions(items: AgentListItem[]): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const raw of item.labels) {
      const label = raw.trim().toLowerCase();
      if (label === '') continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}
