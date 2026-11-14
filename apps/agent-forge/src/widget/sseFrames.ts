/**
 * Incremental SSE frame parser for the `<forge-chat>` widget (X04a).
 *
 * The widget is dependency-free and runs outside Studio, so it cannot
 * import the SDK's `parseEventStream`; this is the same contract in
 * miniature: feed decoded text chunks, get complete frames back. Frames
 * are separated by a blank line; `event:` and `data:` lines carry the
 * payload (multi-line `data:` joins with `'\n'`), `:` lines are comments,
 * and a missing `event:` defaults to `'message'`.
 */

export interface SseFrame {
  event: string;
  data: string;
}

export interface SseParser {
  /** Feed a decoded text chunk; returns the frames it completed. */
  push(chunk: string): SseFrame[];
  /** Flush a trailing frame the stream ended without a blank line after. */
  flush(): SseFrame[];
}

interface FrameState {
  event: string;
  dataLines: string[];
  hasFields: boolean;
}

function freshState(): FrameState {
  return { event: 'message', dataLines: [], hasFields: false };
}

function consumeLine(state: FrameState, line: string): SseFrame | undefined {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed === '') {
    if (!state.hasFields) return undefined;
    const frame: SseFrame = { event: state.event, data: state.dataLines.join('\n') };
    Object.assign(state, freshState());
    return frame;
  }
  if (trimmed.startsWith(':')) return undefined;
  const colon = trimmed.indexOf(':');
  const field = colon === -1 ? trimmed : trimmed.slice(0, colon);
  let value = colon === -1 ? '' : trimmed.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  if (field === 'event') {
    state.hasFields = true;
    state.event = value;
  } else if (field === 'data') {
    state.hasFields = true;
    state.dataLines.push(value);
  }
  return undefined;
}

function dispatch(state: FrameState): SseFrame | undefined {
  if (!state.hasFields) return undefined;
  const frame: SseFrame = { event: state.event, data: state.dataLines.join('\n') };
  Object.assign(state, freshState());
  return frame;
}

export function createSseParser(): SseParser {
  let buffer = '';
  const state = freshState();

  const drainLines = (final: boolean): SseFrame[] => {
    const frames: SseFrame[] = [];
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const frame = consumeLine(state, line);
      if (frame !== undefined) frames.push(frame);
    }
    if (final && buffer !== '') {
      const frame = consumeLine(state, buffer);
      buffer = '';
      if (frame !== undefined) frames.push(frame);
    }
    return frames;
  };

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      return drainLines(false);
    },
    flush(): SseFrame[] {
      const frames = drainLines(true);
      const pending = dispatch(state);
      if (pending !== undefined) frames.push(pending);
      return frames;
    },
  };
}
