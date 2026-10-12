/* Eve multiagent repro 2: tracing of delegated runs.
 *  A) OTel exporter: a background sub-agent's spans are detached from the lead's trace
 *     (the parent `execute_tool task` span already ended, so its OTel context is gone).
 *  B) lousho.cost_usd rollup on the lead's invoke_agent span omits background children.
 *  C) fileTraceExporter default (no redactContent): prompts / tool args / results on disk (REPORT B17 "fixed").
 * Deterministic (mockModel). Run: npx tsx eve/multiagent/r2-otel-background.ts
 * (@opentelemetry/* resolve from E:\agent-sdk\node_modules - nothing installed under audit/.)
 */
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { fileTraceExporter } from '@lousho/build-ai-agent/traces';
import { createOtelTraceExporter } from '@lousho/build-ai-agent/otel';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MODEL = 'openai/gpt-4o-mini';
const u = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

function build(background: boolean, exporter: any, extra: Record<string, unknown> = {}) {
  const child = mockModel([{ text: 'child answer SECRET-CHILD-OUT', usage: u(100000, 10000), delayMs: 150 }], { defaultModel: MODEL });
  const lead = mockModel(
    [
      { toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'SECRET-TASK-PROMPT', description: 'job', background } }], usage: u(10, 1) },
      { text: 'lead done', usage: u(10, 1) },
    ],
    { defaultModel: MODEL }
  );
  const worker = createAgent({ name: 'worker', provider: child, model: MODEL, instructions: 'w', description: 'Worker' } as any);
  return createAgent({
    name: 'lead',
    provider: lead,
    model: MODEL,
    instructions: 'lead SECRET-SYSTEM-PROMPT',
    subagents: { worker },
    subagentOptions: { awaitBackgroundOnFinish: true },
    exporter,
    ...extra,
  } as any);
}

async function otel(background: boolean) {
  const mem = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(mem)] });
  const exporter = createOtelTraceExporter({ tracer: provider.getTracer('t'), metrics: false });
  const r = await build(background, exporter).send('SECRET-USER-INPUT');
  const spans = mem.getFinishedSpans();
  const traces = new Set(spans.map((s) => s.spanContext().traceId));
  const leadAgent = spans.find((s) => s.name === 'invoke_agent lead');
  const childAgent = spans.find((s) => s.name === 'invoke_agent worker');
  const parentOf = (s: any) => s?.parentSpanContext?.spanId ?? s?.parentSpanId;
  const parent = spans.find((s) => s.spanContext().spanId === parentOf(childAgent));
  console.log(`[A] background=${background}: ${spans.length} spans in ${traces.size} trace(s); child invoke_agent parent = ${parent?.name ?? '(none: root of its own trace)'}`);
  console.log(`[B] background=${background}: lead invoke_agent lousho.cost_usd = ${leadAgent?.attributes['lousho.cost_usd']} ; result.usage.costUsd = ${r.usage.costUsd}`);
}

async function file() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-traces-'));
  await build(false, fileTraceExporter({ dir })).send('SECRET-USER-INPUT');
  const text = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('');
  const found = ['SECRET-USER-INPUT', 'SECRET-SYSTEM-PROMPT', 'SECRET-TASK-PROMPT', 'SECRET-CHILD-OUT'].filter((s) => text.includes(s));
  console.log(`[C] fileTraceExporter() defaults (captureContent unset, redactContent unset): content on disk = ${JSON.stringify(found)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

await otel(false);
await otel(true);
await file();

// D) `lousho traces` / listTraces(): tokens are summed from chat spans (child included) but costUsd is the root's rollup (child missing)
{
  const { listTraces } = await import('@lousho/build-ai-agent/traces');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-traces-'));
  const r = await build(true, fileTraceExporter({ dir }), { redactContent: true }).send('x');
  const [summary] = await listTraces({ dir });
  console.log(`[D] background: listTraces -> inputTokens=${summary?.inputTokens} costUsd=${summary?.costUsd} ; result.usage.costUsd=${r.usage.costUsd}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
