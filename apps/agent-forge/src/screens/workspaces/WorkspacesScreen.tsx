import { useMemo } from 'react';
import { CircleAlert } from 'lucide-react';
import type { WorkspaceSummary } from 'lousho/workspaces/client';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { Input } from '../../ui/controls';
import { StatusBadge } from '../../ui/StatusBadge';
import { useClientQuery } from './useClientQuery';
import { parseWorkspacesQuery, workspacePath, workspacesHref } from './workspacesUrl';

type WorkspaceRow = WorkspaceSummary & { errors: number | undefined };

const rowMatches = (row: WorkspaceRow, q: string): boolean => {
  const needle = q.toLowerCase();
  return (
    row.name.toLowerCase().includes(needle) ||
    row.id.toLowerCase().includes(needle) ||
    (row.domain ?? '').toLowerCase().includes(needle)
  );
};

function StatusCell({ errors }: { errors?: number }) {
  if (errors === undefined) return <StatusBadge status="unknown" label="Unknown" size="sm" />;
  if (errors === 0) return <StatusBadge status="done" label="Valid" size="sm" />;
  return <StatusBadge status="error" label={`Invalid (${errors})`} size="sm" />;
}

const COLUMNS: Column<WorkspaceRow>[] = [
  {
    key: 'name',
    header: 'Name',
    render: (row) => (
      <span className="ws-row-name">
        <b>{row.name}</b>
        {row.domain ? <span className="ws-row-domain">{row.domain}</span> : null}
      </span>
    ),
  },
  { key: 'pages', header: 'Pages', render: (row) => row.pageCount },
  { key: 'status', header: 'Status', render: (row) => <StatusCell errors={row.errors} /> },
  { key: 'revision', header: 'Revision', render: (row) => <code>{row.revision}</code> },
  {
    key: 'lastRun',
    header: 'Last run',
    render: () => (
      <span title="Last run shows with P2.6a">—</span>
    ),
  },
  {
    key: 'actions',
    header: 'Actions',
    render: (row) => (
      <span className="dt-actions">
        <a className="btn btn-sm" href={`#${workspacePath(row.id)}`}>
          Open
        </a>
        <button type="button" className="btn btn-sm" title="Export lands with P2.15" disabled>
          Export
        </button>
      </span>
    ),
  },
];

export function WorkspacesScreen() {
  const { query } = useRoute();
  const urlState = useMemo(() => parseWorkspacesQuery(query), [query]);
  const q = urlState.q ?? '';
  const state = useClientQuery<WorkspaceRow[]>(async (client) => {
    const list = await client.call('listWorkspaces', {});
    const problems = await Promise.all(
      list.map((workspace) =>
        client.call('getProblems', { params: { id: workspace.id } }).catch(() => undefined),
      ),
    );
    return list.map((workspace, index) => ({
      ...workspace,
      errors: problems[index]?.filter((problem) => problem.severity === 'error').length,
    }));
  }, 'workspaces');

  const rows = (state.data ?? []).filter((row) => q === '' || rowMatches(row, q));
  const failed = state.error !== undefined || state.notFound;

  return (
    <>
      <ScreenHeader
        title="Workspaces"
        description="Each workspace's pages, problems and live revision."
        actions={
          <button type="button" className="btn" title="Import lands with P2.15" disabled>
            Import
          </button>
        }
      />
      <section className="ws-list" aria-label="Workspaces">
        <h2 className="visually-hidden">Workspaces</h2>
        <Input
          type="search"
          aria-label="Filter workspaces"
          value={q}
          onChange={(event) => navigate(workspacesHref({ q: event.target.value }), { replace: true })}
        />
        {failed ? (
          <EmptyState
            icon={CircleAlert}
            title="Could not load workspaces"
            hint={state.error}
            action={
              <button type="button" className="btn" onClick={state.refresh}>
                Retry
              </button>
            }
          />
        ) : (
          <DataTable
            id="workspaces"
            columns={COLUMNS}
            rows={rows}
            rowKey={(row) => row.id}
            onRowOpen={(row) => navigate(workspacePath(row.id))}
            loading={state.loading && !state.data}
            empty={
              <EmptyState
                title="No workspaces yet"
                hint="Create one with the authoring chat or `lousho workspace init`, or import one."
              />
            }
          />
        )}
      </section>
    </>
  );
}
