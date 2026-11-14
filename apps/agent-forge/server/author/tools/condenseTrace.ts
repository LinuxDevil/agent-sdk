/**
 * `condenseTrace`: one run's spans as the short step list `getTrace`
 * returns (PLAN §8.2, AA20). Pure - it maps the span file's GenAI spans
 * onto `{ kind, name, status, durationMs }` rows (model calls, tool
 * calls, sub-agents, handoffs, guardrails), sums the run's cost off the
 * chat spans, and lists every failed span's error. Long runs keep their
 * first {@link TRACE_STEP_LIMIT} steps plus a "+N more steps" tail row;
 * the root `invoke_agent` gives the trace its status and duration and is
 * never a step.
 */
import type { SpanEvent } from '../../../shared/wireTypes';
import { clip } from './clip';

/**
 * The OTel GenAI attribute keys the SDK writes on its spans
 * (src/execution/semconv.ts; the constants are not a public export, so
 * the app uses the wire strings - same as research §12.2).
 */
const ATTR_OPERATION = 'gen_ai.operation.name';
const ATTR_REQUEST_MODEL = 'gen_ai.request.model';
const ATTR_TOOL_NAME = 'gen_ai.tool.name';
const ATTR_TOOL_ARGS = 'gen_ai.tool.call.arguments';
const ATTR_TOOL_RESULT = 'gen_ai.tool.call.result';
const ATTR_SUBAGENT_NAME = 'lousho.subagent.name';
const ATTR_COST_USD = 'lousho.cost_usd';
const ATTR_ERROR_TYPE = 'error.type';

/** How many steps a condensed trace keeps before the "+N more steps" tail row. */
export const TRACE_STEP_LIMIT = 60;

/** Character cap on a step's captured `args`/`result` excerpt. */
const SPAN_FIELD_LIMIT = 300;

/** One condensed trace line: a model call, tool call, sub-agent, handoff, guardrail or anything else. */
export interface TraceStep {
  kind: 'model' | 'tool' | 'subagent' | 'handoff' | 'guardrail' | 'other';
  name: string;
  status: 'ok' | 'error';
  /** `endTime - startTime`, or null for a span that never ended. */
  durationMs: number | null;
  /** `error.type` or the status message, on failed spans. */
  error?: string;
  /** `gen_ai.tool.call.arguments`, clipped - only when the run captured content on the span. */
  args?: string;
  /** `gen_ai.tool.call.result`, clipped - same capture rule. */
  result?: string;
}

/** `getTrace`'s `ok: true` output: the run's own status/duration/cost plus its condensed steps. */
export interface GetTraceOutput {
  ok: true;
  traceId: string;
  /** The agent whose trace folder held the file (the input's `agentId`, or the agent the search found). */
  agentId: string;
  /** The root span's status. */
  status: 'ok' | 'error';
  /** The root span's duration, or null when it never ended. */
  durationMs: number | null;
  /** Sum of `lousho.cost_usd` over the trace's chat spans; null when none is priced. */
  costUsd: number | null;
  /** Start-time order, max {@link TRACE_STEP_LIMIT} rows plus a "+N more steps" tail. */
  steps: TraceStep[];
  /** `'<span name>: <error.type or status message>'` for every failed span, in start order. */
  errors: string[];
}

/** `attributes[key]` when it is a string. */
function stringAttr(span: SpanEvent, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

/** The span's `gen_ai.operation.name` (`chat`, `invoke_agent`, `execute_tool`, `invoke_workflow`). */
function operationOf(span: SpanEvent): string | undefined {
  return stringAttr(span, ATTR_OPERATION);
}

/** `endTime - startTime` for an ended span, else null. */
function spanDuration(span: SpanEvent): number | null {
  return typeof span.endTime === 'number' ? span.endTime - span.startTime : null;
}

/** The failure text for a failed span: `error.type`, else the status message, else 'error'. */
function errorText(span: SpanEvent): string {
  return stringAttr(span, ATTR_ERROR_TYPE) ?? span.status?.message ?? 'error';
}

/** The step's `{ kind, name }` for one non-root span (the mapping table in the ticket). */
function classify(span: SpanEvent): Pick<TraceStep, 'kind' | 'name'> {
  const operation = operationOf(span);
  if (operation === 'chat') return { kind: 'model', name: stringAttr(span, ATTR_REQUEST_MODEL) ?? span.name };
  if (operation === 'execute_tool') return { kind: 'tool', name: stringAttr(span, ATTR_TOOL_NAME) ?? span.name };
  const subagent = stringAttr(span, ATTR_SUBAGENT_NAME);
  if (operation === 'invoke_agent' && subagent !== undefined) return { kind: 'subagent', name: subagent };
  if (span.name.startsWith('handoff')) return { kind: 'handoff', name: span.name };
  if (span.name.startsWith('guardrail')) return { kind: 'guardrail', name: span.name };
  return { kind: 'other', name: span.name };
}

/** One span as its {@link TraceStep} row. */
function stepOf(span: SpanEvent): TraceStep {
  const { kind, name } = classify(span);
  const status = span.status?.code === 'error' ? 'error' : 'ok';
  const args = stringAttr(span, ATTR_TOOL_ARGS);
  const result = stringAttr(span, ATTR_TOOL_RESULT);
  return {
    kind,
    name,
    status,
    durationMs: spanDuration(span),
    ...(status === 'error' && { error: errorText(span) }),
    ...(args !== undefined && { args: clip(args, SPAN_FIELD_LIMIT) }),
    ...(result !== undefined && { result: clip(result, SPAN_FIELD_LIMIT) }),
  };
}

/** The parentless `invoke_agent` the trace's status and duration come from (any parentless span as fallback). */
function rootOf(ordered: readonly SpanEvent[]): SpanEvent | undefined {
  return (
    ordered.find((span) => span.parentId === undefined && operationOf(span) === 'invoke_agent') ??
    ordered.find((span) => span.parentId === undefined)
  );
}

/**
 * Condenses `spans` (one trace's `readAgentTrace` result) into
 * {@link GetTraceOutput} minus the envelope fields. Steps are in
 * start-time order; every span except the root `invoke_agent` is a
 * step. `costUsd` sums `lousho.cost_usd` over the chat spans (null when
 * none carries it). `errors` lists every failed span as
 * `'<span name>: <error>'`.
 */
export function condenseTrace(spans: readonly SpanEvent[]): Omit<GetTraceOutput, 'ok' | 'traceId' | 'agentId'> {
  const ordered = [...spans].sort((a, b) => a.startTime - b.startTime);
  const root = rootOf(ordered);
  const steps = ordered
    .filter((span) => !(span.parentId === undefined && operationOf(span) === 'invoke_agent'))
    .map(stepOf);
  const costs = ordered
    .filter((span) => operationOf(span) === 'chat')
    .map((span) => span.attributes[ATTR_COST_USD])
    .filter((cost): cost is number => typeof cost === 'number');
  const shown = steps.slice(0, TRACE_STEP_LIMIT);
  if (steps.length > TRACE_STEP_LIMIT) {
    shown.push({
      kind: 'other',
      name: `+${steps.length - TRACE_STEP_LIMIT} more steps`,
      status: 'ok',
      durationMs: null,
    });
  }
  return {
    status: root?.status?.code === 'error' ? 'error' : 'ok',
    durationMs: root !== undefined ? spanDuration(root) : null,
    costUsd: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    steps: shown,
    errors: ordered.filter((span) => span.status?.code === 'error').map((span) => `${span.name}: ${errorText(span)}`),
  };
}
