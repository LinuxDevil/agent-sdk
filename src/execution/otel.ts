/**
 * Bundled, opt-in OpenTelemetry TraceExporter (LOU-K4).
 *
 * `tracing.ts` deliberately ships no bundled exporter - `withSpan()` /
 * `TraceExporter` are a bring-your-own-exporter abstraction so this SDK
 * never forces a tracing backend on every consumer. Historically, wiring
 * that up to real OpenTelemetry meant hand-rolling the adapter shown in
 * `examples/tracing/run-otel.ts` (LOU-E6) every time.
 *
 * This module is the ready-made version of that adapter: import
 * `createOtelTraceExporter()` from the `@loushy/build-ai-agent/otel`
 * subpath to translate this SDK's Span/TraceExporter shape into real
 * OpenTelemetry spans via `@opentelemetry/api`'s `trace.getTracer(...)`,
 * without pulling any OTel SDK/exporter backend into this package.
 *
 * `@opentelemetry/api` is an OPTIONAL peer dependency (see package.json) -
 * it is only required at runtime by consumers who import this subpath.
 * Importing `@loushy/build-ai-agent` (or any other subpath) never loads
 * this module and never requires `@opentelemetry/api` to be installed.
 * If it isn't installed, importing `@loushy/build-ai-agent/otel` throws a
 * clear module-not-found error at that import site, not at package-import
 * time.
 */

import { trace, context, Context, Span as OtelSpan, Tracer } from '@opentelemetry/api';
import { Span, TraceExporter } from './tracing';

/**
 * Options for {@link createOtelTraceExporter}.
 */
export interface OtelTraceExporterOptions {
  /**
   * Name passed to `trace.getTracer(tracerName, tracerVersion)`. Defaults
   * to `'@loushy/build-ai-agent'`. Ignored when `tracer` is supplied.
   */
  tracerName?: string;
  /**
   * Version passed to `trace.getTracer(tracerName, tracerVersion)`.
   * Ignored when `tracer` is supplied.
   */
  tracerVersion?: string;
  /**
   * Use an already-obtained OTel `Tracer` instead of resolving one via
   * `trace.getTracer(...)`. Useful when the host app manages its own
   * `TracerProvider` registration and wants full control over which
   * tracer instance is used.
   */
  tracer?: Tracer;
}

/**
 * Creates a {@link TraceExporter} that starts/ends a real OpenTelemetry
 * span for every `Span` this SDK produces, propagating parent/child
 * relationships (`Span.parentId`) into OTel's context API so a real OTel
 * backend sees the same `agent.run` -> `llm.generate`/`tool.call` span
 * tree that `withSpan()` builds internally.
 *
 * This only depends on `@opentelemetry/api` (the OTel instrumentation
 * API), not any concrete SDK/exporter backend - the host application is
 * responsible for registering a `TracerProvider` (e.g. via
 * `@opentelemetry/sdk-trace-node`) so the spans emitted here actually go
 * somewhere. Without a registered provider, OTel's default no-op tracer
 * is used and spans are silently discarded, which is safe but means
 * nothing is exported.
 *
 * @example
 * ```ts
 * import { createOtelTraceExporter } from '@loushy/build-ai-agent/otel';
 *
 * const exporter = createOtelTraceExporter({ tracerName: 'my-agent' });
 * await AgentExecutor.execute({ agent, input, provider, toolRegistry, exporter });
 * ```
 */
export function createOtelTraceExporter(options: OtelTraceExporterOptions = {}): TraceExporter {
  const tracer =
    options.tracer ?? trace.getTracer(options.tracerName ?? '@loushy/build-ai-agent', options.tracerVersion);

  // Our Span.id -> the OTel span + context it was started in, so a child
  // Span (matched by parentId) can be started as a child of the right
  // OTel context instead of the ambient one.
  const otelSpansById = new Map<string, { span: OtelSpan; ctx: Context }>();

  return {
    onSpanStart(span: Span) {
      const parentEntry = span.parentId ? otelSpansById.get(span.parentId) : undefined;
      const parentContext = parentEntry ? parentEntry.ctx : context.active();

      const otelSpan = tracer.startSpan(span.name, { startTime: span.startTime }, parentContext);

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
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      otelSpan.setAttribute(key, value);
    } else {
      otelSpan.setAttribute(key, JSON.stringify(value));
    }
  }
}
