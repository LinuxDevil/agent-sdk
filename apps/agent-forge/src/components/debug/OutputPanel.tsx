import { useAppState } from '../../state/AppState';
import { JsonView } from '../../ui/JsonView';

/**
 * The final (or paused-for-approval) `ExecutionResult` as a
 * collapsible JSON tree - `runStatus.result` (see server/runRegistry.ts's
 * `handleRunSettled()`, which keeps the full ExecutionResult on the entry
 * for both the 'done' and 'paused' terminal states, not just the final
 * text). Falls back to the current in-memory `AgentSpec`
 * before any run has happened, same as the placeholder did.
 */
export function OutputPanel() {
  const { runStatus, spec } = useAppState();

  if (runStatus?.result) {
    return (
      <div className="output-json">
        <div className="output-label overline">
          {runStatus.status === 'paused' ? 'Paused ExecutionResult (awaiting approval)' : 'ExecutionResult'}
        </div>
        <JsonView value={runStatus.result} />
      </div>
    );
  }

  return (
    <div className="output-json">
      <div className="output-label overline">Agent spec (no run yet)</div>
      <JsonView value={spec} />
    </div>
  );
}
