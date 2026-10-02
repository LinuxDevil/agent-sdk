/**
 * `lousho traces [--dir D] [--limit N] [--json]` - the recent runs that
 * `fileTraceExporter()` saved, newest first; `lousho traces <id|prefix>
 * [--dir D] [--json] [--content]` - one run as a tree of spans (M5a).
 *
 * Reads files only: this module imports `src/traces/`, never the run loop.
 */
import * as path from 'node:path';
import type { Span } from '../execution/tracing';
import { DEFAULT_TRACE_DIR } from '../traces/format';
import { findTraces, listTraces, readTrace, type TraceSummary } from '../traces/readTraces';
import { parseCommand, stringValue, usageError, type CommandSpec } from './args';

const USAGE =
  'Usage: lousho traces [--dir D] [--limit N] [--json]\n       lousho traces <traceId|prefix> [--dir D] [--json] [--content]';

const SPEC: CommandSpec = {
  command: 'traces',
  usage: USAGE,
  positionals: 1,
  options: {
    dir: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
    content: { type: 'boolean' },
  },
};

/** Parsed `lousho traces` arguments. */
export interface TracesArgs {
  /** A trace id or a unique prefix of one: show that trace's tree. */
  traceId?: string;
  /** The trace directory as given (default `.lousho/traces`). */
  dir: string;
  limit: number;
  json: boolean;
  content: boolean;
  help?: boolean;
}

/** Parses `lousho traces` arguments; throws `LOUSHO_CONFIG_INVALID` for a bad flag or `--limit`. */
export function parseTracesArgs(argv: string[]): TracesArgs {
  const { values, positionals, help } = parseCommand(SPEC, argv);
  const limitText = stringValue(values.limit);
  const limit = limitText === undefined ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1) throw usageError(SPEC, '--limit must be a positive integer.');
  return {
    traceId: positionals[0],
    dir: stringValue(values.dir) ?? DEFAULT_TRACE_DIR,
    limit,
    json: values.json === true,
    content: values.content === true,
    help: help || undefined,
  };
}

export interface TracesDeps {
  /** Directory `--dir` is resolved against. Default `process.cwd()`. */
  cwd?: string;
  /** Where output goes. Default `console.log`. */
  log?: (text: string) => void;
  /** The current time, for the "ago" column. Default `Date.now()`. */
  now?: number;
  /** ANSI colours. Default: stdout is a TTY and `NO_COLOR` is not set. */
  color?: boolean;
}

interface Style {
  dim: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  bold: (text: string) => string;
}

function style(color: boolean): Style {
  const wrap = (code: number) => (text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { dim: wrap(2), red: wrap(31), green: wrap(32), bold: wrap(1) };
}

/** `850ms`, `1.24s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return '-';
  return `$${cost.toFixed(cost < 0.01 ? 6 : 4)}`;
}

function formatAgo(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line of at most `max` characters: whitespace runs become one space. */
function truncate(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max);
}

/** Left-aligned columns separated by two spaces; `paint` colours a cell after padding. */
function table(rows: string[][], paint: (row: number, col: number, cell: string) => string = (_r, _c, cell) => cell): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows
    .map((row, r) => row.map((cell, c) => paint(r, c, c === row.length - 1 ? cell : cell.padEnd(widths[c]))).join('  '))
    .join('\n');
}

/** The table of recent traces. */
function renderTraceList(traces: TraceSummary[], options: { now: number; color: boolean }): string {
  const s = style(options.color);
  const header = ['TIME', 'AGENT', 'DURATION', 'MODEL', 'TOOLS', 'TOKENS IN/OUT', 'COST', 'STATUS', 'ID'];
  const rows = traces.map((trace) => [
    formatAgo(trace.startTime, options.now),
    trace.agent ?? trace.name,
    formatDuration(trace.durationMs),
    String(trace.modelCalls),
    String(trace.toolCalls),
    `${trace.inputTokens}/${trace.outputTokens}`,
    formatCost(trace.costUsd),
    trace.status,
    trace.traceId,
  ]);
  const statusCol = 7;
  return table([header, ...rows], (r, c, cell) => {
    if (r === 0) return s.bold(cell);
    if (c === statusCol) return traces[r - 1].status === 'error' ? s.red(cell) : s.green(cell);
    return cell;
  });
}

const BAR_WIDTH = 24;

function bar(span: Span, start: number, total: number): string {
  const scale = total > 0 ? BAR_WIDTH / total : 0;
  const offset = Math.min(BAR_WIDTH - 1, Math.floor((span.startTime - start) * scale));
  const length = Math.max(1, Math.min(BAR_WIDTH - offset, Math.round(((span.endTime ?? span.startTime) - span.startTime) * scale)));
  return `${' '.repeat(offset)}${'█'.repeat(length)}${' '.repeat(BAR_WIDTH - offset - length)}`;
}

function attr(span: Span, key: string): unknown {
  return span.attributes[key];
}

/** N1a: the hosted tools the provider ran inside a `chat` span's call (they have no `execute_tool` span). */
function hostedDetail(span: Span): string[] {
  const hosted = attr(span, 'lousho.hosted_tool_calls');
  return Array.isArray(hosted) && hosted.length > 0 ? [`provider ran ${hosted.join(', ')}`] : [];
}

/** Model, tokens and cost of a `chat` span; tool name of an `execute_tool` span. */
function details(span: Span): string {
  const op = attr(span, 'gen_ai.operation.name');
  const parts: string[] = [];
  if (op === 'chat') {
    const model = attr(span, 'gen_ai.response.model') ?? attr(span, 'gen_ai.request.model');
    if (typeof model === 'string') parts.push(model);
    const input = attr(span, 'gen_ai.usage.input_tokens');
    const output = attr(span, 'gen_ai.usage.output_tokens');
    if (typeof input === 'number' || typeof output === 'number') parts.push(`in ${input ?? 0} out ${output ?? 0}`);
    parts.push(...hostedDetail(span));
  } else if (op === 'execute_tool') {
    const tool = attr(span, 'gen_ai.tool.name');
    if (typeof tool === 'string') parts.push(`tool ${tool}`);
  }
  const cost = attr(span, 'lousho.cost_usd');
  if (typeof cost === 'number') parts.push(formatCost(cost));
  return parts.join('  ');
}

const CONTENT_KEYS: [label: string, keys: string[]][] = [
  ['input', ['gen_ai.input.messages']],
  ['output', ['gen_ai.output.messages']],
  ['args', ['gen_ai.tool.call.arguments', 'args']],
  ['result', ['gen_ai.tool.call.result', 'result']],
];

function contentLines(span: Span): string[] {
  const lines: string[] = [];
  for (const [label, keys] of CONTENT_KEYS) {
    const value = keys.map((key) => attr(span, key)).find((v) => v !== undefined);
    if (value === undefined) continue;
    lines.push(`${label}: ${truncate(typeof value === 'string' ? value : JSON.stringify(value), 200)}`);
  }
  return lines;
}

/** A span placed in the tree: its label (indent, branch and name) and the indent of the lines under it. */
interface TreeRow {
  label: string;
  span: Span;
  prefix: string;
}

/** Spans by parent id; a span whose parent is not in the trace sits at the top (`undefined`). */
function childrenByParent(spans: Span[]): Map<string | undefined, Span[]> {
  const ids = new Set(spans.map((span) => span.id));
  const children = new Map<string | undefined, Span[]>();
  for (const span of spans) {
    const parent = span.parentId !== undefined && ids.has(span.parentId) ? span.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  return children;
}

/** Depth-first rows; `indent` is what goes before this level's branch. */
function treeRows(children: Map<string | undefined, Span[]>, parent: string | undefined, indent: string, rows: TreeRow[]): TreeRow[] {
  const list = children.get(parent) ?? [];
  list.forEach((span, index) => {
    const last = index === list.length - 1;
    if (parent === undefined) {
      rows.push({ label: `${indent}${span.name}`, span, prefix: indent });
      treeRows(children, span.id, indent, rows);
      return;
    }
    const childIndent = `${indent}${last ? '   ' : '│  '}`;
    rows.push({ label: `${indent}${last ? '└─ ' : '├─ '}${span.name}`, span, prefix: childIndent });
    treeRows(children, span.id, childIndent, rows);
  });
  return rows;
}

function spanDuration(span: Span): number {
  return (span.endTime ?? span.startTime) - span.startTime;
}

/** The lines of one row: the span line, its error message, and with `content` its captured content. */
function rowLines(row: TreeRow, layout: { labelWidth: number; start: number; total: number; content: boolean }, s: Style): string[] {
  const error = row.span.status?.code === 'error';
  const label = clip(row.label, layout.labelWidth).padEnd(layout.labelWidth);
  const duration = formatDuration(spanDuration(row.span)).padStart(8);
  const info = [details(row.span), error ? s.red('error') : ''].filter(Boolean).join('  ');
  const lines = [`${label}  ${s.dim('|')}${bar(row.span, layout.start, layout.total)}${s.dim('|')}  ${duration}  ${info}`.trimEnd()];
  const message = error ? row.span.status?.message : undefined;
  if (message) lines.push(s.red(`${row.prefix}   ${truncate(message, 200)}`));
  if (layout.content) lines.push(...contentLines(row.span).map((line) => s.dim(`${row.prefix}   ${line}`)));
  return lines;
}

/** One trace as a tree: one line per span, indented under its parent, with a duration bar scaled to the trace. */
function renderTraceTree(traceId: string, spans: Span[], options: { color: boolean; content: boolean }): string {
  const s = style(options.color);
  const start = Math.min(...spans.map((span) => span.startTime));
  const total = Math.max(...spans.map((span) => span.endTime ?? span.startTime)) - start;
  const rows = treeRows(childrenByParent(spans), undefined, '', []);
  const layout = { labelWidth: Math.min(56, Math.max(...rows.map((row) => row.label.length))), start, total, content: options.content };
  const header = s.bold(`Trace ${traceId}`) + s.dim(`  ${spans.length} spans, ${formatDuration(total)}`);
  return [header, ...rows.flatMap((row) => rowLines(row, layout, s))].join('\n');
}

function noTracesHint(dir: string): string {
  return `No traces in ${dir}. Add exporter: fileTraceExporter() to createAgent().`;
}

async function showList(args: TracesArgs, dir: string, deps: Required<TracesDeps>): Promise<number> {
  const traces = await listTraces({ dir, limit: args.limit });
  if (args.json) {
    deps.log(JSON.stringify(traces, null, 2));
    return 0;
  }
  deps.log(traces.length === 0 ? noTracesHint(args.dir) : renderTraceList(traces, deps));
  return 0;
}

async function showTrace(args: TracesArgs, traceId: string, dir: string, deps: Required<TracesDeps>): Promise<number> {
  const matches = findTraces(traceId, { dir });
  if (matches.length === 0) {
    console.error(`lousho traces: no trace matches '${traceId}' in ${args.dir}.`);
    return 1;
  }
  if (matches.length > 1) {
    console.error(`lousho traces: '${traceId}' matches ${matches.length} traces; give more of the id:`);
    for (const match of matches) console.error(`  ${match.traceId}`);
    return 1;
  }
  const spans = await readTrace(matches[0].traceId, { dir });
  if (args.json) {
    deps.log(JSON.stringify(spans, null, 2));
    return 0;
  }
  deps.log(spans.length === 0 ? `Trace ${matches[0].traceId} is empty.` : renderTraceTree(matches[0].traceId, spans, { color: deps.color, content: args.content }));
  return 0;
}

/**
 * CLI entry point. Resolves with the exit code: 0 shown (or nothing saved
 * yet), 1 no trace or several match the id, 2 bad arguments.
 */
export async function runTraces(rest: string[], deps: TracesDeps = {}): Promise<number> {
  const resolved: Required<TracesDeps> = {
    cwd: deps.cwd ?? process.cwd(),
    log: deps.log ?? ((text) => console.log(text)),
    now: deps.now ?? Date.now(),
    color: deps.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR),
  };
  try {
    const args = parseTracesArgs(rest);
    if (args.help) {
      resolved.log(USAGE);
      return 0;
    }
    const dir = path.resolve(resolved.cwd, args.dir);
    return args.traceId === undefined ? await showList(args, dir, resolved) : await showTrace(args, args.traceId, dir, resolved);
  } catch (error) {
    const hint = (error as { hint?: string }).hint;
    console.error(error instanceof Error ? error.message : String(error));
    if (hint) console.error(hint);
    return 2;
  }
}
