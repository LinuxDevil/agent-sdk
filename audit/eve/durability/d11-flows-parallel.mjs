// D11: FlowExecutor `parallel` branches share ONE variables object.
// (a) Two forEach branches (default loop var `item`) clobber each other's
//     loop variable across awaits -> wrong arguments reach tools.
// (b) A failing branch rejects the flow while sibling branches keep running
//     and executing tools after the caller already saw the failure.
import { FlowExecutor } from '@lousho/build-ai-agent/flows';
import { ToolRegistry } from '@lousho/build-ai-agent/tools';
import { defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const log = [];
const registry = new ToolRegistry();
registry.register(defineTool({ name: 'charge', description: 'charge a customer', input: z.object({ customer: z.string() }),
  execute: async ({ customer }) => { await new Promise((r) => setTimeout(r, 10)); log.push(customer); return 'ok'; } }));
const base = { agent: { name: 'f', prompt: 'x' }, provider: mockModel([{ text: 'note', delayMs: 5 }], { onExhausted: 'repeat-last' }), toolRegistry: registry };
const flow = (root) => ({ code: 'f', name: 'f', inputs: [], flow: root });
const each = (items) => ({ type: 'forEach', items, step: { type: 'sequence', steps: [
  { type: 'llmCall', prompt: 'Write a receipt note for {{item}}' },
  { type: 'toolCall', tool: 'charge', arguments: { customer: '{{item}}' } },
] } });

await FlowExecutor.execute(flow({ type: 'parallel', steps: [each(['alice', 'bob', 'carol']), each(['dave', 'erin', 'frank'])] }), { ...base, variables: {} });
console.log('(a) customers charged:', JSON.stringify(log.sort()));
console.log(log.length === 6 && new Set(log).size === 6 ? '  PASS' : '  FAIL: branches overwrote each other\'s {{item}} - wrong customers charged');

log.length = 0;
let settledAt;
const r = await FlowExecutor.execute(flow({ type: 'parallel', steps: [{ type: 'throw', message: 'validation failed' }, each(['x1', 'x2', 'x3'])] }), { ...base, variables: {} }).catch((e) => ({ error: e }));
settledAt = log.length;
await new Promise((res) => setTimeout(res, 100));
console.log(`(b) flow result: ${r.success === false || r.error ? 'failed' : 'ok'} (${r.error?.message ?? r.error ?? ''}); charges when caller saw failure: ${settledAt}, 100ms later: ${log.length}`);
console.log(log.length > settledAt ? '  FAIL: tools kept running after the flow reported failure (no sibling cancellation)' : '  PASS');
