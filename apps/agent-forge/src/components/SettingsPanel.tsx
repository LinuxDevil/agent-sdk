import { useEffect, useState } from 'react';
import { useAppState } from '../state/AppState';
import {
  runtimeClient,
  RuntimeApiError,
  type ProviderKeyStatus,
  type SettingsFile,
  type SettingsProfile,
  type DeployResult,
} from '../runtime/runtimeClient';

const KEYED_PROVIDERS: { id: 'openai' | 'anthropic'; label: string }[] = [
  { id: 'openai', label: 'OpenAI API key' },
  { id: 'anthropic', label: 'Anthropic API key' },
];

/**
 * LOU-R: real Settings tab content, replacing LOU-L/O's static placeholder
 * ("Provider keys and deploy target settings are wired up in LOU-R.").
 *
 * Three sections, matching `.design-ref/agent-forge-mockup.html`'s
 * `#drawerSettings` layout:
 *  - Provider keys (R1): add/replace/remove a stored key per provider, with
 *    the input always rendered blank (never pre-filled with a real key -
 *    the server only ever returns a masked status, see runtimeClient.ts's
 *    `ProviderKeyStatus`) and the current masked value shown as a hint.
 *  - Settings profile (R3): pick the active local/staging/prod profile,
 *    edit its provider type / deploy adapter / OTel toggle / hook timeout.
 *  - Deploy (R2): pick an adapter and run `loushy build` against this
 *    agent's saved spec, with a simple stdout/stderr log panel.
 */
export function SettingsPanel() {
  const { agentId, refreshActiveProfile } = useAppState();

  const [providers, setProviders] = useState<ProviderKeyStatus[]>([]);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [providerError, setProviderError] = useState<string | undefined>(undefined);

  const [settingsFile, setSettingsFile] = useState<SettingsFile | undefined>(undefined);
  const [profileDraft, setProfileDraft] = useState<SettingsProfile | undefined>(undefined);
  const [profileError, setProfileError] = useState<string | undefined>(undefined);

  const [deployAdapters, setDeployAdapters] = useState<string[]>([]);
  const [deployAdapter, setDeployAdapter] = useState<string>('node-server');
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | undefined>(undefined);

  async function loadProviders() {
    setProviders(await runtimeClient.listProviderKeys());
  }

  async function loadSettings() {
    const file = await runtimeClient.listSettingsProfiles();
    setSettingsFile(file);
    const active = file.profiles.find((p) => p.id === file.activeProfileId) ?? file.profiles[0];
    setProfileDraft(active);
    if (active) setDeployAdapter(active.deployAdapter);
  }

  useEffect(() => {
    void loadProviders();
    void loadSettings();
    runtimeClient
      .listDeployAdapters()
      .then(setDeployAdapters)
      .catch(() => setDeployAdapters(['node-server', 'cloudflare-worker', 'docker']));
  }, []);

  async function handleSaveKey(provider: 'openai' | 'anthropic') {
    setProviderError(undefined);
    const draft = keyDrafts[provider];
    if (!draft || !draft.trim()) return;
    try {
      await runtimeClient.setProviderKey(provider, draft);
      setKeyDrafts((prev) => ({ ...prev, [provider]: '' }));
      await loadProviders();
    } catch (error) {
      setProviderError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
    }
  }

  async function handleRemoveKey(provider: 'openai' | 'anthropic') {
    setProviderError(undefined);
    try {
      await runtimeClient.removeProviderKey(provider);
      await loadProviders();
    } catch (error) {
      setProviderError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
    }
  }

  async function handleSelectProfile(profileId: string) {
    if (!settingsFile) return;
    const next = settingsFile.profiles.find((p) => p.id === profileId);
    if (next) {
      setProfileDraft(next);
      setDeployAdapter(next.deployAdapter);
    }
  }

  async function handleActivateProfile() {
    if (!profileDraft) return;
    setProfileError(undefined);
    try {
      const file = await runtimeClient.activateSettingsProfile(profileDraft.id);
      setSettingsFile(file);
      await refreshActiveProfile();
    } catch (error) {
      setProfileError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
    }
  }

  async function handleSaveProfile() {
    if (!profileDraft) return;
    setProfileError(undefined);
    try {
      const file = await runtimeClient.saveSettingsProfile({ ...profileDraft, deployAdapter: deployAdapter });
      setSettingsFile(file);
      await refreshActiveProfile();
    } catch (error) {
      setProfileError(error instanceof RuntimeApiError ? error.message : (error as Error).message);
    }
  }

  async function handleDeploy() {
    setDeploying(true);
    setDeployResult(undefined);
    try {
      const result = await runtimeClient.deployAgent(agentId, deployAdapter);
      setDeployResult(result);
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div
      style={{
        fontFamily: 'var(--font-ui)',
        padding: '12px 16px',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 20,
        overflow: 'auto',
        height: '100%',
      }}
    >
      <div>
        <div className="rail-section-title" style={{ margin: '0 0 8px' }}>
          Provider keys
        </div>
        {KEYED_PROVIDERS.map(({ id, label }) => {
          const status = providers.find((p) => p.provider === id);
          return (
            <div className="field" key={id}>
              <label>{label}</label>
              <input
                className="input"
                type="password"
                placeholder={status?.hasKey ? status.masked ?? 'set' : 'not set'}
                value={keyDrafts[id] ?? ''}
                onChange={(e) => setKeyDrafts((prev) => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="hint" style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn" onClick={() => void handleSaveKey(id)} disabled={!keyDrafts[id]?.trim()}>
                  Save
                </button>
                <button className="btn btn-ghost" onClick={() => void handleRemoveKey(id)} disabled={!status?.hasKey}>
                  Remove
                </button>
                <span>{status?.hasKey ? `stored: ${status.masked}` : 'not set (runs use the mock provider)'}</span>
              </div>
            </div>
          );
        })}
        {providerError && <div className="run-error">{providerError}</div>}

        <div className="rail-section-title" style={{ margin: '16px 0 8px' }}>
          Settings profile
        </div>
        <div className="field">
          <label>Active profile</label>
          <select
            className="select"
            value={profileDraft?.id ?? ''}
            onChange={(e) => void handleSelectProfile(e.target.value)}
          >
            {(settingsFile?.profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === settingsFile?.activeProfileId ? ' (active)' : ''}
              </option>
            ))}
          </select>
        </div>
        {profileDraft && (
          <>
            <div className="field">
              <label>Provider</label>
              <select
                className="select"
                value={profileDraft.providerType}
                onChange={(e) => setProfileDraft({ ...profileDraft, providerType: e.target.value })}
              >
                <option value="mock">mock</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="ollama">ollama</option>
                <option value="openrouter">openrouter</option>
              </select>
            </div>
            <div className="field">
              <label>Hook timeout (ms)</label>
              <input
                className="input"
                type="number"
                min={100}
                value={profileDraft.hookTimeoutMs}
                onChange={(e) =>
                  setProfileDraft({ ...profileDraft, hookTimeoutMs: Number(e.target.value) || profileDraft.hookTimeoutMs })
                }
              />
            </div>
            <div className="toggle-row">
              <span>Enable OTel tracing</span>
              <div
                className={`switch${profileDraft.otelEnabled ? ' on' : ''}`}
                onClick={() => setProfileDraft({ ...profileDraft, otelEnabled: !profileDraft.otelEnabled })}
                role="switch"
                aria-checked={profileDraft.otelEnabled}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn" onClick={() => void handleSaveProfile()}>
                Save profile
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void handleActivateProfile()}
                disabled={profileDraft.id === settingsFile?.activeProfileId}
              >
                Make active
              </button>
            </div>
          </>
        )}
        {profileError && <div className="run-error">{profileError}</div>}
      </div>

      <div>
        <div className="rail-section-title" style={{ margin: '0 0 8px' }}>
          Deploy target
        </div>
        <div className="field">
          <label>Adapter</label>
          <select className="select" value={deployAdapter} onChange={(e) => setDeployAdapter(e.target.value)}>
            {deployAdapters.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-success" onClick={() => void handleDeploy()} disabled={deploying}>
          {deploying ? 'Deploying…' : 'Deploy this agent'}
        </button>
        {deployResult && (
          <div style={{ marginTop: 10 }}>
            <div className="hint">
              {deployResult.exitCode === 0 ? 'Build succeeded' : `Build failed (exit ${deployResult.exitCode})`} —{' '}
              {deployResult.command}
            </div>
            <pre
              style={{
                marginTop: 6,
                maxHeight: 220,
                overflow: 'auto',
                background: 'var(--surface-2)',
                padding: 8,
                borderRadius: 6,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
              }}
            >
              {deployResult.stdout}
              {deployResult.stderr}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
