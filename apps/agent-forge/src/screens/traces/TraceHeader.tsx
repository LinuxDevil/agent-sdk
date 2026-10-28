import { fmtCost, fmtDateTime, fmtDuration, fmtInt } from '../../observe/format';
import type { ObserveObservationRow } from '../../observe/types';
import { StatusPill } from '../../ui/StatusPill';
import { useToast } from '../../ui/Toast';
import { displayName, displayStatus, elapsedMs } from '../../ui/run/rows';
import { AddToDataset } from './AddToDataset';
import { AddToQueue } from './AddToQueue';

/** Trace-wide totals, summed over every observation the way the daemon's trace list does. */
function traceTotals(rows: ObserveObservationRow[]): { tokens: number | null; cost: number | null } {
  let tokens: number | null = null;
  let cost: number | null = null;
  for (const row of rows) {
    if (row.usage_input_tokens !== null || row.usage_output_tokens !== null) {
      tokens = (tokens ?? 0) + (row.usage_input_tokens ?? 0) + (row.usage_output_tokens ?? 0);
    }
    if (row.cost_usd !== null) cost = (cost ?? 0) + row.cost_usd;
  }
  return { tokens, cost };
}

/** The root's own model, else the first generation's. */
function traceModel(root: ObserveObservationRow, rows: ObserveObservationRow[]): string | null {
  return root.model ?? rows.find((row) => row.kind === 'generation' && row.model)?.model ?? null;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="trace-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyLinkButton() {
  const toast = useToast();
  const copy = () => {
    const href = window.location.href;
    const write = navigator.clipboard?.writeText(href) ?? Promise.reject(new Error('Clipboard unavailable'));
    write.then(
      () => toast.show({ message: 'Link copied', tone: 'success' }),
      () => toast.show({ message: 'Could not copy the link', tone: 'error' }),
    );
  };
  return (
    <button type="button" className="btn btn-ghost trace-copy-link" aria-label="Copy link" title="Copy link" onClick={copy}>
      Copy link
    </button>
  );
}

/**
 * The trace screen's header, from the root observation: name, status, agent
 * (to the agent-filtered trace list), model, start, duration (counting to
 * `now` while running), total tokens and cost, session (to its thread), a
 * copy-link button that copies the current URL, `?obs=` included, and
 * "Add to dataset" (copies the trace's input/output into a dataset) and
 * "Add to queue" (queues the trace for review in an annotation queue).
 */
export function TraceHeader({
  root,
  observations,
  agentName,
  now,
}: {
  root: ObserveObservationRow;
  observations: ObserveObservationRow[];
  agentName: string | undefined;
  now: number;
}) {
  const { tokens, cost } = traceTotals(observations);
  const model = traceModel(root, observations);
  return (
    <header className="trace-header">
      <div className="trace-title">
        <h2>{displayName(root)}</h2>
        <StatusPill status={displayStatus(root)} live={displayStatus(root) === 'running'} />
        <CopyLinkButton />
        <AddToDataset traceId={root.trace_id} />
        <AddToQueue traceId={root.trace_id} />
      </div>
      <dl className="trace-facts">
        {root.agent_id && (
          <Fact label="Agent">
            <a href={`#/traces?agent=${encodeURIComponent(root.agent_id)}`}>{agentName ?? root.agent_id}</a>
          </Fact>
        )}
        <Fact label="Model">{model ? <code>{model}</code> : '-'}</Fact>
        <Fact label="Start">{fmtDateTime(root.start)}</Fact>
        <Fact label="Duration">{fmtDuration(elapsedMs(root, now))}</Fact>
        <Fact label="Tokens">{fmtInt(tokens)}</Fact>
        <Fact label="Cost">{fmtCost(cost)}</Fact>
        {root.session_id && (
          <Fact label="Session">
            <a href={`#/threads/${encodeURIComponent(root.session_id)}`}>{root.session_id}</a>
          </Fact>
        )}
      </dl>
    </header>
  );
}
