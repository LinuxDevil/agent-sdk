import { useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import { downloadSpec, importSpecFile } from '../persistence/importExport';
import { ApprovalCard } from './ApprovalCard';
import { errorMessage } from './errorMessage';
import { StatusPill } from './StatusPill';

function BrandMark() {
  return (
    <div className="brand">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6.5 10v4a2 2 0 0 0 2 2H14" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      Agent Forge
    </div>
  );
}

type RunStatusPayload = ReturnType<typeof useAppState>['runStatus'];
type ActiveProfile = ReturnType<typeof useAppState>['activeProfile'];

function pendingApprovalOf(runStatus: RunStatusPayload) {
  return runStatus?.status === 'paused' ? runStatus.pendingApproval : undefined;
}

function runErrorOf(runStatus: RunStatusPayload) {
  return runStatus?.status === 'error' ? runStatus.error : undefined;
}

function ApprovalNotice({ runStatus }: { runStatus: RunStatusPayload }) {
  const pendingApproval = pendingApprovalOf(runStatus);
  return pendingApproval ? <ApprovalCard toolName={pendingApproval.toolName} args={pendingApproval.args} /> : null;
}

function ErrorNotice({ message }: { message: string | undefined }) {
  return message ? (
    <span className="run-error" title={message}>
      {message}
    </span>
  ) : null;
}

function RunNotices({ runStatus, actionError }: { runStatus: RunStatusPayload; actionError: string | undefined }) {
  return (
    <>
      <ApprovalNotice runStatus={runStatus} />
      <ErrorNotice message={runErrorOf(runStatus)} />
      <ErrorNotice message={actionError} />
    </>
  );
}

function profileTitle(profile: ActiveProfile) {
  return profile ? `Settings profile: ${profile.name}` : undefined;
}

function profileName(profile: ActiveProfile) {
  return profile?.name ?? 'local';
}

/**
 * Eve DUI-F4: the env pill names the provider the agent actually runs on -
 * the one the in-flight run reported, else the agent's own spec - not the
 * settings profile's (cosmetic) provider type. A mock agent gets a visible
 * MOCK badge, so canned replies are never mistaken for a real model.
 */
function EnvSelect() {
  const { spec, activeProfile, runStatus } = useAppState();
  const live = runStatus?.status === 'running' || runStatus?.status === 'paused';
  const provider = (live && runStatus?.provider) || `${spec.provider.type}/${spec.provider.model}`;
  const isMock = provider.split('/')[0] === 'mock';
  const title = [profileTitle(activeProfile), `Provider: ${provider}`].filter(Boolean).join(' - ');
  return (
    <div className={`env-select${isMock ? ' env-select-mock' : ''}`} title={title}>
      <span className="dot" /> {profileName(activeProfile)} &middot; {provider}
      {isMock && <span className="mock-badge">MOCK</span>}
    </div>
  );
}

function DebugToggle() {
  const { debugMode, setDebugMode, setDrawerTab } = useAppState();
  return (
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
  );
}

function SpecFileButtons() {
  const { spec, setSpec, agentId } = useAppState();
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImportChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const imported = await importSpecFile(file);
    setSpec(() => imported);
  }

  return (
    <>
      <button className="btn" onClick={() => fileInputRef.current?.click()}>
        Import
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml,.json"
        style={{ display: 'none' }}
        onChange={handleImportChange}
      />
      <button className="btn" onClick={() => downloadSpec(spec, `${spec.name || agentId}.yaml`)}>
        Export
      </button>
    </>
  );
}

/** Stop/Run actions, surfacing a failed attempt as a message next to the buttons. */
function useRunActions() {
  const { runAgent, stopAgent } = useAppState();
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  async function attempt(action: () => Promise<unknown>) {
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  // A blank input is fine when resuming from a checkpoint (see
  // runRegistry.ts's run() doc comment - AgentExecutor ignores `input`
  // once a checkpoint exists), so this always sends *some* string
  // rather than blocking Run on an empty prompt.
  const handleRun = () => attempt(() => runAgent('Run the agent.'));
  const handleStop = () => attempt(() => stopAgent());

  return { actionError, handleRun, handleStop };
}

export function Topbar() {
  const { spec, save, dirty, runStatus } = useAppState();
  const { actionError, handleRun, handleStop } = useRunActions();

  const status = runStatus?.status ?? 'idle';
  const isRunning = status === 'running';

  return (
    <div className="topbar">
      <BrandMark />
      <div className="crumbs">
        <span>Agents</span>
        <span className="crumb-sep">/</span>
        <b>{spec.name}</b>
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
      </div>
      <div className="topbar-spacer" />

      <RunNotices runStatus={runStatus} actionError={actionError} />

      <StatusPill status={status} />

      {/*
        R3: real per-environment settings profile (name + provider type),
        replacing the LOU-L/O mockup's static "local · mock provider" label.
        Falls back to the current spec's own provider while the profile
        fetch hasn't resolved yet (e.g. runtime server not reachable).
      */}
      <EnvSelect />
      {/*
        O3: toggles debug mode - the Inspector exposes breakpoint toggles
        on llm/tool nodes while on, and the Trace tab's DebugBar shows
        Step/Continue controls (also shown automatically whenever a run is
        actually paused at a breakpoint, even with this off).
      */}
      <DebugToggle />
      <button className="btn btn-danger" onClick={() => void handleStop()} disabled={!isRunning}>
        Stop
      </button>
      <button className="btn btn-success" onClick={() => void handleRun()} disabled={isRunning}>
        Run
      </button>
      <SpecFileButtons />
      <button className="btn btn-primary" onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}
