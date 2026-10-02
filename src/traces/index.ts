/**
 * `@lousho/build-ai-agent/traces` (M5a): local trace files for `lousho traces`.
 * A subpath of its own because it uses `node:fs`.
 */
export { fileTraceExporter, type FileTraceExporterOptions } from './fileTraceExporter';
export { listTraces, readTrace, type ListTracesOptions, type TraceSummary } from './readTraces';
export { DEFAULT_TRACE_DIR, type TraceLine } from './format';
export type { Span, SpanKind, SpanStatus, TraceExporter } from '../execution/tracing';
