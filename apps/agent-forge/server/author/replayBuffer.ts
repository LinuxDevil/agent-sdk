/**
 * The reattach ring buffer (PLAN 8.1): one entry per session holding the
 * last turn's `AuthorServerEvent`s in emission order, so a client that
 * lost its socket mid-turn can send `chat.resume` and get exactly the
 * events it missed (`seq` is per turn, so `afterSeq` is the cursor).
 *
 * A settled turn is never replayed: its entry answers `settled` with only
 * the terminal `turn.finished`/`turn.error` event (replaying deltas could
 * resurrect a proposal card that was saved after the turn ended - the
 * client reconciles from the stored transcript instead). Settled entries
 * linger for `REPLAY_SETTLED_TTL_MS` so a client that dropped just before
 * the last event can still learn the turn ended, then they are evicted
 * lazily on the next `record`/`resume`.
 */
import type { AuthorServerEvent } from '../../shared/authorWire';

/** The most events one turn's entry keeps; overflow evicts `text.delta`s first. */
export const REPLAY_CAPACITY = 4000;

/** How long a settled turn's terminal event stays answerable after the turn ended. */
export const REPLAY_SETTLED_TTL_MS = 120_000;

/** What `resume` says the reconnecting socket should be sent. */
export type ResumeAnswer =
  /** The turn still runs: every buffered event with `seq > afterSeq` (live events follow on the same socket). */
  | { kind: 'replay'; events: AuthorServerEvent[] }
  /** The turn ended: only its `turn.finished`/`turn.error` - the deltas are deliberately withheld. */
  | { kind: 'settled'; final: AuthorServerEvent }
  /** No such turn: unknown requestId, another turn owns the session now, or the entry expired. */
  | { kind: 'unknown' };

/** One session's replay state: the running (or just-settled) turn's events. */
interface ReplayEntry {
  requestId: string;
  events: AuthorServerEvent[];
  settled: boolean;
  /** `now()` at the terminal event (the TTL counts from here). */
  settledAt: number;
  /** Overflow evicted old `text.delta`s: the replayed tail is incomplete, so the client reconciles at the terminal event. */
  truncated: boolean;
}

function isTerminal(event: AuthorServerEvent): boolean {
  return event.type === 'turn.finished' || event.type === 'turn.error';
}

/**
 * Records every event `AuthorTurnRunner` emits (`authorStream.ts` feeds it
 * on the runner's `'event'` channel, one buffer per server) and answers
 * `chat.resume` from it. `deps.now` is the clock seam for tests.
 */
export class ReplayBuffer {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly now: () => number;

  constructor(deps?: { now?: () => number }) {
    this.now = deps?.now ?? (() => Date.now());
  }

  /**
   * Adds `event` to the session's entry. `turn.started` always begins a
   * fresh entry (one running turn per session, so the previous entry -
   * running or settled - is dead the moment a new turn starts); any later
   * event is appended only while it names the entry's own `requestId`.
   * The terminal event flips the entry to settled and starts its TTL.
   */
  record(sessionId: string, event: AuthorServerEvent): void {
    this.evictExpired();
    let entry = this.entries.get(sessionId);
    if (event.type === 'turn.started') {
      entry = { requestId: event.requestId, events: [], settled: false, settledAt: 0, truncated: false };
      this.entries.set(sessionId, entry);
    }
    if (entry === undefined || entry.requestId !== event.requestId) return;
    entry.events.push(event);
    if (isTerminal(event)) {
      entry.settled = true;
      entry.settledAt = this.now();
    }
    this.enforceCapacity(entry);
  }

  /**
   * What a `chat.resume { requestId, afterSeq }` gets back for `sessionId`:
   * the buffered tail of a running turn, the terminal event of a settled
   * one, or `unknown` when the buffer holds no entry for that request.
   */
  resume(sessionId: string, requestId: string, afterSeq: number): ResumeAnswer {
    this.evictExpired();
    const entry = this.entries.get(sessionId);
    if (entry === undefined || entry.requestId !== requestId) return { kind: 'unknown' };
    if (entry.settled) {
      const final = entry.events.at(-1);
      // A settled entry always holds its terminal event (the last push);
      // `undefined` is only reachable through pathological truncation.
      return final === undefined ? { kind: 'unknown' } : { kind: 'settled', final };
    }
    return { kind: 'replay', events: entry.events.filter((event) => event.seq > afterSeq) };
  }

  /** Lazily deletes settled entries past the TTL (called from `record`/`resume`, not a timer). */
  private evictExpired(): void {
    const now = this.now();
    for (const [sessionId, entry] of this.entries) {
      if (entry.settled && now - entry.settledAt > REPLAY_SETTLED_TTL_MS) {
        this.entries.delete(sessionId);
      }
    }
  }

  /**
   * Caps the entry at `REPLAY_CAPACITY`: evict the oldest `text.delta`
   * first (deltas are re-renderable text - losing some leaves a gap the
   * client repairs on reconcile), and only when no delta remains evict
   * the oldest event at all, so every `tool.*` and the terminal event
   * survive any realistic turn. `truncated` marks that the replay tail
   * has a hole.
   */
  private enforceCapacity(entry: ReplayEntry): void {
    while (entry.events.length > REPLAY_CAPACITY) {
      const deltaIndex = entry.events.findIndex((event) => event.type === 'text.delta');
      if (deltaIndex === -1) {
        entry.events.shift();
      } else {
        entry.events.splice(deltaIndex, 1);
      }
      entry.truncated = true;
    }
  }
}
