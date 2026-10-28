import type { SpanEvent } from '../../../shared/wireTypes';
import type { ObserveObservationRow } from '../../observe/types';

/**
 * Live runtime spans (the drawer's `{type:'span'}` feed, or a persisted trace
 * file) as observation rows, so the Agents drawer can show them in the shared
 * `TraceViewer`. Mirrors the SDK observe reporter's span -> observation mapping
 * (src/observe/reporter.ts): kind from `gen_ai.operation.name`, payloads per
 * operation, model/usage/cost from the `gen_ai.*` / `lousho.*` attributes.
 */

const KIND_OF: Record<string, string> = {
  chat: 'generation',
  execute_tool: 'tool',
  invoke_agent: 'span',
  invoke_workflow: 'span',
};

/** Which attributes carry a span's input/output, per operation (the first present one wins). */
const INPUT_KEYS: Record<string, readonly string[]> = {
  chat: ['gen_ai.input.messages'],
  execute_tool: ['gen_ai.tool.call.arguments'],
};
const OUTPUT_KEYS: Record<string, readonly string[]> = {
  execute_tool: ['gen_ai.tool.call.result'],
};
const GENERIC_INPUT_KEYS = ['gen_ai.input.messages'];
const GENERIC_OUTPUT_KEYS = ['gen_ai.output.messages'];

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A string attribute as-is, anything else as JSON. */
function textOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}

function pickText(attrs: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const text = textOf(attrs[key]);
    if (text !== null) return text;
  }
  return null;
}

/** The id of `span`'s top-most known ancestor (itself for a root, or when its parent is not in the list). */
function rootIdOf(span: SpanEvent, byId: Map<string, SpanEvent>): string {
  let current = span;
  const seen = new Set<string>([current.id]);
  while (current.parentId !== undefined) {
    const parent = byId.get(current.parentId);
    if (parent === undefined || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** `attributes`, plus the failure message as `attrs.error` on an errored span (the inspector's Error banner reads it). */
function attrsOf(span: SpanEvent): Record<string, unknown> {
  const message = span.status?.code === 'error' ? span.status.message : undefined;
  return message ? { ...span.attributes, error: message } : span.attributes;
}

function statusOf(span: SpanEvent): string | null {
  if (span.status?.code === 'error') return 'error';
  return span.endTime === undefined ? null : 'ok';
}

function observationOf(span: SpanEvent, traceId: string): ObserveObservationRow {
  const attrs = span.attributes;
  const op = str(attrs['gen_ai.operation.name']) ?? '';
  return {
    obs_id: span.id,
    trace_id: traceId,
    session_id: str(attrs['gen_ai.conversation.id']),
    agent_id: null,
    parent_obs_id: span.parentId ?? null,
    kind: KIND_OF[op] ?? 'span',
    name: span.name,
    start: span.startTime,
    end: span.endTime ?? null,
    status: statusOf(span),
    input: pickText(attrs, INPUT_KEYS[op] ?? GENERIC_INPUT_KEYS),
    output: pickText(attrs, OUTPUT_KEYS[op] ?? GENERIC_OUTPUT_KEYS),
    model: str(attrs['gen_ai.response.model']) ?? str(attrs['gen_ai.request.model']),
    usage_input_tokens: num(attrs['gen_ai.usage.input_tokens']),
    usage_output_tokens: num(attrs['gen_ai.usage.output_tokens']),
    usage_cached_tokens: num(attrs['gen_ai.usage.cached_input_tokens']),
    usage_reasoning_tokens: num(attrs['lousho.usage.reasoning_tokens']),
    cost_usd: num(attrs['lousho.cost_usd']),
    cost_partial: attrs['lousho.cost_partial'] === true ? true : null,
    usage_estimated: attrs['lousho.usage.estimated'] === true ? true : null,
    truncated: false,
    attrs: attrsOf(span),
  };
}

/** Each span as one observation row; `trace_id` is the span's root ancestor id (the SDK's trace id). */
export function spansToObservations(spans: SpanEvent[]): ObserveObservationRow[] {
  const byId = new Map(spans.map((span) => [span.id, span]));
  return spans.map((span) => observationOf(span, rootIdOf(span, byId)));
}
