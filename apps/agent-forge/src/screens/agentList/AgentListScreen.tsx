/**
 * `#/agents` - the agents list (A02): a card grid of every agent in the
 * workspace under a header with the Blank agent action, a FilterBar whose
 * search/labels/status state lives in the URL (`agentListUrl.ts`), and the
 * loading / error / empty / no-match states. A card opens the agent's
 * overview tab; its switch toggles `meta.enabled` optimistically through
 * `useAgentList`. The New agent menu (A04) replaces the single Blank agent
 * button in the header.
 */
import { useCallback, useMemo, useState } from 'react';
import { Bot, CircleAlert, Plus, SearchX } from 'lucide-react';
import type { AgentListItem } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { navigate } from '../../router/router';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { FilterBar, type FacetDef } from '../../ui/FilterBar';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { facet } from '../listFilters';
import { agentTabPath } from '../agents/agentTabs';
import { AgentCard } from './AgentCard';
import { filterAgents, labelOptions, useAgentListFilter, type AgentListFilter } from './agentListUrl';
import { useAgentList, type AgentListState } from './useAgentList';
import './agentList.css';

const SKELETON_CARDS = 6;

const plural = (n: number): string => (n === 1 ? 'agent' : 'agents');

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The header's (and empty state's) primary action until A04's New agent menu lands. */
function BlankAgentButton({ pending, onCreate }: { pending: boolean; onCreate: () => void }) {
  return (
    <button type="button" className="btn btn-primary" disabled={pending} onClick={onCreate}>
      <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
      {pending ? 'Creating…' : 'Blank agent'}
    </button>
  );
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

/** The first-load shimmer grid: skeleton cards plus one hidden status line. */
function LoadingGrid() {
  return (
    <ul className="agent-grid" aria-label="Agents" aria-busy="true">
      <li role="status" className="visually-hidden">
        Loading agents
      </li>
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </ul>
  );
}

/** The error card with Retry (`refresh`). */
function ErrorCard({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <Card as="div">
      <EmptyState
        icon={CircleAlert}
        title="Could not load agents"
        hint={error}
        action={
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        }
      />
    </Card>
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
  creating: boolean;
  onCreateBlank(): void;
  onClearFilters(): void;
  onOpen(id: string): void;
  onToggle(id: string, enabled: boolean): void;
}

/** Exactly one of: error card, loading grid, empty state, no-match state, card grid. */
function AgentListBody({ list, items, visible, creating, onCreateBlank, onClearFilters, onOpen, onToggle }: ListBodyProps) {
  if (list.error !== undefined && list.items === undefined) {
    return <ErrorCard error={list.error} onRetry={list.refresh} />;
  }
  if (list.items === undefined) return <LoadingGrid />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No agents yet"
        hint="Create one to get started."
        action={<BlankAgentButton pending={creating} onCreate={onCreateBlank} />}
      />
    );
  }
  if (visible.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No matching agents"
        hint="Try a different search or clear the filters."
        action={
          <button type="button" className="btn" onClick={onClearFilters}>
            Clear filters
          </button>
        }
      />
    );
  }
  return <AgentGrid items={visible} pendingIds={list.pendingIds} onOpen={onOpen} onToggle={onToggle} />;
}

/** `POST /agents { from: 'blank' }` then into the new agent's canvas; failures toast. */
function useCreateBlankAgent(): { creating: boolean; create(): void } {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const create = useCallback(() => {
    setCreating(true);
    runtimeClient
      .createAgentRecord({ from: 'blank' })
      .then((record) => navigate(agentTabPath(record.id, 'canvas')))
      .catch((error: unknown) => toast.show({ message: messageOf(error), tone: 'error' }))
      .finally(() => setCreating(false));
  }, [toast]);
  return { creating, create };
}

/** The two FilterBar facets: Labels (multi) over every item's labels, Status (single) over on/off. */
function useAgentListFacets(
  items: AgentListItem[],
  filter: AgentListFilter,
  patch: (next: Partial<AgentListFilter>) => void
): FacetDef[] {
  const labelsFacet = useMemo<FacetDef>(
    () => ({
      key: 'label',
      label: 'Labels',
      options: labelOptions(items),
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
  const [filter, setFilter] = useAgentListFilter();
  const { creating, create } = useCreateBlankAgent();

  const items = list.items ?? [];
  const visible = useMemo(() => filterAgents(items, filter), [items, filter]);
  const filtered = filter.q !== '' || filter.labels.length > 0 || filter.enabled !== undefined;
  const patch = useCallback((next: Partial<AgentListFilter>) => setFilter({ ...filter, ...next }), [filter, setFilter]);
  const facets = useAgentListFacets(items, filter, patch);

  const countText =
    list.items === undefined
      ? null
      : filtered
        ? `${visible.length} of ${items.length} ${plural(items.length)}`
        : `${items.length} ${plural(items.length)}`;

  const onOpen = useCallback((id: string) => navigate(agentTabPath(id, 'overview')), []);
  const onToggle = useCallback((id: string, enabled: boolean) => void list.setEnabled(id, enabled), [list]);
  const onClearFilters = useCallback(() => setFilter({ q: '', labels: [], enabled: undefined }), [setFilter]);

  return (
    <>
      <ScreenHeader
        title="Agents"
        description="Every agent in this workspace. Open one to edit it, test it and ship it."
        actions={<BlankAgentButton pending={creating} onCreate={create} />}
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
          creating={creating}
          onCreateBlank={create}
          onClearFilters={onClearFilters}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      </div>
    </>
  );
}
