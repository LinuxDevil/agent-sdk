/**
 * The single write path for `meta.enabled` (L12, PLAN §9): every toggle -
 * the enable switch's manual PATCH and the failure-streak auto-disable -
 * computes its meta patch here so `disabledAt`/`disabledReason`/
 * `failureStreak` can never drift between the two writers.
 */
import type { AgentMeta } from '../../shared/wireTypes';

/**
 * The meta fields an enable/disable transition writes. `reason` is
 * `'manual'` for the switch and `'auto_failure_streak'` for the pass.
 * Re-applying the state the agent is already in is a no-op (`{}`), so a
 * manual disable never overwrites an auto-disable's reason and stamping
 * the same state twice keeps the original `disabledAt`.
 */
export function enabledPatch(
  meta: AgentMeta,
  enabled: boolean,
  reason: 'manual' | 'auto_failure_streak',
  now: string
): Partial<AgentMeta> {
  if (!enabled) {
    if (!meta.enabled) return {};
    return { enabled: false, disabledAt: now, disabledReason: reason };
  }
  if (meta.enabled) return {};
  return { enabled: true, disabledAt: null, disabledReason: null, failureStreak: 0 };
}
