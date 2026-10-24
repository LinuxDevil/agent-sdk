import { useMemo, useState } from 'react';
import { JsonTree } from '../components/debug/JsonTree';
import { useTraceDetail } from './useObserve';
import { flattenObservationTree, nestObservations, traceBounds, type ObservationNode } from './tree';
import type { ObserveObservationRow, ObserveScoreRow } from './types';
import { fmtCost, fmtDateTime, fmtDuration, fmtInt } from './format';
import { ObserveError, ObserveDaemonDown, ObserveStatusPill } from './chrome';
import { ObserveDaemonDownError } from './observeClient';

const KIND_COLOR: Record<string, string> = {
  span: 'var(--info)',
  generation: 'var(--accent)',
  tool: 'var(--warning)',
  event: 'var(--text-faint)',
};

function classNames(...names: (string | false)[]): string {
  return names.filter(Boolean).join(' ');
}

function obsDuration(row: ObserveObservationRow): number | undefined {
  return row.end === null ? undefined : row.end - row.start;
}

function ObsRow({
  node,
  minStart,
  totalMs,
  selected,
  onSelect,
}: {
  node: ObservationNode;
  minStart: number;
  totalMs: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { row } = node;
  const startPct = ((row.start - minStart) / totalMs) * 100;
  const duration = obsDuration(row);
  const widthPct = Math.max(0.5, ((duration ?? 0) / totalMs) * 100);
  const failed = row.status === 'error';
  return (
    <div
      className={classNames('trace-row', 'obs-row', selected && 'selected', failed && 'trace-row-error')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      title={row.name ?? row.obs_id}
    >
      <span className="trace-name" style={{ paddingLeft: node.depth * 14 }}>
        <span className="obs-kind-dot" style={{ background: KIND_COLOR[row.kind] ?? 'var(--text-faint)' }} aria-hidden="true" />
        {row.name ?? row.obs_id.slice(0, 12)}
      </span>
      <span className="trace-kind">{row.kind}</span>
      <span className="trace-bar-track">
        <span
          className={classNames('trace-bar', row.end === null && 'pending', failed && 'error')}
          style={{ left: `${startPct}%`, width: `${widthPct}%` }}
        />
      </span>
      <span className="trace-dur">{duration === undefined ? 'running' : `${Math.round(duration)}ms`}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="obs-field">
      <div className="obs-field-label">{label}</div>
      <div className="obs-field-value">{children}</div>
    </div>
  );
}

/** The right-hand inspector for the selected observation: io, usage/cost (flags kept honest), attrs. */
function ObservationInspector({ row }: { row: ObserveObservationRow }) {
  return (
    <div className="obs-inspector">
      <div className="obs-inspector-head">
        <span className="obs-kind" style={{ color: KIND_COLOR[row.kind] ?? 'var(--text-faint)' }}>
          {row.kind}
        </span>
        <b>{row.name ?? row.obs_id}</b>
        <ObserveStatusPill status={row.status} />
      </div>
      <div className="obs-fields">
        {row.model && <Field label="Model"><code>{row.model}</code></Field>}
        <Field label="Started">{fmtDateTime(row.start)}</Field>
        <Field label="Duration">{row.end === null ? 'still running' : fmtDuration(row.end - row.start)}</Field>
        {(row.usage_input_tokens !== null || row.usage_output_tokens !== null) && (
          <Field label="Tokens">
            {fmtInt(row.usage_input_tokens)} in / {fmtInt(row.usage_output_tokens)} out
            {row.usage_cached_tokens ? ` (${fmtInt(row.usage_cached_tokens)} cached)` : ''}
            {row.usage_reasoning_tokens ? ` (${fmtInt(row.usage_reasoning_tokens)} reasoning)` : ''}
            {row.usage_estimated ? ' · estimated' : ''}
          </Field>
        )}
        {row.cost_usd !== null && (
          <Field label="Cost">
            {fmtCost(row.cost_usd)}
            {row.cost_partial ? ' (partial)' : ''}
          </Field>
        )}
        {row.input !== null && (
          <Field label="Input">
            <pre className="obs-io">{row.input}</pre>
          </Field>
        )}
        {row.output !== null && (
          <Field label="Output">
            <pre className="obs-io">{row.output}</pre>
            {row.truncated && <div className="hint">Truncated by the reporter at ~64KB.</div>}
          </Field>
        )}
        {row.attrs && (
          <Field label="Attributes">
            <JsonTree value={row.attrs} />
          </Field>
        )}
      </div>
    </div>
  );
}

function ScoresBlock({ scores }: { scores: ObserveScoreRow[] }) {
  if (scores.length === 0) return null;
  return (
    <div className="obs-scores">
      <div className="rail-section-title">Scores</div>
      <table className="observe-table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="observe-num">Value</th>
            <th>Source</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score) => (
            <tr key={score.score_id}>
              <td>{score.name}</td>
              <td className="observe-num">{score.value === null ? '-' : score.value}</td>
              <td>{score.source}</td>
              <td className="observe-cell-muted">{score.comment ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * `GET /api/v1/traces/:id` - flat observation rows nested client-side by
 * `parent_obs_id` ({@link nestObservations}), drawn as the same latency
 * waterfall the live Trace tab uses, plus a per-observation inspector and
 * the trace's score rows.
 */
export function TraceDetailView({ traceId, onBack }: { traceId: string; onBack: () => void }) {
  const { data, error, loading } = useTraceDetail(traceId);
  const [selectedObsId, setSelectedObsId] = useState<string | undefined>(undefined);

  const flat = useMemo(() => {
    if (!data) return [];
    return flattenObservationTree(nestObservations(data.observations));
  }, [data]);
  const bounds = useMemo(() => traceBounds(data?.observations ?? []), [data]);
  const totalMs = Math.max(1, bounds.maxEnd - bounds.minStart);
  const selected = flat.find((node) => node.row.obs_id === selectedObsId);

  if (loading && data === undefined) return <div className="observe-loading">Loading trace...</div>;
  if (error) return error instanceof ObserveDaemonDownError ? <ObserveDaemonDown /> : <ObserveError error={error} />;
  if (!data) return <div className="observe-empty"><p>No trace '{traceId}'.</p></div>;

  return (
    <div className="obs-detail">
      <div className="observe-panel-head">
        <button className="btn btn-ghost" onClick={onBack}>
          &larr; Traces
        </button>
        <span className="observe-id" title={traceId}>
          {data.trace_id.slice(0, 16)}
        </span>
        <span className="observe-meta">
          {flat.length} observations · {data.scores.length} scores
        </span>
      </div>
      <div className="obs-detail-body">
        <div className="obs-waterfall" aria-label="Observation waterfall">
          {flat.map((node) => (
            <ObsRow
              key={node.row.obs_id}
              node={node}
              minStart={bounds.minStart}
              totalMs={totalMs}
              selected={node.row.obs_id === selectedObsId}
              onSelect={() => setSelectedObsId(node.row.obs_id === selectedObsId ? undefined : node.row.obs_id)}
            />
          ))}
          <ScoresBlock scores={data.scores} />
        </div>
        {selected && <ObservationInspector row={selected.row} />}
      </div>
    </div>
  );
}
