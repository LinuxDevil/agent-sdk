// handoffs.md:189
import { createAgent, handoff, type Handoff } from '@lousho/build-ai-agent';

const billingHandoffs: Handoff[] = [];
const billing = createAgent({
  name: 'billing',
  description: 'Handles charges and refunds',
  instructions: 'For anything that is not about billing, hand back to triage.',
  model: 'openai/gpt-4o-mini',
  handoffs: billingHandoffs,
});
const triage = createAgent({
  name: 'triage',
  description: 'Routes the user to the right desk',
  model: 'openai/gpt-4o-mini',
  handoffs: [billing],
});
billingHandoffs.push(handoff(triage));
export {};
