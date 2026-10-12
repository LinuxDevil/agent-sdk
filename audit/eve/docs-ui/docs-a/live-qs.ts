import { LIVE_MODEL } from '../../../_shared/env.ts';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
const agent = createAgent({ model: LIVE_MODEL, instructions: 'You are a helpful assistant.' });
const { text } = await agent.send('Hello! Reply in 3 words.');
console.log('send:', text);
const run = agent.stream('Count 1 to 5.'); let n = 0;
for await (const e of run) if (e.type === 'text.delta') n++;
const r = await run.result; console.log('stream deltas', n, 'finish', r.finishReason, 'usage', JSON.stringify(r.usage));
// approval flow live (doc quick-start step 5, real model)
const sendEmail = defineTool({ name: 'send_email', description: 'Send an email', input: z.object({ to: z.string() }), needsApproval: true, execute: async ({ to }) => `sent to ${to}` });
const a2 = createAgent({ model: LIVE_MODEL, instructions: 'You send emails.', tools: [sendEmail] });
const paused = await a2.send('Email the report to sam@example.com');
console.log('paused:', paused.finishReason, paused.approvalId ? 'has id' : 'no id');
if (paused.approvalId) { const res = await a2.approvals.resolve({ id: paused.approvalId, approved: true }); console.log('resolved:', res.finishReason, res.text.slice(0, 100)); }
