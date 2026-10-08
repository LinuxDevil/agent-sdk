/** Is the summarizer's model call visible in result.usage / traces / limits? */
process.env.MAX_LINE ??= '600';
import { createAgent, type TraceExporter } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { INSTRUCTIONS, tools } from '../logs.js';
const call = (pattern: string, limit = 25) => ({ toolCalls: [{ name: 'search_logs', args: { pattern, limit } }] });
const model = mockModel([call('deploy'), call('pool stats'), call('too many'), call('timeout'), call('rollback'), call('scaled'), 'done'], { usage: { promptTokens: 1000, completionTokens: 50 } } as any);
const summarizer = mockModel(Array(10).fill('Goal: triage. Deploy v2.41.0 14:02; pool leak; too many clients 14:11; rollback 14:38.'), { usage: { promptTokens: 3000, completionTokens: 400 } } as any);
const spans: string[] = [];
const exporter: TraceExporter = { onSpanStart: () => {}, onSpanEnd: (s: any) => spans.push(s.name) };
const agent = createAgent({ provider: model, instructions: INSTRUCTIONS, tools, maxSteps: 10, exporter,
  compaction: { contextWindow: 8192, thresholdPercent: 0.12, protectedTokens: 100, summarizer },
  onEvent: (e: any) => { if (e.type === 'compaction.done') console.log(`compaction.done ${e.strategy} ${e.tokensBefore}->${e.tokensAfter} summary=${!!e.summary} ${e.error ? 'ERR ' + e.error.message.slice(0, 100) : ''}`); } });
const r = await agent.send('Investigate.');
console.log(`finish=${r.finishReason} main model calls=${model.calls.length} summarizer calls=${summarizer.calls.length}`);
console.log(`result.usage.modelCalls=${(r.usage as any).modelCalls} inputTokens=${r.usage.inputTokens} (main model alone: ${model.calls.length * 1000})`);
console.log(`spans: ${[...new Set(spans)].join(', ')} | chat spans=${spans.filter((s) => s.startsWith('chat')).length}`);
