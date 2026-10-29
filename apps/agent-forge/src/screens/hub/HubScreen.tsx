/**
 * `#/hub` - the Context Hub's namespaces - and `#/hub/:namespace`, one
 * namespace's key/value entries as cards beside the open entry (URL shapes
 * in `hubModel.ts`).
 *
 * The daemon has no namespace endpoint and reads hub entries only on behalf
 * of an agent (`GET /api/v1/hub?agent_id=`: every fleet entry plus that
 * agent's own private ones), so the screen asks "Viewing as" which agent, and
 * derives the namespace list client-side from up to 1000 entries. Filter
 * edits replace the history entry; opening a namespace pushes one. Behind the
 * daemon-down state, which keeps the URL and swaps back in by itself.
 */
import './hub.css';
import { useMemo, useState } from 'react';
import { Eye, FolderOpen, Info, Library, MousePointerClick } from 'lucide-react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonDown, useDaemonHealth, useHubEntries } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { HubEntryFilter } from '../../observe/observeClient';
import type { ObserveAgentRow, ObserveHubEntry } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { Card } from '../../ui/Card';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { Clip } from '../listFilters';
import { HubEntryCards } from './HubEntryCards';
import { HubEntryDetail } from './HubEntry';
import { HUB_LIMIT, agentLabel, groupNamespaces, hubPath, parseHubQuery, sortAgents, type HubNamespaceRow, type HubUrlState } from './hubModel';

const NAMESPACE_COLUMNS: Column<HubNamespaceRow>[] = [
  {
    key: 'namespace',
    header: 'Namespace',
    width: 260,
    render: (n) => (
      <span className="hub-ns-cell">
        <span className="hub-ns-icon" aria-hidden="true">
          <FolderOpen size={14} strokeWidth={1.75} />
        </span>
        <Clip text={n.namespace} className="list-clip hub-ns-name" />
      </span>
    ),
  },
  { key: 'entries', header: 'Entries', align: 'right', width: 90, render: (n) => fmtInt(n.entries) },
  { key: 'fleet', header: 'Fleet', align: 'right', width: 80, render: (n) => fmtInt(n.fleet) },
  { key: 'private', header: 'Private', align: 'right', width: 80, render: (n) => fmtInt(n.private) },
  { key: 'updated', header: 'Last updated', width: 140, hideBelow: 640, render: (n) => fmtDateTime(n.updated) },
];

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** The viewer and scope pickers, plus what the viewer means for private entries. */
function HubBar({
  agents,
  viewer,
  state,
  onChange,
}: {
  agents: ObserveAgentRow[];
  viewer: string;
  state: HubUrlState;
  onChange: (patch: HubUrlState) => void;
}) {
  const known = agents.some((a) => a.agent_id === viewer);
  const viewerName = agents.find((a) => a.agent_id === viewer);
  return (
    <div className="hub-bar">
      <label className="hub-field">
        <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>Viewing as</span>
        <select className="select" aria-label="Viewing as" value={viewer} onChange={(e) => onChange({ agent: e.target.value })}>
          {!known && <option value={viewer}>{viewer}</option>}
          {agents.map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {agentLabel(a)}
            </option>
          ))}
        </select>
      </label>
      <label className="hub-field">
        <span>Scope</span>
        <select
          className="select"
          aria-label="Scope"
          value={state.scope ?? ''}
          onChange={(e) => onChange({ scope: e.target.value === 'private' || e.target.value === 'fleet' ? e.target.value : undefined })}
        >
          <option value="">Private and fleet</option>
          <option value="private">Private</option>
          <option value="fleet">Fleet</option>
        </select>
      </label>
      <p className="hub-note hub-bar-note">
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>
          Private entries shown are {viewerName ? agentLabel(viewerName) : viewer}'s; other agents' private entries are never readable.
        </span>
      </p>
    </div>
  );
}

/** The entry cards, or their loading / empty state. */
function EntryList({
  entries,
  loading,
  selectedId,
  writerName,
  now,
  onOpen,
}: {
  entries: ObserveHubEntry[];
  loading: boolean;
  selectedId: string | undefined;
  writerName: (id: string | null) => string;
  now: number;
  onOpen: (entry: ObserveHubEntry) => void;
}) {
  if (loading && entries.length === 0) return <SkeletonRows rows={4} />;
  if (entries.length === 0)
    return (
      <Card as="div">
        <EmptyState title="No entries in this namespace" hint="Expired entries are hidden; try the other scope or viewer." />
      </Card>
    );
  return (
    <>
      <p className="hub-overline">{plural(entries.length, 'entry', 'entries')}</p>
      <HubEntryCards entries={entries} selectedId={selectedId} writerName={writerName} now={now} onOpen={onOpen} />
    </>
  );
}

function NamespaceEntries({
  entries,
  loading,
  writerName,
  onSaved,
}: {
  entries: ObserveHubEntry[];
  loading: boolean;
  writerName: (id: string | null) => string;
  onSaved: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const now = useMemo(() => Date.now(), [entries]);
  const selected = entries.find((e) => e.entry_id === selectedId);
  const placeholder = entries.length > 0 && (
    <Card as="div" className="hub-detail-empty">
      <EmptyState icon={MousePointerClick} title="Select an entry" hint="Its full value opens here; fleet entries can be edited in place." />
    </Card>
  );
  return (
    <div className="hub-split">
      <div className="hub-split-list">
        <EntryList
          entries={entries}
          loading={loading}
          selectedId={selectedId}
          writerName={writerName}
          now={now}
          onOpen={(e) => setSelectedId(e.entry_id)}
        />
      </div>
      {selected ? (
        <HubEntryDetail key={selected.entry_id} entry={selected} writer={writerName(selected.agent_id)} now={now} onSaved={onSaved} />
      ) : (
        placeholder
      )}
    </div>
  );
}

function NamespaceList({ rows, state, loading }: { rows: ObserveHubEntry[]; state: HubUrlState; loading: boolean }) {
  const namespaces = groupNamespaces(rows);
  return (
    <Card
      title="Namespaces"
      description={loading && rows.length === 0 ? undefined : `${plural(namespaces.length, 'namespace', 'namespaces')}, ${plural(rows.length, 'entry', 'entries')}`}
      padding="none"
    >
      <DataTable
        id="hub-namespaces"
        columns={NAMESPACE_COLUMNS}
        rows={namespaces}
        rowKey={(n) => n.namespace}
        onRowOpen={(n) => navigate(hubPath(n.namespace, state))}
        loading={loading}
        empty={
          <EmptyState
            icon={Library}
            title="No hub entries"
            hint="Agents publish shared context with hub().publish or the hub_publish tool (or POST /api/v1/hub); namespaces appear here."
          />
        }
      />
    </Card>
  );
}

/** The URL state, the sorted agents and the viewer (the `agent` param, else the first agent by name). */
function useHubViewer() {
  const route = useRoute();
  const queryString = route.query.toString();
  const state = useMemo(() => parseHubQuery(route.query), [queryString]);
  const agents = useAgents();
  const sorted = useMemo(() => sortAgents(agents.data ?? []), [agents.data]);
  return { state, agents, sorted, viewer: state.agent ?? sorted[0]?.agent_id };
}

function HubContent({ namespace }: { namespace: string | undefined }) {
  const { state, agents, sorted, viewer } = useHubViewer();
  const [refreshKey, setRefreshKey] = useState(0);
  const filter: HubEntryFilter | undefined =
    viewer === undefined ? undefined : { agent_id: viewer, namespace, scope: state.scope, limit: HUB_LIMIT };
  const entries = useHubEntries(filter, refreshKey);
  const down = useDaemonDown(false, [agents, entries]);

  if (down) return <ObserveDaemonDown />;
  if (viewer === undefined) {
    if (agents.loading || agents.error) return <ObserveError error={agents.error} />;
    return (
      <EmptyState
        icon={Library}
        title="No agents yet"
        hint="Agents publish shared context with hub().publish or the hub_publish tool (LOUSHO_OBSERVE set); once one reports to this daemon, its namespaces show up here."
      />
    );
  }

  const names = new Map(sorted.map((a) => [a.agent_id, agentLabel(a)]));
  const writerName = (id: string | null) => (id === null ? '—' : (names.get(id) ?? id));
  // Changing the viewer to the default drops `agent`; any filter edit replaces the history entry.
  const update = (patch: HubUrlState) => {
    const next = { ...state, ...patch };
    if (next.agent === sorted[0]?.agent_id) delete next.agent;
    navigate(hubPath(namespace, next), { replace: true });
  };
  const rows = entries.data ?? [];

  return (
    <>
      <HubBar agents={sorted} viewer={viewer} state={state} onChange={update} />
      <ObserveError error={entries.error} />
      {rows.length >= HUB_LIMIT && (
        <p className="hub-note hub-limit" role="status">
          The daemon returned its {fmtInt(HUB_LIMIT)}-entry limit; this list may be incomplete.
        </p>
      )}
      {namespace === undefined ? (
        <NamespaceList rows={rows} state={state} loading={entries.loading || agents.loading} />
      ) : (
        <NamespaceEntries
          key={JSON.stringify([viewer, namespace])}
          entries={rows}
          loading={entries.loading}
          writerName={writerName}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </>
  );
}

/** The page header: the hub, or one namespace under a breadcrumb back to the list (keeping the viewer and scope). */
function HubHeader({ namespace }: { namespace: string | undefined }) {
  const route = useRoute();
  if (namespace === undefined)
    return <ScreenHeader title="Context Hub" description="Shared key/value context the fleet's agents publish for each other." />;
  return (
    <ScreenHeader
      title={namespace}
      description="Entries in this namespace; open one to see its full value."
      breadcrumbs={[{ label: 'Context Hub', href: `#${hubPath(undefined, parseHubQuery(route.query))}` }, { label: namespace }]}
    />
  );
}

/** `#/hub` and `#/hub/:namespace`, behind the daemon-down state. */
export function HubScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  const namespace = matchRoute(`#${path}`, ['/hub/:namespace'])?.params.namespace;
  if (health.down) return <ObserveDaemonDown />;
  return (
    <section className="hub-screen" aria-label="Context Hub">
      <HubHeader namespace={namespace} />
      <h2 className="visually-hidden">Context Hub</h2>
      <HubContent namespace={namespace} />
    </section>
  );
}
