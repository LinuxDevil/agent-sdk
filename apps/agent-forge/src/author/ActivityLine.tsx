import { Check, CircleAlert, Loader2 } from 'lucide-react';
import type { AuthorToolPart } from '../../shared/authorWire';
import { activityLabelFor, activityStateOf, type ActivityState } from './activityLabels';

const ICONS: Record<ActivityState, typeof Check> = {
  busy: Loader2,
  done: Check,
  failed: CircleAlert,
};

/**
 * The quiet one-line row a tool call gets when no card claims it (Wakeel's
 * "Activity" line): a spinning loader while busy, a check when done, an
 * alert when it failed - with copy like "Reading the agent…". Anything
 * richer (proposal, secret, success cards) comes from the AA16/AA17
 * renderers, not this row.
 */
export function ActivityLine({ part }: { part: AuthorToolPart }): JSX.Element {
  const state = activityStateOf(part);
  const Icon = ICONS[state];
  const label = activityLabelFor(part.name, state);
  return (
    <div className="author-activity" data-state={state}>
      <Icon className="author-activity-icon" size={14} strokeWidth={1.75} aria-hidden="true" />
      <span>{state === 'busy' ? `${label}…` : label}</span>
    </div>
  );
}
