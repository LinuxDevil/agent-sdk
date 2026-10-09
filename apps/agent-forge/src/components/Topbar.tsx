import { useEffect, useRef, useState } from 'react';
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
    <span className="run-error" title={message} role="alert">
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
      aria-pressed={debugMode}
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

/**
 * Import/Export. Eve DUI-F11: a failed import (bad YAML, a spec that fails
 * validation) is reported through `onImport`'s error surface instead of
 * failing silently. The hidden file input stays mounted (Eve DUI-F8: the
 * narrow layout's overflow menu unmounts its items once closed).
 */
function useSpecFiles(onImport: (file: File) => Promise<void>) {
  const { spec, agentId } = useAppState();
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImportChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await onImport(file);
  }

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".yaml,.yml,.json"
      style={{ display: 'none' }}
      tabIndex={-1}
      aria-hidden="true"
      onChange={handleImportChange}
    />
  );
  return {
    fileInput,
    openImport: () => fileInputRef.current?.click(),
    exportSpec: () => downloadSpec(spec, `${spec.name || agentId}.yaml`),
  };
}

export type SidePanel = 'rail' | 'inspector';

/** Eve DUI-F8: opens/closes a slide-over side panel in the narrow layout. */
function PanelToggle({
  panel,
  label,
  open,
  onToggle,
  children,
}: {
  panel: SidePanel;
  label: string;
  open: boolean;
  onToggle: (panel: SidePanel) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn btn-ghost panel-toggle${open ? ' active' : ''}`}
      aria-label={label}
      aria-expanded={open}
      aria-controls={panel === 'rail' ? 'studio-rail' : 'studio-inspector'}
      title={label}
      onClick={() => onToggle(panel)}
    >
      {children}
    </button>
  );
}

interface OverflowItem {
  label: string;
  onSelect: () => void;
  checked?: boolean;
}

/**
 * Eve DUI-F8: the narrow layout's "More" menu - Debug, Import, Export and
 * Save, plus the provider pill, which no longer fit next to Run at 375px.
 */
function OverflowMenu({ items, children }: { items: OverflowItem[]; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const entries = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    const i = entries.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % entries.length : (i - 1 + entries.length) % entries.length;
    entries[next]?.focus();
  }

  return (
    <div className="overflow-menu" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-ghost panel-toggle"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => setOpen((o) => !o)}
      >
        &#8943;
      </button>
      {open && (
        <div className="overflow-menu-list" role="menu" aria-label="More actions" onKeyDown={onMenuKeyDown}>
          {children}
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              className="overflow-menu-item"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
              {item.checked && <span aria-hidden="true"> &#10003;</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Stop/Run/Save/Import actions, surfacing a failed attempt as a message next to the buttons. */
function useRunActions() {
  const { runAgent, stopAgent, save, setSpec } = useAppState();
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
  const handleSave = () => attempt(() => save());
  const handleImport = (file: File) =>
    attempt(async () => {
      try {
        const imported = await importSpecFile(file);
        setSpec(() => imported);
      } catch (error) {
        throw new Error(`Import of '${file.name}' failed: ${errorMessage(error)}`);
      }
    });

  return { actionError, handleRun, handleStop, handleSave, handleImport };
}

interface TopbarProps {
  /** Eve DUI-F8: below 860px - side-panel toggles, and Debug/Import/Export/Save move into a "More" menu. */
  narrow?: boolean;
  openPanel?: SidePanel;
  onTogglePanel?: (panel: SidePanel) => void;
}

function NarrowTopbar({ openPanel, onTogglePanel }: Omit<TopbarProps, 'narrow'>) {
  const { spec, dirty, runStatus, debugMode, setDebugMode, setDrawerTab } = useAppState();
  const { actionError, handleRun, handleStop, handleSave, handleImport } = useRunActions();
  const { fileInput, openImport, exportSpec } = useSpecFiles(handleImport);
  const toggle = onTogglePanel ?? (() => undefined);

  const status = runStatus?.status ?? 'idle';
  const isRunning = status === 'running';

  const items: OverflowItem[] = [
    {
      label: 'Debug',
      checked: debugMode,
      onSelect: () => {
        setDebugMode(!debugMode);
        if (!debugMode) setDrawerTab('trace');
      },
    },
    { label: 'Import', onSelect: openImport },
    { label: 'Export', onSelect: exportSpec },
    { label: 'Save', onSelect: () => void handleSave() },
  ];

  return (
    <header className="topbar topbar-narrow">
      <PanelToggle panel="rail" label="Agents and nodes" open={openPanel === 'rail'} onToggle={toggle}>
        &#9776;
      </PanelToggle>
      <div className="crumbs">
        <b>{spec.name}</b>
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        {/* Eve DUI-F4: the provider pill moved into the menu; keep the MOCK badge in sight. */}
        {spec.provider.type === 'mock' && <span className="mock-badge">MOCK</span>}
      </div>
      <RunNotices runStatus={runStatus} actionError={actionError} />
      <StatusPill status={status} live />
      {isRunning ? (
        <button className="btn btn-danger" onClick={() => void handleStop()}>
          Stop
        </button>
      ) : (
        <button className="btn btn-success" onClick={() => void handleRun()}>
          Run
        </button>
      )}
      <OverflowMenu items={items}>
        <div className="overflow-menu-env" role="none">
          <EnvSelect />
        </div>
      </OverflowMenu>
      {fileInput}
      <PanelToggle panel="inspector" label="Inspector" open={openPanel === 'inspector'} onToggle={toggle}>
        &#9881;
      </PanelToggle>
    </header>
  );
}

export function Topbar({ narrow = false, openPanel, onTogglePanel }: TopbarProps = {}) {
  return narrow ? <NarrowTopbar openPanel={openPanel} onTogglePanel={onTogglePanel} /> : <WideTopbar />;
}

function WideTopbar() {
  const { spec, dirty, runStatus } = useAppState();
  const { actionError, handleRun, handleStop, handleSave, handleImport } = useRunActions();
  const { fileInput, openImport, exportSpec } = useSpecFiles(handleImport);

  const status = runStatus?.status ?? 'idle';
  const isRunning = status === 'running';

  return (
    <header className="topbar">
      <BrandMark />
      <div className="crumbs">
        <span>Agents</span>
        <span className="crumb-sep">/</span>
        <b>{spec.name}</b>
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
      </div>
      <div className="topbar-spacer" />

      <RunNotices runStatus={runStatus} actionError={actionError} />

      <StatusPill status={status} live />

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
      <button className="btn" onClick={openImport}>
        Import
      </button>
      {fileInput}
      <button className="btn" onClick={exportSpec}>
        Export
      </button>
      <button className="btn btn-primary" onClick={() => void handleSave()}>
        Save
      </button>
    </header>
  );
}
