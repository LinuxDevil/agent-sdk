import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  PASS_KINDS,
  PASS_KIND_LABELS,
  type PassKind,
  type PassSettings,
  type PassSettingsPatch,
  type PassSpendSummary,
} from '../../shared/wireTypes';
import { runtimeClient } from '../runtime/runtimeClient';
import { Field } from '../ui/Field';
import { Switch } from '../ui/controls';
import { SettingRow, SettingsCard, TonePill } from './SettingsCard';
import { errorMessage } from './errorMessage';
import './passes.css';

/*
 * The Settings screen's "Background passes" card (`#/settings` only, L06b):
 * which model the passes call, which model auto-approvals use, which pass
 * kinds run, and this month's spend from `GET /settings/passes/spend`.
 * Model inputs save on blur, switches on toggle - there is no Save button -
 * and a successful save flashes a `Saved` pill for 2 s while a 400 lands
 * under its field.
 */

/** `$0.0123` - four decimals, `$0.0000` when zero (PLAN's spend format). */
function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Mount-time load: the pass settings and this month's spend summary, independently. */
function usePassesData(): {
  settings: PassSettings | undefined;
  spend: PassSpendSummary | undefined;
  spendError: boolean;
  loadError: string | undefined;
  setSettings: (settings: PassSettings) => void;
} {
  const [settings, setSettings] = useState<PassSettings | undefined>(undefined);
  const [spend, setSpend] = useState<PassSpendSummary | undefined>(undefined);
  const [spendError, setSpendError] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    runtimeClient.getPassSettings().then(
      (next) => {
        if (!cancelled) setSettings(next);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      }
    );
    runtimeClient.getPassSpend().then(
      (summary) => {
        if (!cancelled) setSpend(summary);
      },
      () => {
        if (!cancelled) setSpendError(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { settings, spend, spendError, loadError, setSettings };
}

/** Save-on-change: PUTs one patch, flashes `Saved` for 2 s, and lands a rejection under its field. */
function usePassSave(setSettings: (settings: PassSettings) => void): {
  saving: keyof PassSettings | 'enabled' | undefined;
  errors: Partial<Record<keyof PassSettings, string>>;
  saved: boolean;
  save: (patch: PassSettingsPatch) => void;
} {
  const [saving, setSaving] = useState<keyof PassSettings | 'enabled' | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<keyof PassSettings, string>>>({});
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  async function save(patch: PassSettingsPatch): Promise<void> {
    const field = (Object.keys(patch)[0] ?? 'model') as keyof PassSettings;
    setSaving(field);
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    try {
      setSettings(await runtimeClient.savePassSettings(patch));
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setErrors((prev) => ({ ...prev, [field]: errorMessage(error) }));
    } finally {
      setSaving(undefined);
    }
  }

  return { saving, errors, saved, save: (patch) => void save(patch) };
}

/** One `provider/model` text input; saves on blur when the value changed. */
function ModelInput({
  label,
  hint,
  ariaLabel,
  value,
  disabled,
  error,
  onSave,
}: {
  label: string;
  hint: string;
  ariaLabel: string;
  value: string;
  disabled: boolean;
  error: string | undefined;
  onSave: (value: string) => void;
}): JSX.Element {
  return (
    <SettingRow label={label} hint={hint}>
      <Field label={<span className="visually-hidden">{label}</span>} error={error}>
        <input
          className="input"
          aria-label={ariaLabel}
          defaultValue={value}
          key={value}
          disabled={disabled}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next !== '' && next !== value) onSave(next);
          }}
        />
      </Field>
    </SettingRow>
  );
}

/** The per-kind on/off switches, one `label.toggle-row` per `PASS_KINDS` entry. */
function KindSwitches({
  settings,
  disabled,
  onToggle,
}: {
  settings: PassSettings;
  disabled: boolean;
  onToggle: (kind: PassKind, checked: boolean) => void;
}): JSX.Element {
  return (
    <div className="passes-kinds" role="group" aria-label="Pass kinds">
      {PASS_KINDS.map((kind) => (
        <label key={kind} className="toggle-row passes-kind">
          <span>{PASS_KIND_LABELS[kind]}</span>
          <Switch
            size="sm"
            checked={settings.enabled[kind]}
            disabled={disabled}
            label={PASS_KIND_LABELS[kind]}
            onChange={(checked) => onToggle(kind, checked)}
          />
        </label>
      ))}
    </div>
  );
}

/** This month's spend: the total line plus one table row per kind that ran. */
function SpendView({ spend, error }: { spend: PassSpendSummary | undefined; error: boolean }): JSX.Element {
  if (error) {
    return (
      <div className="passes-spend">
        <p className="passes-spend-total">Couldn't load spend</p>
      </div>
    );
  }
  if (spend === undefined) return <div className="passes-spend" />;
  const rows = PASS_KINDS.map((kind) => ({ kind, ...spend.byKind[kind] })).filter(
    (row): row is { kind: PassKind; calls: number; costUsd: number } => row.calls !== undefined
  );
  return (
    <div className="passes-spend">
      <p className="passes-spend-total">
        This month: <strong className="tabular-nums">{usd(spend.totalUsd)}</strong> across {spend.calls} calls
      </p>
      {rows.length > 0 && (
        <table className="passes-spend-table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.kind}>
                <td>{PASS_KIND_LABELS[row.kind]}</td>
                <td className="tabular-nums">{row.calls}</td>
                <td className="tabular-nums">{usd(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * The "Background passes" settings card. While the settings load the
 * controls sit disabled with no pill; a successful PUT flashes `Saved`
 * in the card header for 2 s.
 */
export function PassesSection(): JSX.Element {
  const { settings, spend, spendError, loadError, setSettings } = usePassesData();
  const { saving, errors, saved, save } = usePassSave(setSettings);
  const loaded = settings !== undefined;
  return (
    <SettingsCard
      Icon={Sparkles}
      title="Background passes"
      description="Small model calls Studio makes on its own. Turn off any you don't want."
      status={saved ? <TonePill tone="ok" label="Saved" /> : undefined}
    >
      <ModelInput
        label="Model"
        hint="Used for summaries, reviews, checks and suggestions."
        ariaLabel="Pass model"
        value={settings?.model ?? ''}
        disabled={!loaded || saving === 'model'}
        error={errors.model}
        onSave={(value) => save({ model: value })}
      />
      <ModelInput
        label="Auto-approval model"
        hint="Decides tool calls marked 'Decide automatically'."
        ariaLabel="Auto-approval model"
        value={settings?.autoApprovalModel ?? ''}
        disabled={!loaded || saving === 'autoApprovalModel'}
        error={errors.autoApprovalModel}
        onSave={(value) => save({ autoApprovalModel: value })}
      />
      {loaded && (
        <KindSwitches
          settings={settings}
          disabled={saving === 'enabled'}
          onToggle={(kind, checked) => save({ enabled: { [kind]: checked } })}
        />
      )}
      <SpendView spend={spend} error={spendError} />
      {loadError !== undefined && (
        <div className="run-error" role="alert">
          {loadError}
        </div>
      )}
    </SettingsCard>
  );
}
