/**
 * OpenTelemetry TraceExporter bridge (LOU-E6)
 *
 * Bridges this SDK's Span/TraceExporter (src/execution/tracing.ts) into
 * real OpenTelemetry spans, propagating parent/child relationships
 * (Span.parentId) into OTel's context API so a real OTel backend (Jaeger,
 * Tempo, Datadog, the console exporter used by run-otel.ts, ...) sees the
 * same agent.run -> llm.generate/tool.call span tree.
 *
 * @opentelemetry/api and @opentelemetry/sdk-trace-node are DEV
 * dependencies ONLY (see package.json) - this SDK does not require or
 * ship OpenTelemetry as a runtime dependency. This file is an example of
 * how a consumer who *does* want OTel can wire it up themselves.
 */

import { trace, context, Context, Span as OtelSpan, Tracer } from '@opentelemetry/api';
import { Span, TraceExporter } from '../../src/execution/tracing';

/**
 * Creates a TraceExporter that starts/ends a real OTel span for every
 * Span this SDK produces, using `tracer` (typically obtained from a
 * configured NodeTracerProvider - see run-otel.ts).
 */
export function createOtelExporter(tracer: Tracer): TraceExporter {
  // Our Span.id -> the OTel span + context it was started in, so a child
  // Span (matched by parentId) can be started as a child of the right
  // OTel context instead of the ambient one.
  const otelSpansById = new Map<string, { span: OtelSpan; ctx: Context }>();

  return {
    onSpanStart(span: Span) {
      const parentEntry = span.parentId ? otelSpansById.get(span.parentId) : undefined;
      const parentContext = parentEntry ? parentEntry.ctx : context.active();

      const otelSpan = tracer.startSpan(
        span.name,
        { startTime: span.startTime },
        parentContext
      );

      // Seed OTel span attributes with whatever this SDK already knew at
      // span-start time (e.g. model, toolName). onSpanEnd below adds
      // whatever was filled in afterwards (token counts, results, ...).
      setAttributes(otelSpan, span.attributes);

      const ctx = trace.setSpan(parentContext, otelSpan);
      otelSpansById.set(span.id, { span: otelSpan, ctx });
    },

    onSpanEnd(span: Span) {
      const entry = otelSpansById.get(span.id);
      if (!entry) {
        return;
      }

      setAttributes(entry.span, span.attributes);
      entry.span.end(span.endTime);
      otelSpansById.delete(span.id);
    },
  };
}

function setAttributes(otelSpan: OtelSpan, attributes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    // OTel attribute values must be a primitive or an array of a single
    // primitive type - stringify anything else (objects/arrays of
    // objects, e.g. `prompt`/`args`/`result`) so nothing throws.
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      otelSpan.setAttribute(key, value);
    } else {
      otelSpan.setAttribute(key, JSON.stringify(value));
    }
  }
}
