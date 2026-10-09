import { HOOK_TEMPLATES, type HookTemplate } from '../hooks/hookTemplates';
import type { AgentNodeHookPhase, GraphPosition } from '../graph/types';

/** Approximate rendered size of an `.rf-node` (layout.css), used to centre a newly added node. */
const NODE_SIZE = { width: 190, height: 80 };

/**
 * Eve DUI-F9: where a palette item added from the keyboard (or a click)
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

/**
 * Attach the first starter template matching both this palette item's phase
 * (see LeftRail's HOOK_PALETTE) and the target node's hook point (llm ->
 * generate, tool -> toolCall) as a sensible default; the Inspector lets the
 * user pick a different template/edit the code afterward.
 */
export function pickHookTemplate(targetType: 'llm' | 'tool', hookPhase: AgentNodeHookPhase): HookTemplate {
  const point = targetType === 'llm' ? 'generate' : 'toolCall';
  return (
    HOOK_TEMPLATES.find((t) => t.phase === hookPhase && t.point === point) ??
    HOOK_TEMPLATES.find((t) => t.point === point) ??
    HOOK_TEMPLATES[0]
  );
}
