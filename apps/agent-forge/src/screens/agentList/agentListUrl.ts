/**
 * The `#/agents` list's URL state and pure helpers (A02, labels per L13):
 * the search text, the label set and the on/off filter live in the hash
 * query (`q`, `labels`, `enabled`), synced with `useQueryState` so edits
 * replace the history entry and Back leaves the screen.
 * `filterAgents`/`parseAgentListQuery` are the pure halves the screen and
 * its tests share; label rules come from `shared/labels.ts`.
 */
import { useCallback } from 'react';
import type { AgentListItem } from '../../../shared/wireTypes';
import { matchesLabels, normalizeLabels } from '../../../shared/labels';
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

/**
 * The `labels` query value, comma-separated in selection order: normalised
 * through `shared/labels.ts`; anything invalid (a hand-edited hash) parses
 * to no filter rather than breaking the list (L13).
 */
export function parseLabelsParam(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    return normalizeLabels(raw.split(','));
  } catch {
    return [];
  }
}

/**
 * Reads the list filter out of the hash query: `q` is the raw search text,
 * `labels` a comma-separated normalised set, `enabled` `'on'`/`'off'`.
 */
export function parseAgentListQuery(query: URLSearchParams): AgentListFilter {
  return {
    q: query.get('q') ?? '',
    labels: parseLabelsParam(query.get('labels')),
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
  const [labels] = useQueryState('labels', parseLabelsParam, formatLabels);
  const [enabled] = useQueryState('enabled', parseEnabled, formatEnabled);
  const set = useCallback((next: AgentListFilter) => {
    const { path, query } = parseHash(window.location.hash);
    const params = new URLSearchParams(query);
    const write = (key: string, value: string | null) => {
      if (value === null) params.delete(key);
      else params.set(key, value);
    };
    write('q', formatQ(next.q));
    write('labels', formatLabels(next.labels));
    write('enabled', formatEnabled(next.enabled));
    const qs = params.toString();
    navigate(qs === '' ? path : `${path}?${qs}`, { replace: true });
  }, []);
  return [{ q, labels, enabled }, set];
}

/**
 * The items the current filter keeps, sorted for the grid: `q` is a
 * case-insensitive substring over name, id, description and model; the
 * label facet keeps agents carrying ANY selected label (OR, L13's
 * `matchesLabels`); `enabled` matches `meta.enabled`. Order is name
 * (case-insensitive), then id.
 */
export function filterAgents(items: AgentListItem[], filter: AgentListFilter): AgentListItem[] {
  const q = filter.q.trim().toLowerCase();
  return items
    .filter((item) => {
      if (q !== '') {
        const haystack = `${item.name}\n${item.id}\n${item.description}\n${item.model}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (!matchesLabels(item.labels, filter.labels)) return false;
      if (filter.enabled === 'on' && !item.enabled) return false;
      if (filter.enabled === 'off' && item.enabled) return false;
      return true;
    })
    .sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)
    );
}


