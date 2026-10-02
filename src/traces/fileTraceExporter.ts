/**
 * fileTraceExporter() (M5a): a TraceExporter that writes every finished span
 * as one JSON line to `<dir>/<YYYY-MM-DD>/<traceId>.jsonl`, for
 * `lousho traces` and anything else that reads the files. No backend, no
 * peer dependency.
 *
 * - One file per trace; the trace id is the id of the root span (the span
 *   with no parent this exporter has seen start). The date folder is the
 *   root span's local start date.
 * - A span is written when it ends (`withSpan` always ends its spans), with
 *   `fs.appendFileSync`, so each line is complete on its own.
 * - Attributes are written whole (content can be large with
 *   `captureContent`); only the terminal view truncates.
 * - A write error is reported once with `console.warn` and never thrown into
 *   the run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Span, TraceExporter } from '../execution/tracing';
import { DEFAULT_TRACE_DIR, type TraceLine } from './format';

export interface FileTraceExporterOptions {
  /** Where trace files go. Default `.lousho/traces`, resolved against `process.cwd()` when the exporter is created. */
  dir?: string;
}

/** Where a span's lines go: its trace and that trace's file. */
interface TraceTarget {
  traceId: string;
  file: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local date of `time` as `YYYY-MM-DD`. */
function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A JSON.stringify replacer that turns bigints into strings and repeated objects (cycles) into `"[Circular]"`. */
function safeReplacer(): (key: string, item: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function replace(_key, item) {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object' || item === null) return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    return item;
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value, safeReplacer());
}

/** The line written for a finished span. */
function lineOf(span: Span, traceId: string): TraceLine {
  return {
    v: 1,
    traceId,
    id: span.id,
    ...(span.parentId !== undefined && { parentId: span.parentId }),
    name: span.name,
    ...(span.kind !== undefined && { kind: span.kind }),
    ...(span.status !== undefined && { status: span.status }),
    startTime: span.startTime,
    endTime: span.endTime ?? Date.now(),
    attributes: span.attributes,
  };
}

/**
 * A TraceExporter that keeps every run as a JSON Lines file under `dir`
 * (default `.lousho/traces`). Pass it to `createAgent({ exporter })` or
 * `AgentExecutor.execute({ exporter })`, then run `npx lousho traces`.
 *
 * @example
 * ```ts
 * import { createAgent } from '@lousho/build-ai-agent';
 * import { fileTraceExporter } from '@lousho/build-ai-agent/traces';
 *
 * const agent = createAgent({ model: 'openai/gpt-4o-mini', exporter: fileTraceExporter() });
 * ```
 */
export function fileTraceExporter(options: FileTraceExporterOptions = {}): TraceExporter {
  const dir = path.resolve(options.dir ?? DEFAULT_TRACE_DIR);
  /** Open spans' targets, by span id; a trace's entries are dropped when its root ends. */
  const targets = new Map<string, TraceTarget>();
  const madeDirs = new Set<string>();
  let warned = false;

  const write = (file: string, line: TraceLine) => {
    try {
      const folder = path.dirname(file);
      if (!madeDirs.has(folder)) {
        fs.mkdirSync(folder, { recursive: true });
        madeDirs.add(folder);
      }
      fs.appendFileSync(file, `${toJson(line)}\n`);
    } catch (error) {
      if (warned) return;
      warned = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`lousho: fileTraceExporter could not write to ${dir}; traces of this process are not saved (${reason}).`);
    }
  };

  return {
    onSpanStart(span) {
      // A span's parent always starts first, so its target is known; an unknown parent starts a trace of its own.
      const parent = span.parentId !== undefined ? targets.get(span.parentId) : undefined;
      targets.set(
        span.id,
        parent ?? { traceId: span.id, file: path.join(dir, localDay(span.startTime), `${span.id}.jsonl`) }
      );
    },
    onSpanEnd(span) {
      const target = targets.get(span.id) ?? {
        traceId: span.id,
        file: path.join(dir, localDay(span.startTime), `${span.id}.jsonl`),
      };
      write(target.file, lineOf(span, target.traceId));
      if (target.traceId !== span.id) return;
      for (const [id, entry] of targets) {
        if (entry.traceId === span.id) targets.delete(id);
      }
    },
  };
}
