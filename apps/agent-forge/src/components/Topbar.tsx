import { useRef, useState, type ReactNode } from 'react';
import {
  Bug,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  PanelLeft,
  Play,
  Save,
  SlidersHorizontal,
  Square,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { useAppState } from '../state/AppState';
import { downloadSpec, importSpecFile } from '../persistence/importExport';
import { ApprovalCard } from './ApprovalCard';
import { errorMessage } from './errorMessage';
import { RunStatus, lastRunTraceId } from './RunStatus';
import { ToolbarMoreMenu, type ToolbarMenuItem } from './ToolbarMoreMenu';
import { navigate } from '../router/router';

/** A toolbar button's 16px leading icon. */
function ToolIcon({ Icon }: { Icon: LucideIcon }) {
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}

/**
 * A toolbar button: leading icon plus a text label. The label stays in the
 * DOM (it is the accessible name) and is only visually collapsed when the
 * bar runs out of room (`.btn-label` in layout.css / topbarNarrow.css).
 */
function ToolButton({
  Icon,
  label,
  className = 'btn',
  ...rest
}: { Icon: LucideIcon; label: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={className} title={label} {...rest}>
      <ToolIcon Icon={Icon} />
      <span className="btn-label">{label}</span>
    </button>
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
  return pendingApproval ? (
    <ApprovalCard variant="inline" toolName={pendingApproval.toolName} args={pendingApproval.args} />
  ) : null;
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

type Graph = ReturnType<typeof useAppState>['graph'];

/** The agent's LLM node's `provider/model`, or undefined when the graph has no LLM node. */
function llmProviderOf(graph: Graph | undefined): string | undefined {
  const llm = graph?.nodes.find((node) => node.type === 'llm');
  return llm?.type === 'llm' ? `${llm.data.provider.type}/${llm.data.provider.model}` : undefined;
}

/**
 * The toolbar's centre model badge: the provider the agent actually runs on -
 * the one the in-flight run reported, else the agent's LLM node's - as a mono
 * `provider · model` chip, hidden when the graph has no LLM node. A mock agent
 * gets a visible MOCK badge, so canned replies are never mistaken for a real
 * model. The settings profile is named in its tooltip.
 */
/** `provider/model` the agent runs on: the in-flight run's, else the LLM node's; undefined without an LLM node. */
function useModelProvider(): string | undefined {
  const { graph, runStatus } = useAppState();
  const live = runStatus?.status === 'running' || runStatus?.status === 'paused';
  return (live && runStatus?.provider) || llmProviderOf(graph);
}

function isMockProvider(provider: string | undefined): boolean {
  return provider?.split('/')[0] === 'mock';
}

function ModelBadge() {
  const { activeProfile } = useAppState();
  const provider = useModelProvider();
  if (!provider) return null;
  const [type, ...model] = provider.split('/');
  const isMock = isMockProvider(provider);
  const title = [profileTitle(activeProfile) ?? `Settings profile: ${profileName(activeProfile)}`, `Provider: ${provider}`].join(' - ');
  return (
    <div className={`env-select${isMock ? ' env-select-mock' : ''}`} title={title}>
      <span className="env-select-text">
        {type} &middot; {model.join('/')}
      </span>
      {isMock && <span className="mock-badge">MOCK</span>}
    </div>
  );
}

function DebugToggle() {
  const { debugMode, setDebugMode, setDrawerTab } = useAppState();
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-toggle collapse-2${debugMode ? ' on' : ''}`}
      aria-pressed={debugMode}
      onClick={() => {
        setDebugMode(!debugMode);
        if (!debugMode) setDrawerTab('trace');
      }}
      title="Toggle step-through debug mode (set breakpoints in the Inspector)"
    >
      <ToolIcon Icon={Bug} />
      <span className="btn-label">Debug</span>
    </button>
  );
}

/**
 * Import/Export. a failed import (bad YAML, a spec that fails
 * validation) is reported through `onImport`'s error surface instead of
 * failing silently. The hidden file input stays mounted (the
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

/** Opens/closes a slide-over side panel in the narrow layout. */
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
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon panel-toggle${open ? ' active' : ''}`}
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
  /** Below 860px - side-panel toggles, and Debug/Import/Export/Save move into a "More" menu. */
  narrow?: boolean;
  openPanel?: SidePanel;
  onTogglePanel?: (panel: SidePanel) => void;
}

/** "Agents / <name>" with the unsaved-changes dot; the name truncates, its full text in the tooltip. */
function Breadcrumb({ showRoot = true }: { showRoot?: boolean }) {
  const { spec, dirty } = useAppState();
  return (
    <div className="crumbs">
      {showRoot && (
        <>
          <span className="crumb-root">Agents</span>
          <ChevronRight className="crumb-sep" size={14} strokeWidth={1.75} aria-hidden="true" />
        </>
      )}
      <b title={spec.name}>{spec.name}</b>
      {dirty && <span className="dirty-dot" title="Unsaved changes" />}
    </div>
  );
}

/** Run, or Stop while a run is in flight (the narrow bar shows one at a time). */
function RunOrStop({ isRunning, onRun, onStop }: { isRunning: boolean; onRun: () => void; onStop: () => void }) {
  return isRunning ? (
    <ToolButton Icon={Square} label="Stop" className="btn btn-danger btn-collapse" onClick={onStop} />
  ) : (
    <ToolButton Icon={Play} label="Run" className="btn btn-success btn-collapse" onClick={onRun} />
  );
}

/** The narrow "More" menu: Debug, Import, Export, Observe surface and (once known) Open trace. */
function useNarrowMenuItems(openImport: () => void, exportSpec: () => void): ToolbarMenuItem[] {
  const { runStatus, spans, debugMode, setDebugMode, setDrawerTab } = useAppState();
  const traceId = lastRunTraceId(runStatus, spans);
  return [
    {
      label: 'Debug',
      Icon: Bug,
      checked: debugMode,
      onSelect: () => {
        setDebugMode(!debugMode);
        if (!debugMode) setDrawerTab('trace');
      },
    },
    { label: 'Import', Icon: Upload, onSelect: openImport },
    { label: 'Export', Icon: Download, onSelect: exportSpec },
    // The old Build/Observe switch's menu entry, kept for muscle memory: Observe is now Traces.
    // Last: the menu focuses its first item on open (e2e expects Debug).
    { label: 'Observe surface', Icon: Eye, onSelect: () => navigate('/traces') },
    // The wide bar's "Open trace" link, which has no room next to Run at 375px.
    ...(traceId
      ? [{ label: 'Open trace', Icon: ExternalLink, onSelect: () => navigate(`/traces/${encodeURIComponent(traceId)}`) }]
      : []),
  ];
}

/**
 * At 860px and below: the side-panel toggles, the agent name, the run status,
 * Run (or Stop) and Save stay in the bar; Debug, Import, Export and the model
 * badge move into the "More actions" menu.
 */
function NarrowTopbar({ openPanel, onTogglePanel }: Omit<TopbarProps, 'narrow'>) {
  const { runStatus } = useAppState();
  const provider = useModelProvider();
  const { actionError, handleRun, handleStop, handleSave, handleImport } = useRunActions();
  const { fileInput, openImport, exportSpec } = useSpecFiles(handleImport);
  const items = useNarrowMenuItems(openImport, exportSpec);
  const toggle = onTogglePanel ?? (() => undefined);

  return (
    <header className="topbar topbar-builder topbar-narrow">
      <PanelToggle panel="rail" label="Agents and nodes" open={openPanel === 'rail'} onToggle={toggle}>
        <ToolIcon Icon={PanelLeft} />
      </PanelToggle>
      <div className="topbar-left">
        <Breadcrumb showRoot={false} />
        {/* The model badge moved into the menu; keep the MOCK badge (same source) in sight. */}
        {isMockProvider(provider) && <span className="mock-badge">MOCK</span>}
        <RunStatus showTraceLink={false} />
      </div>
      <RunNotices runStatus={runStatus} actionError={actionError} />
      <RunOrStop isRunning={runStatus?.status === 'running'} onRun={() => void handleRun()} onStop={() => void handleStop()} />
      <ToolButton Icon={Save} label="Save" className="btn btn-primary btn-collapse" onClick={() => void handleSave()} />
      <ToolbarMoreMenu items={items}>
        {provider && (
          <div className="overflow-menu-env" role="none">
            <ModelBadge />
          </div>
        )}
      </ToolbarMoreMenu>
      {fileInput}
      <PanelToggle panel="inspector" label="Inspector" open={openPanel === 'inspector'} onToggle={toggle}>
        <ToolIcon Icon={SlidersHorizontal} />
      </PanelToggle>
    </header>
  );
}

/**
 * The Build toolbar (Run/Stop/Import/Export/Save/Debug, model badge). Only the
 * Agents screen renders it; every other screen has the shell's ScreenHeader.
 */
export function Topbar({ narrow = false, openPanel, onTogglePanel }: TopbarProps = {}) {
  return narrow ? <NarrowTopbar openPanel={openPanel} onTogglePanel={onTogglePanel} /> : <WideTopbar />;
}

/**
 * The 52px builder toolbar: breadcrumb and run status on the left, the
 * model badge in the centre, and [Debug] [Stop][Run] | [Import][Export] [Save]
 * on the right.
 */
function WideTopbar() {
  const { runStatus } = useAppState();
  const { actionError, handleRun, handleStop, handleSave, handleImport } = useRunActions();
  const { fileInput, openImport, exportSpec } = useSpecFiles(handleImport);

  const isRunning = runStatus?.status === 'running';

  return (
    <header className="topbar topbar-builder">
      <div className="topbar-left">
        <Breadcrumb />
        {/* The last run's status, and its "Open trace" link once known. */}
        <RunStatus />
        <ErrorNotice message={runErrorOf(runStatus)} />
        <ErrorNotice message={actionError} />
      </div>
      {/* While a run waits on a tool approval, the approval takes the model badge's place. */}
      <div className="topbar-center">
        {pendingApprovalOf(runStatus) ? <ApprovalNotice runStatus={runStatus} /> : <ModelBadge />}
      </div>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        {/*
          O3: toggles debug mode - the Inspector exposes breakpoint toggles
          on llm/tool nodes while on, and the Trace tab's DebugBar shows
          Step/Continue controls (also shown automatically whenever a run is
          actually paused at a breakpoint, even with this off).
        */}
        <DebugToggle />
        <ToolButton Icon={Square} label="Stop" className="btn btn-danger collapse-2" onClick={() => void handleStop()} disabled={!isRunning} />
        <ToolButton Icon={Play} label="Run" className="btn btn-success" onClick={() => void handleRun()} disabled={isRunning} />
        <span className="toolbar-divider" aria-hidden="true" />
        <ToolButton Icon={Upload} label="Import" className="btn btn-ghost collapse-1" onClick={openImport} />
        {fileInput}
        <ToolButton Icon={Download} label="Export" className="btn btn-ghost collapse-1" onClick={exportSpec} />
        <ToolButton Icon={Save} label="Save" className="btn btn-primary" onClick={() => void handleSave()} />
      </div>
    </header>
  );
}
