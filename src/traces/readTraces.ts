/**
 * Reading the files fileTraceExporter() writes (M5a): `listTraces()` for the
 * recent runs, `readTrace()` for one run's spans. Used by `lousho traces`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Span } from '../execution/tracing';
import { GenAiAttr, GenAiOperation, SdkAttr } from '../execution/semconv';
import { SDKError } from '../utils/sdkError';
import { DEFAULT_TRACE_DIR, type TraceLine } from './format';

/** One run, summed up from its trace file. */
export interface TraceSummary {
  traceId: string;
  /** The root span's name (`invoke_agent support`). */
  name: string;
  /** `gen_ai.agent.name` of the root span. */
  agent?: string;
  startTime: number;
  durationMs: number;
  /** The root span's status. */
  status: 'ok' | 'error';
  /** `chat` spans, sub-agents' included. */
  modelCalls: number;
  /** `execute_tool` spans, sub-agents' included. */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The sum of the chat spans' `lousho.cost_usd` (sub-agents included); absent when a model's price is unknown. */
  costUsd?: number;
  /** Absolute path of the trace file. */
  file: string;
}

export interface ListTracesOptions {
  /** Default `.lousho/traces` under the working directory. */
  dir?: string;
  /** How many traces, newest first. Default 20. */
  limit?: number;
}

/** A trace file found by id or id prefix. */
export interface TraceFile {
  traceId: string;
  file: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function traceDir(dir: string | undefined): string {
  return path.resolve(dir ?? DEFAULT_TRACE_DIR);
}

function readDirOrEmpty(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Day folders, newest first. */
function days(dir: string): string[] {
  return readDirOrEmpty(dir)
    .filter((entry) => entry.isDirectory() && DAY.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function filesOfDay(dir: string, day: string): TraceFile[] {
  return readDirOrEmpty(path.join(dir, day))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => ({ traceId: entry.name.slice(0, -'.jsonl'.length), file: path.join(dir, day, entry.name) }));
}

/** Every trace file under `dir`, newest day first. */
function allFiles(dir: string): TraceFile[] {
  return days(dir).flatMap((day) => filesOfDay(dir, day));
}

/** The spans of a trace file, by start time; a line that does not parse (a crash mid-write) is skipped. */
async function readLines(file: string): Promise<TraceLine[]> {
  const text = await fs.promises.readFile(file, 'utf8');
  const lines: TraceLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as TraceLine;
      if (line && typeof line.id === 'string' && typeof line.startTime === 'number') lines.push(line);
    } catch {
      // partial line
    }
  }
  return lines.sort((a, b) => a.startTime - b.startTime);
}

function toSpan(line: TraceLine): Span {
  return {
    id: line.id,
    name: line.name,
    attributes: line.attributes ?? {},
    startTime: line.startTime,
    endTime: line.endTime,
    ...(line.parentId !== undefined && { parentId: line.parentId }),
    ...(line.kind !== undefined && { kind: line.kind }),
    ...(line.status !== undefined && { status: line.status }),
  };
}

function numberAttr(span: TraceLine, key: string): number {
  const value = span.attributes?.[key];
  return typeof value === 'number' ? value : 0;
}

/**
 * The trace's cost: the sum of its chat spans' `lousho.cost_usd`, which also
 * counts a background sub-agent that finished after the root's rollup (Eve
 * MA-F2). Falls back to the root's rollup when a chat with token usage has no
 * price, and is absent when nothing is priced.
 */
function traceCost(root: TraceLine, chats: TraceLine[]): number | undefined {
  const rootCost = root.attributes?.[SdkAttr.COST_USD];
  const costs = chats.map((line) => line.attributes?.[SdkAttr.COST_USD]);
  const unpriced = chats.some((line, i) => typeof costs[i] !== 'number' && line.attributes?.[GenAiAttr.USAGE_INPUT_TOKENS] !== undefined);
  const priced = costs.filter((cost): cost is number => typeof cost === 'number');
  if (unpriced || priced.length === 0) return typeof rootCost === 'number' ? rootCost : undefined;
  return priced.reduce((sum, cost) => sum + cost, 0);
}

/** Sums one trace's spans; the root is the trace id's span, else the earliest span. */
function summarize(entry: TraceFile, lines: TraceLine[]): TraceSummary | undefined {
  if (lines.length === 0) return undefined;
  const root = lines.find((line) => line.id === entry.traceId) ?? lines[0];
  const op = (line: TraceLine) => line.attributes?.[GenAiAttr.OPERATION_NAME];
  const chats = lines.filter((line) => op(line) === GenAiOperation.CHAT);
  const costUsd = traceCost(root, chats);
  const end = Math.max(...lines.map((line) => line.endTime ?? line.startTime));
  const agent = root.attributes?.[GenAiAttr.AGENT_NAME];
  return {
    traceId: entry.traceId,
    name: root.name,
    ...(typeof agent === 'string' && { agent }),
    startTime: root.startTime,
    durationMs: (root.id === entry.traceId ? root.endTime : end) - root.startTime,
    status: root.status?.code === 'error' ? 'error' : 'ok',
    modelCalls: chats.length,
    toolCalls: lines.filter((line) => op(line) === GenAiOperation.EXECUTE_TOOL).length,
    inputTokens: chats.reduce((sum, line) => sum + numberAttr(line, GenAiAttr.USAGE_INPUT_TOKENS), 0),
    outputTokens: chats.reduce((sum, line) => sum + numberAttr(line, GenAiAttr.USAGE_OUTPUT_TOKENS), 0),
    ...(costUsd !== undefined && { costUsd }),
    file: entry.file,
  };
}

/**
 * The recent traces under `dir`, newest first (default limit 20). An absent
 * directory gives an empty list.
 *
 * @example
 * ```ts
 * import { listTraces } from '@lousho/build-ai-agent/traces';
 * const [latest] = await listTraces({ limit: 1 });
 * ```
 */
export async function listTraces(options: ListTracesOptions = {}): Promise<TraceSummary[]> {
  const dir = traceDir(options.dir);
  const limit = options.limit ?? 20;
  const summaries: TraceSummary[] = [];
  for (const day of days(dir)) {
    if (summaries.length >= limit) break;
    for (const entry of filesOfDay(dir, day)) {
      const summary = summarize(entry, await readLines(entry.file));
      if (summary) summaries.push(summary);
    }
  }
  return summaries.sort((a, b) => b.startTime - a.startTime).slice(0, limit);
}

/** The trace files whose id is `idOrPrefix` (exact match wins) or starts with it. */
export function findTraces(idOrPrefix: string, options: { dir?: string } = {}): TraceFile[] {
  const files = allFiles(traceDir(options.dir));
  const exact = files.filter((entry) => entry.traceId === idOrPrefix);
  if (exact.length > 0) return exact;
  return idOrPrefix ? files.filter((entry) => entry.traceId.startsWith(idOrPrefix)) : [];
}

/**
 * One trace's spans, by start time. `traceId` may be a unique prefix. Resolves
 * with `[]` when no trace matches; rejects with `LOUSHO_CONFIG_INVALID` when a
 * prefix matches several.
 *
 * @example
 * ```ts
 * import { readTrace } from '@lousho/build-ai-agent/traces';
 * const spans = await readTrace('k3f9');
 * ```
 */
export async function readTrace(traceId: string, options: { dir?: string } = {}): Promise<Span[]> {
  const matches = findTraces(traceId, options);
  if (matches.length > 1) {
    throw new SDKError(
      `Trace id prefix '${traceId}' matches ${matches.length} traces: ${matches.map((m) => m.traceId).join(', ')}.`,
      'LOUSHO_CONFIG_INVALID',
      { hint: 'Give more of the trace id.' }
    );
  }
  if (matches.length === 0) return [];
  return (await readLines(matches[0].file)).map(toSpan);
}
