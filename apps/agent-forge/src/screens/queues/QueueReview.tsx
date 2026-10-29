/**
 * `#/evals/queues/:id` - one annotation queue's review view. It reads the
 * queue (name, rubric, counts) and its next pending item
 * (`GET /api/v1/queues/:id/next`); a 204 is the "Queue is empty" state. An
 * item shows its trace in the shared TraceViewer (the selected step is local
 * state, not the URL) beside the rubric's score form; finishing an item
 * re-reads the queue and its next item.
 */
import { useMemo, useState } from 'react';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import { nestObservations } from '../../observe/tree';
import type { ObserveQueue, ObserveQueueItem } from '../../observe/types';
import { useDaemonDown, useNextQueueItem, useQueue, useTraceDetail } from '../../observe/useObserve';
import { EmptyState } from '../../ui/EmptyState';
import { TraceViewer, type TraceViewMode } from '../../ui/run/TraceViewer';
import { displayName, isRunning } from '../../ui/run/rows';
import { useNow } from '../../ui/run/useNow';
import { fmtInt } from '../../observe/format';
import { RubricForm } from './RubricForm';

const BackLink = () => <a href="#/evals/queues">Back to queues</a>;

function Progress({ counts }: { counts: ObserveQueue['counts'] }) {
  return (
    <p className="queues-progress" aria-label="Queue progress">
      <span>{fmtInt(counts.pending)} pending</span>
      <span>{fmtInt(counts.done)} done</span>
      <span>{fmtInt(counts.skipped)} skipped</span>
    </p>
  );
}

/** One item: its trace (TraceViewer, local selection) and the score form. */
function ReviewItem({ queue, item, onDone }: { queue: ObserveQueue; item: ObserveQueueItem; onDone: () => void }) {
  const trace = useTraceDetail(item.trace_id);
  const down = useDaemonDown(false, [trace]);
  const [obsId, setObsId] = useState<string | null>(null);
  const [mode, setMode] = useState<TraceViewMode>('tree');
  const observations = trace.data?.observations;
  const root = useMemo(() => (observations ? nestObservations(observations)[0]?.row : undefined), [observations]);
  const now = useNow(root !== undefined && isRunning(root));

  let body;
  if (down) body = <ObserveDaemonDown />;
  else if (trace.error) body = <ObserveError error={trace.error} />;
  else if (trace.loading && !trace.data) body = <p className="datasets-note">Loading trace...</p>;
  else if (!trace.data)
    body = <EmptyState title="Trace not found" hint="The trace may have been pruned. Skip it to move on." />;
  else
    body = (
      <TraceViewer
        observations={trace.data.observations}
        scores={trace.data.scores}
        selectedObsId={obsId}
        onSelect={setObsId}
        mode={mode}
        onModeChange={setMode}
        now={now}
      />
    );

  return (
    <div className="queues-review" data-review-trace={item.trace_id}>
      <section className="queues-review-trace" aria-label="Trace under review">
        <h3 className="datasets-section-title">
          {root ? displayName(root) : 'Trace'}{' '}
          <a href={`#/traces/${encodeURIComponent(item.trace_id)}`} title={item.trace_id}>
            {item.trace_id.slice(0, 12)}
          </a>
        </h3>
        {body}
      </section>
      <RubricForm queue={queue} item={item} onDone={onDone} />
    </div>
  );
}

const EmptyQueue = () => (
  <EmptyState
    title="Queue is empty"
    hint="Every item has been reviewed or skipped. Add traces to the queue to review more."
    action={
      <span className="queues-empty-links">
        <BackLink />
        <a href="#/traces">Go to Traces</a>
      </span>
    }
  />
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
  if (down) return <ObserveDaemonDown />;
  const data = queue.data;
  let body;
  if (queue.loading && !data) body = <p className="datasets-note">Loading queue...</p>;
  else if (queue.error) body = <ObserveError error={queue.error} />;
  else if (!data) body = <EmptyState title="Queue not found" hint={`No annotation queue '${queueId}'.`} action={<BackLink />} />;
  else if (next.error) body = <ObserveError error={next.error} />;
  else if (item) body = <ReviewItem key={item.item_id} queue={data} item={item} onDone={() => advance(item.item_id)} />;
  else if (waiting) body = <p className="datasets-note">Loading the next item...</p>;
  else body = <EmptyQueue />;

  return (
    <>
      <nav className="datasets-nav" aria-label="Breadcrumb">
        <BackLink />
      </nav>
      <h2 className="datasets-title">Review {data ? <code>{data.name}</code> : null}</h2>
      {data && <Progress counts={data.counts} />}
      {body}
    </>
  );
}
