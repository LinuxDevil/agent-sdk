/**
 * `#/evals/datasets/:name[?offset=]` - one dataset's examples, oldest first,
 * paged server-side (`GET /api/v1/datasets/:name?limit=&offset=`). Opening a
 * row shows its input and expected value in full; Delete asks first, then
 * `DELETE /api/v1/datasets/:name/examples/:id` and a refetch.
 */
import { useEffect, useState } from 'react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, useDataset } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { observeClient } from '../../observe/observeClient';
import type { ObserveExample } from '../../observe/types';
import { fmtDateTime } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { MessageView } from '../../ui/MessageView';
import { useToast } from '../../ui/Toast';
import { Clip } from '../listFilters';
import { EXAMPLES_PAGE_SIZE, datasetPath, parseOffset, valuePreview } from './datasetsUrl';

const BackLink = () => <a href="#/evals/datasets">Back to datasets</a>;

const SourceTrace = ({ traceId }: { traceId: string | null }) =>
  traceId ? (
    <a href={`#/traces/${encodeURIComponent(traceId)}`} title={traceId}>
      {traceId.slice(0, 12)}
    </a>
  ) : (
    <>-</>
  );

function columns(onDelete: (example: ObserveExample) => void, busy: boolean): Column<ObserveExample>[] {
  return [
    { key: 'input', header: 'Input', width: 300, render: (e) => <Clip text={valuePreview(e.input)} /> },
    { key: 'expected', header: 'Expected', width: 240, render: (e) => <Clip text={valuePreview(e.expected)} /> },
    { key: 'source', header: 'Source trace', width: 140, hideBelow: 720, render: (e) => <SourceTrace traceId={e.source_trace_id} /> },
    { key: 'created', header: 'Created', width: 150, hideBelow: 900, render: (e) => fmtDateTime(e.created_at) },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      label: 'Actions',
      width: 90,
      render: (e) => (
        <button
          type="button"
          className="btn btn-ghost"
          aria-label={`Delete example ${e.example_id}`}
          disabled={busy}
          onClick={() => onDelete(e)}
        >
          Delete
        </button>
      ),
    },
  ];
}

/** The opened example in full: input and expected through MessageView (chat messages render as such). */
function ExamplePanel({ example }: { example: ObserveExample }) {
  return (
    <section className="dataset-example" aria-label={`Example ${example.example_id}`}>
      <MessageView label="Input" value={JSON.stringify(example.input)} />
      {example.expected === null ? (
        <p className="datasets-note">No expected value.</p>
      ) : (
        <MessageView label="Expected" value={JSON.stringify(example.expected)} />
      )}
    </section>
  );
}

/** Delete one example after a confirm; the toast reports the outcome. */
function useDeleteExample(name: string, onDeleted: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const remove = async (example: ObserveExample) => {
    if (!window.confirm(`Delete this example from ${name}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await observeClient.deleteExample(name, example.example_id);
      toast.show({ tone: 'success', message: 'Example deleted.' });
      onDeleted();
    } catch (error) {
      toast.show({ tone: 'error', message: `Could not delete the example: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  return { busy, remove };
}

/** `#/evals/datasets/:name`; an unknown dataset shows an empty state with the way back. */
export function DatasetDetail({ name }: { name: string }) {
  const route = useRoute();
  const offset = parseOffset(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openId, setOpenId] = useState<string | undefined>();
  const query = useDataset(name, { limit: EXAMPLES_PAGE_SIZE, offset }, refreshKey);
  const { busy, remove } = useDeleteExample(name, () => setRefreshKey((k) => k + 1));
  const down = useDaemonDown(false, [query]);
  const examples = query.data?.examples ?? [];
  const total = query.data?.total ?? 0;

  // Deleting the last example of a later page leaves it empty: step back a page.
  useEffect(() => {
    if (query.data && examples.length === 0 && offset > 0 && offset >= total) {
      navigate(datasetPath(name, Math.max(0, offset - EXAMPLES_PAGE_SIZE)), { replace: true });
    }
  }, [query.data, examples.length, offset, total, name]);

  if (down) return <ObserveDaemonDown />;
  const opened = examples.find((e) => e.example_id === openId);
  let body;
  if (query.loading && !query.data) body = <p className="datasets-note">Loading dataset...</p>;
  else if (query.error) body = <ObserveError error={query.error} />;
  else if (!query.data) body = <EmptyState title="Dataset not found" hint={`No dataset '${name}'.`} action={<BackLink />} />;
  else
    body = (
      <>
        {query.data.dataset.description && <p className="datasets-note">{query.data.dataset.description}</p>}
        <DataTable
          id="dataset-examples"
          columns={columns((e) => void remove(e), busy)}
          rows={examples}
          rowKey={(e) => e.example_id}
          selectedKey={opened?.example_id}
          onRowOpen={(e) => setOpenId(e.example_id === openId ? undefined : e.example_id)}
          page={{
            offset,
            limit: EXAMPLES_PAGE_SIZE,
            total,
            onChange: (next) => navigate(datasetPath(name, next), { replace: true }),
          }}
          empty={
            <EmptyState
              title="No examples yet"
              hint="Open a trace and use Add to dataset, or POST examples to /api/v1/datasets/:name/examples."
            />
          }
        />
        {opened && <ExamplePanel example={opened} />}
      </>
    );

  return (
    <>
      <nav className="datasets-nav" aria-label="Breadcrumb">
        <BackLink />
      </nav>
      <h2 className="datasets-title">
        Dataset <code>{name}</code>
      </h2>
      {body}
    </>
  );
}
