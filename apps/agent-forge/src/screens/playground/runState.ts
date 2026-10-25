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

/** Everything the output panel shows. */
export interface RunState {
  status: RunStatus;
  text: string;
  toolCalls: RunToolCall[];
  finishReason?: string;
  traceId?: string;
  error?: string;
}

export const IDLE_RUN: RunState = { status: 'idle', text: '', toolCalls: [] };
export const STARTED_RUN: RunState = { status: 'running', text: '', toolCalls: [] };

/** `state` after `event`; events after the terminal one are ignored. */
export function applyRunEvent(state: RunState, event: PlaygroundEvent): RunState {
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
      };
    case 'error':
      return { ...state, status: 'error', error: event.code ? `${event.message} (${event.code})` : event.message };
    default:
      return state;
  }
}
