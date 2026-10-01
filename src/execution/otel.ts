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

import {
  trace,
  context,
  metrics as otelMetrics,
  Attributes,
  AttributeValue,
  Context,
  Histogram,
  Meter,
  Span as OtelSpan,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  Tracer,
} from '@opentelemetry/api';
import {
  ErrorAttr,
  GenAiAttr,
  GenAiMetric,
  GenAiOperation,
  OPERATION_DURATION_BUCKETS,
  TOKEN_USAGE_BUCKETS,
  TokenType,
} from './semconv';
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
  /**
   * Record the OpenTelemetry GenAI client metrics `gen_ai.client.token.usage`
   * and `gen_ai.client.operation.duration` (one record per model call, and a
   * duration per tool call) alongside the spans (LOU-D48). Default `true`;
   * without a registered `MeterProvider` OTel's no-op meter discards them.
   * See docs/observability.md.
   */
  metrics?: boolean;
  /**
   * Use an already-obtained OTel `Meter` instead of
   * `metrics.getMeter(tracerName, tracerVersion)`. Ignored when `metrics` is `false`.
   */
  meter?: Meter;
}

/**
 * Creates a {@link TraceExporter} that starts/ends a real OpenTelemetry
 * span for every `Span` this SDK produces, propagating parent/child
 * relationships (`Span.parentId`) into OTel's context API so a real OTel
 * backend sees the same `invoke_agent` -> `chat`/`execute_tool` span
 * tree that `withSpan()` builds internally, with span kind and error status
 * carried over. Span names and attributes follow the OpenTelemetry GenAI
 * semantic conventions (see `semconv.ts`; message content is opt-in via
 * `captureContent` on `AgentExecutor.execute()`/`FlowExecutor`).
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
  const recordMetrics = resolveMetricsRecorder(options);

  const otelSpansById = new Map<string, { span: OtelSpan; ctx: Context }>();

  return {
    onSpanStart(span: Span) {
      const parentEntry = span.parentId ? otelSpansById.get(span.parentId) : undefined;
      const parentContext = parentEntry ? parentEntry.ctx : context.active();

      const otelSpan = tracer.startSpan(
        span.name,
        { startTime: span.startTime, kind: span.kind === 'client' ? OtelSpanKind.CLIENT : OtelSpanKind.INTERNAL },
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
      if (span.status?.code === 'error') {
        entry.span.setStatus({ code: SpanStatusCode.ERROR, message: span.status.message });
      }
      entry.span.end(span.endTime);
      otelSpansById.delete(span.id);
      recordMetrics(span);
    },
  };
}

/** The metrics recorder for `options`: a no-op when `metrics` is `false`. */
function resolveMetricsRecorder(options: OtelTraceExporterOptions): (span: Span) => void {
  if (options.metrics === false) return () => undefined;
  const name = options.tracerName ?? '@loushy/build-ai-agent';
  return createMetricsRecorder(options.meter ?? otelMetrics.getMeter(name, options.tracerVersion));
}

/**
 * Returns the function that records a finished span's GenAI client metrics:
 * duration for `chat` and `execute_tool` spans, and token usage (input and
 * output) for `chat` spans that carry token counts.
 */
function createMetricsRecorder(meter: Meter): (span: Span) => void {
  const tokenUsage = meter.createHistogram(GenAiMetric.TOKEN_USAGE, {
    description: 'Number of input and output tokens used',
    unit: '{token}',
    advice: { explicitBucketBoundaries: TOKEN_USAGE_BUCKETS },
  });
  const duration = meter.createHistogram(GenAiMetric.OPERATION_DURATION, {
    description: 'GenAI operation duration',
    unit: 's',
    advice: { explicitBucketBoundaries: OPERATION_DURATION_BUCKETS },
  });

  return (span) => {
    const attributes = metricAttributes(span);
    if (!attributes) return;
    if (span.endTime !== undefined) {
      duration.record((span.endTime - span.startTime) / 1000, attributes);
    }
    recordTokens(tokenUsage, span, attributes);
  };
}

/** Metric attributes of a `chat` / `execute_tool` span; `undefined` for any other span. */
function metricAttributes(span: Span): Attributes | undefined {
  const operation = span.attributes[GenAiAttr.OPERATION_NAME];
  if (operation !== GenAiOperation.CHAT && operation !== GenAiOperation.EXECUTE_TOOL) {
    return undefined;
  }
  const keys = [GenAiAttr.PROVIDER_NAME, GenAiAttr.REQUEST_MODEL, GenAiAttr.RESPONSE_MODEL, ErrorAttr.TYPE];
  const attributes: Attributes = { [GenAiAttr.OPERATION_NAME]: operation };
  for (const key of keys) {
    const value = span.attributes[key];
    if (typeof value === 'string') attributes[key] = value;
  }
  return attributes;
}

function recordTokens(histogram: Histogram, span: Span, attributes: Attributes): void {
  const counts = {
    [TokenType.INPUT]: span.attributes[GenAiAttr.USAGE_INPUT_TOKENS],
    [TokenType.OUTPUT]: span.attributes[GenAiAttr.USAGE_OUTPUT_TOKENS],
  };
  for (const [type, count] of Object.entries(counts)) {
    if (typeof count === 'number') histogram.record(count, { ...attributes, [GenAiAttr.TOKEN_TYPE]: type });
  }
}

function setAttributes(otelSpan: OtelSpan, attributes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      otelSpan.setAttribute(key, toOtelAttributeValue(value));
    }
  }
}

// OTel attribute values must be a primitive or an array of a single
// primitive type - stringify anything else (objects/arrays of
// objects, e.g. `prompt`/`args`/`result`) so nothing throws.
function toOtelAttributeValue(value: unknown): AttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (isHomogeneousPrimitiveArray(value)) {
    return value;
  }
  return JSON.stringify(value);
}

// e.g. `gen_ai.response.finish_reasons` is a string[] attribute in the spec.
function isHomogeneousPrimitiveArray(value: unknown): value is string[] | number[] | boolean[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    ['string', 'number', 'boolean'].some((type) => value.every((item) => typeof item === type))
  );
}
