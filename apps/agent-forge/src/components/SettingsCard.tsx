import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import '../ui/primitives.css';

/** One settings section drawn as a card: an icon, title and one-line description over its fields. */
export function SettingsCard({
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

/**
 * A label-left / control-right row inside a settings card: the setting's name
 * and a muted hint on the left, its control on the right. Wraps to a stack
 * when the card is narrow.
 */
export function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-label">{label}</span>
        {hint != null && <span className="setting-row-hint">{hint}</span>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

/** A sentence-case status pill in one of the kit's tones (the `.status-pill` look from ui/primitives.css). */
export function TonePill({ tone, label, title }: { tone: 'ok' | 'error' | 'info' | 'neutral'; label: string; title?: string }) {
  return (
    <span className={`status-pill pill-${tone}`} title={title}>
      <span className="dot" aria-hidden="true" />
      <span className="status-pill-label">{label}</span>
    </span>
  );
}
