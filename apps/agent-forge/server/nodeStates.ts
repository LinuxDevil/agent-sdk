/**
 * `node` stream frames: the run state of one canvas node, derived from a
 * span notification. The SDK's `nodeIdExporter` stamps `lousho.node.id`
 * (the §3.3 builder id - `agent`, `tool:<name>`, `sub:<n>/...`) on spans
 * of spec-built agents; RunManager turns each stamped span's start into a
 * `running` (or `waiting`) frame and its end into a `done`/`error` frame,
 * so the canvas lights the exact node the span belongs to rather than
 * guessing from span names. Frames carry node ids and state only -
 * never secret values.
 */
import { APPROVAL_WAIT_SPAN_NAME, SdkAttr, type Span } from '@linuxdevil/lousho';
import type { NodeRunState, NodeStatePayload } from '../shared/wireTypes';

/**
 * The span attribute that carries the §3.3 node id - re-exported from the
 * SDK's `SdkAttr` so the literal lives in exactly one place. Private:
 * frame consumers work from {@link NodeStatePayload}, not attributes.
 */
const NODE_ID_ATTRIBUTE = SdkAttr.NODE_ID;

/**
 * True for the `approval.wait <tool>` marker span (`markApprovalWait`,
 * src/execution/markSpan.ts): a zero-length span whose start means the
 * run is paused on a human decision for that tool's node - `waiting`,
 * not `running`.
 */
function isApprovalWait(span: Span): boolean {
  return span.name === APPROVAL_WAIT_SPAN_NAME || span.name.startsWith(`${APPROVAL_WAIT_SPAN_NAME} `);
}

/**
 * The node frame a span notification produces, or `undefined` when the
 * span carries no usable node id (anything not spec-compiled, plus the
 * spans the exporter deliberately leaves unstamped). `phase` is which
 * exporter hook saw the span: `start` maps to `running` (`waiting` for
 * an approval-wait marker), `end` to `error` when the span failed, else
 * `done`.
 */
export function nodeStateFor(span: Span, phase: 'start' | 'end', now: Date): NodeStatePayload | undefined {
  const nodeId = span.attributes[NODE_ID_ATTRIBUTE];
  if (typeof nodeId !== 'string' || nodeId === '') return undefined;
  // The `approval.wait` marker is zero-length (markSpan fires start and
  // end in the same tick): its `end` must not emit a `done` frame over
  // the `waiting` one - the node stays paused until the gated tool's real
  // span (or the run's own status) moves it on. The `span` frame itself
  // is still forwarded; only the node-state derivation is suppressed.
  if (phase === 'end' && isApprovalWait(span)) return undefined;
  const state: NodeRunState =
    phase === 'start'
      ? isApprovalWait(span)
        ? 'waiting'
        : 'running'
      : span.status?.code === 'error'
        ? 'error'
        : 'done';
  return { nodeId, state, spanId: span.id, at: now.toISOString() };
}
