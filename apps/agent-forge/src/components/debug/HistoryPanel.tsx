import { useEffect, useState } from 'react';
import type { TrajectoryStep } from '@lousho/build-ai-agent';
import { useAppState } from '../../state/AppState';
import { runtimeClient } from '../../runtime/runtimeClient';
import { errorMessage } from '../errorMessage';
import type { ForkRunRequest, RunComparisonPayload, RunHistoryStep } from '../../../shared/wireTypes';

type ForkPatch = NonNullable<ForkRunRequest['patch']>;

/** LOU-D45: one row per checkpointed step of the run, each with an "Edit and replay from here" action. */
export function HistoryList({ steps, onReplay }: { steps: RunHistoryStep[]; onReplay: (step: RunHistoryStep) => void }) {
  return (
    <table className="history-table">
      <thead>
        <tr>
          {['Step', 'Status', 'Finish', 'Tool calls', 'Tokens', 'Cost', ''].map((h) => <th key={h}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.step}>
            <td>{s.step}</td>
            <td>{s.status}</td>
            <td>{s.finishReason ?? '-'}</td>
            <td>{s.toolCalls.map((call) => call.name).join(', ') || '-'}</td>
            <td>{s.tokens ?? '-'}</td>
            <td>{s.costUsd === undefined ? '-' : `$${s.costUsd.toFixed(4)}`}</td>
            <td>
              <button className="btn btn-ghost" onClick={() => onReplay(s)}>Edit and replay from here</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A tool result is sent as JSON when it parses, else as the plain string. */
function parseResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function ReplayEditor({ step, onFork, onCancel }: { step: RunHistoryStep; onFork: (patch: ForkPatch) => void; onCancel: () => void }) {
  const [target, setTarget] = useState('append');
  const [text, setText] = useState('');
  const choose = (value: string) => {
    setTarget(value);
    setText(step.toolCalls.find((call) => call.id === value)?.result ?? '');
  };
  const submit = () =>
    onFork(target === 'append' ? { appendInput: text } : { toolResult: { toolCallId: target, result: parseResult(text) } });
  return (
    <div className="replay-editor">
      <b>Replay from step {step.step}</b>
      <select className="select" aria-label="What to change" value={target} onChange={(e) => choose(e.target.value)}>
        <option value="append">Append a user message</option>
        {step.toolCalls.map((call) => (
          <option key={call.id} value={call.id}>Edit the result of {call.name} ({call.id})</option>
        ))}
      </select>
      <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label="Replay edit" />
      <div className="replay-actions">
        <button className="btn btn-primary" disabled={!text.trim()} onClick={submit}>Fork and replay</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function StepCell({ step }: { step: TrajectoryStep | undefined }) {
  if (!step) return <div className="traj-cell traj-missing">-</div>;
  return (
    <div className="traj-cell">
      {step.text && <div>{step.text}</div>}
      {step.tools.map((tool) => (
        <div key={tool.id} className="traj-tool">
          {tool.name}({tool.args}) {'->'} {tool.result ?? 'pending'}
        </div>
      ))}
    </div>
  );
}

/** LOU-D45: two runs' model turns side by side, the first diverging turn and the drift entries highlighted. */
export function TrajectoryCompare({ comparison, a, b }: { comparison: RunComparisonPayload; a: string; b: string }) {
  const turns = Math.max(comparison.a.length, comparison.b.length);
  return (
    <div className="traj-compare">
      <div className="traj-row traj-head">
        <span>Turn</span>
        <b>{a}</b>
        <b>{b}</b>
      </div>
      {Array.from({ length: turns }, (_, i) => (
        <div key={i} className={`traj-row${comparison.divergedAt === i + 1 ? ' diverged' : ''}`}>
          <span>{comparison.divergedAt === i + 1 ? `${i + 1} diverged` : i + 1}</span>
          <StepCell step={comparison.a[i]} />
          <StepCell step={comparison.b[i]} />
        </div>
      ))}
      <ul className="traj-drift">
        {comparison.drift.length === 0 && <li>No drift</li>}
        {comparison.drift.map((d) => (
          <li key={`${d.field}:${d.committed}`}>
            <b>{d.field}</b>: {d.committed} {'->'} {d.current}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The loaded agent's run steps (`GET /runs/:id/history`), refetched on every status change. */
function useRunHistory(agentId: string, statusAt: string | undefined): RunHistoryStep[] {
  const [steps, setSteps] = useState<RunHistoryStep[]>([]);
  useEffect(() => {
    let live = true;
    runtimeClient.runHistory(agentId).then(
      (history) => live && setSteps(history.steps),
      () => live && setSteps([])
    );
    return () => void (live = false);
  }, [agentId, statusAt]);
  return steps;
}

interface ForkView {
  runId: string;
  comparison?: RunComparisonPayload;
}

/**
 * Forks the agent's run (`POST /runs/:id/fork`) and keeps the fork's
 * comparison with it (`GET /runs/compare`) fresh as the fork's status streams in.
 */
function useForkReplay(agentId: string) {
  const [fork, setFork] = useState<ForkView>();
  const [error, setError] = useState<string>();
  useEffect(() => setFork(undefined), [agentId]);

  const forkId = fork?.runId;
  useEffect(() => {
    if (!forkId) return undefined;
    const refresh = () =>
      runtimeClient.compareRuns(agentId, forkId).then(
        (comparison) => setFork((f) => (f?.runId === forkId ? { runId: forkId, comparison } : f)),
        (e: unknown) => setError(errorMessage(e))
      );
    return runtimeClient.subscribe(forkId, (message) => {
      if (message.type === 'status' && message.payload.status !== 'running') void refresh();
    });
  }, [agentId, forkId]);

  const replay = async (fromStep: number, patch: ForkPatch): Promise<boolean> => {
    setError(undefined);
    try {
      const { runId } = await runtimeClient.forkRun(agentId, { fromStep, patch });
      setFork({ runId });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  return { fork, error, replay };
}

function ForkResult({ fork, agentId }: { fork: ForkView | undefined; agentId: string }) {
  if (!fork) return null;
  if (!fork.comparison) return <div className="logs-empty">Replaying as {fork.runId}...</div>;
  return <TrajectoryCompare comparison={fork.comparison} a={agentId} b={fork.runId} />;
}

/** LOU-D45 time travel: the loaded agent's run history, "Edit and replay from here", and the fork next to the original. */
export function HistoryPanel() {
  const { agentId, runStatus } = useAppState();
  const steps = useRunHistory(agentId, runStatus?.updatedAt);
  const { fork, error, replay } = useForkReplay(agentId);
  const [replaying, setReplaying] = useState<RunHistoryStep>();

  const onFork = async (step: RunHistoryStep, patch: ForkPatch) => {
    if (await replay(step.step, patch)) setReplaying(undefined);
  };

  if (steps.length === 0) return <div className="logs-empty">No checkpoint history yet - run the agent first.</div>;
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
