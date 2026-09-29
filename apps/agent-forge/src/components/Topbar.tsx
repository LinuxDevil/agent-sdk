import { useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import { downloadSpec, importSpecFile } from '../persistence/importExport';
import { RuntimeApiError } from '../runtime/runtimeClient';
import { ApprovalCard } from './ApprovalCard';

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
    debugMode,
    setDebugMode,
    setDrawerTab,
    activeProfile,
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

      {isPaused && runStatus?.pendingApproval && (
        <ApprovalCard toolName={runStatus.pendingApproval.toolName} args={runStatus.pendingApproval.args} />
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

      {/*
        R3: real per-environment settings profile (name + provider type),
        replacing the LOU-L/O mockup's static "local · mock provider" label.
        Falls back to the current spec's own provider while the profile
        fetch hasn't resolved yet (e.g. runtime server not reachable).
      */}
      <div className="env-select" title={activeProfile ? `Settings profile: ${activeProfile.name}` : undefined}>
        <span className="dot" /> {activeProfile?.name ?? 'local'} &middot; {activeProfile?.providerType ?? spec.provider.type} provider
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
