/**
 * `#/evals/queues/:id` - one annotation queue's review view. It reads the
 * queue (name, rubric, counts) and its next pending item
 * (`GET /api/v1/queues/:id/next`); a 204 is the "Queue is empty" state. The
 * top strip shows "n of m" and the done/skipped/pending counts over a progress
 * bar. An item shows on the left - its root step's input and output as
 * messages, or (the Messages | Trace toggle, local state) the whole trace in
 * the shared TraceViewer (the selected step is local state too) - beside the
 * rubric's score card; finishing an item re-reads the queue and its next item.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, CheckCheck } from 'lucide-react';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { nestObservations } from '../../observe/tree';
import type { ObserveObservationRow, ObserveQueue, ObserveQueueItem, ObserveTraceDetail } from '../../observe/types';
import { useDaemonDown, useNextQueueItem, useQueue, useTraceDetail } from '../../observe/useObserve';
import { fmtInt } from '../../observe/format';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { MessageView } from '../../ui/MessageView';
import { SkeletonRows } from '../../ui/Skeleton';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { displayName, isRunning } from '../../ui/run/rows';
import { useNow } from '../../ui/run/useNow';
import '../../ui/filterBar.css';
import { EvalsHeader } from '../evals/EvalsTabs';
import { ProgressBar } from './ProgressBar';
import { RubricForm } from './RubricForm';

const BackLink = () => (
  <a className="btn" href="#/evals/queues">
    Back to queues
  </a>
);

/** "Item n of m" (n = finished + 1) over the bar, with the pending / done / skipped counts. */
function Progress({ counts }: { counts: ObserveQueue['counts'] }) {
  const { pending, done, skipped } = counts;
  const finished = done + skipped;
  const total = finished + pending;
  let position: ReactNode;
  if (total === 0) position = 'No items yet';
  else if (pending === 0) position = `All ${fmtInt(total)} finished`;
  else
    position = (
      <>
        Item <b>{fmtInt(finished + 1)}</b> of {fmtInt(total)}
      </>
    );
  return (
    <div className="qu-progress" role="group" aria-label="Queue progress">
      <div className="qu-progress-row">
        <span className="qu-position">{position}</span>
        <span className="qu-counts">
          <span>{fmtInt(pending)} pending</span>
          <span>{fmtInt(done)} done</span>
          <span>{fmtInt(skipped)} skipped</span>
        </span>
      </div>
      <ProgressBar done={done} skipped={skipped} total={total} label="Items finished" />
    </div>
  );
}

type ItemView = 'messages' | 'trace';
const VIEWS: { view: ItemView; label: string }[] = [
  { view: 'messages', label: 'Messages' },
  { view: 'trace', label: 'Trace' },
];

function ViewToggle({ view, onView }: { view: ItemView; onView: (view: ItemView) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Item view">
      {VIEWS.map(({ view: v, label }) => (
        <button key={v} type="button" className="seg-btn" aria-pressed={view === v} onClick={() => onView(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The trace on the left: the root step's input and output, or the whole trace. */
function ItemTrace({ trace, root, view }: { trace: ObserveTraceDetail; root: ObserveObservationRow | undefined; view: ItemView }) {
  const [obsId, setObsId] = useState<string | null>(null);
  const [mode, setMode] = useState<TraceViewMode>('tree');
  const now = useNow(root !== undefined && isRunning(root));
  if (view === 'trace')
    return (
      <TraceViewer
        observations={trace.observations}
        scores={trace.scores}
        selectedObsId={obsId}
        onSelect={setObsId}
        mode={mode}
        onModeChange={setMode}
        now={now}
      />
    );
  if (!root) return <p className="datasets-note">This trace has no steps.</p>;
  return (
    <div className="qu-messages">
      <MessageView value={root.input} label="Input" />
      <MessageView value={root.output} label="Output" />
    </div>
  );
}

/** One item: its trace (Messages | Trace) and the score card. */
function ReviewItem({ queue, item, onDone }: { queue: ObserveQueue; item: ObserveQueueItem; onDone: () => void }) {
  const trace = useTraceDetail(item.trace_id);
  const down = useDaemonDown(false, [trace]);
  const [view, setView] = useState<ItemView>('messages');
  const observations = trace.data?.observations;
  const root = useMemo(() => (observations ? nestObservations(observations)[0]?.row : undefined), [observations]);

  let body: ReactNode;
  if (down) body = <ObserveDaemonDown />;
  else if (trace.error) body = <ObserveError error={trace.error} />;
  else if (trace.loading && !trace.data) body = <SkeletonRows rows={5} />;
  else if (!trace.data) body = <EmptyState title="Trace not found" hint="The trace may have been pruned. Skip it to move on." />;
  else body = <ItemTrace trace={trace.data} root={root} view={view} />;

  return (
    <div className="qu-review" data-review-trace={item.trace_id}>
      <section className="card qu-item" aria-label="Trace under review">
        <div className="qu-item-head">
          <h3 className="card-title qu-item-title" title={root ? displayName(root) : undefined}>
            {root ? displayName(root) : 'Trace'}
          </h3>
          <a className="evals-trace-link" href={`#/traces/${encodeURIComponent(item.trace_id)}`} title={`Open trace ${item.trace_id}`}>
            {item.trace_id.slice(0, 12)}
            <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
          </a>
          <ViewToggle view={view} onView={setView} />
        </div>
        <div className={view === 'trace' ? 'qu-item-body qu-item-body-trace' : 'qu-item-body'}>{body}</div>
      </section>
      <RubricForm queue={queue} item={item} onDone={onDone} />
    </div>
  );
}

const EmptyQueue = () => (
  <Card as="div">
    <EmptyState
      icon={CheckCheck}
      title="Queue is empty"
      hint="Every item has been reviewed or skipped. Add traces to the queue to review more."
      action={
        <span className="qu-empty-links">
          <BackLink />
          <a className="btn btn-ghost" href="#/traces">
            Go to Traces
          </a>
        </span>
      }
    />
  </Card>
);

/** The review area while the queue or its next item loads. */
const LoadingReview = ({ label }: { label: string }) => (
  <div className="qu-review" aria-label={label} role="group">
    <Card as="div">
      <SkeletonRows rows={6} />
    </Card>
    <Card as="div">
      <SkeletonRows rows={4} />
    </Card>
  </div>
);

/** The queue and its next item; `finished` hides the item just completed until the re-read lands. */
function useReview(queueId: string) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [finished, setFinished] = useState<string | undefined>();
  const queue = useQueue(queueId, refreshKey);
  const next = useNextQueueItem(queueId, refreshKey);
  const down = useDaemonDown(false, [queue, next]);
  const item = next.data && next.data.item_id !== finished ? next.data : undefined;
  const advance = (itemId: string) => {
    setFinished(itemId);
    setRefreshKey((k) => k + 1);
  };
  return { queue, next, down, item, advance, waiting: next.loading || (next.data !== undefined && item === undefined) };
}

/** `#/evals/queues/:id`; an unknown queue shows an empty state with the way back. */
export function QueueReview({ queueId }: { queueId: string }) {
  const { queue, next, down, item, advance, waiting } = useReview(queueId);
  const data = queue.data;
  const name = data?.name ?? queueId;
  const header = (
    <EvalsHeader
      title={name}
      description={data ? 'Score each trace against the queue rubric' : undefined}
      breadcrumbs={[{ label: 'Evaluations', href: '#/evals/scores' }, { label: 'Annotation queues', href: '#/evals/queues' }, { label: name }]}
    />
  );
  let body: ReactNode;
  if (down) body = <ObserveDaemonDown />;
  else if (queue.loading && !data) body = <LoadingReview label="Loading queue" />;
  else if (queue.error) body = <ObserveError error={queue.error} />;
  else if (!data)
    body = (
      <Card as="div">
        <EmptyState title="Queue not found" hint={`No annotation queue '${queueId}'.`} action={<BackLink />} />
      </Card>
    );
  else if (next.error) body = <ObserveError error={next.error} />;
  else if (item) body = <ReviewItem key={item.item_id} queue={data} item={item} onDone={() => advance(item.item_id)} />;
  else if (waiting) body = <LoadingReview label="Loading the next item" />;
  else body = <EmptyQueue />;

  return (
    <>
      {header}
      <h2 className="visually-hidden">Review {name}</h2>
      {data && !down && <Progress counts={data.counts} />}
      {body}
    </>
  );
}
