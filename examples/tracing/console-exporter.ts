/**
 * Console TraceExporter
 *
 * The simplest possible TraceExporter (LOU-E6): logs a line to the
 * console when a span starts and another when it ends, indenting child
 * spans (matched via Span.parentId) under their parent for readability.
 * Useful for local development, or as a template for writing a bridge
 * into a real tracing backend (see otel-exporter.ts for that).
 */

import { Span, TraceExporter } from '../../src/execution/tracing';

export function createConsoleExporter(): TraceExporter {
  // Tracks depth so nested spans (llm.generate/tool.call under agent.run)
  // print indented, purely as a readability aid.
  const depthById = new Map<string, number>();

  return {
    onSpanStart(span: Span) {
      const depth = span.parentId ? (depthById.get(span.parentId) ?? 0) + 1 : 0;
      depthById.set(span.id, depth);
      const indent = '  '.repeat(depth);
      console.log(
        `${indent}-> [span start] ${span.name} (id=${span.id}${
          span.parentId ? `, parent=${span.parentId}` : ''
        }) attrs=${JSON.stringify(span.attributes)}`
      );
    },
    onSpanEnd(span: Span) {
      const depth = depthById.get(span.id) ?? 0;
      const indent = '  '.repeat(depth);
      const durationMs =
        span.endTime !== undefined ? span.endTime - span.startTime : undefined;
      console.log(
        `${indent}<- [span end]   ${span.name} (id=${span.id}) duration=${durationMs}ms attrs=${JSON.stringify(
          span.attributes
        )}`
      );
      depthById.delete(span.id);
    },
  };
}
