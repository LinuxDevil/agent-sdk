/** The trace file format shared by fileTraceExporter() and the readers (M5a). */
import type { SpanKind, SpanStatus } from '../execution/tracing';

/** Where trace files go unless `dir` says otherwise (relative to the working directory). */
export const DEFAULT_TRACE_DIR = '.lousho/traces';

/** One line of a trace file: one finished span. */
export interface TraceLine {
  /** Format version. */
  v: 1;
  /** The id of the trace's root span; also the file name. */
  traceId: string;
  id: string;
  parentId?: string;
  name: string;
  kind?: SpanKind;
  status?: SpanStatus;
  /** Milliseconds since the epoch. */
  startTime: number;
  endTime: number;
  attributes: Record<string, unknown>;
}
