import { useEffect, useState } from 'react';

/**
 * What a pause card's deadline line shows: the remaining time as
 * '4m 12s', `urgent` once under a minute is left (the line turns
 * `--warning`), `expired` once the deadline passed - the card stays up
 * until the server's status push replaces it, so '0s' is a real state.
 */
export interface DeadlineState {
  /** '4m 12s', or '0s' once the deadline passed; recomputed each second. */
  remaining: string;
  /** True once under a minute is left. */
  urgent: boolean;
  /** True once the deadline passed. */
  expired: boolean;
}

/** ms-left floored to whole seconds as '4m 12s' ('42s' under a minute). */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Ticks `deadline` (an ISO string on the status payload) down to the
 * second, computed from the client's own `Date.now()` - no server clock
 * sync; a second of drift is inside the countdown's noise. Pure display:
 * the server still owns resolution.
 */
export function useDeadline(deadline: string | undefined): DeadlineState {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Re-anchor on a new deadline so a card shows the right text before
    // the first tick, then keep a one-second heartbeat.
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [deadline]);
  const msLeft = deadline === undefined ? NaN : Date.parse(deadline) - now;
  const expired = Number.isNaN(msLeft) || msLeft <= 0;
  return {
    remaining: formatRemaining(msLeft),
    urgent: !expired && msLeft < 60_000,
    expired,
  };
}
