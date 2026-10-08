// Repro (no model): a flow declares a required input; execute() without it.
import { createMockProvider, defineTool } from '@lousho/build-ai-agent';
import { ToolRegistry } from '@lousho/build-ai-agent/tools';
import { FlowBuilder, FlowExecutor, type EditorStep } from '@lousho/build-ai-agent/flows';
import { z } from 'zod';

const got: unknown[] = [];
const reg = new ToolRegistry();
reg.register(defineTool({ name: 'extract_invoice', description: 'x', input: z.object({ docId: z.string().min(1) }), execute: async (a) => { got.push(a); return 'ran'; } }));
const flow = new FlowBuilder().setCode('f').setName('f').addInput({ name: 'docId', type: 'shortText', required: true })
  .setFlow({ type: 'toolCall', tool: 'extract_invoice', arguments: { docId: '{{docId}}' } } as EditorStep).build();
const r = await FlowExecutor.execute(flow, { agent: { name: 'a' }, provider: createMockProvider(), variables: {}, toolRegistry: reg });
console.log('missing required input -> success', r.success, 'output', r.output, 'tool got', JSON.stringify(got), '(docId min(1) not enforced either)');
