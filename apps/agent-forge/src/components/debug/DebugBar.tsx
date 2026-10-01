import { useAppState } from '../../state/AppState';
import type { DebugStatePayload } from '../../../shared/wireTypes';
import { JsonTree } from './JsonTree';

type DebugState = DebugStatePayload | undefined;

function isPaused(debugState: DebugState): boolean {
  return !!debugState?.paused;
}

/** Step is only useful when paused, when breakpoints exist, or in debug mode. */
function isStepDisabled(debugState: DebugState, debugMode: boolean): boolean {
  const hasBreakpoints = (debugState?.breakpoints.length ?? 0) > 0;
  return !isPaused(debugState) && !hasBreakpoints && !debugMode;
}

function stepCountOf(debugState: DebugState): number {
  return debugState?.stepCount ?? 0;
}

/** The live message array, only meaningful while paused at a breakpoint. */
function pausedMessages(debugState: DebugState): unknown[] {
  return debugState?.paused ? debugState.messages : [];
}

function PausedStatus({ atBreakpoint }: { atBreakpoint: DebugStatePayload['atBreakpoint'] }) {
  return (
    <span>
      Paused at <code>{atBreakpoint?.phase}</code> ({atBreakpoint?.boundary})
    </span>
  );
}

function DebugStatus({ debugState }: { debugState: DebugState }) {
  if (debugState?.paused) return <PausedStatus atBreakpoint={debugState.atBreakpoint} />;
  return <span>Running - set breakpoints on the llm/tool node in the Inspector.</span>;
}

function LiveMessages({ debugState }: { debugState: DebugState }) {
  const messages = pausedMessages(debugState);
  if (messages.length === 0) return null;
  return (
    <details style={{ width: '100%' }}>
      <summary>Live message array ({messages.length})</summary>
      <JsonTree value={messages} defaultExpandDepth={1} />
    </details>
  );
}

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
  const paused = isPaused(debugState);

  if (!debugMode && !paused) return null;

  return (
    <div className="debug-bar">
      <b>Debug</b>
      <DebugStatus debugState={debugState} />
      <span className="step-count">step {stepCountOf(debugState)}</span>
      <div className="topbar-spacer" />
      <button className="btn" onClick={() => void stepDebug()} disabled={isStepDisabled(debugState, debugMode)}>
        Step
      </button>
      <button className="btn btn-success" onClick={() => void continueDebug()} disabled={!paused}>
        Continue
      </button>
      <LiveMessages debugState={debugState} />
    </div>
  );
}
