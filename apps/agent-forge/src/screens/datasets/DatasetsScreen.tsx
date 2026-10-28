/**
 * `#/evals/datasets` - the dataset list (`GET /api/v1/datasets`, paged
 * server-side, `?offset=` in the URL) with a "New dataset" form - and
 * `#/evals/datasets/:name`, one dataset's examples (see `DatasetDetail.tsx`).
 * Both sit under the Evaluations tabs and behind the daemon-down state, which
 * keeps the URL and swaps the screen back in by itself once the daemon is back.
 */
import './datasets.css';
import { useState, type FormEvent } from 'react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, useDaemonHealth, useDatasets } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import type { ObserveDataset } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { useToast } from '../../ui/Toast';
import { Clip } from '../listFilters';
import { EvalsTabs } from '../evals/EvalsTabs';
import { DatasetDetail } from './DatasetDetail';
import { DATASETS_PAGE_SIZE, datasetPath, datasetsPath, parseOffset } from './datasetsUrl';

const COLUMNS: Column<ObserveDataset>[] = [
  { key: 'name', header: 'Name', width: 220, render: (d) => <Clip text={d.name} /> },
  { key: 'description', header: 'Description', width: 320, render: (d) => <Clip text={d.description} /> },
  { key: 'examples', header: 'Examples', align: 'right', width: 100, render: (d) => fmtInt(d.example_count) },
  { key: 'created', header: 'Created', width: 150, hideBelow: 720, render: (d) => fmtDateTime(d.created_at) },
];

/** The create failure shown inline: a 409 is a taken name, anything else its message. */
const createError = (error: unknown): string =>
  error instanceof ObserveApiError && error.status === 409
    ? 'Could not create: a dataset with that name exists.'
    : `Could not create the dataset: ${(error as Error).message}`;

/** "New dataset": a name and an optional description; success refreshes the list. */
function NewDatasetForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const target = name.trim();
    if (!target) return;
    setSaving(true);
    setError(undefined);
    try {
      const text = description.trim();
      await observeClient.createDataset(text ? { name: target, description: text } : { name: target });
      toast.show({ tone: 'success', message: `Created dataset ${target}.` });
      setName('');
      setDescription('');
      onCreated();
    } catch (failure) {
      setError(createError(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="datasets-new" aria-label="New dataset" onSubmit={(e) => void submit(e)}>
      <h3 className="datasets-section-title">New dataset</h3>
      <div className="datasets-new-fields">
        <label className="datasets-field">
          <span>Name</span>
          <input
            name="dataset-name"
            type="text"
            value={name}
            placeholder="e.g. support-golden"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="datasets-field datasets-field-wide">
          <span>Description (optional)</span>
          <input name="dataset-description" type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={saving || !name.trim()}>
          Create dataset
        </button>
      </div>
      {error && (
        <p className="datasets-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function DatasetList() {
  const route = useRoute();
  const offset = parseOffset(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const list = useDatasets({ limit: DATASETS_PAGE_SIZE, offset }, refreshKey);
  if (useDaemonDown(false, [list])) return <ObserveDaemonDown />;
  return (
    <>
      <h2 className="visually-hidden">Datasets</h2>
      <NewDatasetForm onCreated={() => setRefreshKey((k) => k + 1)} />
      <ObserveError error={list.error} />
      <DataTable
        id="datasets"
        columns={COLUMNS}
        rows={list.data?.datasets ?? []}
        rowKey={(d) => d.name}
        onRowOpen={(d) => navigate(datasetPath(d.name))}
        page={{
          offset,
          limit: DATASETS_PAGE_SIZE,
          total: list.data?.total ?? 0,
          onChange: (next) => navigate(datasetsPath(next), { replace: true }),
        }}
        loading={list.loading && !list.data}
        empty={
          <EmptyState
            title="No datasets yet"
            hint="Create one above, or use Add to dataset on a trace to copy its input and output in as an example."
          />
        }
      />
    </>
  );
}

/** `#/evals/datasets` and `#/evals/datasets/:name`, under the Evaluations tabs and behind the daemon-down state. */
export function DatasetsScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  const detail = matchRoute(`#${path}`, ['/evals/datasets/:name']);
  let body;
  if (health.down) body = <ObserveDaemonDown />;
  else if (detail) body = <DatasetDetail key={detail.params.name} name={detail.params.name} />;
  else body = <DatasetList />;
  return (
    <section className="datasets-screen" aria-label="Datasets">
      <EvalsTabs />
      {body}
    </section>
  );
}
