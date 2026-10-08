/**
 * Standalone script: POSTs a synthetic ErrorSignal at the running
 * ops-pipeline demo's /webhook endpoint (LOU-J8 README step).
 *
 * Usage: tsx examples/ops-pipeline/mocks/sendSyntheticError.ts [port]
 * (defaults to port 8787, matching index.ts's default monitor port)
 */
import { sendSyntheticError, exampleErrorSignal } from './mockGrafanaSender';

async function main() {
  const port = Number(process.argv[2] || process.env.MONITOR_PORT) || 8787;
  const url = `http://127.0.0.1:${port}/webhook`;
  const signal = exampleErrorSignal();

  console.log(`POSTing synthetic error signature "${signal.signature}" to ${url} ...`);
  const response = await sendSyntheticError(url, signal);
  const body = await response.json();
  console.log(`Response ${response.status}:`, body);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
