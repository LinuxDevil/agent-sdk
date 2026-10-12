// CORE: can ExecutionResult.messages be fed back into send() (the documented Message[] input)?
// Run: npx tsx eve/core/r11-messages-roundtrip.ts
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const lookup = defineTool({ name: 'lookup', description: 'l', input: z.object({ q: z.string() }), execute: async ({ q }) => `data for ${q}` });
const model = mockModel([{ toolCalls: [{ name: 'lookup', args: { q: 'a' } }] }, 'first answer', 'second answer']);
const agent = createAgent({ provider: model, instructions: 'You are TERSE.', tools: [lookup] });

const r1 = await agent.send('question one');
console.log('r1.messages roles: %j', r1.messages.map((m) => m.role));
const r2 = await agent.send([...r1.messages, { role: 'user', content: 'question two' }]);
const req = model.lastCall!;
const systems = req.messages.filter((m) => m.role === 'system');
console.log('turn-2 request roles: %j', req.messages.map((m) => m.role));
console.log('system messages sent on turn 2: %d -> %j', systems.length, systems.map((m) => String(m.content).slice(0, 30)));
console.log('r2.text=%j', r2.text);
