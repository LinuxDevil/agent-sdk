import type { ReactNode } from 'react';
import { Bot, CalendarClock, Coins, Cpu, FlaskConical, Link2, MessagesSquare, Timer, Wallet, type LucideIcon } from 'lucide-react';

import { fmtCost, fmtDateTime, fmtDuration, fmtInt } from '../../observe/format';
import type { ObserveObservationRow } from '../../observe/types';
import { StatusPill } from '../../ui/StatusPill';
import { useToast } from '../../ui/Toast';
import { displayName, displayStatus, elapsedMs, playgroundHref } from '../../ui/run/rows';
import { AddToDataset } from './AddToDataset';
import { AddToQueue } from './AddToQueue';

/** The latest `end` over every observation, or `undefined` when none has ended. */
function latestEnd(rows: ObserveObservationRow[]): number | undefined {
  let latest: number | undefined;
  for (const row of rows) if (row.end !== null && (latest === undefined || row.end > latest)) latest = row.end;
  return latest;
}

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

/** The generation "Open in Playground" loads: the selected step when it is one, else the earliest generation. */
function playgroundTarget(rows: ObserveObservationRow[], selectedObsId: string | null | undefined): ObserveObservationRow | undefined {
  const selected = rows.find((row) => row.obs_id === selectedObsId);
  if (selected?.kind === 'generation') return selected;
  let first: ObserveObservationRow | undefined;
  for (const row of rows) if (row.kind === 'generation' && (first === undefined || row.start < first.start)) first = row;
  return first;
}

/** One metric chip: the icon stands for the label (read out, and shown as the chip's tooltip), then the value. */
function Fact({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="trace-fact" title={label}>
      <dt>
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="visually-hidden">{label}</span>
      </dt>
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
    <button type="button" className="btn btn-ghost btn-icon trace-copy-link" aria-label="Copy link" title="Copy link" onClick={copy}>
      <Link2 aria-hidden="true" />
    </button>
  );
}

interface TraceHeaderProps {
  root: ObserveObservationRow;
  observations: ObserveObservationRow[];
  agentName: string | undefined;
  now: number;
  /** The selected step: "Open in Playground" loads it when it is a generation. */
  selectedObsId?: string | null;
}

/**
 * The trace screen's header card, from the root observation: the name and status, the actions - copy link (the
 * current URL, `?obs=` included), "Add to dataset", "Add to queue" and, when
 * the trace has a generation, "Open in Playground" - then metric chips:
 * duration (counting to `now` while running), tokens, cost, model, start,
 * agent (to the agent-filtered trace list) and session (to its thread).
 */
export function TraceHeader({ root, observations, agentName, now, selectedObsId }: TraceHeaderProps) {
  const { tokens, cost } = traceTotals(observations);
  const model = traceModel(root, observations);
  const playground = playgroundTarget(observations, selectedObsId);
  const status = displayStatus(root);
  return (
    <header className="card trace-header trace-card">
      <div className="trace-title">
        <div className="trace-title-name">
          <h2 title={displayName(root)}>{displayName(root)}</h2>
          <StatusPill status={status} live={status === 'running'} />
        </div>
        <div className="trace-actions">
          <CopyLinkButton />
          <AddToDataset traceId={root.trace_id} />
          <AddToQueue traceId={root.trace_id} />
          {playground && (
            <a className="btn trace-playground" href={playgroundHref(playground.trace_id, playground.obs_id)}>
              <FlaskConical aria-hidden="true" />
              Open in Playground
            </a>
          )}
        </div>
      </div>
      <dl className="trace-facts">
        <Fact icon={Timer} label="Duration">
          {fmtDuration(elapsedMs(root, now, latestEnd(observations)))}
        </Fact>
        <Fact icon={Coins} label="Tokens">
          {fmtInt(tokens)}
          <span className="trace-fact-unit"> tokens</span>
        </Fact>
        <Fact icon={Wallet} label="Cost">
          {fmtCost(cost)}
        </Fact>
        <Fact icon={Cpu} label="Model">
          {model ? <code>{model}</code> : '-'}
        </Fact>
        <Fact icon={CalendarClock} label="Start">
          {fmtDateTime(root.start)}
        </Fact>
        {root.agent_id && (
          <Fact icon={Bot} label="Agent">
            <a href={`#/traces?agent=${encodeURIComponent(root.agent_id)}`}>{agentName ?? root.agent_id}</a>
          </Fact>
        )}
        {root.session_id && (
          <Fact icon={MessagesSquare} label="Session">
            <a href={`#/threads/${encodeURIComponent(root.session_id)}`}>{root.session_id}</a>
          </Fact>
        )}
      </dl>
    </header>
  );
}
