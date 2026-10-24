import { VirtualList } from '../../components/debug/VirtualList';
import { fmtDuration } from '../../observe/format';
import { traceBounds, type ObservationNode } from '../../observe/tree';
import type { ObserveObservationRow } from '../../observe/types';
import { VIRTUALISE_ABOVE, VIRTUAL_ROW_HEIGHT, cx, displayName, elapsedMs, isRunning, useFlatNodes } from './rows';
import './run.css';

/**
 * Props for {@link Waterfall}. Same rows and selection contract as `RunTree`;
 * `now` is where an open observation's bar ends (defaults to `Date.now()`).
 */
export interface WaterfallProps {
  observations: ObserveObservationRow[];
  selectedObsId?: string | null;
  onSelect: (obsId: string) => void;
  now?: number;
}

const TARGET_TICKS = 5;

/** A 1/2/5 x 10^n step that cuts `totalMs` into roughly {@link TARGET_TICKS} pieces. */
function tickStep(totalMs: number): number {
  const raw = totalMs / TARGET_TICKS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
  return Math.max(1, step ?? 10 * magnitude);
}

/** Tick label relative to the trace start: `0ms`, `250ms`, `1.5s`, `12s`. */
function tickLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Number((ms / 1000).toFixed(2))}s`;
}

function TimeAxis({ totalMs }: { totalMs: number }) {
  const step = tickStep(totalMs);
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += step) ticks.push(t);
  return (
    <div className="run-axis" aria-hidden="true">
      <span className="run-axis-spacer" />
      <span className="run-axis-track">
        {ticks.map((t) => (
          <span key={t} className="run-axis-tick" style={{ left: `${(t / totalMs) * 100}%` }}>
            {tickLabel(t)}
          </span>
        ))}
      </span>
    </div>
  );
}

interface BarRowProps {
  node: ObservationNode;
  minStart: number;
  totalMs: number;
  now: number;
  selected: boolean;
  virtual: boolean;
  onSelect: (obsId: string) => void;
}

function BarRow({ node, minStart, totalMs, now, selected, virtual, onSelect }: BarRowProps) {
  const { row } = node;
  const ms = elapsedMs(row, now);
  const left = ((row.start - minStart) / totalMs) * 100;
  const width = Math.max(0.5, (ms / totalMs) * 100);
  const failed = row.status === 'error';
  const running = isRunning(row);
  const label = `${fmtDuration(ms)}${running ? ' running' : ''}`;
  return (
    <button
      type="button"
      className={cx('run-row', 'run-wf-row', virtual && 'run-row-virtual', selected && 'selected', failed && 'run-row-error')}
      data-obs-id={row.obs_id}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(row.obs_id)}
    >
      <span className="run-name run-wf-name" style={{ paddingLeft: node.depth * 12 }} title={row.name ?? row.obs_id}>
        {displayName(row)}
      </span>
      <span className="run-wf-track">
        <span
          className={cx('run-wf-bar', `run-wf-bar-${row.kind}`, running && 'running', failed && 'error')}
          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
        />
      </span>
      <span className={cx('run-dur', running && 'run-dur-live')}>{label}</span>
    </button>
  );
}

/**
 * The trace on a time axis: tick labels relative to the trace start, then one
 * bar per observation (depth-first order) offset and sized by its start/end
 * within the trace bounds; an open observation's bar runs to `now`, an error
 * bar is red. Above 500 observations the rows render through `VirtualList`.
 */
export function Waterfall({ observations, selectedObsId, onSelect, now }: WaterfallProps) {
  const nodes = useFlatNodes(observations);
  const clock = now ?? Date.now();
  const { minStart, maxEnd } = traceBounds(observations, clock);
  const totalMs = maxEnd - minStart;
  const virtual = nodes.length > VIRTUALISE_ABOVE;
  const renderRow = (node: ObservationNode) => (
    <BarRow
      key={node.row.obs_id}
      node={node}
      minStart={minStart}
      totalMs={totalMs}
      now={clock}
      selected={node.row.obs_id === selectedObsId}
      virtual={virtual}
      onSelect={onSelect}
    />
  );
  return (
    <div className="run-waterfall" role="group" aria-label="Waterfall">
      <TimeAxis totalMs={totalMs} />
      {virtual ? (
        <VirtualList items={nodes} rowHeight={VIRTUAL_ROW_HEIGHT} renderRow={renderRow} className="run-virtual" />
      ) : (
        nodes.map(renderRow)
      )}
    </div>
  );
}
