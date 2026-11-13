import type { WebSocket } from 'ws';

/**
 * Runs `cleanup` exactly once when the socket ends: `ws` emits 'error'
 * then 'close' for the same failure (and either alone otherwise), so a
 * naive `on`/`on` pair would run it twice. Shared by the per-workspace
 * stream and events sockets (W02b) so listener/subscription teardown
 * and the workspace `retain` release happen on every exit path.
 */
export function cleanupOnClose(ws: WebSocket, cleanup: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cleanup();
  };
  ws.on('close', run);
  ws.on('error', run);
}
