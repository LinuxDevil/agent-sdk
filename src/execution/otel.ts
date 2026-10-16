/**
 * Bundled, opt-in OpenTelemetry TraceExporter.
 *
 * `tracing.ts` deliberately ships no bundled exporter - `withSpan()` /
 * `TraceExporter` are a bring-your-own-exporter abstraction so this SDK
 * never forces a tracing backend on every consumer. Historically, wiring
 * that up to real OpenTelemetry meant hand-rolling the adapter shown in
 * `examples/tracing/run-otel.ts` every time.
 *
 * This module is the ready-made version of that adapter: import
 * `createOtelTraceExporter()` from the `@lousho/build-ai-agent/otel`
 * subpath to translate this SDK's Span/TraceExporter shape into real
 * OpenTelemetry spans via `@opentelemetry/api`'s `trace.getTracer(...)`,
 * without pulling any OTel SDK/exporter backend into this package.
 *
 * `@opentelemetry/api` is an OPTIONAL peer dependency (see package.json) -
 * it is only required at runtime by consumers who import this subpath.
 * Importing `@lousho/build-ai-agent` (or any other subpath) never loads
 * this module and never requires `@opentelemetry/api` to be installed.
 * If it isn't installed, importing `@lousho/build-ai-agent/otel` throws a
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
  LegacyAttr,
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
   * to `'@lousho/build-ai-agent'`. Ignored when `tracer` is supplied.
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
   * duration per tool call) alongside the spans. Default `true`;
   * without a registered `MeterProvider` OTel's no-op meter discards them.
   * See docs/observability.md.
   */
  metrics?: boolean;
  /**
   * Use an already-obtained OTel `Meter` instead of
   * `metrics.getMeter(tracerName, tracerVersion)`. Ignored when `metrics` is `false`.
   */
  meter?: Meter;
  /**
   * Also set the deprecated pre-semconv attribute names (`model`,
   * `promptTokens`, `completionTokens`, `totalTokens`, `finishReason`,
   * `toolName`, `latencyMs`, `error`, and the opt-in content ones) next to the
   * `gen_ai.*` ones. Default `true`; `false` keeps only the semantic-convention
   * attributes, halving the attribute count of every span. The SDK's own
   * spans (`fileTraceExporter`, custom exporters) are unaffected.
   */
  legacyAttributes?: boolean;
  /**
   * Set the run's total `gen_ai.usage.input_tokens` / `output_tokens` on
   * `invoke_agent` spans. Default `true`. Those totals repeat the tokens of
   * the run's `chat` spans (and a lead's total repeats its sub-agents'), so a
   * backend that sums `gen_ai.usage.*` over every span of a trace counts each
   * token two or more times; `false` leaves the usage attributes on `chat`
   * spans only. The run's cost (`lousho.cost_usd`) and the token metric are
   * unaffected.
   */
  agentUsageTotals?: boolean;
}

/** How many ended spans of still-open trees an exporter keeps for parenting late children. */
const MAX_ENDED_SPANS = 10_000;

/**
 * How many open spans an exporter tracks at most. Past it, the oldest open span (in practice one of a run
 * abandoned mid-approval, whose root never ends) is ended and exported as-is, with `lousho.span.evicted`, and
 * released.
 */
const MAX_OPEN_SPANS = 100_000;

const LEGACY_KEYS: ReadonlySet<string> = new Set(Object.values(LegacyAttr));

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
 * import { createOtelTraceExporter } from '@lousho/build-ai-agent/otel';
 *
 * const exporter = createOtelTraceExporter({ tracerName: 'my-agent' });
 * await AgentExecutor.execute({ agent, input, provider, toolRegistry, exporter });
 * ```
 */
export function createOtelTraceExporter(options: OtelTraceExporterOptions = {}): TraceExporter {
  const tracer =
    options.tracer ?? trace.getTracer(options.tracerName ?? '@lousho/build-ai-agent', options.tracerVersion);

  // Our Span.id -> the OTel span + context it was started in, so a child
  // Span (matched by parentId) can be started as a child of the right
  // OTel context instead of the ambient one.
  const recordMetrics = resolveMetricsRecorder(options);
  const skip = skippedKeys(options);

  // Entries outlive their span: a queued background sub-agent can start after
  // its `execute_tool task` parent ended, and must still join that trace.
  // A whole tree's entries are dropped when its root span ends.
  const otelSpansById = new Map<string, { span: OtelSpan; ctx: Context; rootId: string }>();
  // The ids of ended (non-root) spans still in the map, oldest end first: only these are evicted past the
  // cap, so an open span (a long run's root) is never lost.
  const endedIds = new Set<string>();

  const release = (id: string) => {
    otelSpansById.delete(id);
    endedIds.delete(id);
  };

  const evictOldestOpen = () => {
    for (const [id, entry] of otelSpansById) {
      if (endedIds.has(id)) continue;
      entry.span.setAttribute('lousho.span.evicted', true);
      entry.span.end();
      release(id);
      return;
    }
  };

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
      setAttributes(otelSpan, span.attributes, skip(span));

      const ctx = trace.setSpan(parentContext, otelSpan);
      otelSpansById.set(span.id, { span: otelSpan, ctx, rootId: parentEntry ? parentEntry.rootId : span.id });
      // A tree whose root never ends (a run abandoned mid-approval, a process that stopped awaiting it) would keep
      // its open spans forever: past a much larger cap the oldest open one is ended and released.
      if (otelSpansById.size - endedIds.size > MAX_OPEN_SPANS) evictOldestOpen();
    },

    onSpanEnd(span: Span) {
      const entry = otelSpansById.get(span.id);
      if (!entry) {
        return;
      }

      setAttributes(entry.span, span.attributes, skip(span));
      if (span.status?.code === 'error') {
        entry.span.setStatus({ code: SpanStatusCode.ERROR, message: span.status.message });
      }
      entry.span.end(span.endTime);
      if (entry.rootId === span.id) {
        for (const [id, other] of otelSpansById) {
          if (other.rootId === span.id) release(id);
        }
      } else {
        endedIds.add(span.id);
        if (endedIds.size > MAX_ENDED_SPANS) {
          const oldest = endedIds.values().next().value;
          if (oldest !== undefined) release(oldest);
        }
      }
      recordMetrics(span);
    },
  };
}

/** The metrics recorder for `options`: a no-op when `metrics` is `false`. */
function resolveMetricsRecorder(options: OtelTraceExporterOptions): (span: Span) => void {
  if (options.metrics === false) return () => undefined;
  const name = options.tracerName ?? '@lousho/build-ai-agent';
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

const AGENT_USAGE_KEYS: ReadonlySet<string> = new Set([GenAiAttr.USAGE_INPUT_TOKENS, GenAiAttr.USAGE_OUTPUT_TOKENS]);

/** The attribute names `options` leaves out of a span's OTel attributes. */
function skippedKeys(options: OtelTraceExporterOptions): (span: Span) => (key: string) => boolean {
  const skipLegacy = options.legacyAttributes === false;
  const skipAgentUsage = options.agentUsageTotals === false;
  return (span) => {
    const agentUsage = skipAgentUsage && span.attributes[GenAiAttr.OPERATION_NAME] === GenAiOperation.INVOKE_AGENT;
    return (key) => (skipLegacy && LEGACY_KEYS.has(key)) || (agentUsage && AGENT_USAGE_KEYS.has(key));
  };
}

function setAttributes(otelSpan: OtelSpan, attributes: Record<string, unknown>, skip: (key: string) => boolean): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && !skip(key)) {
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
