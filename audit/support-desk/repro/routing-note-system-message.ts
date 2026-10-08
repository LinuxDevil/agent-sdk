/**
 * Repro: after a handoff the target's model request carries a `system` message
 * in the MIDDLE of the conversation (the routing note). Chat templates of
 * Qwen / Llama-family models served by LM Studio, llama.cpp, vLLM, Ollama reject
 * that ("System message must be at the beginning."), so every handoff fails.
 *
 *   npx tsx support-desk/repro/routing-note-system-message.ts
 */
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const model = mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: { reason: 'refund' } }] }, 'Billing here.']);
const billing = createAgent({ name: 'billing', description: 'refunds', instructions: 'You are billing.', provider: model });
const triage = createAgent({ name: 'triage', instructions: 'Route.', provider: model, handoffs: [billing] });
await triage.send('I want a refund');
const roles = model.calls[1].messages.map((m) => m.role);
console.log('target request roles:', JSON.stringify(roles));
console.log('system messages after index 0:', model.calls[1].messages.slice(1).filter((m) => m.role === 'system').map((m) => String(m.content)));
