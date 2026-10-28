/**
 * `#/evals/queues` - the annotation queue list (`GET /api/v1/queues`, paged
 * server-side, `?offset=` in the URL) with a "New annotation queue" form -
 * and `#/evals/queues/:id`, one queue's review view (see `QueueReview.tsx`).
 * Both sit under the Evaluations tabs and behind the daemon-down state, which
 * keeps the URL and swaps the screen back in by itself once the daemon is back.
 */
import '../datasets/datasets.css';
import './queues.css';
import { useState } from 'react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, useDaemonHealth, useQueues } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { ObserveQueue } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { Clip } from '../listFilters';
import { EvalsTabs } from '../evals/EvalsTabs';
import { parseOffset } from '../datasets/datasetsUrl';
import { NewQueueForm } from './NewQueueForm';
import { QueueReview } from './QueueReview';
import { QUEUES_PAGE_SIZE, queuePath, queuesPath } from './queuesUrl';

const COLUMNS: Column<ObserveQueue>[] = [
  { key: 'name', header: 'Name', width: 240, render: (q) => <Clip text={q.name} /> },
  { key: 'pending', header: 'Pending', align: 'right', width: 90, render: (q) => fmtInt(q.counts.pending) },
  { key: 'done', header: 'Done', align: 'right', width: 90, render: (q) => fmtInt(q.counts.done) },
  { key: 'skipped', header: 'Skipped', align: 'right', width: 90, render: (q) => fmtInt(q.counts.skipped) },
  { key: 'created', header: 'Created', width: 150, hideBelow: 720, render: (q) => fmtDateTime(q.created_at) },
];

function QueueList() {
  const route = useRoute();
  const offset = parseOffset(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const list = useQueues({ limit: QUEUES_PAGE_SIZE, offset }, refreshKey);
  if (useDaemonDown(false, [list])) return <ObserveDaemonDown />;
  return (
    <>
      <h2 className="visually-hidden">Annotation queues</h2>
      <NewQueueForm onCreated={() => setRefreshKey((k) => k + 1)} />
      <ObserveError error={list.error} />
      <DataTable
        id="queues"
        columns={COLUMNS}
        rows={list.data?.queues ?? []}
        rowKey={(q) => q.queue_id}
        onRowOpen={(q) => navigate(queuePath(q.queue_id))}
        page={{
          offset,
          limit: QUEUES_PAGE_SIZE,
          total: list.data?.total ?? 0,
          onChange: (next) => navigate(queuesPath(next), { replace: true }),
        }}
        loading={list.loading && !list.data}
        empty={
          <EmptyState
            title="No annotation queues yet"
            hint="Create one above with a rubric, then add traces to it (POST /api/v1/queues/:id/items) to review them here."
          />
        }
      />
    </>
  );
}

/** `#/evals/queues` and `#/evals/queues/:id`, under the Evaluations tabs and behind the daemon-down state. */
export function QueuesScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  const review = matchRoute(`#${path}`, ['/evals/queues/:id']);
  let body;
  if (health.down) body = <ObserveDaemonDown />;
  else if (review) body = <QueueReview key={review.params.id} queueId={review.params.id} />;
  else body = <QueueList />;
  return (
    <section className="datasets-screen" aria-label="Annotation queues">
      <EvalsTabs />
      {body}
    </section>
  );
}
