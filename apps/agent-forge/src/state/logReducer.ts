import type { LogEntry } from '../runtime/runtimeClient';

/**
 * O1: client-side ring buffer cap. A real run can produce far more than the
 * mockup's static 8 log lines - this bounds memory/DOM growth instead of
 * letting `logs` grow unbounded for the lifetime of a long-running agent.
 */
export const LOG_BUFFER_CAPACITY = 2000;

/**
 * Appends `entry` to `buffer`, evicting the oldest entries once
 * `LOG_BUFFER_CAPACITY` is exceeded. Pure/reducer-shaped (no mutation of
 * `buffer`) so it's trivial to unit test and to call from a `setState`
 * updater.
 */
export function appendLog(buffer: LogEntry[], entry: LogEntry, capacity = LOG_BUFFER_CAPACITY): LogEntry[] {
  if (buffer.length < capacity) {
    return [...buffer, entry];
  }
  // Drop from the front once at capacity, then push - keeps the buffer at
  // exactly `capacity` rather than letting it grow one-then-trim-many.
  return [...buffer.slice(buffer.length - capacity + 1), entry];
}

export interface LogFilter {
  levels?: Set<LogEntry['level']>;
  phases?: Set<LogEntry['phase']>;
  /** Case-insensitive substring match against `message` (and `toolName`, if present). */
  search?: string;
}

/** Pure filter used by both the reducer's derived view and its own tests - no component-only logic. */
export function filterLogs(buffer: LogEntry[], filter: LogFilter): LogEntry[] {
  const search = filter.search?.trim().toLowerCase();
  return buffer.filter((entry) => {
    if (filter.levels && filter.levels.size > 0 && !filter.levels.has(entry.level)) return false;
    if (filter.phases && filter.phases.size > 0 && !filter.phases.has(entry.phase)) return false;
    if (search) {
      const haystack = `${entry.message} ${entry.toolName ?? ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}
