/**
 * Deterministic compaction repro: real tools with big outputs, a scripted
 * model, an 8K window. Shows what the hook does at each step.
 *
 *   npx tsx log-incident/repro/compaction-mock.ts
 */
process.env.MAX_LINE ??= '600';
import { createAgent, estimateTokens, type AgentEvent, type LLMProvider } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { IncidentReport, INSTRUCTIONS, tools } from '../logs.js';

const FINAL = JSON.stringify({ title: 't', severity: 'SEV1', impactStart: 'a', impactEnd: 'b', timeline: [{ time: '1', event: 'e' }, { time: '2', event: 'e' }, { time: '3', event: 'e' }], rootCause: 'r', trigger: 't', blastRadius: { affectedEndpoints: ['/api/checkout'], unaffected: [], peak5xxPerMinute: 1 }, evidence: [{ source: 'app', line: 'x' }, { source: 'app', line: 'y' }], remediation: ['x'] });
const big = (pattern: string, limit = 30) => ({ name: 'search_logs', args: { pattern, limit } });

async function run(label: string, script: any[], summarizer: LLMProvider | undefined, extra: Record<string, unknown> = {}) {
  console.log(`\n=== ${label}`);
  const model = mockModel(script);
  const agent = createAgent({
    provider: model, instructions: INSTRUCTIONS, tools, output: IncidentReport, maxSteps: 10,
    compaction: { contextWindow: 8192, thresholdPercent: 0.6, protectedTokens: 900, ...(summarizer && { summarizer }), ...extra },
    onEvent: (e: AgentEvent) => {
      const ev = e as any;
      if (e.type === 'compaction.start') console.log(`   [step] compaction.start strategy=${ev.strategy} est=${ev.tokensBefore} threshold=${ev.thresholdTokens}`);
      if (e.type === 'compaction.done') console.log(`   [step] compaction.done strategy=${ev.strategy} ${ev.tokensBefore}->${ev.tokensAfter} pruned=${ev.prunedToolCallIds.length} summary=${!!ev.summary}${ev.error ? ' ERROR=' + ev.error.message.slice(0, 160) : ''}`);
    },
  });
  const r = await agent.send('Investigate the checkout outage.');
  for (const [i, c] of model.calls.entries()) {
    const msgs = (c as any).messages;
    console.log(`   model call ${i + 1}: est=${estimateTokens(msgs)} (+~${Math.round(JSON.stringify((c as any).tools ?? []).length / 4)} tool-schema tok unestimated) roles=${msgs.map((m: any) => m.role[0]).join('')} pruned=${msgs.filter((m: any) => String(m.content).startsWith('[pruned')).length} summary=${msgs.some((m: any) => String(m.content).startsWith('[Conversation summary]'))}`);
  }
  console.log(`   finish=${r.finishReason}`);
  return model;
}

const turns = [
  { toolCalls: [big('error'), big('warn'), { name: 'status_per_minute', args: { from: '13:30', to: '15:00' } }] },
  { toolCalls: [big('too many clients'), big('pool stats')] },
  { toolCalls: [big('deploy|rollback|scaled', 10)] },
  FINAL,
];
await run('A. prune only (compaction: { contextWindow })', turns, undefined);
await run('B. two-phase, summarizer works', turns, mockModel(Array(5).fill('Goal: triage checkout outage. Found deploy v2.41.0 at 14:02, too many clients from 14:11.')));
await run('C. two-phase, summarizer returns empty text (a reasoning model that spent maxTokens thinking)', turns, mockModel(Array(5).fill('')));
await run('D. one huge fresh result bigger than the whole window', [{ toolCalls: [big('', 30), big('.', 30), big('a', 30)] }, FINAL], undefined);
const unknown = mockModel([{ toolCalls: [big('', 30), big('.', 30), big('a', 30)] }, FINAL]);
console.log('\n=== E. compaction: true with an unregistered local model id (no contextWindow given)');
const ag = createAgent({ provider: unknown, model: 'qwen3.5-9b-uncensored-hauhaucs-aggressive', instructions: INSTRUCTIONS, tools, output: IncidentReport, compaction: true, onEvent: (e) => { if (e.type.startsWith('compaction')) console.log('   ', e.type); } });
await ag.send('go');
console.log(`   request 2 estimate=${estimateTokens((unknown.calls[1] as any).messages)} tokens; compaction events: none above => assumed 128K window`);
