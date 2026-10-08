/**
 * SRE incident-triage agent: investigates the 2026-09-30 checkout outage from
 * nginx / app / postgres logs and returns a typed IncidentReport.
 *
 *   npx tsx log-incident/index.ts            # one run, durable (SQLite), traced
 */
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { fileTraceExporter } from '@lousho/build-ai-agent/traces';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { triageAgent, TASK, capped, provider0 } from './agent.js';
import { grade, LOCAL_CONTEXT_WINDOW } from './logs.js';


const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, '.lousho'), { recursive: true });
const store = new SqliteStore(join(here, '.lousho', 'incident.db'));
const agent = triageAgent({
  store,
  exporter: fileTraceExporter({ dir: join(here, '.lousho', 'traces') }),
  // LM Studio serves this model with an 8K window; the registry does not know it.
  compaction: { contextWindow: LOCAL_CONTEXT_WINDOW, thresholdPercent: 0.6, protectedTokens: 2500, summarizer: capped(provider0(), 1500) },
});

const sessionId = process.argv[2] ?? `triage-${Date.now()}`;
const t0 = Date.now();
// The shared LM Studio box is often saturated ("Context size has been exceeded" for any
// request). withRetry covers short blips; for longer outages the durable store lets us
// pick the run up where it stopped with agent.resume() instead of starting over.
let result: Awaited<ReturnType<typeof agent.send>> | null = null;
for (let attempt = 0; attempt < Number(process.env.RESUMES ?? 6) && !result; attempt++) {
  try {
    result = attempt === 0 ? await agent.send(TASK, { sessionId }) : await agent.resume(sessionId);
  } catch (e) {
    const cp = await store.checkpoints.load(sessionId);
    console.log(`[run attempt ${attempt + 1}] ${(e as Error).name}: ${(e as Error).message.slice(0, 140)}`);
    console.log(`   checkpoint: status=${(cp as any)?.status} step=${(cp as any)?.stepIndex} messages=${(cp as any)?.messages?.length}; resuming in 20s`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
}
if (!result) throw new Error('gave up');
console.log('\n=== finishReason:', result.finishReason, 'steps:', result.steps, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('usage:', JSON.stringify(result.usage), 'cost:', JSON.stringify((result as any).cost));
console.log('toolCalls:', result.toolCalls?.map((c: any) => c.toolName ?? c.name).join(', '));
if (result.object) {
  console.log(JSON.stringify(result.object, null, 2));
  console.log('grade:', JSON.stringify(grade(result.object)));
} else {
  console.log('outputError:', JSON.stringify(result.outputError));
  console.log('raw text:', result.text?.slice(0, 1500));
}
store.close();
