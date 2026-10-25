/**
 * Streams `POST /playground/run` from the Studio server (not the observe
 * daemon, so a run works with the daemon down). Carries the per-launch
 * Studio token like runtimeClient.ts.
 */
import { STUDIO_TOKEN_HEADER, loadStudioToken } from '../../runtime/studioToken';
import { createSseParser } from './sse';
import type { PlaygroundEvent, PlaygroundRunBody } from './types';

/** The error event for a non-SSE answer (the server's 400 `{ error }`, or any other status). */
async function errorEventOf(res: Response): Promise<PlaygroundEvent> {
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const message = typeof body?.error === 'string' ? body.error : `The run request failed with ${res.status}`;
  return { type: 'error', message };
}

/** Reads the SSE body to the end, handing every event to `onEvent` as it arrives. */
async function pump(body: ReadableStream<Uint8Array>, onEvent: (event: PlaygroundEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true })).forEach(onEvent);
  }
  parser.push(decoder.decode()).forEach(onEvent);
  parser.flush().forEach(onEvent);
}

/**
 * Runs `body` and calls `onEvent` per streamed event. A failed request
 * becomes one `error` event; aborting `signal` (the Stop button) resolves
 * quietly with no further events.
 */
export async function streamPlaygroundRun(
  body: PlaygroundRunBody,
  onEvent: (event: PlaygroundEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
  const token = loadStudioToken();
  if (token) headers.set(STUDIO_TOKEN_HEADER, token);
  try {
    const res = await fetch('/playground/run', { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) return onEvent(await errorEventOf(res));
    await pump(res.body, onEvent);
  } catch (error) {
    if (signal?.aborted) return;
    onEvent({ type: 'error', message: `The Studio server is not reachable (${(error as Error).message}).` });
  }
}
