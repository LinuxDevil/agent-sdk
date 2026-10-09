import { useEffect, useState } from 'react';
import { useAppState } from '../state/AppState';
import { runtimeClient } from '../runtime/runtimeClient';
import type { DeployResult, ProviderKeyStatus, SettingsFile, SettingsProfile } from '../../shared/wireTypes';
import { errorMessage } from './errorMessage';

type KeyedProviderId = 'openai' | 'anthropic';

const KEYED_PROVIDERS: { id: KeyedProviderId; label: string }[] = [
  { id: 'openai', label: 'OpenAI API key' },
  { id: 'anthropic', label: 'Anthropic API key' },
];

const PROVIDER_TYPES = ['mock', 'openai', 'anthropic', 'ollama', 'openrouter'];

function useProviderKeys() {
  const [providers, setProviders] = useState<ProviderKeyStatus[]>([]);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [providerError, setProviderError] = useState<string | undefined>(undefined);

  async function loadProviders() {
    setProviders(await runtimeClient.listProviderKeys());
  }

  useEffect(() => {
    loadProviders().catch((error) => setProviderError(errorMessage(error)));
  }, []);

  function setDraft(provider: string, value: string) {
    setKeyDrafts((prev) => ({ ...prev, [provider]: value }));
  }

  async function saveKey(provider: KeyedProviderId) {
    setProviderError(undefined);
    const draft = keyDrafts[provider];
    if (!draft || !draft.trim()) return;
    try {
      await runtimeClient.setProviderKey(provider, draft);
      setDraft(provider, '');
      await loadProviders();
    } catch (error) {
      setProviderError(errorMessage(error));
    }
  }

  async function removeKey(provider: KeyedProviderId) {
    setProviderError(undefined);
    try {
      await runtimeClient.removeProviderKey(provider);
      await loadProviders();
    } catch (error) {
      setProviderError(errorMessage(error));
    }
  }

  return { providers, keyDrafts, providerError, setDraft, saveKey, removeKey };
}

function useSettingsProfiles(setDeployAdapter: (adapter: string) => void, deployAdapter: string) {
  const { refreshActiveProfile } = useAppState();
  const [settingsFile, setSettingsFile] = useState<SettingsFile | undefined>(undefined);
  const [profileDraft, setProfileDraft] = useState<SettingsProfile | undefined>(undefined);
  const [profileError, setProfileError] = useState<string | undefined>(undefined);

  async function loadSettings() {
    const file = await runtimeClient.listSettingsProfiles();
    setSettingsFile(file);
    const active = file.profiles.find((p) => p.id === file.activeProfileId) ?? file.profiles[0];
    setProfileDraft(active);
    if (active) setDeployAdapter(active.deployAdapter);
  }

  useEffect(() => {
    loadSettings().catch((error) => setProfileError(errorMessage(error)));
  }, []);

  function selectProfile(profileId: string) {
    const next = settingsFile?.profiles.find((p) => p.id === profileId);
    if (!next) return;
    setProfileDraft(next);
    setDeployAdapter(next.deployAdapter);
  }

  async function submitProfile(request: (draft: SettingsProfile) => Promise<SettingsFile>) {
    if (!profileDraft) return;
    setProfileError(undefined);
    try {
      setSettingsFile(await request(profileDraft));
      await refreshActiveProfile();
    } catch (error) {
      setProfileError(errorMessage(error));
    }
  }

  const activateProfile = () => submitProfile((draft) => runtimeClient.activateSettingsProfile(draft.id));
  const saveProfile = () =>
    submitProfile((draft) => runtimeClient.saveSettingsProfile({ ...draft, deployAdapter: deployAdapter }));

  return { settingsFile, profileDraft, profileError, setProfileDraft, selectProfile, activateProfile, saveProfile };
}

function useDeploy(deployAdapter: string) {
  const { agentId } = useAppState();
  const [deployAdapters, setDeployAdapters] = useState<string[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | undefined>(undefined);

  useEffect(() => {
    runtimeClient
      .listDeployAdapters()
      .then(setDeployAdapters)
      .catch(() => setDeployAdapters(['node-server', 'cloudflare-worker', 'docker']));
  }, []);

  async function deploy() {
    setDeploying(true);
    setDeployResult(undefined);
    try {
      const result = await runtimeClient.deployAgent(agentId, deployAdapter);
      setDeployResult(result);
    } finally {
      setDeploying(false);
    }
  }

  return { deployAdapters, deploying, deployResult, deploy };
}

interface ProviderKeyFieldProps {
  label: string;
  status: ProviderKeyStatus | undefined;
  draft: string | undefined;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
}

function keyPlaceholder(status: ProviderKeyStatus | undefined): string {
  return status?.hasKey ? status.masked ?? 'set' : 'not set';
}

function keyStatusHint(status: ProviderKeyStatus | undefined): string {
  return status?.hasKey ? `stored: ${status.masked}` : 'not set (runs use the mock provider)';
}

function ProviderKeyField({ label, status, draft, onDraftChange, onSave, onRemove }: ProviderKeyFieldProps) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        type="password"
        placeholder={keyPlaceholder(status)}
        value={draft ?? ''}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="hint" style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn" onClick={onSave} disabled={!draft?.trim()}>
          Save
        </button>
        <button className="btn btn-ghost" onClick={onRemove} disabled={!status?.hasKey}>
          Remove
        </button>
        <span>{keyStatusHint(status)}</span>
      </div>
    </div>
  );
}

function InlineError({ message }: { message: string | undefined }) {
  return message ? <div className="run-error">{message}</div> : null;
}

function ProviderKeysSection() {
  const { providers, keyDrafts, providerError, setDraft, saveKey, removeKey } = useProviderKeys();
  return (
    <>
      <div className="rail-section-title" style={{ margin: '0 0 8px' }}>
        Provider keys
      </div>
      {KEYED_PROVIDERS.map(({ id, label }) => (
        <ProviderKeyField
          key={id}
          label={label}
          status={providers.find((p) => p.provider === id)}
          draft={keyDrafts[id]}
          onDraftChange={(value) => setDraft(id, value)}
          onSave={() => void saveKey(id)}
          onRemove={() => void removeKey(id)}
        />
      ))}
      <InlineError message={providerError} />
    </>
  );
}

interface ProfileEditorProps {
  profileDraft: SettingsProfile;
  isActive: boolean;
  onChange: (profile: SettingsProfile) => void;
  onSave: () => void;
  onActivate: () => void;
}

function ProfileEditor({ profileDraft, isActive, onChange, onSave, onActivate }: ProfileEditorProps) {
  return (
    <>
      <div className="field">
        <label>Provider</label>
        <select
          className="select"
          value={profileDraft.providerType}
          onChange={(e) => onChange({ ...profileDraft, providerType: e.target.value })}
        >
          {PROVIDER_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
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
            onChange({ ...profileDraft, hookTimeoutMs: Number(e.target.value) || profileDraft.hookTimeoutMs })
          }
        />
      </div>
      <div className="toggle-row">
        <span>Enable OTel tracing</span>
        <div
          className={`switch${profileDraft.otelEnabled ? ' on' : ''}`}
          onClick={() => onChange({ ...profileDraft, otelEnabled: !profileDraft.otelEnabled })}
          role="switch"
          aria-checked={profileDraft.otelEnabled}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn" onClick={onSave}>
          Save profile
        </button>
        <button className="btn btn-primary" onClick={onActivate} disabled={isActive}>
          Make active
        </button>
      </div>
    </>
  );
}

interface ProfileSectionProps {
  profiles: ReturnType<typeof useSettingsProfiles>;
}

function profileList(file: SettingsFile | undefined): SettingsProfile[] {
  return file?.profiles ?? [];
}

interface ProfileSelectProps {
  selectedId: string | undefined;
  profiles: SettingsProfile[];
  activeProfileId: string | undefined;
  onSelect: (profileId: string) => void;
}

function ProfileSelect({ selectedId, profiles, activeProfileId, onSelect }: ProfileSelectProps) {
  return (
    <div className="field">
      <label>Active profile</label>
      <select className="select" value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.id === activeProfileId ? ' (active)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function ProfileSection({ profiles }: ProfileSectionProps) {
  const { settingsFile, profileDraft, profileError, setProfileDraft, selectProfile, activateProfile, saveProfile } =
    profiles;
  const activeProfileId = settingsFile?.activeProfileId;
  return (
    <>
      <div className="rail-section-title" style={{ margin: '16px 0 8px' }}>
        Settings profile
      </div>
      <ProfileSelect
        selectedId={profileDraft?.id}
        profiles={profileList(settingsFile)}
        activeProfileId={activeProfileId}
        onSelect={selectProfile}
      />
      {profileDraft && (
        <ProfileEditor
          profileDraft={profileDraft}
          isActive={profileDraft.id === activeProfileId}
          onChange={setProfileDraft}
          onSave={() => void saveProfile()}
          onActivate={() => void activateProfile()}
        />
      )}
      <InlineError message={profileError} />
    </>
  );
}

function DeployResultView({ result }: { result: DeployResult }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="hint">
        {result.exitCode === 0 ? 'Build succeeded' : `Build failed (exit ${result.exitCode})`} — {result.command}
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
        {result.stdout}
        {result.stderr}
      </pre>
    </div>
  );
}

interface DeploySectionProps {
  deployAdapter: string;
  onAdapterChange: (adapter: string) => void;
}

function DeploySection({ deployAdapter, onAdapterChange }: DeploySectionProps) {
  const { deployAdapters, deploying, deployResult, deploy } = useDeploy(deployAdapter);
  return (
    <div>
      <div className="rail-section-title" style={{ margin: '0 0 8px' }}>
        Deploy target
      </div>
      <div className="field">
        <label>Adapter</label>
        <select className="select" value={deployAdapter} onChange={(e) => onAdapterChange(e.target.value)}>
          {deployAdapters.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <button className="btn btn-success" onClick={() => void deploy()} disabled={deploying}>
        {deploying ? 'Deploying…' : 'Deploy this agent'}
      </button>
      {deployResult && <DeployResultView result={deployResult} />}
    </div>
  );
}

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
 *  - Deploy (R2): pick an adapter and run `lousho build` against this
 *    agent's saved spec, with a simple stdout/stderr log panel.
 */
export function SettingsPanel() {
  const [deployAdapter, setDeployAdapter] = useState<string>('node-server');
  const profiles = useSettingsProfiles(setDeployAdapter, deployAdapter);

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
        <ProviderKeysSection />
        <ProfileSection profiles={profiles} />
      </div>
      <DeploySection deployAdapter={deployAdapter} onAdapterChange={setDeployAdapter} />
    </div>
  );
}
