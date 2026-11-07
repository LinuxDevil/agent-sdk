import './status.css';

import { STATUS_CONFIG, statusToneClass, type StatusKey } from './status';

/**
 * Props for {@link StatusDot}. Without `title` the dot is decorative
 * (`aria-hidden`); with one it is a named `role="img"` so a toolbar that shows
 * only dots still announces the status.
 */
export interface StatusDotProps {
  status: StatusKey;
  /** A 3px tint ring around the dot - the "enabled" look. */
  halo?: boolean;
  /** When set the dot is `role="img"` with this as its `aria-label`; otherwise it is `aria-hidden`. */
  title?: string;
}

/**
 * The 6px status dot: one colour per {@link StatusKey}, a halo for emphasis and
 * a pulse for live states, all from {@link STATUS_CONFIG}.
 */
export function StatusDot({ status, halo = false, title }: StatusDotProps): JSX.Element {
  const config = STATUS_CONFIG[status];
  const className = [
    'status-dot',
    statusToneClass(status),
    halo ? 'status-dot-halo' : '',
    config.pulse ? 'status-dot-pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return title == null ? (
    <span className={className} aria-hidden="true" />
  ) : (
    <span className={className} role="img" aria-label={title} />
  );
}

/** Props for {@link StatusBadge}. */
export interface StatusBadgeProps {
  status: StatusKey;
  /** Overrides `STATUS_CONFIG[status].label` (e.g. "Published v3"). */
  label?: string;
  /** Whether to draw the status icon; default true. */
  icon?: boolean;
  /** 18px (`sm`) or 20px (`md`, the default) tall. */
  size?: 'sm' | 'md';
  /** Tooltip for when the badge's short label needs more explanation. */
  title?: string;
}

/**
 * The status badge: a bordered pill showing {@link STATUS_CONFIG}'s icon and
 * label for a {@link StatusKey}, in the same tone the matching `StatusDot`
 * draws, so every surface agrees on a status's look.
 */
export function StatusBadge({ status, label, icon = true, size = 'md', title }: StatusBadgeProps): JSX.Element {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <span
      className={['status-badge', statusToneClass(status), size === 'sm' ? 'status-badge-sm' : '']
        .filter(Boolean)
        .join(' ')}
      title={title}
    >
      {icon && (
        <Icon
          size={12}
          strokeWidth={1.75}
          className={`status-badge-icon${config.spin ? ' status-badge-spin' : ''}`}
          aria-hidden="true"
        />
      )}
      <span className="status-badge-label">{label ?? config.label}</span>
    </span>
  );
}
