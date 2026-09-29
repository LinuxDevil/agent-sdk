import { useAppState } from '../../state/AppState';
import { JsonTree } from './JsonTree';

/**
 * O3: step-through controls + live paused state, shown above the Trace tab
 * whenever a breakpoint has been hit (or `debugMode` is on). "Paused" here
 * is a real await inside AgentExecutor's onLLMRequest/onLLMResponse/
 * onToolCall/onToolResult hooks (see server/debugController.ts) - Step
 * resumes execution only as far as the next LLM/tool boundary, Continue
 * resumes normally.
 */
export function DebugBar() {
  const { debugMode, debugState, continueDebug, stepDebug } = useAppState();

  if (!debugMode && !debugState?.paused) return null;

  const paused = !!debugState?.paused;

  return (
    <div className="debug-bar">
      <b>Debug</b>
      {paused ? (
        <span>
          Paused at <code>{debugState?.atBreakpoint?.phase}</code> ({debugState?.atBreakpoint?.boundary})
        </span>
      ) : (
        <span>Running - set breakpoints on the llm/tool node in the Inspector.</span>
      )}
      <span className="step-count">step {debugState?.stepCount ?? 0}</span>
      <div className="topbar-spacer" />
      <button className="btn" onClick={() => void stepDebug()} disabled={!paused && (debugState?.breakpoints.length ?? 0) === 0 && !debugMode}>
        Step
      </button>
      <button className="btn btn-success" onClick={() => void continueDebug()} disabled={!paused}>
        Continue
      </button>
      {paused && debugState?.messages && debugState.messages.length > 0 && (
        <details style={{ width: '100%' }}>
          <summary>Live message array ({debugState.messages.length})</summary>
          <JsonTree value={debugState.messages} defaultExpandDepth={1} />
        </details>
      )}
    </div>
  );
}
