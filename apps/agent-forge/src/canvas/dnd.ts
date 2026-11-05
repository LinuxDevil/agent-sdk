/**
 * Shared drag-and-drop MIME type for the LeftRail "Nodes" palette ->
 * CanvasArea drop target. Kept as one constant so the producer
 * (LeftRail) and consumer (CanvasArea) can't drift out of sync. The
 * payload is the palette entry's id (canvas/kinds/index.ts's
 * `PaletteEntry.id`), not a node kind - a kind may offer several entries.
 */
export const PALETTE_DRAG_MIME = 'application/agent-forge-node-type';
