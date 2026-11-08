import type { AgentRunStatusPayload, NodeRunState } from '../../shared/wireTypes';
import type { NodeStates } from '../state/nodeStateReducer';

/** A node card's status, in the builder's StatusPill vocabulary. */
export type NodeRunStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

/** An open span outranks a failed one, which outranks a finished one. */
const RANK: Record<NodeRunStatus, number> = { idle: 0, done: 1, error: 2, paused: 3, running: 4 };

/**
 * The card status one `node` frame's state maps to. `running` is live
 * only while its run is: a stopped or finished run's never-ended span is
 * a stale open frame and reads idle; `waiting` (the approval-wait
 * marker) is the paused ring; `done`/`error` are terminal.
 */
function frameStatus(state: NodeRunState, runStatus: AgentRunStatusPayload | undefined): NodeRunStatus {
  switch (state) {
    case 'running': {
      const run = runStatus?.status;
      return run === 'running' ? 'running' : run === 'paused' ? 'paused' : 'idle';
    }
    case 'waiting':
      return 'paused';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/** The owner path of a §3.3 node id: `sub:a/sub:b/tool:x` → `sub:a/sub:b`; `''` for a root id. */
function ownerId(nodeId: string): string {
  const slash = nodeId.lastIndexOf('/');
  return slash === -1 ? '' : nodeId.slice(0, slash);
}

/**
 * Each canvas node's status in the current run, from the server's `node`
 * frames (state/nodeStateReducer.ts): every known node id starts idle,
 * each frame raises its node (and, for a sub-path id like
 * `sub:<name>/tool:<n>`, its group node `sub:<name>`) to the mapped
 * status, the highest rank winning when several frames touch one node.
 * Frames for node ids the graph does not have are ignored.
 */
export function nodeRunStatuses(
  nodeIds: readonly string[],
  nodeStates: NodeStates,
  runStatus: AgentRunStatusPayload | undefined
): Record<string, NodeRunStatus> {
  const known = new Set(nodeIds);
  const statuses: Record<string, NodeRunStatus> = Object.fromEntries(nodeIds.map((id) => [id, 'idle']));
  const raise = (nodeId: string, status: NodeRunStatus) => {
    if (known.has(nodeId) && RANK[status] > RANK[statuses[nodeId]]) statuses[nodeId] = status;
  };
  for (const frame of Object.values(nodeStates)) {
    const status = frameStatus(frame.state, runStatus);
    raise(frame.nodeId, status);
    const owner = ownerId(frame.nodeId);
    if (owner !== '') raise(owner, status);
  }
  return statuses;
}
