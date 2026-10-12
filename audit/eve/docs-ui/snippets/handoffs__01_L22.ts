// handoffs.md:22
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const lookupCharges = defineTool({
  name: 'lookup_charges',
  description: "Lists the user's recent charges",
  input: z.object({}),
  execute: async () => [{ date: '2026-09-01', amountUsd: 9.99 }],
});

const billing = createAgent({
  name: 'billing',
  description: 'Handles charges, refunds and subscriptions',
  instructions: 'You are the billing desk. Answer in one or two sentences.',
  model: 'openai/gpt-4o-mini',
  tools: [lookupCharges],
});

const techSupport = createAgent({
  name: 'tech-support',
  description: 'Handles logins, passwords and technical problems',
  instructions: 'You are tech support. Answer in one or two sentences.',
  model: 'openai/gpt-4o-mini',
});

const triage = createAgent({
  name: 'triage',
  instructions: 'Route the user: billing questions to billing, technical questions to tech-support.',
  model: 'openai/gpt-4o-mini',
  handoffs: [billing, techSupport],
});

const result = await triage.send('I was charged twice for my subscription.');
console.log(result.agentName, result.text); // 'billing', the billing desk's answer
export {};
