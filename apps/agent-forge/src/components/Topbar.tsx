import { useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import { downloadSpec, importSpecFile } from '../persistence/importExport';
import { RuntimeApiError } from '../runtime/runtimeClient';

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  stopped: 'stopped',
  error: 'error',
  paused: 'awaiting approval',
};

export function Topbar() {
  const {
    spec,
    setSpec,
    save,
    dirty,
    agentId,
    runStatus,
    runAgent,
    stopAgent,
    approveAgent,
    debugMode,
    setDebugMode,
    setDrawerTab,
  } = useAppState();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const status = runStatus?.status ?? 'idle';
  const isRunning = status === 'running';
  const isPaused = status === 'paused' && !!runStatus?.pendingApproval;

  function handleExport() {
    downloadSpec(spec, `${spec.name || agentId}.yaml`);
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleImportChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const imported = await importSpecFile(file);
    setSpec(() => imported);
  }

  async function handleRun() {
    setActionError(undefined);
    try {
      // A blank input is fine when resuming from a checkpoint (see
      // runRegistry.ts's run() doc comment - AgentExecutor ignores `input`
      // once a checkpoint exists), so this always sends *some* string
      // rather than blocking Run on an empty prompt.
      await runAgent('Run the agent.');
    } catch (error) {
      setActionError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
    }
  }

  async function handleStop() {
    setActionError(undefined);
    try {
      await stopAgent();
    } catch (error) {
      setActionError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
    }
  }

  async function handleApprove(approved: boolean) {
    setActionError(undefined);
    try {
      await approveAgent(approved);
    } catch (error) {
      setActionError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
    }
  }

  return (
    <div className="topbar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M6.5 10v4a2 2 0 0 0 2 2H14" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        Agent Forge
      </div>
      <div className="crumbs">
        <span>Agents</span>
        <span className="crumb-sep">/</span>
        <b>{spec.name}</b>
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
      </div>
      <div className="topbar-spacer" />

      {isPaused && (
        <div className="approval-card" title={JSON.stringify(runStatus?.pendingApproval?.args)}>
          <span>
            Approve <b>{runStatus?.pendingApproval?.toolName}</b>?
          </span>
          <button className="btn btn-success" onClick={() => void handleApprove(true)}>
            Approve
          </button>
          <button className="btn btn-danger" onClick={() => void handleApprove(false)}>
            Reject
          </button>
        </div>
      )}

      {status === 'error' && runStatus?.error && (
        <span className="run-error" title={runStatus.error}>
          {runStatus.error}
        </span>
      )}
      {actionError && (
        <span className="run-error" title={actionError}>
          {actionError}
        </span>
      )}

      <span className={`status-pill status-${status}`}>
        <span className="dot" />
        {STATUS_LABEL[status] ?? status}
      </span>

      <div className="env-select">
        <span className="dot" /> local &middot; {spec.provider.type} provider
      </div>
      {/*
        O3: toggles debug mode - the Inspector exposes breakpoint toggles
        on llm/tool nodes while on, and the Trace tab's DebugBar shows
        Step/Continue controls (also shown automatically whenever a run is
        actually paused at a breakpoint, even with this off).
      */}
      <button
        className={`btn${debugMode ? ' btn-primary' : ' btn-ghost'}`}
        onClick={() => {
          setDebugMode(!debugMode);
          if (!debugMode) setDrawerTab('trace');
        }}
        title="Toggle step-through debug mode (set breakpoints in the Inspector)"
      >
        Debug
      </button>
      <button className="btn btn-danger" onClick={() => void handleStop()} disabled={!isRunning}>
        Stop
      </button>
      <button className="btn btn-success" onClick={() => void handleRun()} disabled={isRunning}>
        Run
      </button>
      <button className="btn" onClick={handleImportClick}>
        Import
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml,.json"
        style={{ display: 'none' }}
        onChange={handleImportChange}
      />
      <button className="btn" onClick={handleExport}>
        Export
      </button>
      <button className="btn btn-primary" onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}
