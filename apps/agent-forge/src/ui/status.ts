import {
  BadgeCheck,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Hourglass,
  LoaderCircle,
  Power,
  PowerOff,
  type LucideIcon,
} from 'lucide-react';

/**
 * The closed set of statuses the new Studio design system draws: run states
 * (queued through timed_out), agent enablement, publish state, and `unknown`
 * for anything unrecognised. Raw status words are folded onto these keys by
 * {@link statusKey}; each key's look lives in {@link STATUS_CONFIG} so agent
 * cards, run rows, tool rows and the detail header always agree.
 */
export type StatusKey =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'error'
  | 'stopped'
  | 'timed_out'
  | 'enabled'
  | 'disabled'
  | 'draft'
  | 'published'
  | 'unknown';

/** The colour families a status can take, each one a `.status-tone-<name>` class in status.css. */
export type StatusToneName = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'violet' | 'accent';

/** One status's presentation: its label, colour tone and icon, plus the motion its live states carry. */
export interface StatusConfig {
  label: string;
  tone: StatusToneName;
  icon: LucideIcon;
  /** The dot pulses while this status is live (honours prefers-reduced-motion). */
  pulse?: boolean;
  /** The badge icon spins while this status is live (honours prefers-reduced-motion). */
  spin?: boolean;
}

/**
 * The single status table for the Studio: every {@link StatusKey}'s label, tone,
 * icon and motion, consumed by `StatusDot`, `StatusBadge` and tone classes for
 * coloured left edges.
 */
export const STATUS_CONFIG: Record<StatusKey, StatusConfig> = {
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  running: { label: 'Running', tone: 'info', icon: LoaderCircle, pulse: true, spin: true },
  waiting: { label: 'Waiting on you', tone: 'warning', icon: Hourglass },
  done: { label: 'Done', tone: 'success', icon: CircleCheck },
  error: { label: 'Failed', tone: 'danger', icon: CircleX },
  stopped: { label: 'Stopped', tone: 'neutral', icon: Ban },
  timed_out: { label: 'Timed out', tone: 'warning', icon: Clock },
  enabled: { label: 'Enabled', tone: 'success', icon: Power },
  disabled: { label: 'Disabled', tone: 'neutral', icon: PowerOff },
  draft: { label: 'Draft', tone: 'neutral', icon: CircleDashed },
  published: { label: 'Published', tone: 'accent', icon: BadgeCheck },
  unknown: { label: 'Unknown', tone: 'neutral', icon: CircleDashed },
};

const KEY_BY_RAW = new Map<string, StatusKey>([
  ['queued', 'queued'],
  ['running', 'running'],
  ['paused', 'waiting'],
  ['awaiting_approval', 'waiting'],
  ['waiting', 'waiting'],
  ['blocked', 'waiting'],
  ['done', 'done'],
  ['ok', 'done'],
  ['completed', 'done'],
  ['pass', 'done'],
  ['success', 'done'],
  ['error', 'error'],
  ['failed', 'error'],
  ['fail', 'error'],
  ['stopped', 'stopped'],
  ['aborted', 'stopped'],
  ['cancelled', 'stopped'],
  ['interrupted', 'stopped'],
  ['timed_out', 'timed_out'],
  ['timeout', 'timed_out'],
  ['expired', 'timed_out'],
  ['enabled', 'enabled'],
  ['disabled', 'disabled'],
  ['draft', 'draft'],
  ['published', 'published'],
]);

/**
 * Maps the Studio's raw status words onto a {@link StatusKey}: `queued`→queued;
 * `running`→running; `paused`|`awaiting_approval`|`waiting`|`blocked`→waiting;
 * `done`|`ok`|`completed`|`pass`|`success`→done; `error`|`failed`|`fail`→error;
 * `stopped`|`aborted`|`cancelled`|`interrupted`→stopped;
 * `timed_out`|`timeout`|`expired`→timed_out; `enabled`|`disabled`|`draft`|`published`→themselves;
 * `idle`, null, undefined and anything else→unknown. A `Map` lookup keeps
 * `Object.prototype` words like `'constructor'` on `unknown`.
 */
export function statusKey(raw: string | null | undefined): StatusKey {
  return (raw != null && KEY_BY_RAW.get(raw)) || 'unknown';
}

/** `status-tone-<tone>` for a key (used for left edges and custom chips). */
export function statusToneClass(key: StatusKey): string {
  return `status-tone-${STATUS_CONFIG[key].tone}`;
}
