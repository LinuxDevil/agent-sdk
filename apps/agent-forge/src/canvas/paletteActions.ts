import type { GraphPosition } from '../graph/v2/types';

/** Approximate rendered size of an `.rf-node` (screens/agents/agents.css), used to centre a newly added node. */
const NODE_SIZE = { width: 208, height: 80 };

/**
 * Where a palette item added from the keyboard (or a click)
 * lands - the flow-space point under the centre of the visible canvas,
 * offset so the node itself is centred there. `transform` is React Flow's
 * `[x, y, zoom]` viewport transform and `width`/`height` the pane size.
 */
export function viewportCentrePosition(
  transform: readonly [number, number, number],
  width: number,
  height: number
): GraphPosition {
  const [x, y, zoom] = transform;
  const safeZoom = zoom || 1;
  return {
    x: Math.round((width / 2 - x) / safeZoom - NODE_SIZE.width / 2),
    y: Math.round((height / 2 - y) / safeZoom - NODE_SIZE.height / 2),
  };
}
