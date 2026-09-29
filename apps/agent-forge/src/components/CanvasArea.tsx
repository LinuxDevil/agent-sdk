/**
 * Canvas placeholder (LOU-L1). Real ReactFlow-based node-graph editing
 * lands in LOU-M - this just occupies the layout's center column with a
 * styled placeholder so the app shell is complete without pretending to be
 * an interactive canvas.
 */
export function CanvasArea() {
  return (
    <div className="canvas-wrap">
      <div className="canvas-placeholder">
        <div className="title">Canvas</div>
        The node-graph editor (ReactFlow) is built in LOU-M. This placeholder confirms the app shell's layout,
        theming and data model without a real canvas yet.
      </div>
    </div>
  );
}
