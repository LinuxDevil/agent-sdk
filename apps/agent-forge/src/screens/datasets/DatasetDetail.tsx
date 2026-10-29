/**
 * `#/evals/datasets/:name[?offset=]` - one dataset's examples, oldest first,
 * paged server-side (`GET /api/v1/datasets/:name?limit=&offset=`). Opening a
 * row shows its input and expected value in full in a card beside the table
 * (under it on narrow screens); Delete asks first, then
 * `DELETE /api/v1/datasets/:name/examples/:id` and a refetch.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Trash2, X } from 'lucide-react';
import { navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, useDataset } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { observeClient } from '../../observe/observeClient';
import type { ObserveDatasetDetail, ObserveExample } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { Card } from '../../ui/Card';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { MessageView } from '../../ui/MessageView';
import { useToast } from '../../ui/Toast';
import { Clip } from '../listFilters';
import { EvalsHeader } from '../evals/EvalsTabs';
import { EXAMPLES_PAGE_SIZE, datasetPath, parseOffset, valuePreview } from './datasetsUrl';

const BackLink = () => (
  <a className="btn" href="#/evals/datasets">
    Back to datasets
  </a>
);

const SourceTrace = ({ traceId }: { traceId: string | null }) =>
  traceId ? (
    <a className="evals-trace-link" href={`#/traces/${encodeURIComponent(traceId)}`} title={`Open trace ${traceId}`}>
      {traceId.slice(0, 12)}
      <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
    </a>
  ) : (
    <span className="value-missing">—</span>
  );

/** An input/expected preview: one mono line, the full text as its tooltip. */
const Preview = ({ value }: { value: unknown }) => {
  const text = valuePreview(value);
  return text === null ? <span className="value-missing">—</span> : <Clip text={text} className="list-clip ds-mono" />;
};

function columns(onDelete: (example: ObserveExample) => void, busy: boolean): Column<ObserveExample>[] {
  return [
    { key: 'input', header: 'Input', width: 300, render: (e) => <Preview value={e.input} /> },
    { key: 'expected', header: 'Expected', width: 240, render: (e) => <Preview value={e.expected} /> },
    { key: 'source', header: 'Source trace', width: 150, hideBelow: 720, render: (e) => <SourceTrace traceId={e.source_trace_id} /> },
    { key: 'created', header: 'Created', width: 130, hideBelow: 900, render: (e) => fmtDateTime(e.created_at) },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      label: 'Actions',
      width: 52,
      render: (e) => (
        <span className="dt-actions">
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm btn-danger-text"
            aria-label={`Delete example ${e.example_id}`}
            title="Delete example"
            disabled={busy}
            onClick={() => onDelete(e)}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </span>
      ),
    },
  ];
}

/** The opened example in full, as a card: input and expected through MessageView (chat messages render as such). */
function ExamplePanel({ example, onClose }: { example: ObserveExample; onClose: () => void }) {
  return (
    <section className="card ds-example" aria-label={`Example ${example.example_id}`}>
      <div className="ds-example-head">
        <div className="card-heading">
          <h3 className="card-title">Example</h3>
          <p className="card-description ds-mono" title={example.example_id}>
            {example.example_id}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close example" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="ds-example-body">
        <MessageView label="Input" value={JSON.stringify(example.input)} />
        {example.expected === null ? (
          <p className="datasets-note">No expected value.</p>
        ) : (
          <MessageView label="Expected" value={JSON.stringify(example.expected)} />
        )}
      </div>
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

const NO_EXAMPLES = (
  <EmptyState
    title="No examples yet"
    hint="Open a trace and use Add to dataset, or POST examples to /api/v1/datasets/:name/examples."
  />
);

/** A loaded dataset: the examples page in a card, and the opened example beside it. */
function Examples({
  name,
  detail,
  offset,
  onChanged,
}: {
  name: string;
  detail: ObserveDatasetDetail;
  offset: number;
  onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | undefined>();
  const { busy, remove } = useDeleteExample(name, onChanged);
  const opened = detail.examples.find((e) => e.example_id === openId);
  return (
    <div className={opened ? 'ds-detail ds-detail-open' : 'ds-detail'}>
      <Card title="Examples" description={`${fmtInt(detail.total)} ${detail.total === 1 ? 'example' : 'examples'}, oldest first`} padding="none">
        <DataTable
          id="dataset-examples"
          columns={columns((e) => void remove(e), busy)}
          rows={detail.examples}
          rowKey={(e) => e.example_id}
          selectedKey={opened?.example_id}
          onRowOpen={(e) => setOpenId(e.example_id === openId ? undefined : e.example_id)}
          page={{
            offset,
            limit: EXAMPLES_PAGE_SIZE,
            total: detail.total,
            onChange: (next) => navigate(datasetPath(name, next), { replace: true }),
          }}
          empty={NO_EXAMPLES}
        />
      </Card>
      {opened && <ExamplePanel example={opened} onClose={() => setOpenId(undefined)} />}
    </div>
  );
}

/** The examples card while the first page loads: DataTable's skeleton rows. */
const LoadingExamples = () => (
  <Card title="Examples" padding="none">
    <DataTable columns={columns(() => {}, true)} rows={[]} rowKey={(e) => e.example_id} loading empty={NO_EXAMPLES} />
  </Card>
);

/** `#/evals/datasets/:name`; an unknown dataset shows an empty state with the way back. */
export function DatasetDetail({ name }: { name: string }) {
  const route = useRoute();
  const offset = parseOffset(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const query = useDataset(name, { limit: EXAMPLES_PAGE_SIZE, offset }, refreshKey);
  const down = useDaemonDown(false, [query]);
  const detail = query.data;

  // Deleting the last example of a later page leaves it empty: step back a page.
  useEffect(() => {
    if (detail && detail.examples.length === 0 && offset > 0 && offset >= detail.total) {
      navigate(datasetPath(name, Math.max(0, offset - EXAMPLES_PAGE_SIZE)), { replace: true });
    }
  }, [detail, offset, name]);

  let body: ReactNode;
  if (down) body = <ObserveDaemonDown />;
  else if (query.loading && !detail) body = <LoadingExamples />;
  else if (query.error) body = <ObserveError error={query.error} />;
  else if (!detail)
    body = (
      <Card as="div">
        <EmptyState title="Dataset not found" hint={`No dataset '${name}'.`} action={<BackLink />} />
      </Card>
    );
  else body = <Examples name={name} detail={detail} offset={offset} onChanged={() => setRefreshKey((k) => k + 1)} />;

  return (
    <>
      <EvalsHeader
        title={name}
        description={detail?.dataset.description ?? undefined}
        breadcrumbs={[{ label: 'Evaluations', href: '#/evals/scores' }, { label: 'Datasets', href: '#/evals/datasets' }, { label: name }]}
      />
      <h2 className="visually-hidden">Dataset {name}</h2>
      {body}
    </>
  );
}
