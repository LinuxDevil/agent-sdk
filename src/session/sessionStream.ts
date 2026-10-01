/**
 * LOU-V8: the `AgentRun` that `session.stream()` returns. A session has to
 * queue behind earlier calls and load its history before it can start a turn,
 * but a run handle must exist at once, so this wraps the run the session
 * starts when its turn comes: same events, but under its own `runId`, and
 * `run.done` is delivered only after the turn has been persisted.
 */

import { newId } from '../utils/id';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload } from '../execution/agentEvents';
import type { AgentRun } from '../execution/agentRun';

/**
 * Runs one session turn. Call `started` with the run as soon as it exists;
 * resolve with the turn's result once it is recorded (or reject).
 */
export type SessionTurn = (signal: AbortSignal, started: (run: AgentRun) => void) => Promise<ExecutionResult>;

class SessionRun implements AgentRun {
  readonly runId = newId();
  readonly result: Promise<ExecutionResult>;
  private readonly controller = new AbortController();
  private readonly started: Promise<AgentRun>;
  private iterated = false;

  constructor(turn: SessionTurn, signal: AbortSignal | undefined) {
    let onStarted!: (run: AgentRun) => void;
    let onFailed!: (error: unknown) => void;
    this.started = new Promise<AgentRun>((resolve, reject) => {
      onStarted = resolve;
      onFailed = reject;
    });
    this.started.catch(() => undefined);
    const runSignal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.result = turn(runSignal, onStarted).catch((error: unknown) => {
      onFailed(error);
      throw error;
    });
    this.result.catch(() => undefined);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iterated) {
      throw new Error(
        'AgentRun can only be iterated once. Collect the events in the first for-await loop, ' +
          'or call session.stream() again for a new run.'
      );
    }
    this.iterated = true;
    let finished = false;
    try {
      let run: AgentRun;
      try {
        run = await this.started;
      } catch (error) {
        finished = true;
        yield* this.failure(error, 0);
        return;
      }
      for await (const event of run) {
        if (event.type === 'run.done') {
          finished = true;
          try {
            await this.result;
          } catch (error) {
            // An error that failed the run itself was already reported by its events.
            if (event.finishReason !== 'error') {
              yield* this.failure(error, event.seq);
              return;
            }
          }
        }
        yield { ...event, runId: this.runId } as AgentEvent;
      }
    } finally {
      if (!finished) {
        this.controller.abort(
          new DOMException('The AgentRun was not iterated to the end (the for-await loop exited early)', 'AbortError')
        );
      }
    }
  }

  /** `error` then `run.done`, for a turn that failed outside the run's own events. */
  private *failure(error: unknown, seq: number): Generator<AgentEvent> {
    const { name, message } = error as { name?: unknown; message?: unknown };
    yield this.event(
      {
        type: 'error',
        error: {
          name: typeof name === 'string' && name ? name : 'Error',
          message: typeof message === 'string' ? message : String(error),
        },
      },
      seq
    );
    yield this.event({ type: 'run.done', finishReason: 'error', text: '' }, seq + 1);
  }

  private event(payload: AgentEventPayload, seq: number): AgentEvent {
    return { ...payload, runId: this.runId, seq, timestamp: new Date().toISOString(), v: AGENT_EVENT_SCHEMA_VERSION } as AgentEvent;
  }
}

/** Starts `turn` and returns its handle; `signal` (the caller's) and an early `break` abort the turn. */
export function streamSessionTurn(turn: SessionTurn, signal?: AbortSignal): AgentRun {
  return new SessionRun(turn, signal);
}
