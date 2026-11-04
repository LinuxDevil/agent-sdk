import { classifyToolFailure, failureSignature, type ToolFailureClass } from '../execution/progressGuard';
import type { Span } from '../execution/tracing';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { listTraces, readTrace } from '../traces/readTraces';

const MAX_TRACE_IDS = 5;
const MAX_EXAMPLE_CHARS = 300;
const GUARD_MARKER = '[progress-guard]';
const LEAF_OPERATIONS = new Set(['execute_tool', 'chat']);
const ALL_TRACES = Number.MAX_SAFE_INTEGER;

export interface FailureSample {
  agent: string;
  source: string;
  operation: string;
  error: string;
  traceId: string;
  at: number;
  hinted?: boolean;
}

export type FailureClass = ToolFailureClass | 'guard-denied';

export interface FailureGroup {
  agent: string;
  source: string;
  operation: string;
  failureClass: FailureClass;
  signature: string;
  example: string;
  count: number;
  traces: number;
  hints: number;
  recurring: boolean;
  traceIds: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface FailureReport {
  scanned: { traces: number; spans: number; failed: number };
  groups: FailureGroup[];
}

function classOf(error: string): FailureClass {
  return error.includes(GUARD_MARKER) ? 'guard-denied' : classifyToolFailure({ message: error });
}

export function groupFailures(samples: readonly FailureSample[]): FailureGroup[] {
  const groups = new Map<string, { group: FailureGroup; traces: Set<string> }>();
  for (const sample of samples) {
    const signature = failureSignature(sample.error);
    const key = JSON.stringify([sample.agent, sample.source, signature]);
    const entry = groups.get(key) ?? {
      traces: new Set<string>(),
      group: {
        agent: sample.agent,
        source: sample.source,
        operation: sample.operation,
        failureClass: classOf(sample.error),
        signature,
        example: sample.error.slice(0, MAX_EXAMPLE_CHARS),
        count: 0,
        traces: 0,
        hints: 0,
        recurring: false,
        traceIds: [],
        firstSeen: sample.at,
        lastSeen: sample.at,
      },
    };
    groups.set(key, entry);
    const { group, traces } = entry;
    group.count += 1;
    if (sample.hinted) group.hints += 1;
    group.firstSeen = Math.min(group.firstSeen, sample.at);
    group.lastSeen = Math.max(group.lastSeen, sample.at);
    if (!traces.has(sample.traceId) && group.traceIds.length < MAX_TRACE_IDS) group.traceIds.push(sample.traceId);
    traces.add(sample.traceId);
    group.traces = traces.size;
    group.recurring = traces.size >= 2;
  }
  return [...groups.values()].map(({ group }) => group).sort((a, b) => b.traces - a.traces || b.count - a.count);
}

function parsedAttrs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sampleFrom(fields: { agent: string; name: string; traceId: string; at: number; attrs: Record<string, unknown> }): FailureSample | undefined {
  const { attrs } = fields;
  if (typeof attrs.error !== 'string') return undefined;
  const operation = String(attrs['gen_ai.operation.name'] ?? '');
  const tool = attrs['gen_ai.tool.name'];
  return {
    agent: fields.agent,
    source: typeof tool === 'string' ? tool : fields.name,
    operation,
    error: attrs.error,
    traceId: fields.traceId,
    at: fields.at,
    ...(attrs['lousho.tool.replaced_by_hook'] === 'progress-guard' && { hinted: true }),
  };
}

export function failureReportFromDb(db: SqlDatabase, filter: { since?: number; agent?: string }): FailureReport {
  const where = ["kind IN ('tool', 'generation')", 'start >= ?', "(? = '' OR agent_id = ?)"].join(' AND ');
  const args = [filter.since ?? 0, filter.agent ?? '', filter.agent ?? ''];
  const counts = db.prepare(`SELECT COUNT(DISTINCT trace_id) AS traces, COUNT(*) AS spans FROM observations WHERE ${where}`).get(...args);
  const rows = db.prepare(`SELECT agent_id, name, trace_id, start, attrs FROM observations WHERE ${where} AND status = 'error'`).all(...args);
  const samples = rows.flatMap((row) => {
    const sample = sampleFrom({
      agent: String(row.agent_id ?? 'unknown'),
      name: String(row.name ?? 'unknown'),
      traceId: String(row.trace_id),
      at: Number(row.start),
      attrs: parsedAttrs(row.attrs),
    });
    return sample ? [sample] : [];
  });
  return {
    scanned: { traces: Number(counts?.traces ?? 0), spans: Number(counts?.spans ?? 0), failed: samples.length },
    groups: groupFailures(samples),
  };
}

function leafSpans(spans: readonly Span[]): Span[] {
  return spans.filter((span) => LEAF_OPERATIONS.has(String(span.attributes['gen_ai.operation.name'])));
}

export async function failureReportFromTraces(dirs: readonly string[]): Promise<FailureReport> {
  const samples: FailureSample[] = [];
  let traces = 0;
  let spans = 0;
  for (const dir of dirs) {
    for (const summary of await listTraces({ dir, limit: ALL_TRACES })) {
      traces += 1;
      const leaves = leafSpans(await readTrace(summary.traceId, { dir }));
      spans += leaves.length;
      for (const span of leaves) {
        if (span.status?.code !== 'error') continue;
        const sample = sampleFrom({
          agent: String(span.attributes['gen_ai.agent.name'] ?? summary.agent ?? 'unknown'),
          name: span.name,
          traceId: summary.traceId,
          at: span.startTime,
          attrs: span.attributes,
        });
        if (sample) samples.push(sample);
      }
    }
  }
  return { scanned: { traces, spans, failed: samples.length }, groups: groupFailures(samples) };
}

export function formatFailureReport(report: FailureReport): string {
  const { traces, spans, failed } = report.scanned;
  const scanned = `Scanned ${traces} traces, ${spans} tool and model calls, ${failed} failed.`;
  if (report.groups.length === 0) return `No failures found. ${scanned}`;
  const lines = report.groups.map((group) => {
    const tag = group.recurring ? 'RECURRING' : 'once';
    const hints = group.hints > 0 ? `, ${group.hints} hinted` : '';
    return [
      `${tag}  ${group.agent} / ${group.source}  [${group.failureClass}]  ${group.count} failures in ${group.traces} traces${hints}`,
      `  ${group.example}`,
      `  traces: ${group.traceIds.join(', ')}`,
    ].join('\n');
  });
  return [scanned, '', ...lines].join('\n');
}
