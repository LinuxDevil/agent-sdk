import { useRef } from 'react';
import { useAppState } from '../state/AppState';
import { downloadSpec, importSpecFile } from '../persistence/importExport';

export function Topbar() {
  const { spec, setSpec, save, dirty, agentId } = useAppState();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      <div className="env-select">
        <span className="dot" /> local &middot; {spec.provider.type} provider
      </div>
      {/* Debug/Stop/Run are chrome-only placeholders here - wiring them to a
          real running agent needs LOU-N's runtime control server and
          LOU-O's debug console, neither of which exist yet in this epic. */}
      <button className="btn btn-ghost" disabled title="Wired up in LOU-O (debug console)">
        Debug
      </button>
      <button className="btn btn-danger" disabled title="Wired up in LOU-N (runtime control server)">
        Stop
      </button>
      <button className="btn btn-success" disabled title="Wired up in LOU-N (runtime control server)">
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
