import { useEffect, useState } from 'react';
import type { TraceListFilter } from './observeClient';
import { useAgents, useTraces } from './useObserve';
import type { ObserveTraceRow } from './types';
import { fmtCost, fmtDateTime, fmtDuration, fmtInt } from './format';
import { AgentSelect, ObserveError, ObserveStatusPill } from './chrome';

const PAGE_SIZE = 50;
const STATUS_OPTIONS = ['', 'ok', 'error', 'interrupted'] as const;

function FilterBar({
  filter,
  onChange,
}: {
  filter: TraceListFilter;
  onChange: (filter: TraceListFilter) => void;
}) {
  const agents = useAgents();
  const projects = [...new Set((agents.data ?? []).map((a) => a.project).filter((p): p is string => p !== null))].sort();
  const set = (patch: Partial<TraceListFilter>) => onChange({ ...filter, ...patch });

  return (
    <div className="observe-filter-bar">
      <label>
        Agent
        <AgentSelect
          agents={agents.data}
          value={filter.agent_id ?? ''}
          onChange={(agentId) => set({ agent_id: agentId || undefined })}
        />
      </label>
      <label>
        Project
        <select
          className="select"
          value={filter.project ?? ''}
          onChange={(e) => set({ project: e.target.value || undefined })}
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project} value={project}>
              {project}
            </option>
          ))}
        </select>
      </label>
      <label>
        Status
        <select
          className="select"
          value={filter.status ?? ''}
          onChange={(e) => set({ status: e.target.value || undefined })}
        >
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status === '' ? 'Any status' : status}
            </option>
          ))}
        </select>
      </label>
      {agents.error && <ObserveError error={agents.error} />}
    </div>
  );
}

function TraceRow({ trace, onOpen }: { trace: ObserveTraceRow; onOpen: () => void }) {
  const duration = trace.end - trace.start;
  return (
    <tr onClick={onOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <td className="observe-cell-name" title={trace.trace_id}>
        {trace.name ?? <span className="observe-id">{trace.trace_id.slice(0, 12)}</span>}
      </td>
      <td>{fmtDateTime(trace.start)}</td>
      <td>{fmtDuration(duration)}</td>
      <td>
        <ObserveStatusPill status={trace.status} />
      </td>
      <td className="observe-num">{fmtInt(trace.observations)}</td>
      <td className="observe-num" title={`${fmtInt(trace.input_tokens)} in / ${fmtInt(trace.output_tokens)} out`}>
        {fmtInt(trace.input_tokens + trace.output_tokens)}
      </td>
      <td className="observe-num">{fmtCost(trace.cost_usd)}</td>
    </tr>
  );
}

/**
 * `GET /api/v1/traces` - the paginated, filterable trace list (time-ordered,
 * newest first). Clicking a row hands the trace id to ObserveView, which
 * swaps in {@link TraceDetailView}.
 */
export function TracesPanel({
  filter,
  onFilterChange,
  onOpenTrace,
}: {
  filter: TraceListFilter;
  onFilterChange: (filter: TraceListFilter) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  // Any filter edit restarts pagination at the first page.
  useEffect(() => setOffset(0), [JSON.stringify(filter)]);
  const query = useTraces({ ...filter, limit: PAGE_SIZE, offset });
  const { data, error, loading } = query;
  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="observe-panel">
      <FilterBar filter={filter} onChange={onFilterChange} />
      <ObserveError error={error} />
      {loading && data === undefined ? (
        <div className="observe-loading">Loading traces...</div>
      ) : (data?.traces.length ?? 0) === 0 ? (
        <div className="observe-empty">
          <p>No traces match this filter. Traces appear once an agent with <code>LOUSHO_OBSERVE=1</code> finishes a run.</p>
        </div>
      ) : (
        <>
          <div className="observe-table-wrap">
            <table className="observe-table clickable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th className="observe-num">Spans</th>
                  <th className="observe-num">Tokens</th>
                  <th className="observe-num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data!.traces.map((trace) => (
                  <TraceRow key={trace.trace_id} trace={trace} onOpen={() => onOpenTrace(trace.trace_id)} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="observe-pager">
            <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Newer
            </button>
            <span>
              Page {page} of {pages} · {fmtInt(total)} traces
            </span>
            <button
              className="btn"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Older
            </button>
          </div>
        </>
      )}
    </div>
  );
}
