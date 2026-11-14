/**
 * `#/agents` - the agents list (A02, scoped per W06b): a card grid under a
 * header with the New agent menu (A04), a FilterBar whose
 * search/labels/status/workspace state lives in the URL
 * (`agentListUrl.ts`), and the loading / error / empty / no-match states.
 *
 * Two scopes (W06b): `#/agents` is the all-workspaces list - every
 * workspace's agents, each card carrying a workspace chip, a Workspace
 * facet, and a note for workspaces that could not be read; `#/w/<ws>/agents`
 * is one workspace's list with no chip and no facet. A card opens the
 * agent's overview tab IN ITS OWN workspace; its switch toggles
 * `meta.enabled` optimistically through `useAgentList`, which PATCHes
 * with that workspace's header.
 */
import { useCallback, useMemo, useState } from 'react';
import { Bot, RefreshCw, SearchX } from 'lucide-react';
import type { CodeAgentItem, ObservedAgentItem, WorkspaceAgentItem } from '../../../shared/wireTypes';
import { labelFacetOptions } from '../../../shared/labels';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useWorkspacesMaybe } from '../../workspace/WorkspacesProvider';
import { workspaceLabel } from '../../workspace/workspaceLabels';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { EmptyState } from '../../ui/EmptyState';
import { FilterBar, type FacetDef } from '../../ui/FilterBar';
import { Skeleton } from '../../ui/Skeleton';
import { facet } from '../listFilters';
import { LoadErrorCard, LoadingGrid } from '../listStates';
import { agentTabPath } from '../agents/agentTabs';
import { ImportSheet } from '../agents/import/ImportSheet';
import { AgentCard } from './AgentCard';
import { CodeAgentCard } from './CodeAgentCard';
import { ObservedAgentCard } from './ObservedAgentCard';
import { HostBanner } from '../../components/HostBanner';
import { useHostStatus } from '../../state/useHostStatus';
import { filterAgents, filterCode, filterObserved, useAgentListFilter, workspaceOptions, type AgentListFilter } from './agentListUrl';
import { NewAgentMenu, StartOptions } from './NewAgentMenu';
import { useNewAgentActions, type NewAgentActions } from './newAgent';
import { pendingKey, useAgentList, type AgentListScope, type AgentListState } from './useAgentList';
import './agentList.css';

const plural = (n: number): string => (n === 1 ? 'agent' : 'agents');

/** The list's scope from the hash: `/w/<ws>/agents` is one workspace, `/agents` is all of them. */
function scopeForHash(hash: string): AgentListScope {
  const route = matchRoute(hash, ['/w/:ws/agents']);
  const ws = route?.params.ws;
  return ws === undefined ? { kind: 'all' } : { kind: 'workspace', workspaceId: ws };
}

/** The visually-hidden count line: total when unfiltered, "X of Y" under a filter, nothing while loading. */
function countTextFor(list: AgentListState, items: WorkspaceAgentItem[], visible: WorkspaceAgentItem[], filtered: boolean): string | null {
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

/** The loaded grid: one AgentCard per visible workspace item, then the observed items placed in a workspace (W07b), then the code agents (W08b) - keyed `<workspaceId>/<id>` / `observed/<id>` / `code/<workspaceId>/<path>` (ids repeat across workspaces and daemons). */
function AgentGrid({
  items,
  observed,
  code,
  pendingIds,
  allMode,
  workspaceNameOf,
  workspaceRootOf,
  onOpen,
  onToggle,
}: {
  items: WorkspaceAgentItem[];
  observed: ObservedAgentItem[];
  code: CodeAgentItem[];
  pendingIds: ReadonlySet<string>;
  allMode: boolean;
  workspaceNameOf(id: string): string | undefined;
  workspaceRootOf(id: string): string | undefined;
  onOpen(item: WorkspaceAgentItem): void;
  onToggle(item: WorkspaceAgentItem, enabled: boolean): void;
}) {
  return (
    <ul className="agent-grid" aria-label="Agents" aria-busy="false">
      {items.map((item) => (
        <AgentCard
          key={pendingKey(item)}
          agent={item}
          workspaceId={allMode ? item.workspaceId : undefined}
          workspaceName={allMode ? workspaceNameOf(item.workspaceId) : undefined}
          workspaceRoot={allMode ? workspaceRootOf(item.workspaceId) : undefined}
          onOpen={() => onOpen(item)}
          onToggleEnabled={(_id, enabled) => onToggle(item, enabled)}
          toggling={pendingIds.has(pendingKey(item))}
        />
      ))}
      {observed.map((item) => (
        <ObservedAgentCard
          key={`observed/${item.id}`}
          agent={item}
          workspaceName={allMode && item.workspaceId !== null ? workspaceNameOf(item.workspaceId) : undefined}
        />
      ))}
      {code.map((item) => (
        <CodeAgentCard
          key={`code/${item.workspaceId}/${item.id}`}
          agent={item}
          workspaceName={allMode ? workspaceNameOf(item.workspaceId) : undefined}
        />
      ))}
    </ul>
  );
}

interface ListBodyProps {
  list: AgentListState;
  items: WorkspaceAgentItem[];
  visible: WorkspaceAgentItem[];
  /** Observed items placed in a workspace (main grid, after the workspace's own agents). */
  observedPlaced: ObservedAgentItem[];
  /** Observed items under "Elsewhere" (all-workspaces mode only; empty in workspace mode). */
  observedElsewhere: ObservedAgentItem[];
  /** Code agents in the grid (W08b), after the workspace's own and observed agents. */
  code: CodeAgentItem[];
  allMode: boolean;
  workspaceNameOf(id: string): string | undefined;
  workspaceRootOf(id: string): string | undefined;
  newAgent: NewAgentActions;
  onClearFilters(): void;
  onOpen(item: WorkspaceAgentItem): void;
  onToggle(item: WorkspaceAgentItem, enabled: boolean): void;
}

/** The all-mode note for workspaces the aggregate could not read (W06b). */
function SkippedNote({ skipped, nameOf }: { skipped: AgentListState['skipped']; nameOf(id: string): string | undefined }) {
  if (skipped.length === 0) return null;
  const names = skipped.map((entry) => nameOf(entry.workspaceId) ?? entry.workspaceId).join(', ');
  return (
    <p className="agent-list-skipped" role="note">
      Some workspaces could not be read: {names}. Check them in{' '}
      <a href="#/settings">Settings</a>.
    </p>
  );
}

/** Exactly one of: error card, loading grid, empty state, no-match state, card grid (+ the Elsewhere group, W07b). */
// fallow-ignore-next-line complexity
function AgentListBody({
  list,
  items,
  visible,
  observedPlaced,
  observedElsewhere,
  code,
  allMode,
  workspaceNameOf,
  workspaceRootOf,
  newAgent,
  onClearFilters,
  onOpen,
  onToggle,
}: ListBodyProps) {
  if (list.error !== undefined && list.items === undefined) {
    return <LoadErrorCard title="Could not load agents" error={list.error} onRetry={list.refresh} />;
  }
  if (list.items === undefined) {
    return <LoadingGrid className="agent-grid" label="Agents" status="Loading agents" skeleton={SkeletonCard} />;
  }
  const restCount = observedPlaced.length + observedElsewhere.length + code.length;
  if (items.length === 0 && restCount === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No agents yet"
        hint="Pick a way to start."
        action={<StartOptions {...newAgent} />}
      />
    );
  }
  if (visible.length === 0 && restCount === 0) {
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
  return (
    <>
      <AgentGrid
        items={visible}
        observed={observedPlaced}
        code={code}
        pendingIds={list.pendingIds}
        allMode={allMode}
        workspaceNameOf={workspaceNameOf}
        workspaceRootOf={workspaceRootOf}
        onOpen={onOpen}
        onToggle={onToggle}
      />
      {observedElsewhere.length > 0 && (
        <section aria-label="Elsewhere">
          <h2 className="agent-list-group">Elsewhere</h2>
          <p className="agent-list-group-hint">Reported to the collector from projects that are not in Studio.</p>
          <ul className="agent-grid" aria-label="Elsewhere agents">
            {observedElsewhere.map((item) => (
              <ObservedAgentCard key={`observed/${item.id}`} agent={item} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The FilterBar facets: Labels (multi), Status (single), and Workspace (multi, all mode only, W06b). */
function useAgentListFacets(
  items: WorkspaceAgentItem[],
  allMode: boolean,
  filter: AgentListFilter,
  patch: (next: Partial<AgentListFilter>) => void,
  workspaces: readonly import('../../../shared/wireTypes').WorkspaceListItem[] | undefined
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
  const workspaceFacet = useMemo<FacetDef | undefined>(() => {
    if (!allMode) return undefined;
    return {
      key: 'workspace',
      label: 'Workspace',
      options: workspaceOptions(items, workspaces),
      value: filter.workspaces,
      onChange: (workspaces) => patch({ workspaces }),
    };
  }, [allMode, items, workspaces, filter.workspaces, patch]);
  return workspaceFacet === undefined ? [labelsFacet, statusFacet] : [labelsFacet, statusFacet, workspaceFacet];
}

/**
 * `#/agents` (all workspaces) and `#/w/<ws>/agents` (one workspace) - see
 * the module comment. Filter state is the URL's; the list itself comes
 * from `useAgentList`.
 */
// fallow-ignore-next-line complexity
export function AgentListScreen() {
  const route = useRoute();
  const scope = useMemo(() => scopeForHash(`#${route.path}${route.query.size > 0 ? `?${route.query}` : ''}`), [route]);
  const allMode = scope.kind === 'all';
  const list = useAgentList(scope);
  // W11c: the scoped workspace's host banner (which SDK runs its agents);
  // the all-workspaces list has no single host to report.
  const host = useHostStatus(scope.kind === 'workspace' ? scope.workspaceId : undefined);
  const workspacesState = useWorkspacesMaybe();
  const workspaces = workspacesState?.list;
  const launchId = workspacesState?.launchId;
  const [filter, setFilter] = useAgentListFilter();
  // One instance shared by the header menu and the empty state's start buttons:
  // a second useNewAgentActions would track `creating` separately and let a
  // second blank create slip through while the first is in flight.
  const [importOpen, setImportOpen] = useState(false);
  // The workspace a blank agent is created in (W06b): the scoped route's
  // workspace; in all mode the single selected Workspace filter value, else
  // the launch workspace.
  const createWorkspace =
    scope.kind === 'workspace'
      ? scope.workspaceId
      : filter.workspaces.length === 1
        ? filter.workspaces[0]
        : launchId;
  const newAgent = useNewAgentActions(() => setImportOpen(true), createWorkspace);

  const allItems = list.items ?? [];
  // W07b: workspace items feed the grid/filters/facets; observed items get
  // their own (search + Workspace-facet only) pass and split into the
  // workspace-placed group and "Elsewhere".
  const items = useMemo(() => allItems.filter((item): item is WorkspaceAgentItem => item.kind === 'workspace'), [allItems]);
  const observedItems = useMemo(() => allItems.filter((item): item is ObservedAgentItem => item.kind === 'observed'), [allItems]);
  const codeItems = useMemo(() => allItems.filter((item): item is CodeAgentItem => item.kind === 'code'), [allItems]);
  // The `workspace` query key only applies in all-workspaces mode.
  const effectiveFilter = useMemo<AgentListFilter>(
    () => (allMode ? filter : { ...filter, workspaces: [] }),
    [allMode, filter]
  );
  const visible = useMemo(() => filterAgents(items, effectiveFilter), [items, effectiveFilter]);
  const visibleObserved = useMemo(() => filterObserved(observedItems, effectiveFilter), [observedItems, effectiveFilter]);
  const visibleCode = useMemo(() => filterCode(codeItems, effectiveFilter), [codeItems, effectiveFilter]);
  const observedElsewhere = visibleObserved.filter((item) => item.workspaceId === null);
  const observedPlaced = visibleObserved.filter((item) => item.workspaceId !== null);
  const filtered =
    effectiveFilter.q !== '' || effectiveFilter.labels.length > 0 || effectiveFilter.enabled !== undefined || effectiveFilter.workspaces.length > 0;
  const patch = useCallback((next: Partial<AgentListFilter>) => setFilter({ ...filter, ...next }), [filter, setFilter]);
  const facets = useAgentListFacets(items, allMode, filter, patch, workspaces);

  const wsNameOf = useCallback((id: string) => workspaceLabel(id, workspaces), [workspaces]);
  const wsRootOf = useCallback(
    (id: string) => workspaces?.find((ws) => ws.id === id)?.root,
    [workspaces]
  );
  const countText = countTextFor(list, items, visible, filtered);

  const scopeName = scope.kind === 'workspace' ? workspaceLabel(scope.workspaceId, workspaces) : undefined;
  const description =
    scopeName === undefined
      ? 'Every agent in every workspace. Open one to edit it, test it and ship it.'
      : `Agents in ${scopeName}. Open one to edit it, test it and ship it.`;

  const onOpen = useCallback((item: WorkspaceAgentItem) => navigate(agentTabPath(item.id, 'overview', item.workspaceId)), []);
  const onToggle = useCallback((item: WorkspaceAgentItem, enabled: boolean) => void list.setEnabled(item, enabled), [list]);
  const onClearFilters = useCallback(() => setFilter({ q: '', labels: [], enabled: undefined, workspaces: [] }), [setFilter]);
  // W08b: workspace mode's "Rescan code" re-runs the workspace's pattern
  // scan; all mode needs no action (the aggregate already carries the
  // cached scan results).
  const onRescanCode = useCallback(() => {
    if (scope.kind === 'workspace') void list.rescanCode(workspaceLabel(scope.workspaceId, workspaces));
  }, [scope, list, workspaces]);

  return (
    <>
      <ScreenHeader
        title="Agents"
        description={description}
        actions={
          <>
            {scope.kind === 'workspace' && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onRescanCode}
                disabled={list.scanningCode}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {list.scanningCode ? 'Scanning…' : 'Rescan code'}
              </button>
            )}
            <NewAgentMenu {...newAgent} />
          </>
        }
      />
      <div className="agent-list-screen">
        {scope.kind === 'workspace' && (
          <HostBanner status={host.status} restarting={host.restarting} restartError={host.restartError} onRestart={() => void host.restart()} />
        )}
        <FilterBar
          search={{ value: filter.q, onChange: (q) => patch({ q }), placeholder: 'Search agents' }}
          facets={facets}
        />
        {countText !== null && (
          <p className="visually-hidden" role="status" aria-live="polite">
            {countText}
          </p>
        )}
        {allMode && <SkippedNote skipped={list.skipped} nameOf={wsNameOf} />}
        {list.observed === 'unavailable' && list.items !== undefined && (
          <p className="agent-list-skipped" role="note">
            The collector is not running, so agents deployed elsewhere are not shown.
          </p>
        )}
        <AgentListBody
          list={list}
          items={items}
          visible={visible}
          observedPlaced={observedPlaced}
          observedElsewhere={observedElsewhere}
          code={visibleCode}
          allMode={allMode}
          workspaceNameOf={wsNameOf}
          workspaceRootOf={wsRootOf}
          newAgent={newAgent}
          onClearFilters={onClearFilters}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      </div>
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
