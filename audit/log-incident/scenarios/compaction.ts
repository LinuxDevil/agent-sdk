/**
 * Compaction audit against the real 8K-context local model.
 *
 * Big tool outputs (MAX_LINE=600, limit up to 30 lines) + a small threshold so
 * the hook must prune and then summarize with the local model. For every model
 * call we print: the SDK's token estimate before compaction (an earlier hook),
 * what compaction did, and the prompt tokens LM Studio actually billed.
 *
 *   STREAM=0 npx tsx log-incident/scenarios/compaction.ts
 */
process.env.MAX_LINE ??= '600';
import { estimateTokens, type AgentHook } from '@lousho/build-ai-agent';

const { triageAgent, TASK, capped, provider0 } = await import('../agent.js');

const rows: { step: number; estimateBefore: number; msgs: number; compaction?: string; realPrompt?: number; estToolsChars?: number }[] = [];
let step = 0;
const measure: AgentHook = {
  name: 'measure',
  preGenerate(ctx) {
    step++;
    const toolsChars = JSON.stringify(ctx.request.tools ?? []).length;
    rows.push({ step, estimateBefore: estimateTokens(ctx.request.messages), msgs: ctx.request.messages.length, estToolsChars: toolsChars });
  },
};
const summaries: string[] = [];
const agent = triageAgent({
  quiet: true,
  hooks: [measure],
  maxSteps: 12,
  compaction: {
    contextWindow: 8192,
    thresholdPercent: Number(process.env.THRESHOLD ?? 0.4), // ~3.3K tokens
    protectedTokens: Number(process.env.PROTECTED ?? 900),
    summarizer: capped(provider0(), Number(process.env.SUMMARY_TOKENS ?? 1500)),
  },
  onEvent: (e) => {
    const ev = e as any;
    if (e.type === 'tool.start') console.log(`  -> ${ev.toolName}(${JSON.stringify(ev.args).slice(0, 120)})`);
    if (e.type === 'tool.error') console.log(`  !! ${ev.toolName} ${JSON.stringify(ev.error).slice(0, 200)}`);
    if (e.type === 'compaction.start') console.log(`  compaction.start ${JSON.stringify({ ...ev, type: undefined, runId: undefined, seq: undefined, timestamp: undefined, v: undefined })}`);
    if (e.type === 'compaction.done') {
      const s = `${ev.strategy} ${ev.tokensBefore}->${ev.tokensAfter} pruned=${ev.prunedToolCallIds.length} summary=${!!ev.summary}${ev.error ? ' error=' + ev.error.message : ''}`;
      rows.at(-1)!.compaction = s;
      console.log(`  compaction.done ${s}`);
    }
    if (e.type === 'step.done') {
      const r = rows.find((x) => x.step === ev.step) ?? rows.at(-1)!;
      r.realPrompt = ev.usage?.promptTokens;
      console.log(`  step ${ev.step} done finish=${ev.finishReason} usage=${JSON.stringify(ev.usage)}`);
    }
    if (e.type === 'provider.retry') console.log(`  provider.retry ${ev.attempt}`);
  },
});
// the hook object's onCompaction is not reachable through createAgent({compaction}); read the summary from the transcript instead
const t0 = Date.now();
try {
  const r = await agent.send(TASK);
  console.log(`\nfinish=${r.finishReason} steps=${r.steps} ${(Date.now() - t0) / 1000}s object=${!!r.object}`);
  console.log('usage', JSON.stringify(r.usage));
  const sum = r.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('[Conversation summary]'));
  if (sum) summaries.push(sum.content as string);
  const pruned = r.messages.filter((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('[pruned'));
  console.log(`transcript: ${r.messages.length} msgs, roles=${r.messages.map((m) => m.role[0]).join('')}, pruned markers=${pruned.length} e.g. ${JSON.stringify(pruned[0]?.content)}`);
  if (r.object) console.log('rootCause:', (r.object as any).rootCause);
  else console.log('outputError', JSON.stringify(r.outputError), 'text', r.text?.slice(0, 300));
} catch (e) {
  console.log('THREW', (e as Error).message.slice(0, 300));
}
console.log('\nstep | SDK estimate (msgs only, pre-compaction) | msgs | tool-schema chars | compaction | real prompt tokens');
for (const r of rows) console.log(`${r.step} | ${r.estimateBefore} | ${r.msgs} | ${r.estToolsChars} | ${r.compaction ?? '-'} | ${r.realPrompt ?? '?'}`);
if (summaries[0]) console.log('\nSUMMARY TEXT:\n' + summaries[0].slice(0, 2500));
