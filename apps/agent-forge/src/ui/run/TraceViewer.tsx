import { useMemo } from 'react';

import { nestObservations } from '../../observe/tree';
import type { ObserveObservationRow, ObserveScoreRow } from '../../observe/types';
import { EmptyState } from '../EmptyState';
import { RunInspector, type RunInspectorProps } from './RunInspector';
import { RunTree } from './RunTree';
import { Waterfall } from './Waterfall';
import './run.css';

/** The two ways {@link TraceViewer} lays out a trace's steps. */
export type TraceViewMode = 'tree' | 'waterfall';

/**
 * Props for {@link TraceViewer}. The caller owns both the selection and the
 * mode; pass `onModeChange` to get a Tree/Waterfall toggle. `now` is the clock
 * open observations run to (defaults to `Date.now()`). `renderFeedback` is
 * handed to the inspector (see {@link RunInspectorProps}). `playgroundLinks:
 * false` hides the "Open in Playground" links (default true).
 */
export interface TraceViewerProps {
  observations: ObserveObservationRow[];
  scores: ObserveScoreRow[];
  selectedObsId?: string | null;
  onSelect: (obsId: string) => void;
  mode: TraceViewMode;
  onModeChange?: (mode: TraceViewMode) => void;
  now?: number;
  renderFeedback?: RunInspectorProps['renderFeedback'];
  playgroundLinks?: boolean;
}

const MODES: { mode: TraceViewMode; label: string }[] = [
  { mode: 'tree', label: 'Tree' },
  { mode: 'waterfall', label: 'Waterfall' },
];

/** The selected row, else the earliest-started error, else the first root. */
function pickInspected(rows: ObserveObservationRow[], selectedObsId: string | null | undefined): ObserveObservationRow | undefined {
  if (selectedObsId != null) {
    const selected = rows.find((row) => row.obs_id === selectedObsId);
    if (selected) return selected;
  }
  let firstError: ObserveObservationRow | undefined;
  for (const row of rows) {
    if (row.status === 'error' && (firstError === undefined || row.start < firstError.start)) firstError = row;
  }
  return firstError ?? nestObservations(rows)[0]?.row;
}

/**
 * The one trace viewer: a `RunTree` or `Waterfall` (per `mode`) beside a
 * `RunInspector`. With no valid selection the inspector shows the first
 * failed step (so a failed trace opens on its Error banner), else the root.
 */
export function TraceViewer({
  observations,
  scores,
  selectedObsId,
  onSelect,
  mode,
  onModeChange,
  now,
  renderFeedback,
  playgroundLinks = true,
}: TraceViewerProps) {
  const inspected = useMemo(() => pickInspected(observations, selectedObsId), [observations, selectedObsId]);
  if (inspected === undefined) {
    return <EmptyState title="No steps recorded" hint="This trace has no observations yet. Steps appear here as the run reports them." />;
  }
  const listProps = { observations, selectedObsId: inspected.obs_id, onSelect, now };
  return (
    <div className="run-viewer" data-mode={mode}>
      <div className="run-viewer-steps">
        {onModeChange && (
          <div className="run-mode-toggle" role="group" aria-label="Trace layout">
            {MODES.map((m) => (
              <button key={m.mode} type="button" aria-pressed={mode === m.mode} onClick={() => onModeChange(m.mode)}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        {mode === 'waterfall' ? <Waterfall {...listProps} /> : <RunTree {...listProps} playgroundLinks={playgroundLinks} />}
      </div>
      <div className="run-viewer-inspector">
        <RunInspector observation={inspected} scores={scores} now={now} renderFeedback={renderFeedback} playgroundLinks={playgroundLinks} />
      </div>
    </div>
  );
}
