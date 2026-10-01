/**
 * Runnable example: AgentExecutor.execute() wired to the console
 * TraceExporter (LOU-E6).
 *
 * Run with:
 *   npm run example:tracing:console
 */

import { createConsoleExporter } from './console-exporter';
import { runWeatherScenario } from './weather-scenario';

async function main() {
  await runWeatherScenario(createConsoleExporter());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
