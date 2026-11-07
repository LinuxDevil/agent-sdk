/**
 * Marker spans: zero-length spans for a moment in a run — a handoff
 * (`handoff <to>`) and a pause for approval (`approval.wait <tool>`) — so a
 * trace consumer can light the canvas node the run is on: the handoff
 * target becomes the active node and the paused tool node is `waiting`.
 * Start and end are the same timestamp, and the span is notified like any
 * other (`onSpanStart`, then `onSpanEnd`), parented to the run's
 * `invoke_agent` span when the caller can reach its id. Marker spans carry
 * ids only — never args, prompts or other secrets.
 *
 * This file also hosts {@link notifyExporter}, the swallow-and-warn-once
 * notification both {@link markSpan} and tracing.ts's `withSpan` share: it
 * cannot live as an export of tracing.ts because that module is re-exported
 * from the package root. Internal: this file is not in any barrel.
 */
import { newId } from '../utils/id';
import { describeApproval, type PendingApproval } from './ApprovalGate';
import { subagentNameOf } from './agentRun';
import { defined } from './genAiSpans';
import { APPROVAL_WAIT_SPAN_NAME, GenAiAttr, HANDOFF_SPAN_NAME, SdkAttr } from './semconv';
import type { Span, TraceExporter } from './tracing';

/** Exporters that already threw once; later throws from them are not reported again. */
const warnedExporters = new WeakSet<TraceExporter>();

/**
 * Calls an exporter hook, never letting it fail the traced work: a throwing
 * exporter (a broken observability backend), or an async one whose promise
 * rejects, is reported once with `console.warn` and otherwise ignored, like
 * the OpenTelemetry SDK does.
 */
export function notifyExporter(exporter: TraceExporter | undefined, hook: 'onSpanStart' | 'onSpanEnd', span: Span): void {
  if (!exporter) return;
  const warn = (error: unknown) => {
    if (warnedExporters.has(exporter)) return;
    warnedExporters.add(exporter);
    console.warn(
      `[lousho] A trace exporter's ${hook} threw (${error instanceof Error ? error.message : String(error)}); the run continues. Further errors from this exporter are not reported.`
    );
  };
  try {
    // The hooks are typed `void`, but an `async` implementation is assignable: catch its rejection.
    const result: unknown = exporter[hook](span);
    if (isThenable(result)) result.then(undefined, warn);
  } catch (error) {
    warn(error);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * A zero-length span for a moment in a run (a handoff, a pause): start and
 * end at the same time, notified like any span. No-op without an exporter.
 * Never throws (exporter errors are swallowed as in `withSpan`).
 */
// fallow-ignore-next-line unused-export -- the marker primitive; markHandoff/markApprovalWait call it here, and the guardrail-marker emitters (S20b) call it directly
export function markSpan(exporter: TraceExporter | undefined, name: string, attributes: Record<string, unknown>, parentId?: string): void {
  if (!exporter) return;
  const at = Date.now();
  const span: Span = { id: newId(), name, attributes, startTime: at, endTime: at, parentId };
  notifyExporter(exporter, 'onSpanStart', span);
  notifyExporter(exporter, 'onSpanEnd', span);
}

/**
 * The `handoff <to>` marker for a handoff the run honored, emitted where
 * the run's `handoff` event is emitted. `toolCallId` is the transfer call
 * the model made; `parentId` is the run's `invoke_agent` span, when known.
 */
export function markHandoff(exporter: TraceExporter | undefined, marker: { from: string; to: string }, toolCallId: string, parentId?: string): void {
  markSpan(
    exporter,
    `${HANDOFF_SPAN_NAME} ${marker.to}`,
    defined({
      [SdkAttr.HANDOFF_FROM]: marker.from,
      [SdkAttr.HANDOFF_TO]: marker.to,
      [GenAiAttr.TOOL_CALL_ID]: toolCallId,
    }),
    parentId
  );
}

/**
 * The `approval.wait <tool>` marker for one pending approval, emitted where
 * its `approval.requested` event is emitted — and skipped where the event
 * would be: a sub-agent's run reports no approval events (its lead reports
 * the pause), so its marker is the lead's, not its own.
 */
export function markApprovalWait(options: { exporter?: TraceExporter }, pending: PendingApproval, parentId?: string): void {
  if (subagentNameOf(options) !== undefined) return;
  markSpan(
    options.exporter,
    `${APPROVAL_WAIT_SPAN_NAME} ${pending.toolName}`,
    defined({
      [SdkAttr.APPROVAL_ID]: pending.id,
      [SdkAttr.APPROVAL_KIND]: describeApproval(pending).kind ?? 'tool',
      [GenAiAttr.TOOL_NAME]: pending.toolName,
      [GenAiAttr.TOOL_CALL_ID]: pending.toolCallId,
      [SdkAttr.APPROVAL_EXPIRES_AT]: pending.expiresAt,
    }),
    parentId
  );
}
