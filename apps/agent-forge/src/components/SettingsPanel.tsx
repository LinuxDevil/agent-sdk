import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound, Rocket, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { useAppState } from '../state/AppState';
import { runtimeClient } from '../runtime/runtimeClient';
import type { DeployResult, ProviderKeyStatus, SettingsFile, SettingsProfile } from '../../shared/wireTypes';
import { errorMessage } from './errorMessage';

type KeyedProviderId = 'openai' | 'anthropic';

/** One settings section drawn as a card: an icon, title and one-line description over its fields. */
function SettingsCard({
  Icon,
  title,
  description,
  children,
}: {
  Icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card" aria-label={title}>
      <div className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">
          <Icon size={16} strokeWidth={1.75} />
        </span>
        <span>
          <span className="settings-card-title">{title}</span>
          <span className="settings-card-desc">{description}</span>
        </span>
      </div>
      {children}
    </section>
  );
}

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
        aria-label={label}
        className="input"
        type="password"
        placeholder={keyPlaceholder(status)}
        value={draft ?? ''}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="hint settings-key-actions">
        <button className="btn btn-sm" onClick={onSave} disabled={!draft?.trim()}>
          Save
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onRemove} disabled={!status?.hasKey}>
          Remove
        </button>
        <span className="settings-key-status">{keyStatusHint(status)}</span>
      </div>
    </div>
  );
}

function InlineError({ message }: { message: string | undefined }) {
  return message ? (
    <div className="run-error" role="alert">
      {message}
    </div>
  ) : null;
}

function ProviderKeysSection() {
  const { providers, keyDrafts, providerError, setDraft, saveKey, removeKey } = useProviderKeys();
  return (
    <SettingsCard Icon={KeyRound} title="Provider keys" description="Stored on this machine; never shown in full.">
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
    </SettingsCard>
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
          aria-label="Provider"
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
          aria-label="Hook timeout (ms)"
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
        <button
          type="button"
          className={`switch${profileDraft.otelEnabled ? ' on' : ''}`}
          onClick={() => onChange({ ...profileDraft, otelEnabled: !profileDraft.otelEnabled })}
          role="switch"
          aria-checked={profileDraft.otelEnabled}
          aria-label="Enable OTel tracing"
        />
      </div>
      <div className="settings-actions">
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
      <select className="select" aria-label="Active profile" value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value)}>
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
    <SettingsCard
      Icon={SlidersHorizontal}
      title="Settings profile"
      description="The environment runs use: provider, hook timeout and tracing."
    >
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
    </SettingsCard>
  );
}

function DeployResultView({ result }: { result: DeployResult }) {
  return (
    <div className="deploy-result">
      <div className="hint">
        {result.exitCode === 0 ? 'Build succeeded' : `Build failed (exit ${result.exitCode})`} — {result.command}
      </div>
      <pre className="deploy-log">
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
    <SettingsCard Icon={Rocket} title="Deploy target" description="Build this agent's saved spec with a deploy adapter.">
      <div className="field">
        <label>Adapter</label>
        <select className="select" aria-label="Deploy adapter" value={deployAdapter} onChange={(e) => onAdapterChange(e.target.value)}>
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
    </SettingsCard>
  );
}

/**
 * Real Settings tab content, replacing the static placeholder
 * ("Provider keys and deploy target settings are wired up later.").
 *
 * Three sections:
 *  - Provider keys: add/replace/remove a stored key per provider, with
 *    the input always rendered blank (never pre-filled with a real key -
 *    the server only ever returns a masked status, see runtimeClient.ts's
 *    `ProviderKeyStatus`) and the current masked value shown as a hint.
 *  - Settings profile: pick the active local/staging/prod profile,
 *    edit its provider type / deploy adapter / OTel toggle / hook timeout.
 *  - Deploy (R2): pick an adapter and run `lousho build` against this
 *    agent's saved spec, with a simple stdout/stderr log panel.
 */
export function SettingsPanel() {
  const [deployAdapter, setDeployAdapter] = useState<string>('node-server');
  const profiles = useSettingsProfiles(setDeployAdapter, deployAdapter);

  return (
    <div className="settings-panel">
      <ProviderKeysSection />
      <ProfileSection profiles={profiles} />
      <DeploySection deployAdapter={deployAdapter} onAdapterChange={setDeployAdapter} />
    </div>
  );
}
