import type { SpanEvent } from '../../../shared/wireTypes';

/**
 * The attribute the SDK's `nodeIdExporter` stamps on every span a graph node
 * owns (src/execution/semconv.ts `NODE_ID`, PLAN §3.3): the node's stable id,
 * with a subagent's children carrying the `<nodeId>/…` path prefix.
 */
const NODE_ID_ATTRIBUTE = 'lousho.node.id';

function stampedNodeId(span: SpanEvent): string | undefined {
  const value = span.attributes[NODE_ID_ATTRIBUTE];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The spans `nodeId` owns in the live/last run's span feed: every span whose
 * `lousho.node.id` is `nodeId` itself or starts with `${nodeId}/` (a
 * subagent's children, tool calls and flow steps nested under it). Spans of
 * sibling and unrelated nodes are excluded. A matched span whose `parentId`
 * points outside the matched set — e.g. the subagent's own root span when
 * only a nested path was asked for — has `parentId` cut to `undefined` so it
 * becomes a root; `spansToObservations`/`nestObservations` then never look
 * for a parent that is not there.
 */
export function spansForNode(spans: readonly SpanEvent[], nodeId: string): SpanEvent[] {
  const prefix = `${nodeId}/`;
  const matched = spans.filter((span) => {
    const stamped = stampedNodeId(span);
    return stamped === nodeId || (stamped !== undefined && stamped.startsWith(prefix));
  });
  const matchedIds = new Set(matched.map((span) => span.id));
  return matched.map((span) =>
    span.parentId !== undefined && !matchedIds.has(span.parentId) ? { ...span, parentId: undefined } : span,
  );
}
