/* Eve multiagent repro 2b: a QUEUED background sub-agent (maxConcurrent reached) starts after its
 * `execute_tool task` span ended -> the OTel exporter has dropped that parent's context and the
 * child's spans become a separate root trace. Run: npx tsx eve/multiagent/r2b-otel-queued.ts */
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { createOtelTraceExporter } from '@lousho/build-ai-agent/otel';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const call = (n: number) => ({ name: 'task', args: { agent: 'worker', prompt: `job ${n}`, description: `job ${n}`, background: true } });
const child = mockModel([{ text: 'a', delayMs: 100 }, { text: 'b', delayMs: 100 }]);
const lead = mockModel([{ toolCalls: [call(1), call(2)] }, { text: 'lead done' }]);
const worker = createAgent({ name: 'worker', provider: child, instructions: 'w', description: 'Worker' });
const mem = new InMemorySpanExporter();
const tp = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(mem)] });
const agent = createAgent({
  name: 'lead', provider: lead, instructions: 'lead', subagents: { worker },
  subagentOptions: { maxConcurrent: 1, awaitBackgroundOnFinish: true },
  exporter: createOtelTraceExporter({ tracer: tp.getTracer('t'), metrics: false }),
});
const r = await agent.send('go');
const spans = mem.getFinishedSpans();
const byTrace = new Map<string, string[]>();
for (const s of spans) byTrace.set(s.spanContext().traceId, [...(byTrace.get(s.spanContext().traceId) ?? []), s.name]);
console.log('backgroundTasks:', JSON.stringify(r.backgroundTasks?.map((t) => t.status)));
console.log(`${spans.length} spans in ${byTrace.size} trace(s):`);
for (const [id, names] of byTrace) console.log(' ', id.slice(0, 8), names.join(' | '));
