import type { ReactNode } from 'react';
import './primitives.css';

/**
 * Props for {@link EmptyState}. A title alone is not allowed: an empty screen
 * must say what to do next, through a `hint`, an `action`, or both.
 */
export type EmptyStateProps = { title: string; icon?: ReactNode } & (
  | { hint: ReactNode; action?: ReactNode }
  | { hint?: ReactNode; action: ReactNode }
);

/** The shared "nothing here yet" block: an optional decorative icon, a title, then a hint and/or an action. */
export function EmptyState({ title, hint, action, icon }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon != null && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="empty-state-title">{title}</p>
      {hint != null && <p className="empty-state-hint">{hint}</p>}
      {action != null && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
