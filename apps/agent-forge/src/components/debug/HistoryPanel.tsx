import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { TonePill, stepTone } from './TonePill';
import { useAppState } from '../../state/AppState';
import { ForkResult, ReplayEditor, useForkReplay, useRunHistory, type ForkPatch } from './forkReplay';
import type { RunHistoryStep } from '../../../shared/wireTypes';

// Re-exported so imports from this module keep working after the fork/replay
// pieces moved to ./forkReplay (shared with the node spans sheet, T08).
export { TrajectoryCompare } from './forkReplay';

const NUMERIC_COLUMNS = new Set(['Step', 'Tokens', 'Cost']);

/** A value the step does not have: a faint em dash. */
const MISSING = <span className="value-missing">—</span>;

/** One row per checkpointed step of the run, each with an "Edit and replay from here" action. */
export function HistoryList({ steps, onReplay }: { steps: RunHistoryStep[]; onReplay: (step: RunHistoryStep) => void }) {
  return (
    <table className="history-table">
      <thead>
        <tr>
          {['Step', 'Status', 'Finish', 'Tool calls', 'Tokens', 'Cost', ''].map((h) => (
            <th key={h} className={NUMERIC_COLUMNS.has(h) ? 'num' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.step}>
            <td className="num">{s.step}</td>
            <td>
              <TonePill tone={stepTone(s.status)} label={s.status} />
            </td>
            <td className="mono">{s.finishReason ?? MISSING}</td>
            <td className="mono">{s.toolCalls.map((call) => call.name).join(', ') || MISSING}</td>
            <td className="num">{s.tokens ?? MISSING}</td>
            <td className="num">{s.costUsd === undefined ? MISSING : `$${s.costUsd.toFixed(4)}`}</td>
            <td className="history-action">
              <button className="btn btn-ghost btn-sm" onClick={() => onReplay(s)}>
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                Edit and replay from here
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Time travel: the loaded agent's run history, "Edit and replay from here", and the fork next to the original. */
export function HistoryPanel() {
  const { agentId, runStatus } = useAppState();
  const steps = useRunHistory(agentId, runStatus?.updatedAt);
  const { fork, error, replay } = useForkReplay(agentId);
  const [replaying, setReplaying] = useState<RunHistoryStep>();

  const onFork = async (step: RunHistoryStep, patch: ForkPatch) => {
    if (await replay(step.step, patch)) setReplaying(undefined);
  };

  if (steps.length === 0) return <div className="logs-empty drawer-empty">No checkpoint history yet - run the agent first.</div>;
  return (
    <div className="history-panel">
      {error && <div className="run-error" role="alert">{error}</div>}
      <HistoryList steps={steps} onReplay={setReplaying} />
      {replaying && (
        <ReplayEditor
          key={replaying.step}
          step={replaying}
          onFork={(patch) => void onFork(replaying, patch)}
          onCancel={() => setReplaying(undefined)}
        />
      )}
      <ForkResult fork={fork} agentId={agentId} />
    </div>
  );
}
