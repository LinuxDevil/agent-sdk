// Repro (no model): flow toolCall semantics that matter for an AP pipeline.
import { defineTool, createMockProvider } from '@lousho/build-ai-agent';
import { ToolRegistry } from '@lousho/build-ai-agent/tools';
import { FlowBuilder, FlowExecutor, type EditorStep } from '@lousho/build-ai-agent/flows';
import { z } from 'zod';

const seen: Record<string, unknown> = {};
const reg = new ToolRegistry();
reg.register(defineTool({ name: 'extract', description: 'x', input: z.object({ docId: z.string() }),
  execute: async ({ docId }) => ({ docId, total: '1200.00', lineItems: [{ amount: '1200.00' }] }) }));
reg.register(defineTool({ name: 'echo', description: 'x', input: z.object({ invoice: z.any(), amount: z.number() }),
  execute: async (args, ctx: any) => { seen.echo = { args, typeofAmount: typeof args.amount, hasAbortSignal: !!ctx?.abortSignal }; return 'ok'; } }));
reg.register(defineTool({ name: 'pay', description: 'Pay a vendor', input: z.object({ amount: z.string() }), needsApproval: true,
  execute: async ({ amount }) => { seen.paid = amount; return `PAID ${amount}`; } }));
reg.register(defineTool({ name: 'boom', description: 'x', input: z.object({}),
  execute: async () => { const e: any = new Error('upstream extraction timed out'); e.code = 'E_TIMEOUT'; throw e; } }));
reg.register(defineTool({ name: 'slow', description: 'x', input: z.object({ n: z.string() }),
  execute: async ({ n }) => { await new Promise((r) => setTimeout(r, 300)); seen[`slow${n}`] = Date.now(); return n; } }));

const agent = { name: 'ap', prompt: 'You are an AP clerk.' };
const provider = createMockProvider();
const mk = (code: string, flow: EditorStep) => new FlowBuilder().setCode(code).setName(code).setFlow(flow).build();

// 1) passing an object result from one toolCall to the next
let r = await FlowExecutor.execute(mk('pass', { type: 'sequence', steps: [
  { type: 'toolCall', tool: 'extract', arguments: { docId: 'inv-1' }, outputVariable: 'inv' },
  { type: 'toolCall', tool: 'echo', arguments: { invoice: '{{inv}}', amount: '{{inv}}' } },
] } as EditorStep), { agent, provider, variables: {}, toolRegistry: reg });
console.log('1a {{inv}} as arg ->', JSON.stringify(seen.echo), 'success', r.success);
r = await FlowExecutor.execute(mk('pass2', { type: 'sequence', steps: [
  { type: 'toolCall', tool: 'extract', arguments: { docId: 'inv-1' }, outputVariable: 'inv' },
  { type: 'toolCall', tool: 'echo', arguments: { invoice: '$inv', amount: 5 } },
] } as EditorStep), { agent, provider, variables: {}, toolRegistry: reg });
console.log('1b "$inv" as arg ->', JSON.stringify(seen.echo));

// 2) a needsApproval tool called from a flow
r = await FlowExecutor.execute(mk('pay', { type: 'toolCall', tool: 'pay', arguments: { amount: '25000.00' } } as EditorStep),
  { agent, provider, variables: {}, toolRegistry: reg });
console.log('2 needsApproval tool in flow -> success', r.success, 'output', JSON.stringify(r.output), 'paid', seen.paid);

// 3) a throwing tool: how does the error surface?
let threw = false;
try {
  r = await FlowExecutor.execute(mk('boom', { type: 'sequence', steps: [{ type: 'toolCall', tool: 'boom', arguments: {} }] } as EditorStep),
    { agent, provider, variables: {}, toolRegistry: reg });
} catch { threw = true; }
console.log('3 throwing tool -> execute() rejected?', threw, 'success', r.success, 'error', r.error?.constructor?.name, JSON.stringify(r.error?.message), 'code', (r.error as any)?.code,
  'events', r.events.map((e) => e.type).join(','));

// 4) cancellation: the caller gives up after 100 ms; does the flow keep running?
const t0 = Date.now();
const p = FlowExecutor.execute(mk('slow', { type: 'sequence', steps: [
  { type: 'toolCall', tool: 'slow', arguments: { n: '1' } },
  { type: 'toolCall', tool: 'slow', arguments: { n: '2' } },
  { type: 'toolCall', tool: 'slow', arguments: { n: '3' } },
] } as EditorStep), { agent, provider, variables: {}, toolRegistry: reg, signal: AbortSignal.timeout(100) } as any);
await Promise.race([p, new Promise((res) => setTimeout(res, 100))]);
console.log('4 after caller timeout (100ms): steps run so far', Object.keys(seen).filter((k) => k.startsWith('slow')));
await p;
console.log('  ...flow kept going; all steps ran by', Date.now() - t0, 'ms:', Object.keys(seen).filter((k) => k.startsWith('slow')));

// 5) step ids
r = await FlowExecutor.execute(mk('ids', { type: 'sequence', steps: [
  { type: 'setVariable', variable: 'a', value: 1 }, { type: 'setVariable', variable: 'b', value: 2 }, { type: 'setVariable', variable: 'c', value: 3 },
] } as EditorStep), { agent, provider, variables: {} });
const ids = r.events.filter((e) => e.type === 'step-start').map((e) => e.stepId);
console.log('5 auto step ids', ids, 'unique', new Set(ids).size, 'of', ids.length);

// 6) typing: what is result.output?
const out: unknown = r.output; // FlowExecutionResult.output is `unknown`; variables is Record<string, unknown>
void out;
