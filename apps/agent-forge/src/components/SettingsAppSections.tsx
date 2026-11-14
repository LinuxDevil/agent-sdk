import { useEffect, useState } from 'react';
import { Keyboard, Monitor, Moon, Palette, Sun, type LucideIcon } from 'lucide-react';
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
import { AuthorSettingsCard } from './AuthorSettingsCard';
import { SettingRow, SettingsCard } from './SettingsCard';
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

function DensityResetHint({ onReset }: { onReset: () => void }) {
  return (
    <>
      Row height for every table.{' '}
      <button type="button" className="setting-link" onClick={onReset}>
        Reset to screen defaults
      </button>
    </>
  );
}

/** Theme (Light / Dark / System) and table density, both remembered in this browser. */
export function AppearanceSection() {
  const [density, setDensityState] = useState<Density | null>(getDensity);
  const pick = (next: Density | null) => {
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
        hint={density ? <DensityResetHint onReset={() => pick(null)} /> : "Tables use each screen's default until you pick one."}
      >
        <DensityControl value={density} onChange={pick} />
      </SettingRow>
    </SettingsCard>
  );
}

/**
 * The Agent Author's model choices (author model, review model, review on/off).
 * A screen-only section: it sits under Provider keys because that is where its
 * "Add key" button sends you, and the builder drawer's Settings tab does not show it.
 */
export function AgentAuthorSection() {
  return <AuthorSettingsCard />;
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
