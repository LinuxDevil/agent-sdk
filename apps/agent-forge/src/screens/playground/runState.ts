/** The Playground's run state and how each streamed event moves it (pure, so the hook stays small). */
import type { PlaygroundEvent } from './types';

/** A status word for the one `StatusPill` (`paused` reads "awaiting approval"). */
export type RunStatus = 'idle' | 'running' | 'done' | 'paused' | 'error' | 'stopped';

/** One tool call the model made during the run. */
export interface RunToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The token usage a `done` event reports. */
export type RunUsage = NonNullable<Extract<PlaygroundEvent, { type: 'done' }>['usage']>;

/** Everything the output panel shows. */
export interface RunState {
  status: RunStatus;
  text: string;
  toolCalls: RunToolCall[];
  finishReason?: string;
  traceId?: string;
  error?: string;
  usage?: RunUsage;
  /** `Date.now()` when the run started; set by `useRun`. */
  startedAt?: number;
  /** Start to the terminal event, when `startedAt` is known. */
  durationMs?: number;
}

export const IDLE_RUN: RunState = { status: 'idle', text: '', toolCalls: [] };
export const STARTED_RUN: RunState = { status: 'running', text: '', toolCalls: [] };

/** `{ durationMs }` from `startedAt` to `now`, or nothing when the start is unknown. */
const timed = (state: RunState, now: number) => (state.startedAt === undefined ? {} : { durationMs: now - state.startedAt });

/** `state` after `event` (arriving at `now`); events after the terminal one are ignored. */
export function applyRunEvent(state: RunState, event: PlaygroundEvent, now = Date.now()): RunState {
  if (state.status !== 'running') return state;
  switch (event.type) {
    case 'delta':
      return { ...state, text: state.text + event.text };
    case 'tool_call':
      return { ...state, toolCalls: [...state.toolCalls, { id: event.id, name: event.name, args: event.args }] };
    case 'done':
      return {
        ...state,
        status: event.finishReason === 'awaiting-approval' ? 'paused' : 'done',
        text: event.text || state.text,
        finishReason: event.finishReason,
        ...(event.traceId ? { traceId: event.traceId } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
        ...timed(state, now),
      };
    case 'error':
      return {
        ...state,
        status: 'error',
        error: event.code ? `${event.message} (${event.code})` : event.message,
        ...timed(state, now),
      };
    default:
      return state;
  }
}
