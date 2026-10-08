/**
 * How good is the SDK's token estimate (what compaction decides on) for this
 * agent's real requests? Builds the step-2 request of a triage run with
 * mockModel (real tools, real outputs), then asks LM Studio to bill the exact
 * same request (maxTokens 1) and compares.
 *
 *   npx tsx log-incident/repro/token-estimate.ts
 */
process.env.MAX_LINE ??= '600';
import { createAgent, estimateTokens, getModelInfo, type GenerateOptions } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { IncidentReport, INSTRUCTIONS, tools } from '../logs.js';
import { provider0 } from '../agent.js';
import { LOCAL_MODEL } from '../../_shared/local.js';

const model = mockModel([
  { toolCalls: [
    { name: 'status_per_minute', args: { from: '13:30', to: '15:00' } },
    { name: 'search_logs', args: { pattern: 'deploy|scale|restart', source: 'app', limit: 15 } },
    { name: 'search_logs', args: { pattern: 'too many clients|timeout exceeded', limit: 30 } },
  ] },
  '{}',
]);
await createAgent({ provider: model, instructions: INSTRUCTIONS, tools, output: IncidentReport, maxSteps: 2 }).send('Pager fired at 14:12 UTC: checkout is failing. Investigate the logs and produce the incident report.');
console.log(`registry contextWindow for '${LOCAL_MODEL}': ${getModelInfo(LOCAL_MODEL)?.contextWindow ?? 'unknown -> compaction assumes 128000'}`);

const p = provider0();
for (const [i, call] of model.calls.entries()) {
  const req = call as unknown as GenerateOptions;
  const est = estimateTokens(req.messages);
  const toolsJson = JSON.stringify(req.tools ?? []);
  const schemaJson = JSON.stringify((req as any).responseFormat ?? {});
  let real: number | string = '?';
  for (let a = 0; a < 12 && real === '?'; a++) {
    try {
      const r = await p.generate({ ...req, maxTokens: 16, responseFormat: undefined } as GenerateOptions);
      real = r.usage?.promptTokens ?? 'n/a';
    } catch (e) { await new Promise((r) => setTimeout(r, 5000)); }
  }
  console.log(`request ${i + 1}: messages=${req.messages.length} chars=${JSON.stringify(req.messages).length} | SDK estimate (messages only)=${est} | tools JSON ${toolsJson.length} chars (~${Math.round(toolsJson.length / 4)} tok, not estimated) | responseFormat schema ${schemaJson.length} chars | LM Studio prompt tokens=${real}${typeof real === 'number' ? ` | estimate/real=${(est / real).toFixed(2)}` : ''}`);
}
