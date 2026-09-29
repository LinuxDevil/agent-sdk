/**
 * Shared drag-and-drop MIME type for the LeftRail "Nodes" palette ->
 * CanvasArea drop target (LOU-M1). Kept as one constant so the producer
 * (LeftRail) and consumer (CanvasArea) can't drift out of sync.
 */
export const PALETTE_DRAG_MIME = 'application/agent-forge-node-type';

/**
 * LOU-Q3: drag-and-drop MIME type for the LeftRail "Nodes" tab's
 * Pre-hook/Post-hook palette items -> CanvasArea drop target. Distinct from
 * PALETTE_DRAG_MIME (which adds a new `AgentGraphNode`) because dropping a
 * hook item doesn't create a node at all - it attaches an
 * `AgentNodeHookInstance` (see graph/types.ts) onto whichever existing node
 * the drop lands on, so CanvasArea's onDrop needs to hit-test the node
 * under the cursor rather than just read a drop position. The payload
 * carries the hook's phase ('pre'|'post') so the drop handler knows which
 * starter template to attach by default.
 */
export const HOOK_DRAG_MIME = 'application/agent-forge-hook-phase';
