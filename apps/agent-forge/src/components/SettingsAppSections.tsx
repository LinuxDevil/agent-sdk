import { useEffect, useState } from 'react';
import { Activity, Keyboard, Monitor, Moon, Palette, Sun, type LucideIcon } from 'lucide-react';
import { useCollectorStatus, type CollectorState } from '../shell/DaemonStatus';
import { SHORTCUTS } from '../shell/shortcuts';
import {
  THEME_EVENT,
  getDensity,
  getThemeChoice,
  setDensity,
  setThemeChoice,
  type Density,
  type ThemeChoice,
} from '../shell/theme';
import { SettingRow, SettingsCard, TonePill } from './SettingsCard';
import '../ui/filterBar.css';

/*
 * The app-level Settings sections: only the routed `#/settings` screen shows
 * them (`<SettingsPanel variant="screen" />`); the builder drawer's Settings
 * tab keeps to the agent-relevant cards.
 */

const THEMES: { id: ThemeChoice; label: string; Icon: LucideIcon }[] = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'system', label: 'System', Icon: Monitor },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'comfortable', label: 'Comfortable' },
];

/** The theme choice, kept in sync with a change made elsewhere (the palette's "Toggle theme"). */
function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  useEffect(() => {
    const sync = () => setChoice(getThemeChoice());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  return [choice, setThemeChoice];
}

function ThemeControl() {
  const [choice, choose] = useThemeChoice();
  return (
    <div className="segmented" role="group" aria-label="Theme">
      {THEMES.map(({ id, label, Icon }) => (
        <button key={id} type="button" className="seg-btn" aria-pressed={choice === id} onClick={() => choose(id)}>
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

function DensityControl({ value, onChange }: { value: Density | null; onChange: (density: Density) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Table density">
      {DENSITIES.map(({ id, label }) => (
        <button key={id} type="button" className="seg-btn" aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Theme (Light / Dark / System) and table density, both remembered in this browser. */
export function AppearanceSection() {
  const [density, setDensityState] = useState<Density | null>(getDensity);
  const pick = (next: Density) => {
    setDensity(next);
    setDensityState(next);
  };
  return (
    <SettingsCard Icon={Palette} title="Appearance" description="How the Studio looks in this browser.">
      <SettingRow label="Theme" hint="System follows your operating system.">
        <ThemeControl />
      </SettingRow>
      <SettingRow
        label="Table density"
        hint={density ? 'Row height for every table.' : "Tables use each screen's default until you pick one."}
      >
        <DensityControl value={density} onChange={pick} />
      </SettingRow>
    </SettingsCard>
  );
}

const COLLECTOR_PILLS: Record<CollectorState, { tone: 'ok' | 'error' | 'neutral'; label: string }> = {
  up: { tone: 'ok', label: 'Running' },
  down: { tone: 'error', label: 'Unreachable' },
  checking: { tone: 'neutral', label: 'Checking…' },
};

/** The observe daemon the Studio reads traces from: its status, its address, and how to start it. */
export function CollectorSection() {
  const { state, target } = useCollectorStatus();
  const pill = COLLECTOR_PILLS[state];
  return (
    <SettingsCard Icon={Activity} title="Collector" description="The observe daemon that stores traces, scores and sessions.">
      <SettingRow label="Status" hint={state === 'down' ? <>Start it with <code>lousho observe start</code>.</> : undefined}>
        <span role="status">
          <span className="visually-hidden">Collector status: </span>
          <TonePill tone={pill.tone} label={pill.label} />
        </span>
      </SettingRow>
      <SettingRow label="Address" hint="Where the Studio's /observe proxy forwards.">
        <span className="setting-mono" title={target}>
          {target ?? '—'}
        </span>
      </SettingRow>
    </SettingsCard>
  );
}

/** Every Studio shortcut, from the same list as the `?` sheet. */
export function ShortcutsSection() {
  return (
    <SettingsCard Icon={Keyboard} title="Keyboard shortcuts" description="Press ? anywhere outside a text field to see these.">
      <dl className="settings-shortcuts">
        {SHORTCUTS.map((s) => (
          <div key={s.id} className="settings-shortcut">
            <dt>{s.description}</dt>
            <dd>
              <kbd>{s.keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
}
