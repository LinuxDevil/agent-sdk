import type { AgentRunStatusPayload, NodeStatePayload } from '../../shared/wireTypes';

/**
 * The canvas node-status overlay's state: the latest `node` frame per
 * builder node id (§3.3 ids - `agent`, `tool:<name>`, `sub:<n>/...`),
 * keyed by node id. Frames arrive over `WS /agents/:id/stream` as
 * `{type:'node'}` (server/nodeStates.ts) and are folded in by
 * {@link applyNodeState}; `nodeRunStatuses` (canvas/nodeStatus.ts) maps
 * them onto the card's `NodeRunStatus` vocabulary.
 */
export type NodeStates = Record<string, NodeStatePayload>;

/**
 * Folds one `node` frame into the per-node latest-frame map. The latest
 * frame per node wins by `at`; a frame for the same span id always
 * overrides the earlier one (a span's `running` start frame and its
 * `done`/`error`/`waiting` end frame share the span id, and the later
 * phase must win even on an `at` tie). Returns the same object when the
 * frame is stale so React can bail out of the re-render.
 */
export function applyNodeState(states: NodeStates, frame: NodeStatePayload): NodeStates {
  const prev = states[frame.nodeId];
  if (prev !== undefined && prev.spanId !== frame.spanId && frame.at < prev.at) return states;
  return { ...states, [frame.nodeId]: frame };
}

/**
 * True when `next` starts a new run relative to `prev`: the previous
 * status was not live (`running`/`paused` - `undefined` counts as not
 * live) and the next one is `running`. The stream uses this to drop the
 * previous run's node marks at a run's first `running` status.
 */
export function isNewRun(prev: AgentRunStatusPayload | undefined, next: AgentRunStatusPayload): boolean {
  return next.status === 'running' && prev?.status !== 'running' && prev?.status !== 'paused';
}
