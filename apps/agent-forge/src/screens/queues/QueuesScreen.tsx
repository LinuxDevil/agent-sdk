/**
 * `#/evals/queues` - the annotation queue list (`GET /api/v1/queues`, paged
 * server-side, `?offset=` in the URL) as a card grid, with a "New annotation
 * queue" form opened from the header - and `#/evals/queues/:id`, one queue's
 * review view (see `QueueReview.tsx`). Both sit under the Evaluations header
 * tabs and behind the daemon-down state, which keeps the URL and swaps the
 * screen back in by itself once the daemon is back.
 */
import '../datasets/datasets.css';
import './queues.css';
import { useId, useState } from 'react';
import { CalendarDays, Inbox, ListChecks, Plus } from 'lucide-react';
import { matchRoute, navigate } from '../../router/router';
import { useRoute } from '../../router/useRoute';
import { useDaemonDown, useDaemonHealth, useQueues } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { ObserveQueue, ObserveQueueList, ObserveRubricEntry } from '../../observe/types';
import { fmtInt } from '../../observe/format';
import { Card } from '../../ui/Card';
import { TablePager } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { EvalsHeader } from '../evals/EvalsTabs';
import { GridSkeleton } from '../evals/GridSkeleton';
import { parseOffset } from '../datasets/datasetsUrl';
import { NewQueueForm, NEW_QUEUE_FORM_ID } from './NewQueueForm';
import { ProgressBar } from './ProgressBar';
import { QueueReview } from './QueueReview';
import { QUEUES_PAGE_SIZE, queuePath, queuesPath, rubricRange } from './queuesUrl';

const DESCRIPTION = 'Traces queued for human review against a rubric';
/** Rubric chips shown per card before a "+n" chip. */
const MAX_CHIPS = 4;

/** A created date as "Oct 20, 2026". */
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function RubricChips({ rubric }: { rubric: ObserveRubricEntry[] }) {
  if (rubric.length === 0) return <span className="qu-chips qu-chips-none">No rubric</span>;
  const shown = rubric.slice(0, MAX_CHIPS);
  return (
    <span className="qu-chips">
      {shown.map((entry) => (
        <span key={entry.name} className="qu-chip" title={entry.description ?? entry.name}>
          <span className="qu-chip-name">{entry.name}</span>
          <span className="qu-chip-range">{rubricRange(entry)}</span>
        </span>
      ))}
      {rubric.length > shown.length && <span className="qu-chip qu-chip-more">+{rubric.length - shown.length}</span>}
    </span>
  );
}

/** One queue as a card; the whole card is the link to its review view. */
function QueueCard({ queue: q }: { queue: ObserveQueue }) {
  const id = useId();
  const { pending, done, skipped } = q.counts;
  const total = pending + done + skipped;
  return (
    <li className="ds-card">
      <a
        className="ds-card-link qu-card"
        href={`#${queuePath(q.queue_id)}`}
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-rubric ${id}-progress ${id}-meta`}
      >
        <span className="ds-card-top">
          <span className="ds-card-icon" aria-hidden="true">
            <ListChecks size={16} strokeWidth={1.75} />
          </span>
          <span className="ds-card-name" id={`${id}-name`} title={q.name}>
            {q.name}
          </span>
        </span>
        <span id={`${id}-rubric`}>
          <RubricChips rubric={q.rubric} />
        </span>
        <span className="qu-card-progress" id={`${id}-progress`}>
          <ProgressBar done={done} skipped={skipped} total={total} />
          <span className="qu-card-progress-text">
            <span className="qu-reviewed">
              <b>{fmtInt(done)}</b> reviewed of {fmtInt(total)}
            </span>
            {skipped > 0 && <span className="qu-skipped">{fmtInt(skipped)} skipped</span>}
          </span>
        </span>
        <span className="ds-card-meta" id={`${id}-meta`}>
          <span className="ds-card-stat qu-pending">
            <Inbox size={14} strokeWidth={1.75} aria-hidden="true" />
            {fmtInt(pending)} pending
          </span>
          <span className="ds-card-stat">
            <CalendarDays size={14} strokeWidth={1.75} aria-hidden="true" />
            Created {fmtDate(q.created_at)}
          </span>
        </span>
      </a>
    </li>
  );
}

function NewQueueButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-primary" aria-expanded={open} aria-controls={open ? NEW_QUEUE_FORM_ID : undefined} onClick={onClick}>
      <Plus aria-hidden="true" />
      New queue
    </button>
  );
}

const EMPTY_HINT = 'Create one with New queue and a rubric, then add traces to it (POST /api/v1/queues/:id/items) to review them here.';

/** The loaded grid (or its empty state) and, past one page, the pager. */
function QueueGrid({ data, offset, creating, onNew }: { data: ObserveQueueList; offset: number; creating: boolean; onNew: () => void }) {
  if (data.queues.length === 0 && offset === 0)
    return (
      <Card as="div">
        {creating ? (
          <EmptyState icon={ListChecks} title="No annotation queues yet" hint={EMPTY_HINT} />
        ) : (
          <EmptyState icon={ListChecks} title="No annotation queues yet" hint={EMPTY_HINT} action={<NewQueueButton open={false} onClick={onNew} />} />
        )}
      </Card>
    );
  return (
    <>
      {data.queues.length === 0 ? (
        <p className="datasets-note">No queues on this page.</p>
      ) : (
        <ul className="ds-grid" aria-label="Annotation queues">
          {data.queues.map((q) => (
            <QueueCard key={q.queue_id} queue={q} />
          ))}
        </ul>
      )}
      {(offset > 0 || data.total > QUEUES_PAGE_SIZE) && (
        <TablePager offset={offset} limit={QUEUES_PAGE_SIZE} total={data.total} onChange={(next) => navigate(queuesPath(next), { replace: true })} />
      )}
    </>
  );
}

function QueueList() {
  const route = useRoute();
  const offset = parseOffset(route.query);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const list = useQueues({ limit: QUEUES_PAGE_SIZE, offset }, refreshKey);
  const down = useDaemonDown(false, [list]);
  const created = () => {
    setCreating(false);
    setRefreshKey((k) => k + 1);
  };
  const header = (
    <EvalsHeader description={DESCRIPTION} actions={down ? undefined : <NewQueueButton open={creating} onClick={() => setCreating((v) => !v)} />} />
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
      <h2 className="visually-hidden">Annotation queues</h2>
      {creating && <NewQueueForm onCancel={() => setCreating(false)} onCreated={created} />}
      <ObserveError error={list.error} />
      {list.loading && !list.data && <GridSkeleton label="Loading annotation queues" />}
      {list.data && <QueueGrid data={list.data} offset={offset} creating={creating} onNew={() => setCreating(true)} />}
    </>
  );
}

/** `#/evals/queues` and `#/evals/queues/:id`, under the Evaluations header and behind the daemon-down state. */
export function QueuesScreen() {
  const { path } = useRoute();
  const health = useDaemonHealth();
  const review = matchRoute(`#${path}`, ['/evals/queues/:id']);
  let body;
  if (health.down)
    body = (
      <>
        <EvalsHeader description={DESCRIPTION} />
        <ObserveDaemonDown />
      </>
    );
  else if (review) body = <QueueReview key={review.params.id} queueId={review.params.id} />;
  else body = <QueueList />;
  return (
    <section className="ds-screen" aria-label="Annotation queues">
      {body}
    </section>
  );
}
