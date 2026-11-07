import { classifyToolFailure, failureSignature, type ToolFailureClass } from '../execution/progressGuard';
import type { Span } from '../execution/tracing';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { listTraces, readTrace } from '../traces/readTraces';

const MAX_TRACE_IDS = 5;
const MAX_EXAMPLE_CHARS = 300;
const GUARD_MARKERS = ['[progress-guard]', 'LOUSHO_RUN_NO_PROGRESS'];
const LEAF_OPERATIONS = new Set(['execute_tool', 'chat']);
const ALL_TRACES = Number.MAX_SAFE_INTEGER;
const NO_ANSWER_REASONS = new Set(['max-steps', 'budget-exceeded']);
const RATE_LIMIT = /rate.?limit|\b429\b/i;
const NO_ANSWER_EXAMPLE = /^The run ended with .* and no answer$/;
const INTERRUPTED_EXAMPLE = "The run's process died before it finished";
const DEFAULT_MIN_SCORE = 0.5;

export interface FailureSample {
  agent: string;
  source: string;
  operation: string;
  error: string;
  traceId: string;
  at: number;
  hinted?: boolean;
}

export type FailureClass = ToolFailureClass | 'guard-denied' | 'rate-limit' | 'no-answer' | 'interrupted' | 'low-score';

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
  scanned: { traces: number; spans: number; failed: number; noAnswer: number; interrupted: number; lowScores: number };
  groups: FailureGroup[];
}

function classOf(error: string, operation: string): FailureClass {
  if (operation === 'score') return 'low-score';
  if (error === INTERRUPTED_EXAMPLE) return 'interrupted';
  if (NO_ANSWER_EXAMPLE.test(error)) return 'no-answer';
  if (RATE_LIMIT.test(error)) return 'rate-limit';
  return GUARD_MARKERS.some((marker) => error.includes(marker)) ? 'guard-denied' : classifyToolFailure({ message: error });
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
        failureClass: classOf(sample.error, sample.operation),
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
  const agentName = attrs['gen_ai.agent.name'];
  return {
    agent: typeof agentName === 'string' ? agentName : fields.agent,
    source: typeof tool === 'string' ? tool : fields.name,
    operation,
    error: attrs.error,
    traceId: fields.traceId,
    at: fields.at,
    ...(attrs['lousho.tool.replaced_by_hook'] === 'progress-guard' && { hinted: true }),
  };
}

function noAnswerSample(fields: { agent: string; traceId: string; at: number; attrs: Record<string, unknown> }): FailureSample | undefined {
  const reason = fields.attrs['lousho.run.finish_reason'];
  if (typeof reason !== 'string' || !NO_ANSWER_REASONS.has(reason)) return undefined;
  const name = fields.attrs['gen_ai.agent.name'];
  return {
    agent: typeof name === 'string' ? name : fields.agent,
    source: 'run',
    operation: 'invoke_agent',
    error: `The run ended with ${reason} and no answer`,
    traceId: fields.traceId,
    at: fields.at,
  };
}

function agentOf(row: Record<string, unknown>): string {
  return String(row.agent_name ?? row.agent_id ?? 'unknown');
}

const FROM_OBSERVATIONS = 'FROM observations o LEFT JOIN agents a ON a.agent_id = o.agent_id';
const OBSERVATION_COLUMNS = 'o.agent_id, a.name AS agent_name, o.name, o.trace_id, o.start, o.status, o.attrs';

function rowFields(row: Record<string, unknown>) {
  return { agent: agentOf(row), name: String(row.name ?? 'unknown'), traceId: String(row.trace_id), at: Number(row.start), attrs: parsedAttrs(row.attrs) };
}

function rootSample(row: Record<string, unknown>): FailureSample | undefined {
  const fields = rowFields(row);
  if (row.status !== 'interrupted') return noAnswerSample(fields);
  const name = fields.attrs['gen_ai.agent.name'];
  return { agent: typeof name === 'string' ? name : fields.agent, source: 'run', operation: 'invoke_agent', error: INTERRUPTED_EXAMPLE, traceId: fields.traceId, at: fields.at };
}

function lowScoreSamples(db: SqlDatabase, since: number, agent: string, minScore: number): FailureSample[] {
  const rows = db
    .prepare(
      'SELECT s.name, s.value, s.trace_id, s.created_at, s.agent_id, a.name AS agent_name FROM scores s LEFT JOIN agents a ON a.agent_id = s.agent_id ' +
        "WHERE s.value IS NOT NULL AND s.value < ? AND s.created_at >= ? AND (? = '' OR s.agent_id = ?)"
    )
    .all(minScore, since, agent, agent);
  return rows.map((row) => ({
    agent: agentOf(row),
    source: `score ${String(row.name)}`,
    operation: 'score',
    error: `Score ${String(row.name)} was below ${minScore}`,
    traceId: String(row.trace_id),
    at: Number(row.created_at),
  }));
}

export function failureReportFromDb(db: SqlDatabase, filter: { since?: number; agent?: string; minScore?: number }): FailureReport {
  const since = filter.since ?? 0;
  const agent = filter.agent ?? '';
  const filters = "o.start >= ? AND (? = '' OR o.agent_id = ?)";
  const args = [since, agent, agent];
  const leaf = `o.kind IN ('tool', 'generation') AND ${filters}`;
  const counts = db.prepare(`SELECT COUNT(DISTINCT o.trace_id) AS traces, COUNT(*) AS spans FROM observations o WHERE ${leaf}`).get(...args);
  const failed = db.prepare(`SELECT ${OBSERVATION_COLUMNS} ${FROM_OBSERVATIONS} WHERE ${leaf} AND o.status = 'error'`).all(...args).flatMap((row) => {
    const fields = rowFields(row);
    const sample = sampleFrom(fields);
    return sample ? [sample] : [];
  });
  const roots = db.prepare(`SELECT ${OBSERVATION_COLUMNS} ${FROM_OBSERVATIONS} WHERE o.kind = 'span' AND o.parent_obs_id IS NULL AND ${filters}`).all(...args).flatMap((row) => {
    const sample = rootSample(row);
    return sample ? [sample] : [];
  });
  const lowScores = lowScoreSamples(db, since, agent, filter.minScore ?? DEFAULT_MIN_SCORE);
  const interrupted = roots.filter((sample) => sample.error === INTERRUPTED_EXAMPLE).length;
  return {
    scanned: { traces: Number(counts?.traces ?? 0), spans: Number(counts?.spans ?? 0), failed: failed.length, noAnswer: roots.length - interrupted, interrupted, lowScores: lowScores.length },
    groups: groupFailures([...roots, ...lowScores, ...failed]),
  };
}

function leafSpans(spans: readonly Span[]): Span[] {
  return spans.filter((span) => LEAF_OPERATIONS.has(String(span.attributes['gen_ai.operation.name'])));
}

export async function failureReportFromTraces(dirs: readonly string[]): Promise<FailureReport> {
  const samples: FailureSample[] = [];
  const noAnswer: FailureSample[] = [];
  let traces = 0;
  let spans = 0;
  for (const dir of dirs) {
    for (const summary of await listTraces({ dir, limit: ALL_TRACES })) {
      traces += 1;
      const all = await readTrace(summary.traceId, { dir });
      const unanswered = all.filter((span) => span.parentId === undefined).flatMap((span) => {
        const sample = noAnswerSample({ agent: summary.agent ?? 'unknown', traceId: summary.traceId, at: span.startTime, attrs: span.attributes });
        return sample ? [sample] : [];
      });
      noAnswer.push(...unanswered);
      const leaves = leafSpans(all);
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
  return { scanned: { traces, spans, failed: samples.length, noAnswer: noAnswer.length, interrupted: 0, lowScores: 0 }, groups: groupFailures([...noAnswer, ...samples]) };
}

export function formatFailureReport(report: FailureReport): string {
  const { traces, spans, failed, noAnswer, interrupted, lowScores } = report.scanned;
  const extras = [
    noAnswer > 0 ? `${noAnswer} runs ended without an answer.` : '',
    interrupted > 0 ? `${interrupted} run${interrupted === 1 ? ' was' : 's were'} interrupted.` : '',
    lowScores > 0 ? `${lowScores} low scores.` : '',
  ].filter(Boolean);
  const scanned = [`Scanned ${traces} traces, ${spans} tool and model calls, ${failed} failed.`, ...extras].join(' ');
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
