import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { runtimeClient } from '../runtime/runtimeClient';
import type { CatalogModel } from '../../shared/wireTypes';
import type { AuthorSettings, AuthorSettingsPayload } from '../../shared/authorWire';
import { Field } from '../ui/Field';
import { Select, Switch, type SelectOption } from '../ui/controls';
import { SettingRow, SettingsCard, TonePill } from './SettingsCard';
import { errorMessage } from './errorMessage';

/*
 * The Settings screen's "Agent Author" card (`#/settings` only): which
 * model drafts agents in the Author chat, which model reviews each draft,
 * and whether that review runs at all. Each control saves straight to
 * `PUT /settings/author` on change - there is no Save button - and the
 * header pill reports `ready` (the configured model's provider has a key),
 * pointing at the Provider keys card when it does not.
 */

/** The "Add key" button scrolls to the Provider keys card on the same screen. */
function scrollToProviderKeys(): void {
  document.getElementById('settings-provider-keys')?.scrollIntoView();
}

/**
 * The tool-capable catalog entries as select options: a model whose
 * provider has no key stays listed but disabled with a " (no key)" suffix.
 * `current` is always an option, so the select still shows the configured
 * model when the catalog request failed or lacks it.
 */
function modelOptions(models: readonly CatalogModel[], current: string): SelectOption[] {
  const options = models
    .filter((m) => m.capabilities.tools)
    .map((m) => ({ value: m.id, label: m.available ? m.id : `${m.id} (no key)`, disabled: !m.available }));
  if (current !== '' && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: current, disabled: false });
  }
  return options;
}

/** Header status: `Ready` when the configured Author model can run, else `Needs a key` plus the scroll-to-keys button. */
function ReadyPill({ settings }: { settings: AuthorSettingsPayload }): JSX.Element {
  if (settings.ready) return <TonePill tone="ok" label="Ready" />;
  const provider = settings.missingKeyFor ?? settings.model.split('/')[0];
  return (
    <>
      <TonePill tone="error" label="Needs a key" title={`Add a ${provider} key in Provider keys.`} />
      <button type="button" className="setting-link" onClick={scrollToProviderKeys}>
        Add key
      </button>
    </>
  );
}

interface ModelRowProps {
  label: string;
  hint: string;
  options: SelectOption[];
  value: string;
  disabled: boolean;
  error: string | undefined;
  onChange: (value: string) => void;
}

/** One model picker row; the Field carries the PUT error under the select and names it for assistive tech. */
function ModelRow({ label, hint, options, value, disabled, error, onChange }: ModelRowProps): JSX.Element {
  return (
    <SettingRow label={label} hint={hint}>
      <Field label={<span className="visually-hidden">{label}</span>} error={error}>
        <Select
          options={options}
          placeholder={value === '' ? 'Loading…' : undefined}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    </SettingRow>
  );
}

interface ReviewToggleRowProps {
  checked: boolean;
  disabled: boolean;
  error: string | undefined;
  onChange: (checked: boolean) => void;
}

/** The "Review drafts" row: a Switch bound to `reviewEnabled`, same error treatment as the model rows. */
function ReviewToggleRow({ checked, disabled, error, onChange }: ReviewToggleRowProps): JSX.Element {
  return (
    <SettingRow label="Review drafts" hint="Turn off to see drafts without the extra check.">
      <Field label={<span className="visually-hidden">Review drafts</span>} error={error}>
        <Switch checked={checked} disabled={disabled} onChange={onChange} />
      </Field>
    </SettingRow>
  );
}

/**
 * Mount-time load: `GET /settings/author` and the model catalog in
 * parallel. A settings failure surfaces as `loadError`; a catalog failure
 * leaves `models` empty, so each select falls back to its current value.
 */
function useAuthorSettingsData(): {
  settings: AuthorSettingsPayload | undefined;
  models: CatalogModel[];
  loadError: string | undefined;
  setSettings: (settings: AuthorSettingsPayload) => void;
} {
  const [settings, setSettings] = useState<AuthorSettingsPayload | undefined>(undefined);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const onSettings = (next: AuthorSettingsPayload) => {
      if (!cancelled) setSettings(next);
    };
    const onSettingsError = (error: unknown) => {
      if (!cancelled) setLoadError(errorMessage(error));
    };
    const onModels = (catalog: CatalogModel[]) => {
      if (!cancelled) setModels(catalog);
    };
    runtimeClient.getAuthorSettings().then(onSettings, onSettingsError);
    runtimeClient.catalogModels().then(onModels, () => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return { settings, models, loadError, setSettings };
}

/**
 * Save-on-change: `save` PUTs one field, marks it in flight while the
 * request runs (the control disables itself), adopts the response as the
 * new state, and on a rejection restores the previous value and records
 * the server's error under that row.
 */
function useAuthorSave(setSettings: (settings: AuthorSettingsPayload) => void): {
  saving: keyof AuthorSettings | undefined;
  errors: Partial<Record<keyof AuthorSettings, string>>;
  save: (patch: Partial<AuthorSettings>) => void;
} {
  const [saving, setSaving] = useState<keyof AuthorSettings | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<keyof AuthorSettings, string>>>({});

  async function save(patch: Partial<AuthorSettings>): Promise<void> {
    const field = Object.keys(patch)[0] as keyof AuthorSettings;
    setSaving(field);
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    try {
      setSettings(await runtimeClient.saveAuthorSettings(patch));
    } catch (error) {
      setErrors((prev) => ({ ...prev, [field]: errorMessage(error) }));
    } finally {
      setSaving(undefined);
    }
  }

  return { saving, errors, save: (patch) => void save(patch) };
}

/**
 * The "Agent Author" settings card. While the settings load the controls
 * sit disabled with no pill; the Ready/Needs-a-key pill mirrors `ready`,
 * and the rows update from each PUT's response (`ready` is recomputed
 * server-side, so a model swap can flip the pill).
 */
export function AuthorSettingsCard(): JSX.Element {
  const { settings, models, loadError, setSettings } = useAuthorSettingsData();
  const { saving, errors, save } = useAuthorSave(setSettings);
  const loaded = settings !== undefined;
  return (
    <SettingsCard
      Icon={Sparkles}
      title="Agent Author"
      description="The models that draft your agents and review each draft."
      status={settings !== undefined ? <ReadyPill settings={settings} /> : undefined}
    >
      <ModelRow
        label="Author model"
        hint="Writes proposals in the Author chat."
        options={modelOptions(models, settings?.model ?? '')}
        value={settings?.model ?? ''}
        disabled={!loaded || saving === 'model'}
        error={errors.model}
        onChange={(value) => save({ model: value })}
      />
      <ModelRow
        label="Review model"
        hint="Checks each draft before you see it. A small, fast model is enough."
        options={modelOptions(models, settings?.reviewModel ?? '')}
        value={settings?.reviewModel ?? ''}
        disabled={!loaded || saving === 'reviewModel'}
        error={errors.reviewModel}
        onChange={(value) => save({ reviewModel: value })}
      />
      <ReviewToggleRow
        checked={settings?.reviewEnabled ?? false}
        disabled={!loaded || saving === 'reviewEnabled'}
        error={errors.reviewEnabled}
        onChange={(checked) => save({ reviewEnabled: checked })}
      />
      {loadError !== undefined && (
        <div className="run-error" role="alert">
          {loadError}
        </div>
      )}
    </SettingsCard>
  );
}
