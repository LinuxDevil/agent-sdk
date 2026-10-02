/**
 * Runnable example: AgentExecutor.execute() wired to a real OpenTelemetry
 * NodeTracerProvider, using OTel's own ConsoleSpanExporter so the emitted
 * spans are visible without needing a real collector (LOU-E6, LOU-K4).
 *
 * The TraceExporter itself comes from the bundled, opt-in
 * `createOtelTraceExporter()` (src/execution/otel.ts) - this example only
 * wires up the OTel SDK plumbing (a NodeTracerProvider + span processor)
 * that decides *where* the spans go; the SDK-to-OTel translation is no
 * longer hand-rolled here.
 *
 * LOU-D48: the same exporter also records the GenAI metrics
 * (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`) through
 * whatever global MeterProvider is registered; here an OTel MeterProvider
 * prints them to the console on shutdown. The spans carry `lousho.cost_usd`.
 *
 * Run with:
 *   npm run example:tracing:otel
 */

import { metrics } from '@opentelemetry/api';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  NodeTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { createOtelTraceExporter } from '../../src/execution/otel';
import { runWeatherScenario } from './weather-scenario';

async function main() {
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  provider.register();
  const tracer = provider.getTracer('lousho-tracing-example');

  // Metrics go wherever the global MeterProvider sends them. `shutdown()`
  // below flushes them to the console once.
  const meterProvider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() })],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  // In real usage the tracer name is enough - `createOtelTraceExporter()`
  // will resolve one via `trace.getTracer(...)` for you. Passing the
  // tracer explicitly here just reuses the one obtained above.
  const exporter = createOtelTraceExporter({ tracer });

  await runWeatherScenario(exporter);

  await provider.shutdown();
  await meterProvider.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
