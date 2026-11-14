import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';

/**
 * The auto-layout worker (C17): runs elkjs off the main thread. `layout.ts`
 * posts `{ id, graph }` (an ELK JSON graph from `toElkGraph`) and gets back
 * `{ id, result }` or `{ id, error }`. One ELK instance serves every request.
 */
interface LayoutRequest {
  id: number;
  graph: ElkNode;
}

interface LayoutResponse {
  id: number;
  result?: ElkNode;
  error?: string;
}

const elk = new ELK();

// `self` is the DedicatedWorkerGlobalScope; the app's DOM lib types it as Window.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse): void;
};

scope.onmessage = (event) => {
  const { id, graph } = event.data;
  elk.layout(graph).then(
    (result) => scope.postMessage({ id, result }),
    (cause) => scope.postMessage({ id, error: cause instanceof Error ? cause.message : String(cause) })
  );
};
