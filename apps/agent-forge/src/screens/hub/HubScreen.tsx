/**
 * `#/hub` - the Context Hub's namespaces - and `#/hub/:namespace`, one
 * namespace's key/value entries (URL shapes in `hubModel.ts`).
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
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useAgents, useDaemonHealth, useHubEntries } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveDaemonDownError, type HubEntryFilter } from '../../observe/observeClient';
import type { ObserveAgentRow, ObserveHubEntry } from '../../observe/types';
import { fmtDateTime, fmtInt, fmtStarted } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { StatusPill } from '../../ui/StatusPill';
import { Clip } from '../listFilters';
import { HubEntryDetail } from './HubEntry';
import {
  HUB_LIMIT,
  agentLabel,
  groupNamespaces,
  hubPath,
  parseHubQuery,
  sortAgents,
  ttlText,
  valuePreview,
  type HubNamespaceRow,
  type HubUrlState,
} from './hubModel';

const NAMESPACE_COLUMNS: Column<HubNamespaceRow>[] = [
  { key: 'namespace', header: 'Namespace', width: 240, render: (n) => <Clip text={n.namespace} /> },
  { key: 'entries', header: 'Entries', align: 'right', width: 90, render: (n) => fmtInt(n.entries) },
  { key: 'fleet', header: 'Fleet', align: 'right', width: 80, render: (n) => fmtInt(n.fleet) },
  { key: 'private', header: 'Private', align: 'right', width: 80, render: (n) => fmtInt(n.private) },
  { key: 'updated', header: 'Last updated', width: 140, hideBelow: 640, render: (n) => fmtDateTime(n.updated) },
];

function entryColumns(writerName: (id: string | null) => string, now: number): Column<ObserveHubEntry>[] {
  return [
    { key: 'key', header: 'Key', width: 180, render: (e) => <Clip text={e.key} /> },
    { key: 'value', header: 'Value', width: 280, render: (e) => <Clip text={valuePreview(e.value)} className="list-clip hub-preview" /> },
    { key: 'scope', header: 'Scope', width: 96, render: (e) => <StatusPill status={e.scope} /> },
    { key: 'writer', header: 'Writer', width: 130, hideBelow: 720, render: (e) => <Clip text={writerName(e.agent_id)} /> },
    { key: 'updated', header: 'Updated', width: 140, hideBelow: 900, render: (e) => fmtStarted(e.created_at, now) },
    { key: 'ttl', header: 'TTL', width: 180, hideBelow: 1000, render: (e) => ttlText(e, now) },
  ];
}

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
      <p className="hub-note">
        Private entries shown are {viewerName ? agentLabel(viewerName) : viewer}'s; other agents' private entries are never readable.
      </p>
    </div>
  );
}

function NamespaceEntries({
  namespace,
  state,
  entries,
  loading,
  writerName,
  onSaved,
}: {
  namespace: string;
  state: HubUrlState;
  entries: ObserveHubEntry[];
  loading: boolean;
  writerName: (id: string | null) => string;
  onSaved: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const now = useMemo(() => Date.now(), [entries]);
  const selected = entries.find((e) => e.entry_id === selectedId);
  return (
    <>
      <p className="hub-crumbs">
        <a href={`#${hubPath(undefined, state)}`}>All namespaces</a>
      </p>
      <h3 className="hub-title">
        <code>{namespace}</code>
      </h3>
      <DataTable
        id="hub-entries"
        columns={entryColumns(writerName, now)}
        rows={entries}
        rowKey={(e) => e.entry_id}
        selectedKey={selectedId}
        onRowOpen={(e) => setSelectedId(e.entry_id)}
        loading={loading}
        empty={<EmptyState title="No entries in this namespace" hint="Expired entries are hidden; try the other scope or viewer." />}
      />
      {selected && (
        <HubEntryDetail key={selected.entry_id} entry={selected} writer={writerName(selected.agent_id)} onSaved={onSaved} />
      )}
    </>
  );
}

function NamespaceList({ rows, state, loading }: { rows: ObserveHubEntry[]; state: HubUrlState; loading: boolean }) {
  return (
    <DataTable
      id="hub-namespaces"
      columns={NAMESPACE_COLUMNS}
      rows={groupNamespaces(rows)}
      rowKey={(n) => n.namespace}
      onRowOpen={(n) => navigate(hubPath(n.namespace, state))}
      loading={loading}
      empty={
        <EmptyState
          title="No hub entries"
          hint="Agents publish shared context with hub().publish or the hub_publish tool (or POST /api/v1/hub); namespaces appear here."
        />
      }
    />
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

  if (agents.error instanceof ObserveDaemonDownError || entries.error instanceof ObserveDaemonDownError) return <ObserveDaemonDown />;
  if (viewer === undefined) {
    if (agents.loading || agents.error) return <ObserveError error={agents.error} />;
    return (
      <EmptyState
        title="No agents yet"
        hint="Agents publish shared context with hub().publish or the hub_publish tool (LOUSHO_OBSERVE set); once one reports to this daemon, its namespaces show up here."
      />
    );
  }

  const names = new Map(sorted.map((a) => [a.agent_id, agentLabel(a)]));
  const writerName = (id: string | null) => (id === null ? '-' : (names.get(id) ?? id));
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
        <p className="hub-note" role="status">
          The daemon returned its {fmtInt(HUB_LIMIT)}-entry limit; this list may be incomplete.
        </p>
      )}
      {namespace === undefined ? (
        <NamespaceList rows={rows} state={state} loading={entries.loading || agents.loading} />
      ) : (
        <NamespaceEntries
          key={JSON.stringify([viewer, namespace])}
          namespace={namespace}
          state={state}
          entries={rows}
          loading={entries.loading}
          writerName={writerName}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </>
  );
}

/** `#/hub` and `#/hub/:namespace`, behind the daemon-down state. */
export function HubScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  if (health.down) return <ObserveDaemonDown />;
  const namespace = matchRoute(`#${path}`, ['/hub/:namespace'])?.params.namespace;
  return (
    <section className="hub-screen" aria-label="Context Hub">
      <h2 className="visually-hidden">Context Hub</h2>
      <HubContent namespace={namespace} />
    </section>
  );
}
