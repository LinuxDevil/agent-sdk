/**
 * `#/evals/datasets` - the dataset list (`GET /api/v1/datasets`, paged
 * server-side, `?offset=` in the URL) as a card grid, with a "New dataset" form
 * opened from the header - and `#/evals/datasets/:name`, one dataset's examples
 * (see `DatasetDetail.tsx`). Both sit under the Evaluations header tabs and
 * behind the daemon-down state, which keeps the URL and swaps the screen back
 * in by itself once the daemon is back.
 */
import './datasets.css';
import { useState, type FormEvent } from 'react';
import { CalendarDays, Database, Plus, Rows3, X } from 'lucide-react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, useDaemonHealth, useDatasets } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import type { ObserveDataset } from '../../observe/types';
import { fmtInt } from '../../observe/format';
import { Card } from '../../ui/Card';
import { TablePager } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { EvalsHeader } from '../evals/EvalsTabs';
import { DatasetDetail } from './DatasetDetail';
import { DATASETS_PAGE_SIZE, datasetPath, datasetsPath, parseOffset } from './datasetsUrl';

const DESCRIPTION = 'Example sets for offline evals';
const FORM_ID = 'new-dataset-form';

/** A created date as "Oct 20, 2026". */
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** The create failure shown inline: a 409 is a taken name, anything else its message. */
const createError = (error: unknown): string =>
  error instanceof ObserveApiError && error.status === 409
    ? 'Could not create: a dataset with that name exists.'
    : `Could not create the dataset: ${(error as Error).message}`;

/** "New dataset": a name and an optional description; success refreshes the list and closes the form. */
function NewDatasetForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
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
      onCreated();
    } catch (failure) {
      setError(createError(failure));
      setSaving(false);
    }
  };

  return (
    <form id={FORM_ID} className="card ds-new" aria-label="New dataset" onSubmit={(e) => void submit(e)}>
      <div className="ds-new-head">
        <h3 className="card-title">New dataset</h3>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close new dataset" onClick={onCancel}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="ds-new-fields">
        <label className="ds-field ds-new-name">
          <span className="ds-field-label">Name</span>
          <input
            className="input"
            name="dataset-name"
            type="text"
            value={name}
            placeholder="e.g. support-golden"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="ds-field ds-new-desc">
          <span className="ds-field-label">Description (optional)</span>
          <input
            className="input"
            name="dataset-description"
            type="text"
            value={description}
            placeholder="What these examples cover"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="ds-new-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            Create dataset
          </button>
        </div>
      </div>
      {error && (
        <p className="datasets-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** One dataset as a card; the whole card is the link to its examples. */
function DatasetCard({ dataset: d }: { dataset: ObserveDataset }) {
  return (
    <li className="ds-card">
      <a className="ds-card-link" href={`#${datasetPath(d.name)}`}>
        <span className="ds-card-top">
          <span className="ds-card-icon" aria-hidden="true">
            <Database size={16} strokeWidth={1.75} />
          </span>
          <span className="ds-card-name" title={d.name}>
            {d.name}
          </span>
        </span>
        <span className={d.description ? 'ds-card-desc' : 'ds-card-desc ds-card-desc-none'} title={d.description ?? undefined}>
          {d.description || 'No description'}
        </span>
        <span className="ds-card-meta">
          <span className="ds-card-stat">
            <Rows3 size={14} strokeWidth={1.75} aria-hidden="true" />
            {fmtInt(d.example_count)} {d.example_count === 1 ? 'example' : 'examples'}
          </span>
          <span className="ds-card-stat">
            <CalendarDays size={14} strokeWidth={1.75} aria-hidden="true" />
            Created {fmtDate(d.created_at)}
          </span>
        </span>
      </a>
    </li>
  );
}

/** The grid's first-load placeholder: six skeleton cards and one status line. */
function GridSkeleton() {
  return (
    <div className="ds-grid-loading">
      <span role="status" className="visually-hidden">
        Loading datasets
      </span>
      <ul className="ds-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="ds-card ds-card-skeleton">
            <Skeleton width={28} height={28} radius="var(--radius)" />
            <Skeleton width="55%" height={12} />
            <Skeleton width="85%" height={10} />
            <Skeleton width="40%" height={10} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewDatasetButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-primary" aria-expanded={open} aria-controls={open ? FORM_ID : undefined} onClick={onClick}>
      <Plus aria-hidden="true" />
      New dataset
    </button>
  );
}

/** The loaded grid (or its empty state) and, past one page, the pager. */
function DatasetGrid({ datasets, total, offset, onNew }: { datasets: ObserveDataset[]; total: number; offset: number; onNew: () => void }) {
  if (datasets.length === 0 && offset === 0)
    return (
      <Card as="div">
        <EmptyState
          icon={Database}
          title="No datasets yet"
          hint="Create one here, or use Add to dataset on a trace to copy its input and output in as an example."
          action={<NewDatasetButton open={false} onClick={onNew} />}
        />
      </Card>
    );
  return (
    <>
      <ul className="ds-grid" aria-label="Datasets">
        {datasets.map((d) => (
          <DatasetCard key={d.name} dataset={d} />
        ))}
      </ul>
      {(offset > 0 || total > DATASETS_PAGE_SIZE) && (
        <TablePager
          offset={offset}
          limit={DATASETS_PAGE_SIZE}
          total={total}
          onChange={(next) => navigate(datasetsPath(next), { replace: true })}
        />
      )}
    </>
  );
}

function DatasetList() {
  const route = useRoute();
  const offset = parseOffset(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const list = useDatasets({ limit: DATASETS_PAGE_SIZE, offset }, refreshKey);
  const down = useDaemonDown(false, [list]);
  const header = (
    <EvalsHeader description={DESCRIPTION} actions={down ? undefined : <NewDatasetButton open={creating} onClick={() => setCreating((v) => !v)} />} />
  );
  if (down)
    return (
      <>
        {header}
        <ObserveDaemonDown />
      </>
    );
  return (
    <>
      {header}
      <h2 className="visually-hidden">Datasets</h2>
      {creating && (
        <NewDatasetForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      <ObserveError error={list.error} />
      {list.loading && !list.data && <GridSkeleton />}
      {list.data && (
        <DatasetGrid datasets={list.data.datasets} total={list.data.total} offset={offset} onNew={() => setCreating(true)} />
      )}
    </>
  );
}

/** `#/evals/datasets` and `#/evals/datasets/:name`, under the Evaluations header and behind the daemon-down state. */
export function DatasetsScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  const detail = matchRoute(`#${path}`, ['/evals/datasets/:name']);
  let body;
  if (health.down)
    body = (
      <>
        <EvalsHeader description={DESCRIPTION} />
        <ObserveDaemonDown />
      </>
    );
  else if (detail) body = <DatasetDetail key={detail.params.name} name={detail.params.name} />;
  else body = <DatasetList />;
  return (
    <section className="ds-screen" aria-label="Datasets">
      {body}
    </section>
  );
}
