/* Eve multiagent repro 7: FlowExecutor `parallel` fan-out.
 *  A) one branch fails -> flow returns failure at once, but sibling branches keep running and keep
 *     spending (no abort of siblings; the caller has already been told the flow is over).
 *  B) FlowExecutionResult has no usage/cost total; only per-event usage.
 * Run: npx tsx eve/multiagent/r7-flow-parallel.ts */
import { FlowBuilder, FlowExecutor } from '@lousho/build-ai-agent/flows';
import { AgentBuilder } from '@lousho/build-ai-agent/executor';
import { mockModel } from '@lousho/build-ai-agent/testing';

const model = mockModel([
  { text: 'slow branch A', usage: { inputTokens: 5000, outputTokens: 500 }, delayMs: 400 },
  { text: 'slow branch B', usage: { inputTokens: 5000, outputTokens: 500 }, delayMs: 400 },
]);
const flow = new FlowBuilder()
  .setCode('fan')
  .setName('Fan out')
  .setFlow({
    type: 'parallel',
    steps: [
      { type: 'llmCall', prompt: 'expensive summary A' },
      { type: 'llmCall', prompt: 'expensive summary B' },
      { type: 'throw', message: 'validation failed' },
    ],
  } as any)
  .build();
const agent = AgentBuilder.create().setName('flow').setPrompt('p').build();
const t0 = Date.now();
const result = await FlowExecutor.execute(flow, { agent, provider: model, variables: {} } as any);
console.log(`[A] flow returned after ${Date.now() - t0}ms: success=${result.success} error=${result.error?.message}`);
console.log(`[A] model calls started by then: ${model.calls.length}`);
await new Promise((r) => setTimeout(r, 600));
const late = result.events.filter((e: any) => e.type === 'llm-response').length;
console.log(`[A] 600ms later: llm-response events appended to the already-returned result.events: ${late}`);
console.log(`[B] result keys: ${Object.keys(result).join(',')}`);
