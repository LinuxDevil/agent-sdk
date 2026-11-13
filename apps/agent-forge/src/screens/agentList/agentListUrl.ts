/**
 * The `#/agents` list's URL state and pure helpers (A02, labels per L13):
 * the search text, the label set and the on/off filter live in the hash
 * query (`q`, `labels`, `enabled`), synced with `useQueryState` so edits
 * replace the history entry and Back leaves the screen.
 * `filterAgents`/`parseAgentListQuery` are the pure halves the screen and
 * its tests share; label rules come from `shared/labels.ts`.
 */
import { useCallback } from 'react';
import type { CodeAgentItem, ObservedAgentItem, WorkspaceAgentItem, WorkspaceListItem } from '../../../shared/wireTypes';
import { workspaceLabel } from '../../workspace/workspaceLabels';
import { matchesLabels, normalizeLabels } from '../../../shared/labels';
import { navigate, parseHash } from '../../router/router';
import { useQueryState } from '../../router/useRoute';

/** The list's filter state: search text, selected labels and the on/off facet. */
export interface AgentListFilter {
  q: string;
  labels: string[];
  enabled: 'on' | 'off' | undefined;
  /** Selected workspace ids (`?workspace=<id>,<id>`) - only meaningful in all-workspaces mode (W06b). */
  workspaces: string[];
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
/** The `workspace` query value: comma-separated ids, order kept, blanks dropped (hand-edited hashes parse leniently). */
// fallow-ignore-next-line unused-export -- the `workspace` query key's parser; useQueryState reads it below and tests pin it
export function parseWorkspacesParam(raw: string | null): string[] {
  if (raw === null) return [];
  return raw.split(',').map((id) => id.trim()).filter((id) => id !== '');
}

export function parseAgentListQuery(query: URLSearchParams): AgentListFilter {
  return {
    q: query.get('q') ?? '',
    labels: parseLabelsParam(query.get('labels')),
    enabled: parseEnabled(query.get('enabled')),
    workspaces: parseWorkspacesParam(query.get('workspace')),
  };
}

const parseQ = (raw: string | null): string => raw ?? '';
const formatQ = (q: string): string | null => (q === '' ? null : q);
const formatLabels = (labels: string[]): string | null => (labels.length === 0 ? null : labels.join(','));
const formatEnabled = (enabled: AgentListFilter['enabled']): string | null => enabled ?? null;
const formatWorkspaces = (workspaces: string[]): string | null => (workspaces.length === 0 ? null : workspaces.join(','));

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
  const [workspaces] = useQueryState('workspace', parseWorkspacesParam, formatWorkspaces);
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
    write('workspace', formatWorkspaces(next.workspaces));
    const qs = params.toString();
    navigate(qs === '' ? path : `${path}?${qs}`, { replace: true });
  }, []);
  return [{ q, labels, enabled, workspaces }, set];
}

/**
 * The items the current filter keeps, sorted for the grid: `q` is a
 * case-insensitive substring over name, id, description and model; the
 * label facet keeps agents carrying ANY selected label (OR, L13's
 * `matchesLabels`); `enabled` matches `meta.enabled`. Order is name
 * (case-insensitive), then id.
 */
export function filterAgents(items: WorkspaceAgentItem[], filter: AgentListFilter): WorkspaceAgentItem[] {
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
      if (filter.workspaces.length > 0 && !filter.workspaces.includes(item.workspaceId)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.id.localeCompare(b.id) ||
        a.workspaceId.localeCompare(b.workspaceId)
    );
}

/**
 * The observed items the current filter keeps (W07b): the label and
 * on/off facets don't apply (an observed agent has neither), so only `q`
 * (name or project substring) and the Workspace facet narrow them - and
 * the facet hides "Elsewhere" (`workspaceId: null`) whenever it is set.
 * Order is the aggregate's (name, then project).
 */
export function filterObserved(items: ObservedAgentItem[], filter: AgentListFilter): ObservedAgentItem[] {
  const q = filter.q.trim().toLowerCase();
  return items.filter((item) => {
    if (q !== '') {
      const haystack = `${item.name}\n${item.project ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filter.workspaces.length > 0 && (item.workspaceId === null || !filter.workspaces.includes(item.workspaceId))) return false;
    return true;
  });
}

/**
 * The code-agent items the current filter keeps (W08b): like observed
 * items, labels and the on/off facet don't apply (a code agent has
 * neither), so only `q` (name, path or config file) and the Workspace
 * facet narrow them. Order is the caller's (the aggregate's / scan's).
 */
export function filterCode(items: CodeAgentItem[], filter: AgentListFilter): CodeAgentItem[] {
  const q = filter.q.trim().toLowerCase();
  return items.filter((item) => {
    if (q !== '') {
      const haystack = `${item.name}\n${item.id}\n${item.configFile}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filter.workspaces.length > 0 && !filter.workspaces.includes(item.workspaceId)) return false;
    return true;
  });
}

/**
 * The Workspace facet's options (W06b, all-workspaces mode): every
 * workspace the registry knows, labelled through `workspaceLabel`, with
 * the number of listed agents it contributes. Workspaces absent from both
 * the items and the registry list are ignored; `list` may be undefined
 * while `GET /workspaces` is still in flight (ids then label as
 * themselves).
 */
export function workspaceOptions(
  items: WorkspaceAgentItem[],
  list: readonly WorkspaceListItem[] | undefined
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.workspaceId, (counts.get(item.workspaceId) ?? 0) + 1);
  const known = new Map((list ?? []).map((ws) => [ws.id, ws]));
  const ids = new Set([...counts.keys(), ...known.keys()]);
  return [...ids]
    .map((id) => ({
      value: id,
      label: workspaceLabel(id, list),
      count: counts.get(id) ?? 0,
    }))
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.value.localeCompare(b.value));
}


