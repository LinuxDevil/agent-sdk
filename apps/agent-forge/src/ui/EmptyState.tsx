import { Inbox, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import './primitives.css';

/**
 * Props for {@link EmptyState}. A title alone is not allowed: an empty screen
 * must say what to do next, through a `hint`, an `action`, or both. `icon` is
 * a lucide component (`icon={Search}`) drawn in a 40px tile; it defaults to
 * `Inbox`, and `null` drops the tile.
 */
export type EmptyStateProps = { title: string; icon?: LucideIcon | null } & (
  | { hint: ReactNode; action?: ReactNode }
  | { hint?: ReactNode; action: ReactNode }
);

/** The shared "nothing here yet" block: a decorative icon tile, a title, then a hint and/or an action. */
export function EmptyState({ title, hint, action, icon: Icon = Inbox }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Icon && (
        <span className="empty-state-icon" aria-hidden="true">
          <Icon size={20} strokeWidth={1.75} />
        </span>
      )}
      <p className="empty-state-title">{title}</p>
      {hint != null && <p className="empty-state-hint">{hint}</p>}
      {action != null && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
