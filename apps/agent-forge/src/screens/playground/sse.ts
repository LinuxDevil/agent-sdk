import type { PlaygroundEvent } from './types';

/** An incremental SSE parser: `push` text chunks as they arrive, `flush` at end of stream. */
export interface SseParser {
  push(chunk: string): PlaygroundEvent[];
  flush(): PlaygroundEvent[];
}

const isEvent = (value: unknown): value is PlaygroundEvent =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** The event in one SSE frame's `data:` lines, or `undefined` for comments, empty or non-JSON frames. */
function eventOf(frame: string): PlaygroundEvent | undefined {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return isEvent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parses the `data: <json>` frames of the playground stream; frames may be split across chunks. */
export function createSseParser(): SseParser {
  let buffer = '';
  const take = (frames: string[]) => frames.map(eventOf).filter((e): e is PlaygroundEvent => e !== undefined);
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n?/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      return take(frames);
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return take([rest]);
    },
  };
}
