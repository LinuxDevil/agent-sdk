/**
 * `#/agents` - the agents list (A02): a card grid of every agent in the
 * workspace under a header with the New agent menu (A04), a FilterBar whose
 * search/labels/status state lives in the URL (`agentListUrl.ts`), and the
 * loading / error / empty / no-match states. A card opens the agent's
 * overview tab; its switch toggles `meta.enabled` optimistically through
 * `useAgentList`.
 */
import { useCallback, useMemo, useState } from 'react';
import { Bot, SearchX } from 'lucide-react';
import type { AgentListItem } from '../../../shared/wireTypes';
import { labelFacetOptions } from '../../../shared/labels';
import { navigate } from '../../router/router';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { EmptyState } from '../../ui/EmptyState';
import { FilterBar, type FacetDef } from '../../ui/FilterBar';
import { Skeleton } from '../../ui/Skeleton';
import { facet } from '../listFilters';
import { LoadErrorCard, LoadingGrid } from '../listStates';
import { agentTabPath } from '../agents/agentTabs';
import { ImportSheet } from '../agents/import/ImportSheet';
import { AgentCard } from './AgentCard';
import { CodeAgentSection } from './CodeAgentSection';
import { filterAgents, useAgentListFilter, type AgentListFilter } from './agentListUrl';
import { useCodeAgentDirs } from './useCodeAgentDirs';
import { NewAgentMenu, StartOptions } from './NewAgentMenu';
import { useNewAgentActions, type NewAgentActions } from './newAgent';
import { useAgentList, type AgentListState } from './useAgentList';
import './agentList.css';

const plural = (n: number): string => (n === 1 ? 'agent' : 'agents');

/** The visually-hidden count line: total when unfiltered, "X of Y" under a filter, nothing while loading. */
function countTextFor(list: AgentListState, items: AgentListItem[], visible: AgentListItem[], filtered: boolean): string | null {
  if (list.items === undefined) return null;
  return filtered ? `${visible.length} of ${items.length} ${plural(items.length)}` : `${items.length} ${plural(items.length)}`;
}

/** One shimmer card standing in for an agent while the list loads. */
function SkeletonCard() {
  return (
    <li className="agent-card-skeleton" aria-hidden="true">
      <span className="agent-card-skeleton-head">
        <Skeleton width={36} height={36} radius="var(--radius)" />
        <span className="agent-card-skeleton-lines">
          <Skeleton width="60%" height={10} />
          <Skeleton width="90%" height={10} />
          <Skeleton width="40%" height={10} />
        </span>
      </span>
    </li>
  );
}

/** The loaded grid: one AgentCard per visible item. */
function AgentGrid({
  items,
  pendingIds,
  onOpen,
  onToggle,
}: {
  items: AgentListItem[];
  pendingIds: ReadonlySet<string>;
  onOpen(id: string): void;
  onToggle(id: string, enabled: boolean): void;
}) {
  return (
    <ul className="agent-grid" aria-label="Agents" aria-busy="false">
      {items.map((item) => (
        <AgentCard
          key={item.id}
          agent={item}
          onOpen={onOpen}
          onToggleEnabled={onToggle}
          toggling={pendingIds.has(item.id)}
        />
      ))}
    </ul>
  );
}

interface ListBodyProps {
  list: AgentListState;
  items: AgentListItem[];
  visible: AgentListItem[];
  newAgent: NewAgentActions;
  onClearFilters(): void;
  onOpen(id: string): void;
  onToggle(id: string, enabled: boolean): void;
}

/** Exactly one of: error card, loading grid, empty state, no-match state, card grid. */
function AgentListBody({ list, items, visible, newAgent, onClearFilters, onOpen, onToggle }: ListBodyProps) {
  if (list.error !== undefined && list.items === undefined) {
    return <LoadErrorCard title="Could not load agents" error={list.error} onRetry={list.refresh} />;
  }
  if (list.items === undefined) {
    return <LoadingGrid className="agent-grid" label="Agents" status="Loading agents" skeleton={SkeletonCard} />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No agents yet"
        hint="Pick a way to start."
        action={<StartOptions {...newAgent} />}
      />
    );
  }
  if (visible.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No agents match these filters"
        hint="Clear a filter to see more agents."
        action={
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClearFilters}>
            Clear filters
          </button>
        }
      />
    );
  }
  return <AgentGrid items={visible} pendingIds={list.pendingIds} onOpen={onOpen} onToggle={onToggle} />;
}

/** The two FilterBar facets: Labels (multi) over every item's labels, Status (single) over on/off. */
function useAgentListFacets(
  items: AgentListItem[],
  filter: AgentListFilter,
  patch: (next: Partial<AgentListFilter>) => void
): FacetDef[] {
  const labelsFacet = useMemo<FacetDef>(
    () => ({
      key: 'labels',
      label: 'Labels',
      options: labelFacetOptions(items),
      value: filter.labels,
      onChange: (labels) => patch({ labels }),
    }),
    [items, filter.labels, patch]
  );
  const statusFacet = useMemo<FacetDef>(() => {
    const def = facet('enabled', 'Status', ['on', 'off'], filter.enabled, (enabled) =>
      patch({ enabled: enabled as AgentListFilter['enabled'] })
    );
    return {
      ...def,
      options: def.options.map((option) => ({ ...option, label: option.value === 'on' ? 'On' : 'Off' })),
    };
  }, [filter.enabled, patch]);
  return [labelsFacet, statusFacet];
}

/**
 * `#/agents` - see the module comment. Filter state is the URL's; the list
 * itself comes from `useAgentList` (`GET /agents`).
 */
export function AgentListScreen() {
  const list = useAgentList();
  // X06b: code-defined agent directories, shown as the "In your code" section (hidden when none).
  const codeDirs = useCodeAgentDirs();
  const [filter, setFilter] = useAgentListFilter();
  // One instance shared by the header menu and the empty state's start buttons:
  // a second useNewAgentActions would track `creating` separately and let a
  // second blank create slip through while the first is in flight.
  const [importOpen, setImportOpen] = useState(false);
  const newAgent = useNewAgentActions(() => setImportOpen(true));

  const items = list.items ?? [];
  const visible = useMemo(() => filterAgents(items, filter), [items, filter]);
  const filtered = filter.q !== '' || filter.labels.length > 0 || filter.enabled !== undefined;
  const patch = useCallback((next: Partial<AgentListFilter>) => setFilter({ ...filter, ...next }), [filter, setFilter]);
  const facets = useAgentListFacets(items, filter, patch);

  const countText = countTextFor(list, items, visible, filtered);

  const onOpen = useCallback((id: string) => navigate(agentTabPath(id, 'overview')), []);
  const onToggle = useCallback((id: string, enabled: boolean) => void list.setEnabled(id, enabled), [list]);
  const onClearFilters = useCallback(() => setFilter({ q: '', labels: [], enabled: undefined }), [setFilter]);

  return (
    <>
      <ScreenHeader
        title="Agents"
        description="Every agent in this workspace. Open one to edit it, test it and ship it."
        actions={<NewAgentMenu {...newAgent} />}
      />
      <div className="agent-list-screen">
        <FilterBar
          search={{ value: filter.q, onChange: (q) => patch({ q }), placeholder: 'Search agents' }}
          facets={facets}
        />
        {countText !== null && (
          <p className="visually-hidden" role="status" aria-live="polite">
            {countText}
          </p>
        )}
        <AgentListBody
          list={list}
          items={items}
          visible={visible}
          newAgent={newAgent}
          onClearFilters={onClearFilters}
          onOpen={onOpen}
          onToggle={onToggle}
        />
        <CodeAgentSection dirs={codeDirs} />
      </div>
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
