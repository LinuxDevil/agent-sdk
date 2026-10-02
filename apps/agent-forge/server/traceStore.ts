/**
 * M5b: where Agent Forge keeps run traces, and how it reads them back.
 *
 * Every run writes the SDK's trace files (`fileTraceExporter`, the same
 * format `lousho traces` reads) to `<baseDir>/.lousho/agents/<agentId>/traces`.
 * The server only ever reads inside that folder: an agent id is validated
 * before it becomes a path segment, a trace id is matched against the file
 * names found there (never joined into a path), and the absolute file path is
 * not sent to the browser.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TraceExporter } from '@lousho/build-ai-agent';
import { listTraces, readTrace, type TraceSummary } from '@lousho/build-ai-agent/traces';
import type { SpanEvent, TraceSummaryPayload } from '../shared/wireTypes';

/** A trace id is a UUID in practice; this is the strictest shape that still allows prefixes. */
const TRACE_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

export const DEFAULT_TRACE_LIMIT = 20;
export const MAX_TRACE_LIMIT = 200;

export function isValidTraceId(id: string): boolean {
  return TRACE_ID_RE.test(id);
}

/** The agent's trace folder; `agentId` must already have passed `isValidAgentId`. */
export function agentTraceDir(baseDir: string, agentId: string): string {
  return path.join(baseDir, '.lousho', 'agents', agentId, 'traces');
}

export function traceDirExists(baseDir: string, agentId: string): boolean {
  return fs.existsSync(agentTraceDir(baseDir, agentId));
}

/** A TraceExporter that calls every exporter in turn. */
export function fanOutExporter(...exporters: TraceExporter[]): TraceExporter {
  return {
    onSpanStart: (span) => exporters.forEach((exporter) => exporter.onSpanStart?.(span)),
    onSpanEnd: (span) => exporters.forEach((exporter) => exporter.onSpanEnd?.(span)),
  };
}

function toPayload(summary: TraceSummary): TraceSummaryPayload {
  const { file, ...rest } = summary;
  void file; // the server-side path stays on the server
  return rest;
}

/** The agent's recent traces, newest first. */
export async function listAgentTraces(baseDir: string, agentId: string, limit: number): Promise<TraceSummaryPayload[]> {
  const summaries = await listTraces({ dir: agentTraceDir(baseDir, agentId), limit });
  return summaries.map(toPayload);
}

/** One trace's spans; `[]` when the agent has no such trace. */
export async function readAgentTrace(baseDir: string, agentId: string, traceId: string): Promise<SpanEvent[]> {
  return (await readTrace(traceId, { dir: agentTraceDir(baseDir, agentId) })) as SpanEvent[];
}
