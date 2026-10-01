import type { LogEntry } from '../../shared/wireTypes';

/**
 * O1: client-side ring buffer cap. A real run can produce far more than the
 * mockup's static 8 log lines - this bounds memory/DOM growth instead of
 * letting `logs` grow unbounded for the lifetime of a long-running agent.
 */
const LOG_BUFFER_CAPACITY = 2000;

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

/** An empty/absent set means "no restriction" for that dimension. */
function passesSet<T>(set: Set<T> | undefined, value: T): boolean {
  return !set || set.size === 0 || set.has(value);
}

function matchesSearch(entry: LogEntry, search: string | undefined): boolean {
  if (!search) return true;
  return `${entry.message} ${entry.toolName ?? ''}`.toLowerCase().includes(search);
}

/** Pure filter used by both the reducer's derived view and its own tests - no component-only logic. */
export function filterLogs(buffer: LogEntry[], filter: LogFilter): LogEntry[] {
  const search = filter.search?.trim().toLowerCase();
  return buffer.filter(
    (entry) => passesSet(filter.levels, entry.level) && passesSet(filter.phases, entry.phase) && matchesSearch(entry, search)
  );
}
