import { useEffect, useState } from 'react';
import type { AgentRunStatusPayload } from '../../../shared/wireTypes';

/** `m:ss` - minutes unpadded, seconds always two digits (`1:05`, `0:59`, `12:00`). */
function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * How long the current run has been going, as `m:ss`, measured from the
 * status' `updatedAt` (the server's last write for this run) - `undefined`
 * while no run is in flight, so an idle bar shows no ticking clock. While
 * running a one-second interval re-renders the bar; it is cleared on stop,
 * on a new `updatedAt`, and on unmount.
 *
 * `now` is injectable for tests; production callers take `Date.now`.
 */
export function useRunElapsed(
  runStatus: AgentRunStatusPayload | undefined,
  now: () => number = Date.now,
): string | undefined {
  const running = runStatus?.status === 'running';
  const startedAt = running ? runStatus?.updatedAt : undefined;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (startedAt === undefined) return;
    const id = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === undefined) return undefined;
  const elapsedMs = now() - Date.parse(startedAt);
  if (Number.isNaN(elapsedMs)) return undefined;
  return formatElapsed(elapsedMs / 1000);
}
