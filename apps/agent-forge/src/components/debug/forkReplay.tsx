import { useEffect, useState } from 'react';
import type { TrajectoryStep } from 'lousho';
import { runtimeClient } from '../../runtime/runtimeClient';
import { errorMessage } from '../errorMessage';
import type { ForkRunRequest, RunComparisonPayload, RunHistoryStep } from '../../../shared/wireTypes';

/** The patch `POST /runs/:id/fork` applies at `fromStep`: a replacement tool result, an appended user message, or business state. */
export type ForkPatch = NonNullable<ForkRunRequest['patch']>;

/** A tool result is sent as JSON when it parses, else as the plain string. */
function parseResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The fork's edit form for one checkpointed step — "Edit and replay from
 * here" in the History tab and "Fork from here" in the node spans sheet:
 * pick what to change at `step` (append a user message, or edit the
 * recorded result of one of its tool calls), edit the text, submit.
 * `defaultTarget` (a `toolCalls[].id`) opens the form with that call
 * preselected and its recorded result loaded; without it the form opens on
 * "Append a user message" as before.
 */
export function ReplayEditor({
  step,
  onFork,
  onCancel,
  defaultTarget,
}: {
  step: RunHistoryStep;
  onFork: (patch: ForkPatch) => void;
  onCancel: () => void;
  defaultTarget?: string;
}): JSX.Element {
  const [target, setTarget] = useState(defaultTarget ?? 'append');
  const [text, setText] = useState(() =>
    defaultTarget === undefined ? '' : (step.toolCalls.find((call) => call.id === defaultTarget)?.result ?? ''),
  );
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
  if (!step) return <div className="traj-cell traj-missing">—</div>;
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

/** Two runs' model turns side by side, the first diverging turn and the drift entries highlighted. */
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
export function useRunHistory(agentId: string, statusAt: string | undefined): RunHistoryStep[] {
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

/** A forked run and, once the fork leaves `running`, its side-by-side comparison with the original run. */
export interface ForkView {
  runId: string;
  comparison?: RunComparisonPayload;
}

/**
 * Forks the agent's run (`POST /runs/:id/fork`) and keeps the fork's
 * comparison with it (`GET /runs/compare`) fresh as the fork's status streams in.
 */
export function useForkReplay(agentId: string) {
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

/** The fork's progress ("Replaying as <runId>…") then its comparison with `agentId`, or nothing before any fork. */
export function ForkResult({ fork, agentId }: { fork: ForkView | undefined; agentId: string }): JSX.Element | null {
  if (!fork) return null;
  if (!fork.comparison) return <div className="logs-empty">Replaying as {fork.runId}...</div>;
  return <TrajectoryCompare comparison={fork.comparison} a={agentId} b={fork.runId} />;
}
