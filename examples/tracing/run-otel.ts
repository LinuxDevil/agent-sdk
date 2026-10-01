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
 * Run with:
 *   npm run example:tracing:otel
 */

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
  const tracer = provider.getTracer('loushy-tracing-example');

  // In real usage the tracer name is enough - `createOtelTraceExporter()`
  // will resolve one via `trace.getTracer(...)` for you. Passing the
  // tracer explicitly here just reuses the one obtained above.
  const exporter = createOtelTraceExporter({ tracer });

  await runWeatherScenario(exporter);

  await provider.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
