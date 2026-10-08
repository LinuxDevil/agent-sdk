/**
 * Does summarizeStrategy work with the local 9B reasoning model?
 * Builds a realistic 4-turn triage transcript (mockModel + real tools), then
 * runs compactMessages(summarizeStrategy({ model: local })) with two
 * maxSummaryTokens settings.
 *
 *   npx tsx log-incident/repro/summary-local.ts
 */
import { compactMessages, createAgent, summarizeStrategy } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { INSTRUCTIONS, tools } from '../logs.js';
import { provider0 } from '../agent.js';

const call = (name: string, args: Record<string, unknown>) => ({ toolCalls: [{ name, args }] });
const model = mockModel([
  call('status_per_minute', { from: '14:00', to: '14:45', pathPrefix: '/api/checkout' }),
  call('search_logs', { pattern: 'deploy|scaled|rollback', source: 'app', limit: 10 }),
  call('search_logs', { pattern: 'too many clients', source: 'postgres', limit: 5 }),
  call('logs_around', { timestamp: '14:10:40', windowSeconds: 5, excludePattern: 'request completed|healthz|pool stats', limit: 10 }),
  'done',
]);
const r = await createAgent({ provider: model, instructions: INSTRUCTIONS, tools, maxSteps: 6 }).send('Pager fired at 14:12 UTC: checkout is failing. Investigate.');
const history = r.messages;
console.log(`transcript: ${history.length} messages`);
for (const maxSummaryTokens of [400, undefined]) {
  const t0 = Date.now();
  let out;
  for (let a = 0; a < 8; a++) {
    out = await compactMessages(history, { protectedTokens: 200, contextWindow: 8192, strategy: summarizeStrategy({ model: provider0(), maxSummaryTokens }) });
    if (!out.error || !/context size|exceed/i.test(out.error.message)) break;
    console.log(`   (server busy: ${out.error.message.slice(0, 80)}) retrying`);
    await new Promise((res) => setTimeout(res, 8000));
  }
  console.log(`\n=== maxSummaryTokens=${maxSummaryTokens}: ${((Date.now() - t0) / 1000).toFixed(0)}s ${out!.tokensBefore} -> ${out!.tokensAfter} tokens, messages ${history.length} -> ${out!.messages.length}`);
  console.log(`   error: ${out!.error?.message.split('\n')[0] ?? '-'}`);
  console.log(`   summary: ${out!.summary ? JSON.stringify(out!.summary.slice(0, 1200)) : '(none)'}`);
  console.log(`   roles after: ${out!.messages.map((m) => m.role[0]).join('')}`);
}
process.exit(0);
